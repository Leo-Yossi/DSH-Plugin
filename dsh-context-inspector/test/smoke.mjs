/**
 * Offline smoke test for `@local/dsh-context-inspector`.
 *
 * It checks the two things that can be checked without a browser:
 *
 * 1. The Host fold reconstructs the payload from a synthetic Session log —
 *    including the surface replacement path, the empty-content system drop, and
 *    the change gate that keeps ignored events free.
 * 2. The Client bundle registers the locale dictionary and both slot entries,
 *    and every `origin.*` / `kind.*` key the Host can emit exists in both
 *    dictionaries.
 *
 * Run: `node test/smoke.mjs`
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
let checks = 0

function ok(condition, label, detail) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`FAIL  ${label}${detail === undefined ? '' : `\n      ${detail}`}`)
}

function eq(actual, expected, label) {
  ok(
    actual === expected,
    label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  )
}

//#region host half

const host = await import(pathToFileURL(join(root, 'index.js')).href)

eq(host.name, 'context-inspector', 'host: plugin name')
ok(Array.isArray(host.inject) && host.inject.includes('sessionProjections'), 'host: injects sessionProjections')

let definition
const ctx = {
  sessionProjections: {
    register(value) {
      definition = value
      return () => {}
    },
  },
}
host.apply(ctx)
ok(definition !== undefined, 'host: registers a projection unit')
eq(definition.key, 'contextPayload', 'host: projection key')

const TOOL_A = { name: 'read', description: 'Read a file', parameters: { type: 'object' } }
const TOOL_B = { name: 'grep', description: 'Search', parameters: { type: 'object' } }

function event(seq, type, data, extra) {
  return Object.assign({ seq, time: 1000 + seq, type, data }, extra)
}

let state = definition.init(undefined, 0)
const drive = (ev) => {
  state = definition.apply(state, ev)
  return state
}

const ignored = drive(event(0, 'turn/start', { turn: 1 }))
ok(ignored !== undefined, 'host: empty state advances')

const beforeIgnored = state
state = definition.apply(state, event(99, 'session/title', { title: 'x' }))
ok(state === beforeIgnored, 'host: an ignored event returns the same state reference')

drive(
  event(1, 'request/header', {
    header: {
      config: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 8000 },
      tools: [TOOL_A, TOOL_B],
    },
    reason: 'initial',
    startsSeries: true,
  }),
)
drive(event(2, 'system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are DSH.' }] } }))
drive(
  event(3, 'user/message', {
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }),
)
drive(
  event(4, 'assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'a1',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }],
    },
  }),
)
drive(event(5, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }))
drive(
  event(6, 'tool/result', {
    turn: 1,
    step: 1,
    message: { id: 't1', role: 'tool', callId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false },
  }),
)
drive(event(7, 'hook/invoked', { turn: 1, point: 'PreToolUse', dialect: 'claude-code', handlerId: 'h1' }))
drive(event(8, 'hook/result', { turn: 1, point: 'PreToolUse', handlerId: 'h1', decision: 'pass', durationMs: 12 }))
drive(event(9, 'request/context', { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 65536 }))
drive(event(10, 'step/start', { turn: 1, step: 1 }))
// An empty system/message is how the loop records "the prompt is now empty":
// it must contribute no message but must still appear as a record.
drive(event(11, 'system/message', { turn: 1, step: 1, message: { role: 'system', content: [] } }))

let view = definition.wire.view(state)
const payload = view.payload

eq(payload.provider, 'deepseek', 'payload: provider')
eq(payload.model, 'deepseek-chat', 'payload: model')
eq(payload.maxTokens, 8000, 'payload: maxTokens')
ok(!('temperature' in payload), 'payload: absent optional field stays absent')
eq(payload.messages.length, 4, 'payload: one message per emitting surface event')
eq(payload.messages[0].role, 'system', 'payload: system prompt is messages[0]')
eq(payload.messages[1].source.kind, 'user', 'payload: user message keeps its source')
eq(payload.tools.length, 2, 'payload: tools carried from the header')
eq(payload.toolHistory.tools.length, 2, 'payload: tool history tools')
eq(payload.toolHistory.updates.length, 0, 'payload: no tool updates yet')
eq(payload.sessionId, null, 'payload: sessionId left to the browser to fill')
ok('signal' in payload, 'payload: signal marked')
ok(!('system' in payload), 'payload: GenerateOptions.system is absent')

// The empty system node produced a record but no message.
const emptyRecord = view.records.find((record) => record.seq === 11)
ok(emptyRecord !== undefined, 'records: empty system node is still recorded')
ok(emptyRecord.note !== undefined, 'records: empty system node is annotated as not sent')

// Every origin the Host emits must be localizable by the browser.
const origins = new Set(view.records.map((record) => record.origin))
const kinds = new Set(view.records.map((record) => record.kind))
for (const expected of ['envelope', 'tools', 'system', 'user', 'assistant', 'tool-call', 'tool-result', 'hooks', 'routing', 'lifecycle']) {
  ok(origins.has(expected), `records: origin ${expected} present`)
}
ok(kinds.has('tool-schema'), 'records: tool schemas recorded')
ok(kinds.has('tool-call'), 'records: tool calls recorded')
ok(kinds.has('hook-result'), 'records: hook results recorded')

eq(view.stats.tools, 2, 'stats: tools')
eq(view.stats.messages, 4, 'stats: messages')
eq(view.stats.hooks, 2, 'stats: hooks')
eq(view.stats.systemChars, 12, 'stats: effective system prompt characters')
ok(view.stats.systemChars > 0, 'stats: a surviving non-empty prompt measures its characters')

// Tool-call records point into the payload rather than duplicating it.
const callRecord = view.records.find((record) => record.kind === 'tool-call')
ok(callRecord !== undefined && typeof callRecord.path === 'string', 'records: tool call resolves by path')

// A developer tool-addition must feed the tool-history fold.
let state2 = state
state2 = definition.apply(
  state2,
  event(12, 'request/header', {
    header: {
      config: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 8000 },
      tools: [TOOL_A],
    },
    reason: 'change',
  }),
)
eq(definition.wire.view(state2).payload.tools.length, 1, 'tool change: header drops a tool')

// A surface replacement of the user message must replace, not append.
let state3 = state
state3 = definition.apply(
  state3,
  event(13, 'user/message', {
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text: 'hi (edited)' }],
    source: { kind: 'user' },
  }, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3] }),
)
const replaced = definition.wire.view(state3)
eq(replaced.payload.messages.length, 4, 'replacement: message count unchanged')
eq(
  replaced.payload.messages[1].content[0].text,
  'hi (edited)',
  'replacement: the replaced message wins',
)

// Clearing the prompt is an empty-content replacement over the live node.
let state4 = state
state4 = definition.apply(
  state4,
  event(14, 'system/message', { turn: 1, step: 1, message: { role: 'system', content: [] } }, {
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
    sourceEventSeqs: [2],
  }),
)
const cleared = definition.wire.view(state4)
eq(cleared.stats.systemChars, 0, 'cleared prompt: effective characters drop to zero')
eq(cleared.stats.messages, 3, 'cleared prompt: the cleared system message leaves the list')
eq(cleared.payload.messages[0].role, 'user', 'cleared prompt: the next message takes its place')

// The view is memoized per state, which is what keeps the registry's
// Object.is publication gate honest.
ok(definition.wire.view(state3) === replaced, 'view: memoized per state')

// Records point into `payload` by path, and the browser resolves them against
// `view.payload` — never against the view itself. Every path must resolve, and
// the two that a reader checks first must land on real values.
const resolvePath = (root, path) => {
  if (typeof path !== 'string' || path === '' || path === '/') return root
  let cursor = root
  for (const raw of path.split('/')) {
    if (raw === '') continue
    if (cursor === null || cursor === undefined) return undefined
    cursor = cursor[raw]
  }
  return cursor
}
ok(replaced.payload !== undefined && typeof replaced.payload === 'object', 'wire: view.payload is the payload object')
ok(Array.isArray(replaced.records), 'wire: view.records is a list')
ok(!Object.hasOwn(replaced, 'messages'), 'wire: the message list lives under payload, not at the top level')
for (const record of replaced.records) {
  if (record.path === undefined) continue
  ok(
    resolvePath(replaced.payload, record.path) !== undefined,
    `wire: record path ${record.path} resolves inside view.payload`,
  )
}
ok(
  resolvePath(replaced.payload, '/messages/0') !== undefined,
  'wire: /messages/0 resolves inside view.payload',
)
ok(
  resolvePath(replaced.payload, '/tools/0') !== undefined,
  'wire: /tools/0 resolves inside view.payload',
)

//#endregion

//#region lossless JSON

/**
 * Mirrors `isRemoteJsonValue` from `@deepseek-ai/dsh-typert-protocol`, which
 * guards every Remote carrier. Refused: a nested `undefined`, a non-finite
 * number, `-0`, a non-plain object, a symbol key, a sparse array and a cycle.
 *
 * This exists because a projection value travels as a Remote argument inside a
 * `SessionSummary`: one nested `undefined` makes the Host refuse
 * `api-session/added` and **new Session creation fails**. The empty-state case
 * below is exactly the shape that did it.
 * @param value - candidate.
 * @param path - diagnostic path of the value.
 * @param ancestors - cycle detection.
 * @returns the first offending path, or undefined when the value is lossless.
 */
