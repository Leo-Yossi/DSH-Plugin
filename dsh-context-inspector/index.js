/**
 * Host half of `@local/dsh-context-inspector`.
 *
 * Reconstructs, per Session, the payload the Agent loop hands to
 * `ctx.llm.stream()` and serves it to the browser as the `contextPayload`
 * Session projection. The browser half renders it in a button-opened window
 * docked into `shell.overlay`.
 *
 * ## Why a Session projection
 *
 * `.agents` guidance in the shipped `cordis-plugin-development` skill
 * (`references/practices.md`) is explicit: per-session state derived from the
 * log belongs in a `ctx.sessionProjections` unit, and "when the Client needs a
 * value derived from a session, declare `wire.view` on the Host projection —
 * the value reaches the Client already computed; the Client does not fold
 * session events itself."
 *
 * ## What "the payload" means here
 *
 * `dsh-agent-loop`'s `buildRequest()` freezes exactly this object and passes it
 * straight to `llm.stream()`:
 *
 * ```js
 * markAgentLoopRequest(Object.freeze({
 *   ...header.config,          // provider, model, reasoningEffort?, temperature?, maxTokens?, stop?
 *   messages: boundaryMessages, // session.deriveMessages(), system prompt first
 *   toolHistory: session.toolHistory(),
 *   ...header.tools !== void 0 ? { tools: header.tools } : {},
 *   sessionId: this.session.id,
 *   signal
 * }))
 * ```
 *
 * The loop logs a full canonical `request/header` snapshot whenever the
 * envelope changes and one surface event per message, and the loop package's
 * own invariant (`dsh-agent-loop/invariant.js`) asserts that the live request
 * equals the fold of those events — so the log is a faithful, replayable
 * reconstruction of the request.
 *
 * Two deliberate limits, surfaced in the UI rather than hidden:
 *
 * 1. `GenerateOptions.system` is `undefined` on every loop-built request; the
 *    rendered system prompt travels as `messages[0]` (`role: 'system'`).
 * 2. This is the *logical* payload. `dsh-llm`'s `adapterStream()` may still
 *    project it on the way to the provider (file references to text, images to
 *    text on text-only routes, tool-schema rewriting for `modelInfo.toolUpdate`),
 *    and compaction/session-title sub-requests carry `purpose` without passing
 *    through this log fold at all.
 *
 * `@module @local/dsh-context-inspector`
 */

/** Cordis plugin name. */
export const name = 'context-inspector'

/**
 * The one service this plugin needs. Without it the plugin stays inactive
 * instead of throwing, exactly as the practices reference requires.
 */
export const inject = ['sessionProjections']

/** Projection key the browser reads through `useProjection(KEY)`. */
const PROJECTION_KEY = 'contextPayload'

/**
 * Bumped whenever the state fields or the fold semantics change, so a stale
 * persisted checkpoint is discarded instead of reinterpreted.
 */
const STATE_VERSION = 1

/** Bounds on the harness-side facts retained outside the payload. */
const HOOK_LIMIT = 400
const MARK_LIMIT = 400

/**
 * The projection registry calls `.parse()` on `stateSchema` (checkpoint
 * restore) and `viewSchema` (every value leaving for the browser). This plugin
 * ships no dependency, and both values are already plain JSON produced by this
 * module, so the schemas are deliberately trivial rather than zod-validated.
 * Keep every state and view field JSON-safe when editing this file.
 */
const PASSTHROUGH_SCHEMA = Object.freeze({ parse: (value) => value })

/** Surface events produce model-visible messages; everything else does not. */
const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/** Harness-side hook records: never part of the outgoing payload. */
const HOOK_TYPES = new Set(['hook/invoked', 'hook/result'])

/** Turn/step/compaction markers: timeline orientation, not payload fields. */
const MARK_TYPES = new Set(['turn/start', 'step/start', 'compaction/start', 'compaction/end'])

