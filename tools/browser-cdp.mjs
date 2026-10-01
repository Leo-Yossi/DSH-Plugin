/**
 * Ad-hoc CDP control for the DSH Desktop window, for eyeballing anything the
 * automated runbook does not cover.
 *
 * Requires the app to have been started with the debugging switch:
 *
 *   & "D:\DSH-desktop\DeepSeek Harness.exe" --remote-debugging-port=9222
 *
 *   node tools/browser-cdp.mjs list
 *   node tools/browser-cdp.mjs shot .scratch/page.png
 *   node tools/browser-cdp.mjs text  ".ci-panel"
 *   node tools/browser-cdp.mjs eval  "document.title"
 *   node tools/browser-cdp.mjs click ".ci-btn"
 *   node tools/browser-cdp.mjs push  ".ci-btn"     # real pointer events
 *
 * Env: `CDP_PORT` (default 9222), `CDP_MATCH` (URL substring to require).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { attach, listTargets, DEFAULT_PORT } from './cdp.mjs'

const [command, argument] = process.argv.slice(2)

function usage() {
  console.log('usage: node tools/browser-cdp.mjs list|shot|text|eval|click|push [argument]')
}

if (command === 'list') {
  try {
    for (const target of await listTargets(DEFAULT_PORT)) {
      console.log(`${target.type}\t${target.title}\t${target.url}`)
    }
  } catch (error) {
    console.error(`browser-cdp: ${error.message}`)
    process.exit(2)
  }
} else if (command !== undefined) {
  const page = await attach({ match: process.env.CDP_MATCH })
  console.log(`attached: ${page.target.title} — ${page.target.url}`)
  try {
    if (command === 'shot') {
      const out = argument ?? '.scratch/page.png'
      await page.send('Page.enable')
      const result = await page.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      })
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, Buffer.from(result.data, 'base64'))
      console.log(`wrote ${out}`)
    } else if (command === 'text') {
      const selector = JSON.stringify(argument ?? 'body')
      console.log(
        await page.evaluate(
          `(() => { const el = document.querySelector(${selector}); return el === null ? '(no element)' : el.innerText })()`,
        ),
      )
    } else if (command === 'eval') {
      console.log(JSON.stringify(await page.evaluate(argument ?? 'null'), undefined, 2))
    } else if (command === 'click') {
      const selector = JSON.stringify(argument)
      console.log(
        await page.evaluate(
          `(() => { const el = document.querySelector(${selector}); if (el === null) return 'no element'; el.click(); return 'clicked' })()`,
        ),
      )
    } else if (command === 'push') {
      const selector = JSON.stringify(argument)
      const box = await page.evaluate(
        `(() => { const el = document.querySelector(${selector}); if (el === null) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
      )
      if (box === null) throw new Error(`no element for ${String(argument)}`)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await page.send('Input.dispatchMouseEvent', {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1,
        })
      }
      console.log(`pushed ${String(argument)} at ${String(box.x)},${String(box.y)}`)
    } else {
      usage()
    }
  } finally {
    page.close()
  }
} else {
  usage()
}