function losslessFault(value, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? undefined
      : `${path}: ${Object.is(value, -0) ? '-0' : 'non-finite number'}`
  }
  if (typeof value !== 'object') return `${path}: ${typeof value}`
  if (ancestors.has(value)) return `${path}: cycle`
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return `${path}: non-array prototype`
      if (Reflect.ownKeys(value).length !== value.length + 1) return `${path}: sparse or extra keys`
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) return `${path}[${index}]: hole`
        const fault = losslessFault(value[index], `${path}[${index}]`, ancestors)
        if (fault !== undefined) return fault
      }
      return undefined
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return `${path}: non-plain object`
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return `${path}: symbol key`
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true) return `${path}.${key}: non-enumerable`
      const fault = losslessFault(Reflect.get(value, key), `${path}.${key}`, ancestors)
      if (fault !== undefined) return fault
    }
    return undefined
  } finally {
    ancestors.delete(value)
  }
}

// The checker must be able to fail, or every assertion below is worthless.
ok(
  losslessFault({ provider: undefined }) !== undefined,
  'lossless: the checker rejects a nested undefined (the exact production bug)',
)
ok(losslessFault({ ok: [1, 'a', null, true] }) === undefined, 'lossless: the checker accepts plain JSON')

const emptyState = definition.init(undefined, 0)
ok(
  losslessFault(emptyState) === undefined,
  `lossless: an empty fold state (${String(losslessFault(emptyState))})`,
)
const emptyView = definition.wire.view(emptyState)
const emptyFault = losslessFault(emptyView)
ok(
  emptyFault === undefined,
  'lossless: the view of a Session with no request yet — the case that broke session creation',
  String(emptyFault),
)
ok(
  !Object.hasOwn(emptyView.payload, 'provider') && !Object.hasOwn(emptyView.payload, 'model'),
  'lossless: an unrouted Session omits the route keys instead of setting them to undefined',
)
ok(
  losslessFault(state) === undefined,
  `lossless: a populated fold state is checkpointable (${String(losslessFault(state))})`,
)
ok(
  losslessFault(view) === undefined,
  `lossless: a populated view crosses the Remote carrier (${String(losslessFault(view))})`,
)
ok(
  losslessFault(replaced) === undefined,
  `lossless: a replaced-surface view crosses the Remote carrier (${String(losslessFault(replaced))})`,
)
// A session that logged events but has not built a request yet is the other
// half of the empty case: a header exists but is null.
const halfState = definition.apply(definition.init(undefined, 0), event(1, 'turn/start', { turn: 1 }))
ok(
  losslessFault(definition.wire.view(halfState)) === undefined,
  'lossless: a view with events but no request header',
)