/** Message roles whose empty content produces no message at all. */
const DROPPABLE_WHEN_EMPTY = new Set(['system/message', 'developer/message', 'assistant/message'])

//#region fold state

/**
 * Create the empty fold state for one Session.
 * @returns a fresh, JSON-plain state object.
 */
function emptyState() {
  return {
    /** Highest consumed event seq, or -1. */
    seq: -1,
    /** Latest `request/header` snapshot. */
    header: null,
    headerSeq: -1,
    headerTime: 0,
    headerReason: '',
    startsSeries: false,
    /** Latest `request/context` record. */
    routing: null,
    routingSeq: -1,
    routingTime: 0,
    /** Ordered surface nodes: `{ seq, time, turn, type, origin, message, emits }`. */
    nodes: [],
    /** Bounded `hook/invoked` / `hook/result` facts. */
    hooks: [],
    /** Bounded turn/step/compaction markers. */
    marks: [],
    /** `callId -> tool name`, used to title `tool/result` records. */
    callNames: {},
    /** Tool-history fold: header seq -> its tool list. */
    toolHeaders: {},
    /** Tool-history fold: tool name -> serialized definition, for redeclaration. */
    declaredJson: {},
    /** Tool-history fold: header that started the current declaration series. */
    baselineSeq: -1,
    /** Tool-history fold: definitions frozen at the series start. */
    historyTools: [],
    /** Tool-history fold: resolved additions since the series start. */
    historyUpdates: [],
    /** Tool-history fold: active names reconstructed from the baseline. */
    available: [],
  }
}

/**
 * Stable source id for one surface event. The browser maps these ids to
 * presentation, so adding a source means adding one entry to the Client's
 * origin table and returning its id from here — nothing else changes.
 * @param event - a committed surface event.
 * @returns the origin id.
 */
function originForSurface(event) {
  switch (event.type) {
    case 'system/message':
      return 'system'
    case 'developer/message':
      return 'developer'
    case 'user/message':
      return event.data !== null &&
        typeof event.data === 'object' &&
        event.data.source !== null &&
        typeof event.data.source === 'object' &&
        event.data.source.kind === 'user'
        ? 'user'
        : 'injected'
    case 'assistant/message':
      return 'assistant'
    case 'tool/result':
      return 'tool-result'
    /* v8 ignore next -- SURFACE_TYPES gates the caller */
    default:
      return 'other'
  }
}

/**
 * Whether a surface event contributes a model-visible message.
 * Mirrors `deriveEventMessage()` in `dsh-session`, which drops empty
 * system/developer/assistant content.
 * @param event - a committed surface event.
 * @param message - the message the event carries.
 * @returns true when the message reaches the model.
 */
function emitsMessage(event, message) {
  if (!DROPPABLE_WHEN_EMPTY.has(event.type)) return true
  return Array.isArray(message.content) && message.content.length > 0
}

/** Update the tool-history fold with a new canonical header snapshot. */
function applyHeaderToToolHistory(state, event) {
  const tools = event.data.header.tools ?? []
  const toolHeaders = { ...state.toolHeaders, [String(event.seq)]: tools }

  let redeclared = false
  for (const tool of tools) {
    const before = state.declaredJson[tool.name]
    if (before !== undefined && before !== safeString(tool)) {
      redeclared = true
      break
    }
  }

  const startsSeries =
    state.baselineSeq === -1 ||
    event.data.reason === 'series' ||
    event.data.startsSeries === true ||
    redeclared

  if (!startsSeries) return { ...state, toolHeaders }

  const declaredJson = {}
  for (const tool of tools) declaredJson[tool.name] = safeString(tool)
  return {
    ...state,
    toolHeaders,
    baselineSeq: event.seq,
    declaredJson,
    historyTools: tools,
    historyUpdates: [],
    available: tools.map((tool) => tool.name),
  }
}

