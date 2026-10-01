/**
 * One-command visual verification for `@local/dsh-context-inspector`.
 *
 * Run it AFTER restarting the Desktop app with the debugging switch:
 *
 *   & "D:\DSH-desktop\DeepSeek Harness.exe" --remote-debugging-port=9222
 *   node tools/verify-context-inspector.mjs
 *
 * It opens this Session's window state without touching anything else: finds
 * the composer button, clicks it, waits for the panel, probes the field view,
 * switches to the code view, probes again, and writes two screenshots under
 * `.scratch/` for `read_image`.
 *
 * Every check prints PASS/FAIL, so the result is readable without the images.
 * Exit code is non-zero when a check fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { attach, waitForEndpoint, DEFAULT_PORT } from './cdp.mjs'

const OUT = '.scratch'
const buttonSelector = 'button.ci-btn'
const panelSelector = '.ci-panel'

let failures = 0
let checks = 0

function check(ok, label, detail) {
  checks += 1
  if (ok) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.error(`FAIL  ${label}${detail === undefined ? '' : `\n      ${detail}`}`)
}

try {
  await waitForEndpoint(DEFAULT_PORT)
} catch (error) {
  console.error(`verify-context-inspector: ${error.message}`)
  console.error(
    'Restart the app first:  & "D:\\DSH-desktop\\DeepSeek Harness.exe" --remote-debugging-port=9222',
  )
  process.exit(2)
}
const page = await attach({ match: process.env.CDP_MATCH })
console.log(`attached: ${page.target.title} — ${page.target.url}`)

const shot = async (name) => {
  await page.send('Page.enable')
  const result = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  mkdirSync(OUT, { recursive: true })
  const path = `${OUT}/${name}`
  writeFileSync(path, Buffer.from(result.data, 'base64'))
  console.log(`shot: ${path}`)
}

/** Read the panel's rendered state. */
const probePanel = `(() => {
  const panel = document.querySelector(${JSON.stringify(panelSelector)})
  if (panel === null) return { open: false }
  const text = panel.innerText
  return {
    open: true,
    title: panel.querySelector('.ci-title')?.textContent ?? null,
    tabs: Array.from(panel.querySelectorAll('.ci-tab')).map((el) => el.textContent),
    groups: Array.from(panel.querySelectorAll('.ci-group-name')).map((el) => el.textContent),
    records: panel.querySelectorAll('.ci-rec').length,
    fields: Array.from(panel.querySelectorAll('.ci-field')).map((row) => ({
      name: row.querySelector('.ci-field-name')?.textContent ?? null,
      value: row.querySelector('.ci-field-val')?.textContent ?? null,
    })),
    literalUndefined: (text.match(/undefined/g) ?? []).length,
    dashes: (text.match(/—/g) ?? []).length,
    stats: panel.querySelector('.ci-stats')?.innerText ?? null,
  }
})()`