//#endregion

//#region client half

const clientSource = readFileSync(join(root, 'client.js'), 'utf8')
let registration
const windowStub = { __ModuleLoader__: { load(value) { registration = value } } }
new Function('window', clientSource)(windowStub)

ok(registration !== undefined, 'client: registers a module factory')
eq(registration.id, '@local/dsh-context-inspector', 'client: bundle id equals the package name')
eq(typeof registration.factory, 'function', 'client: factory is a function')

const ReactStub = { createElement: () => null }
const plugin = registration.factory((specifier) => {
  ok(specifier === 'react', `client: only baseline require() calls (saw ${JSON.stringify(specifier)})`)
  return ReactStub
})

ok(Array.isArray(plugin.inject), 'client: exports inject')
eq(plugin.inject.join(','), 'slots,locale', 'client: injects slots and locale')
eq(typeof plugin.apply, 'function', 'client: exports apply')

const registrations = []
const injections = []
let dictionaries
const clientCtx = {
  effect(fn, label) {
    ok(typeof label === 'string' && label.length > 0, 'client: locale effect is labelled')
    return fn()
  },
  locale: {
    register(ns, dicts) {
      eq(ns, '@local/dsh-context-inspector', 'client: locale namespace')
      dictionaries = dicts
      return () => {}
    },
  },
  slots: {
    inject(key, callback) {
      injections.push(key)
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
plugin.apply(clientCtx)

eq(injections.join(','), 'conversation.input.right,shell.overlay', 'client: contributes to both slots')
eq(registrations.length, 2, 'client: two slot entries')
for (const entry of registrations) {
  eq(entry.options.name, entry.options.name === 'shell.overlay' ? 'shell.overlay' : 'conversation.input.right', 'client: entry targets its slot')
  eq(entry.options.locale, '@local/dsh-context-inspector', 'client: entry declares the locale namespace')
  ok(typeof entry.options.id === 'string' && entry.options.id.length > 0, 'client: entry has an id')
  ok(typeof entry.options.order === 'number', 'client: entry has an order')
  eq(typeof entry.component, 'function', 'client: entry has a component')
}
ok(
  registrations.some((entry) => entry.options.id === 'context-inspector-button'),
  'client: the composer button is registered',
)
ok(
  registrations.some((entry) => entry.options.id === 'context-inspector-panel'),
  'client: the overlay window is registered',
)

ok(dictionaries !== undefined, 'client: registers a dictionary')
const enKeys = Object.keys(dictionaries.en)
const zhKeys = Object.keys(dictionaries.zh)
eq(enKeys.length, zhKeys.length, 'locale: en and zh have the same key count')
for (const key of enKeys) ok(zhKeys.includes(key), `locale: zh covers ${key}`)

for (const origin of origins) {
  ok(enKeys.includes(`origin.${origin}`), `locale: en names origin ${origin}`)
  ok(zhKeys.includes(`origin.${origin}`), `locale: zh names origin ${origin}`)
  ok(enKeys.includes(`origin.${origin}.desc`), `locale: en describes origin ${origin}`)
}
for (const kind of kinds) {
  ok(enKeys.includes(`kind.${kind}`), `locale: en names kind ${kind}`)
  ok(zhKeys.includes(`kind.${kind}`), `locale: zh names kind ${kind}`)
}
for (const reason of view.omitted.map((entry) => entry.reason)) {
  ok(enKeys.includes(`omitted.${reason}`), `locale: en explains omission ${reason}`)
  ok(zhKeys.includes(`omitted.${reason}`), `locale: zh explains omission ${reason}`)
}

//#endregion

//#region search

const internals = plugin.internals
ok(internals !== undefined, 'search: the pure helpers are exposed for the offline test')

if (internals !== undefined) {
  ok(internals.matchText('DeepSeek', 'deep') === true, 'search: matching ignores case')
  ok(internals.matchText('deepseek', '') === false, 'search: an empty query matches nothing')
  ok(internals.matchText(undefined, 'x') === false, 'search: a missing value matches nothing')

  const codeHits = internals.collectCodeHits(replaced.payload, 'deepseek')
  ok(codeHits.length >= 2, `search: the code view finds provider and model (${String(codeHits.length)})`)
  ok(
    codeHits.every((hit) => typeof hit.id === 'string' && Array.isArray(hit.openIds)),
    'search: every code hit carries an anchor id and an ancestor chain',
  )
  // This is the invariant that makes a jump able to expand: every id the chain
  // opens is an ancestor of (or equal to) the anchor it scrolls to.
  ok(
    codeHits.every((hit) =>
      hit.openIds.every((id) => hit.id === id || hit.id.startsWith(id === '' ? '' : id + '/')),
    ),
    'search: each ancestor id is a prefix of the anchor it opens',
  )

  // A hit buried inside a collapsed message must still be found, with the whole
  // chain needed to reveal it.
  const buried = internals
    .collectCodeHits(replaced.payload, 'ok')
    .find((hit) => /^\/messages\/\d+\/content\/0\/text$/.test(hit.id))
  ok(buried !== undefined, 'search: a hit inside a collapsed message is still found')
  if (buried !== undefined) {
    const owner = buried.id.slice(0, buried.id.indexOf('/content/'))
    ok(buried.openIds.includes('/messages'), 'search: the chain opens the enclosing array')
    ok(buried.openIds.includes(owner), `search: the chain opens the enclosing message (${owner})`)
    ok(
      buried.openIds.length >= 3,
      `search: the chain reaches the leaf (${buried.openIds.join(' , ')})`,
    )
  }

  // A long string renders as its own expandable row, so its anchor is that row
  // and the chain has to open it for the body to become visible.
  const long = internals.collectValueHits({ note: 'x'.repeat(200) }, 'xxx', '', undefined)
  ok(
    long.length === 1 && long[0].id === '/note#text' && long[0].openIds.includes('/note#text'),
    `search: a long string anchors on its expandable row (${JSON.stringify(long.map((hit) => hit.id))})`,
  )

  const identity = (key) => key
  const fieldHits = internals.collectFieldHits(replaced, replaced.payload, 'hook', 'session-1', identity)
  ok(fieldHits.length > 0, 'search: the field view finds the hook records')
  ok(
    fieldHits.some((hit) => hit.origin === 'hooks' && hit.openIds.includes('grp-hooks')),
    'search: a hook hit opens its source group',
  )
  const bodyHit = fieldHits.find((hit) => hit.id.startsWith('rec-') && hit.id.includes('/'))
  ok(bodyHit !== undefined, 'search: the field view reaches inside a record body')
  if (bodyHit !== undefined) {
    ok(
      bodyHit.openIds.includes('grp-hooks') && bodyHit.openIds.some((id) => id.startsWith('rec-')),
      `search: a body hit opens its group and its record row (${bodyHit.openIds.join(' , ')})`,
    )
  }

  // Search must not double-count the record row and its body root, which share
  // one fold id in the field view.
  const seen = new Set()
  let duplicated = false
  for (const hit of fieldHits) {
    if (seen.has(hit.id)) duplicated = true
    seen.add(hit.id)
  }
  ok(!duplicated, 'search: no hit id is reported twice in the field view')

  ok(internals.collectCodeHits(replaced.payload, '').length === 0, 'search: an empty query builds no index')

  // The code view also renders the harness tree, which lives outside the
  // payload, so the index has to reach it — but only when that section renders.
  const withHarness = internals.collectCodeHits(replaced.payload, 'hook', {
    hooks: replaced.hooks,
    marks: replaced.marks,
  })
  ok(
    withHarness.some((hit) => hit.id.startsWith('/harness/')),
    'search: the code view reaches the harness section it renders',
  )
  ok(
    internals
      .collectCodeHits(replaced.payload, 'hook')
      .every((hit) => !hit.id.startsWith('/harness')),
    'search: with no harness tree, no hit points outside the payload',
  )

  ok(
    internals.attrEscape('a"b\\c') === 'a\\"b\\\\c',
    'search: an anchor id is escaped for the attribute selector',
  )
}

//#endregion

//#region window ownership and the click-through backdrop

// One Session can be mounted in the main conversation and in a right-sidebar
// chat tab at the same time; each renders its own button. Only the occurrence
// that was clicked may look open, or the two panes mirror each other.
if (internals !== undefined) {
  const owns = internals.occurrenceOwns
  ok(
    typeof owns === 'function',
    'occurrence: the ownership rule is exposed for the offline test',
  )
  ok(owns({ open: true, owner: 'occ1' }, 'occ1') === true, 'occurrence: the pane that opened it owns the window')
  ok(
    owns({ open: true, owner: 'occ1' }, 'occ2') === false,
    'occurrence: a second pane showing the same Session does not mirror the first',
  )
  ok(owns({ open: false, owner: 'occ1' }, 'occ1') === false, 'occurrence: a closed window is owned by nobody')
  ok(
    owns({ open: true, owner: undefined }, 'occ1') === false,
    'occurrence: a window with no recorded owner is owned by nobody',
  )
}

// `shell.overlay` is a click-through layer whose occupants opt back into
// pointer events. A blocking full-screen scrim swallows clicks meant for the
// app underneath — on Windows its title-bar controls live in the page at the
// top right — so the backdrop must stay `none` and only the panel takes input.
ok(
  /\.ci-scrim\{[^}]*pointer-events:none/.test(clientSource),
  'backdrop: the scrim is click-through so the app underneath keeps its own buttons',
)
ok(
  /\.ci-panel\{[^}]*pointer-events:auto/.test(clientSource),
  'backdrop: the panel itself opts back into pointer events',
)
ok(
  !/className: 'ci-scrim',[\s\S]{0,200}?onMouseDown/.test(clientSource),
  'backdrop: the click-through scrim carries no click handler that could dismiss or swallow',
)

//#endregion

console.log(`${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) {
  console.error(`${String(failures)} check(s) failed`)
  process.exitCode = 1
}