/** Update the tool-history fold with a developer tool add/remove notice. */
function applyDeveloperToToolHistory(state, event) {
  const message = event.data.message
  const blocks = Array.isArray(message.content) ? message.content : []
  const headerSeq = event.data.headerSeq
  const definitions = headerSeq === undefined ? undefined : state.toolHeaders[String(headerSeq)]

  const additions = []
  const declaredJson = { ...state.declaredJson }
  for (const block of blocks) {
    if (block.type !== 'tool-addition') continue
    const tool = definitions?.find((candidate) => candidate.name === block.toolName)
    /* v8 ignore next -- a log that reaches here violates the session invariant */
    if (tool === undefined) continue
    additions.push(tool)
    declaredJson[tool.name] = safeString(tool)
  }

  let available = state.available
  let changed = false
  for (const block of blocks) {
    if (block.type === 'tool-addition') {
      if (available.includes(block.toolName)) continue
      if (!changed) available = [...available]
      changed = true
      available.push(block.toolName)
    } else if (block.type === 'tool-removal') {
      if (!available.includes(block.toolName)) continue
      if (!changed) available = [...available]
      changed = true
      available = available.filter((name) => name !== block.toolName)
    }
  }

  return {
    ...state,
    declaredJson,
    available,
    historyUpdates: [...state.historyUpdates, { messageId: message.id, additions }],
  }
}

/**
 * Read the current tool-history snapshot, following `ToolHistoryProjection`.
 * Sessions written before tool-update emission carry headers without matching
 * updates; those fall back to the active list with no updates.
 * @param state - the fold state.
 * @param activeTools - the latest header's tools.
 * @returns `{ tools, updates }` as the payload carries it.
 */
function toolHistorySnapshot(state, activeTools) {
  const available = new Set(state.available)
  const diverges =
    activeTools.length !== available.size || activeTools.some((tool) => !available.has(tool.name))
  if (diverges) return { tools: activeTools, updates: [] }
  return { tools: state.historyTools, updates: state.historyUpdates }
}

/** Serialize a value for the redeclaration comparison, tolerating cycles. */
function safeString(value) {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    /* v8 ignore next -- tool schemas are JSON by construction */
    return ''
  }
}

/**
 * Apply one committed Session event.
 *
 * The registry's change gate is `Object.is` on the returned reference, so an
 * ignored event must return the same object.
 * @param state - current fold state.
 * @param event - one committed Session event.
 * @returns the next state, or `state` when the event does not concern us.
 */
function applyEvent(state, event) {
  switch (event.type) {
    case 'request/header': {
      const withHistory = applyHeaderToToolHistory(state, event)
      return {
        ...withHistory,
        seq: event.seq,
        header: event.data.header,
        headerSeq: event.seq,
        headerTime: event.time,
        headerReason: event.data.reason,
        startsSeries: event.data.startsSeries === true,
      }
    }
    case 'request/context':
      return {
        ...state,
        seq: event.seq,
        routing: { ...event.data },
        routingSeq: event.seq,
        routingTime: event.time,
      }
    case 'tool/call':
      return {
        ...state,
        seq: event.seq,
        callNames: { ...state.callNames, [String(event.data.callId)]: event.data.name },
      }
    case 'developer/message': {
      const withHistory = applyDeveloperToToolHistory(state, event)
      return appendSurface({ ...withHistory, seq: event.seq }, event)
    }
    default:
      break
  }

  if (SURFACE_TYPES.has(event.type)) return appendSurface({ ...state, seq: event.seq }, event)

  if (HOOK_TYPES.has(event.type)) {
    const hooks = [...state.hooks, hookRecord(event)]
    return {
      ...state,
      seq: event.seq,
      hooks: hooks.length > HOOK_LIMIT ? hooks.slice(hooks.length - HOOK_LIMIT) : hooks,
    }
  }

  if (MARK_TYPES.has(event.type)) {
    const marks = [...state.marks, markRecord(event)]
    return {
      ...state,
      seq: event.seq,
      marks: marks.length > MARK_LIMIT ? marks.slice(marks.length - MARK_LIMIT) : marks,
    }
  }

  return state
}