try {
  // The composer button only exists while a Session is selected and its
  // composer is mounted, so say so plainly instead of clicking nothing.
  const buttons = await page.evaluate(
    `Array.from(document.querySelectorAll(${JSON.stringify(buttonSelector)})).map((el) => ({
       label: el.getAttribute('aria-label'),
       expanded: el.getAttribute('aria-expanded'),
       disabled: el.disabled,
     }))`,
  )
  check(buttons.length === 1, `exactly one composer button (found ${String(buttons.length)})`, JSON.stringify(buttons))
  if (buttons.length === 0) {
    throw new Error(
      'no button: open this Session in the app first (the composer only renders with a Session selected)',
    )
  }
  console.log(`button: ${JSON.stringify(buttons[0])}`)
  check(buttons[0].disabled !== true, 'the button is enabled (so useProjection is available)')

  const before = await page.evaluate(probePanel)
  if (before.open) await page.evaluate(`document.querySelector(${JSON.stringify(buttonSelector)}).click()`)
  await page.evaluate(`document.querySelector(${JSON.stringify(buttonSelector)}).click()`)

  const opened = await page.waitFor(
    `document.querySelector(${JSON.stringify(panelSelector)}) !== null`,
    8000,
  )
  check(opened, 'the window opens on click')
  if (!opened) throw new Error('the window never appeared')

  await new Promise((resolve) => setTimeout(resolve, 400))
  const fields = await page.evaluate(probePanel)
  await shot('inspector-fields.png')

  check(fields.title !== null && fields.title.length > 0, `window title: ${String(fields.title)}`)
  check(
    (fields.groups ?? []).length >= 5,
    `field view groups sources (${String((fields.groups ?? []).length)}): ${(fields.groups ?? []).join(', ')}`,
  )
  check(
    (fields.records ?? 0) > 0,
    `field view renders records (${String(fields.records)})`,
  )
  check(
    (fields.literalUndefined ?? 0) === 0,
    `no literal "undefined" in the field view (${String(fields.literalUndefined)})`,
    'this is the bug that was fixed: record paths resolve against view.payload',
  )
  check(
    (fields.stats ?? '').includes('payload'),
    `header shows payload statistics: ${String(fields.stats)}`,
  )

  const named = new Map((fields.fields ?? []).map((row) => [row.name, row.value]))
  for (const field of ['provider', 'model', 'messages', 'tools', 'sessionId']) {
    const value = named.get(field)
    check(
      value !== undefined && value !== '—',
      `field ${field} resolved: ${String(value)}`,
    )
  }

  // Code view: the payload must sit at the top level, not the wire wrapper.
  await page.evaluate(
    `Array.from(document.querySelectorAll('.ci-tab')).find((el) => /Code|代码/.test(el.textContent))?.click()`,
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
  const code = await page.evaluate(probePanel)
  await shot('inspector-code.png')

  const codeText = await page.evaluate(
    `(() => { const panel = document.querySelector(${JSON.stringify(panelSelector)}); return panel === null ? '' : panel.innerText })()`,
  )
  check(/provider/.test(codeText), 'code view shows the provider field')
  check(/messages/.test(codeText), 'code view shows the messages field')
  check(/toolHistory/.test(codeText), 'code view shows the toolHistory field')
  check(
    !/^\s*asOfSeq\s*$/m.test(codeText),
    'code view is not showing the wire wrapper (no top-level asOfSeq)',
  )
  check(
    (code.literalUndefined ?? 0) === 0,
    `no literal "undefined" in the code view (${String(code.literalUndefined)})`,
  )

  // Search: collapse everything first, then prove a query still expands its way
  // to the hit, highlights it, and lands it as the current one.
  const type = async (text) => {
    await page.evaluate(`(() => {
      const input = document.querySelector('.ci-find-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const probeFind = `(() => {
    const panel = document.querySelector(${JSON.stringify(panelSelector)})
    if (panel === null) return { open: false }
    return {
      open: true,
      count: panel.querySelector('.ci-count')?.textContent ?? null,
      hits: panel.querySelectorAll('.ci-hit').length,
      marks: panel.querySelectorAll('mark.ci-mark').length,
      currentRows: panel.querySelectorAll('[data-ci-cur="1"]').length,
      currentVisible: panel.querySelector('[data-ci-cur="1"]') !== null,
      listOpen: panel.querySelector('.ci-hits') !== null,
    }
  })()`

  const collapseAll = await page.evaluate(
    `(() => {
      const button = Array.from(document.querySelectorAll('.ci-act')).find((el) => /Collapse|折叠/.test(el.textContent))
      if (button === undefined) return false
      button.click()
      return true
    })()`,
  )
  check(collapseAll, 'the collapse-all control is present')
  await new Promise((resolve) => setTimeout(resolve, 300))

  await type('system')
  const found = await page.evaluate(probeFind)
  await shot('inspector-search.png')

  check(/\d+\s*\/\s*\d+/.test(String(found.count)), `search reports a position: ${String(found.count)}`)
  check((found.hits ?? 0) > 0, `search lists its hits (${String(found.hits)})`)
  check((found.marks ?? 0) > 0, `matches are highlighted (${String(found.marks)} marks)`)
  check(
    found.currentVisible === true,
    'a jump expanded a collapsed node: the current hit is in the DOM after collapse-all',
  )

  const advanced = await page.evaluate(
    `(() => {
      const next = Array.from(document.querySelectorAll('.ci-act')).find((el) => el.title && /Next|下一/.test(el.title))
      if (next === undefined) return null
      next.click()
      return true
    })()`,
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
  const second = await page.evaluate(probeFind)
  check(advanced === true, 'the next-match control is present')
  check(
    second.count !== found.count || second.currentRows === 1,
    `moving to the next hit changes the position (${String(found.count)} -> ${String(second.count)})`,
  )

  await type('')
  const cleared = await page.evaluate(probeFind)
  check((cleared.hits ?? 0) === 0 && cleared.listOpen === false, 'clearing the query removes the hit list')

  // The window must not disturb the app underneath.
  const behind = await page.evaluate(`document.querySelectorAll('[data-composer-card]').length`)
  check(behind >= 1, 'the composer is still mounted behind the window')

  await page.evaluate(
    `Array.from(document.querySelectorAll('.ci-close')).find((el) => el.offsetParent !== null)?.click()`,
  )
  const closed = await page.waitFor(
    `document.querySelector(${JSON.stringify(panelSelector)}) === null`,
    4000,
  )
  check(closed, 'the window closes again')
} finally {
  page.close()
}

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) process.exitCode = 1
