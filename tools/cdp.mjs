/**
 * Tiny Chrome DevTools Protocol client over Node's built-in `WebSocket`.
 *
 * No dependency, because the only browser that is already authenticated to the
 * Harness GUI is the Desktop app's own window: the web surface authenticates
 * every API method and stream with a cookie exchanged from a fresh process
 * token in the startup URL, so an external browser at the bare loopback URL
 * gets 401. Attaching to the app's own window through Chromium's standard
 * `--remote-debugging-port` switch sidesteps that entirely.
 *
 * @module tools/cdp
 */

/** Default debugging port the app is expected to expose. */
export const DEFAULT_PORT = process.env.CDP_PORT ?? '9222'

/**
 * List the debuggable targets the browser exposes.
 * @param port - remote debugging port.
 * @returns the target list.
 */
export async function listTargets(port = DEFAULT_PORT) {
  const base = `http://127.0.0.1:${port}`
  let response
  try {
    response = await fetch(`${base}/json/list`)
  } catch (error) {
    throw new Error(
      `cannot reach ${base} (${error.message}). Restart the app with --remote-debugging-port=${port}.`,
    )
  }
  if (!response.ok) throw new Error(`${base}/json/list answered ${String(response.status)}`)
  return response.json()
}

/**
 * Choose the page to drive: a real `page` target, preferring one that looks
 * like the Harness window.
 * @param targets - the target list.
 * @param match - optional URL substring to require.
 * @returns the chosen target.
 */
export function pickPage(targets, match) {
  const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl)
  if (pages.length === 0) throw new Error('the browser exposes no page target')
  if (match !== undefined) {
    const wanted = pages.find((page) => String(page.url).includes(match))
    if (wanted === undefined) {
      throw new Error(
        `no page target matches ${JSON.stringify(match)}; saw ${pages.map((page) => page.url).join(', ')}`,
      )
    }
    return wanted
  }
  return (
    pages.find((page) => /127\.0\.0\.1|localhost/.test(String(page.url))) ??
    pages.find((page) => String(page.title ?? '').length > 0) ??
    pages[0]
  )
}

/** One CDP connection with request/response correlation. */
class Connection {
  /** @param socket - an open WebSocket to a page target. */
  constructor(socket) {
    this.socket = socket
    this.pending = new Map()
    this.nextId = 1
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    })
  }

  /**
   * Send one CDP command.
   * @param method - CDP method name.
   * @param params - CDP parameters.
   * @returns the command result.
   */
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 20000)
    })
  }
}

/**
 * Attach to one page target.
 * @param options - `{ port, match }`.
 * @returns `{ target, send, evaluate, waitFor, close }`.
 */
export async function attach(options = {}) {
  const port = options.port ?? DEFAULT_PORT
  const target = pickPage(await listTargets(port), options.match)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('the CDP socket failed to open')), {
      once: true,
    })
  })
  const connection = new Connection(socket)

  /** Evaluate an expression in the page and return its value. */
  async function evaluate(expression) {
    const result = await connection.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      const description =
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
      throw new Error(`the page threw: ${description}`)
    }
    return result.result?.value
  }

  /** Poll an expression until it is truthy. */
  async function waitFor(expression, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await evaluate(expression)) return true
      if (Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  return {
    target,
    send: (method, params) => connection.send(method, params),
    evaluate,
    waitFor,
    close: () => socket.close(),
  }
}

/** Poll the debugging endpoint until the browser answers. */
export async function waitForEndpoint(port = DEFAULT_PORT, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await listTargets(port)
      return true
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}