/** One harness-side hook fact, flat and JSON-safe. */
function hookRecord(event) {
  const data = event.data
  if (event.type === 'hook/invoked') {
    return {
      seq: event.seq,
      time: event.time,
      event: 'hook/invoked',
      turn: data.turn,
      point: data.point,
      dialect: data.dialect,
      handlerId: data.handlerId,
      ...(data.matcher === undefined ? {} : { matcher: data.matcher }),
    }
  }
  return {
    seq: event.seq,
    time: event.time,
    event: 'hook/result',
    turn: data.turn,
    point: data.point,
    handlerId: data.handlerId,
    decision: data.decision,
    durationMs: data.durationMs,
    ...(data.exitCode === undefined ? {} : { exitCode: data.exitCode }),
    ...(data.stderrSummary === undefined ? {} : { stderrSummary: data.stderrSummary }),
  }
}

/** One timeline marker, flat and JSON-safe. */
function markRecord(event) {
  return {
    seq: event.seq,
    time: event.time,
    event: event.type,
    ...(typeof event.data?.turn === 'number' ? { turn: event.data.turn } : {}),
    ...(typeof event.data?.step === 'number' ? { step: event.data.step } : {}),
  }
}

/**
 * Fold one surface event into the ordered node list, honouring the positional
 * replacement operation (`surfaceOp: { op: 'replace', startSeq, endSeq }`) that
 * compaction and prompt rewrites use.
 * @param state - state carrying the updated seq.
 * @param event - a committed surface event.
 * @returns the next state.
 */
function appendSurface(state, event) {
  const data = event.data
  const message = event.type === 'user/message' ? data : data?.message
  /* v8 ignore next -- the session invariant rejects a surface event without a message */
  if (message === undefined || message === null) return state

  const node = {
    seq: event.seq,
    time: event.time,
    turn: typeof data?.turn === 'number' ? data.turn : undefined,
    type: event.type,
    origin: originForSurface(event),
    message,
    emits: emitsMessage(event, message),
  }

  const op = event.surfaceOp
  if (op === undefined || op === 'append') return { ...state, nodes: [...state.nodes, node] }

  const nodes = state.nodes
  const startIdx = nodes.findIndex((candidate) => candidate.seq === op.startSeq)
  /* v8 ignore next -- a windowed fold that lost the endpoint keeps what it has */
  if (startIdx === -1) return state

  const keep = (candidate) => candidate.seq < op.startSeq || candidate.seq > op.endSeq
  return {
    ...state,
    nodes: [...nodes.slice(0, startIdx).filter(keep), node, ...nodes.slice(startIdx).filter(keep)],
  }
}

//#endregion

//#region view

/**
 * Per-state memo so the registry's `Object.is` gate suppresses republication
 * for a state that has already been viewed.
 */
const viewCache = new WeakMap()

/**
 * Build the browser-facing value.
 *
 * Shape (all fields stable, all values JSON):
 *
 * - `payload`    the reconstructed `GenerateOptions`, field for field
 * - `fields`     one row per payload field, with the origin that produced it
 * - `omitted`    payload fields that are absent, and why
 * - `records`    every folded fact: `{ id, origin, kind, label, path?, data?, seq, time }`
 * - `hooks`      harness-side hook facts (never sent)
 * - `marks`      turn/step/compaction markers (never sent)
 * - `stats`      cheap counters for the panel header
 *
 * @param state - the fold state.
 * @returns a plain JSON view.
 */
function buildView(state) {
  const cached = viewCache.get(state)
  if (cached !== undefined) return cached

  const header = state.header
  const config = header?.config ?? {}
  const tools = header?.tools ?? []

  const messages = []
  const messageIndex = []
  for (const node of state.nodes) {
    if (node.emits) {
      messageIndex.push(messages.length)
      messages.push(node.message)
    } else {
      messageIndex.push(-1)
    }
  }

  const toolHistory = toolHistorySnapshot(state, tools)

  const payload = {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    ...(config.stop === undefined ? {} : { stop: config.stop }),
    messages,
    toolHistory,
    ...(tools.length === 0 ? {} : { tools }),
    /** Filled by the browser, which knows the Session it is rendering. */
    sessionId: null,
    /** A live AbortSignal; shown as a marker rather than serialized. */
    signal: '<AbortSignal>',
  }

  const records = []
  if (header !== undefined && header !== null) {
    records.push({
      id: `h${String(state.headerSeq)}`,
      origin: 'envelope',
      kind: 'request-header',
      label: `${config.provider ?? '?'} / ${config.model ?? '?'}`,
      path: '/provider',
      seq: state.headerSeq,
      time: state.headerTime,
      note: state.headerReason,
    })
    tools.forEach((tool, index) => {
      records.push({
        id: `t${String(state.headerSeq)}-${String(index)}`,
        origin: 'tools',
        kind: 'tool-schema',
        label: tool.name,
        path: `/tools/${String(index)}`,
        seq: state.headerSeq,
        time: state.headerTime,
      })
    })
  }
  if (state.routing !== null) {
    records.push({
      id: `r${String(state.routingSeq)}`,
      origin: 'routing',
      kind: 'request-context',
      label: `${state.routing.provider} / ${state.routing.model}`,
      data: state.routing,
      seq: state.routingSeq,
      time: state.routingTime,
    })
  }

  state.nodes.forEach((node, index) => {
    const path =
      messageIndex[index] === -1 ? undefined : `/messages/${String(messageIndex[index])}`
    records.push({
      id: `n${String(node.seq)}`,
      origin: node.origin,
      kind: surfaceKind(node),
      label: surfaceLabel(node, state),
      ...(path === undefined ? { data: node.message } : { path }),
      seq: node.seq,
      time: node.time,
      ...(node.emits ? {} : { note: 'empty-content, not sent' }),
      ...(node.turn === undefined ? {} : { turn: node.turn }),
    })

    if (node.type !== 'assistant/message') return
    const content = Array.isArray(node.message.content) ? node.message.content : []
    content.forEach((block, blockIndex) => {
      if (block.type !== 'tool-call') return
      records.push({
        id: `c${String(node.seq)}-${String(blockIndex)}`,
        origin: 'tool-call',
        kind: 'tool-call',
        label: block.name,
        path: `/messages/${String(messageIndex[index])}/content/${String(blockIndex)}`,
        seq: node.seq,
        time: node.time,
        ...(node.turn === undefined ? {} : { turn: node.turn }),
      })
    })
  })

  for (const hook of state.hooks) {
    records.push({
      id: `k${String(hook.seq)}`,
      origin: 'hooks',
      kind: hook.event === 'hook/invoked' ? 'hook-invoked' : 'hook-result',
      label: `${hook.point} · ${hook.handlerId}`,
      data: hook,
      seq: hook.seq,
      time: hook.time,
    })
  }
  for (const mark of state.marks) {
    records.push({
      id: `m${String(mark.seq)}`,
      origin: 'lifecycle',
      kind: 'marker',
      label: mark.event,
      data: mark,
      seq: mark.seq,
      time: mark.time,
    })
  }
  records.sort((left, right) => left.seq - right.seq)

  const view = {
    revision: 1,
    asOfSeq: state.seq,
    assembled: header !== undefined && header !== null,
    payload,
    fields: buildFieldIndex(tools.length, toolHistory),
    omitted: buildOmitted(),
    records,
    hooks: state.hooks,
    marks: state.marks,
    stats: {
      messages: messages.length,
      surfaceNodes: state.nodes.length,
      tools: tools.length,
      toolHistoryUpdates: toolHistory.updates.length,
      hooks: state.hooks.length,
      marks: state.marks.length,
      systemChars: effectiveSystemChars(state.nodes),
      payloadBytes: safeString(payload).length,
    },
  }
  viewCache.set(state, view)
  return view
}

/**
 * Characters in the *effective* system prompt: the last surviving
 * `system/message` node that carries content, which is what
 * `inspectSystemPrompt` classifies as the prompt in force. An empty surviving
 * node clears it, so a cleared prompt measures zero.
 */
function effectiveSystemChars(nodes) {
  let chars = 0
  for (const node of nodes) {
    if (node.type !== 'system/message' || !node.emits) continue
    let total = 0
    for (const block of node.message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') total += block.text.length
    }
    chars = total
  }
  return chars
}

/** A stable sub-kind the browser localizes. */
function surfaceKind(node) {
  switch (node.type) {
    case 'system/message':
      return 'system-prompt'
    case 'developer/message':
      return 'developer-message'
    case 'user/message':
      return node.origin === 'user' ? 'user-message' : 'injected-context'
    case 'assistant/message':
      return 'assistant-message'
    case 'tool/result':
      return 'tool-result'
    /* v8 ignore next -- SURFACE_TYPES gates the caller */
    default:
      return 'unknown'
  }
}

/** A language-neutral label; the browser prefixes its own localized kind name. */
function surfaceLabel(node, state) {
  if (node.type === 'tool/result') {
    const callId = node.message.callId
    const name = callId === undefined ? undefined : state.callNames[String(callId)]
    return name === undefined ? `#${String(node.seq)}` : name
  }
  const blocks = Array.isArray(node.message.content) ? node.message.content : []
  for (const block of blocks) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const firstLine = block.text.split('\n', 1)[0] ?? ''
    return firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine
  }
  return `#${String(node.seq)}`
}

/**
 * One row per payload field, each naming the origin that produced it. This is
 * what the field view renders as the "broken out" view of the envelope.
 */
function buildFieldIndex(toolCount, toolHistory) {
  const fields = [
    { name: 'provider', origin: 'envelope' },
    { name: 'model', origin: 'envelope' },
    { name: 'reasoningEffort', origin: 'envelope' },
    { name: 'temperature', origin: 'envelope' },
    { name: 'maxTokens', origin: 'envelope' },
    { name: 'stop', origin: 'envelope' },
    { name: 'messages', origin: 'messages' },
    { name: 'toolHistory', origin: 'tools', count: toolHistory.updates?.length ?? 0 },
  ]
  if (toolCount > 0) fields.push({ name: 'tools', origin: 'tools', count: toolCount })
  fields.push({ name: 'sessionId', origin: 'envelope' })
  fields.push({ name: 'signal', origin: 'envelope' })
  return fields.map((field) => ({ ...field, path: `/${field.name}` }))
}

/**
 * Payload fields that are absent, each with a stable reason code the browser
 * localizes. Naming them is the point: a reader asking "where is `system`?"
 * gets an answer instead of silence.
 */
function buildOmitted() {
  return [
    { name: 'system', reason: 'system-travels-in-messages' },
    { name: 'purpose', reason: 'agent-loop-requests-only' },
  ]
}

//#endregion

//#region projection

/** The `contextPayload` Session projection unit. */
const contextPayloadProjection = {
  key: PROJECTION_KEY,
  stateVersion: STATE_VERSION,
  stateSchema: PASSTHROUGH_SCHEMA,
  init: () => emptyState(),
  apply: (state, event) => applyEvent(state, event),
  wire: {
    viewSchema: PASSTHROUGH_SCHEMA,
    view: (state) => buildView(state),
  },
}

/**
 * Register the projection. Registration is a Cordis effect on the calling
 * fiber, so unloading the plugin removes the key and its cached cells.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.sessionProjections.register(contextPayloadProjection)
}

//#endregion
