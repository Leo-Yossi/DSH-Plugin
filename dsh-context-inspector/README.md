---
description: "Read the context a Session actually sends: a composer button opens a window over the exact outgoing request payload, in a code view and a field view grouped by source."
kind: "package-reference"
---

# @local/dsh-context-inspector

English | [中文](README.zh.md)

## Summary

A composer button opens a window showing **the payload this Session hands to the model** — every field, not just `messages` — in two views:

- **Code view** — the request object rendered as a JSON tree, field for field.
- **Field view** — the same fields broken out, grouped and colour-coded by the source that produced them.

Both views fold and unfold like an IDE; long content starts collapsed. `system prompt`, `tool` and `hook` are three of thirteen classified sources, and adding a source later is one table entry.

The Host half reconstructs the payload from the Session log as the `contextPayload` Session projection; the browser half registers a button into `conversation.input.right` and the window into `shell.overlay`. Nothing is appended to any Session, and the plugin makes no model calls.

## Usage

1. Open a Session and send at least one message.
2. Click the **Sent context** button in the composer tool row, beside Send.
3. Switch between **Fields** and **Code**; click any row to fold or unfold it; use **Expand all** / **Collapse all** / **Reset folds**.
4. Type in the find bar to locate and jump to any content — see [Search](#search).

## Search

The find bar sits under the toolbar. Typing filters and jumps in one gesture: matches highlight in place, and the list under the bar shows what was found and where.

- **Both views.** The field view indexes the field overview rows, every record row, and every record body. The code view indexes the payload tree plus the harness-side tree it renders below it — and indexes that second tree only while it is actually on screen, so a hit can never point at an anchor that does not exist.
- **Jumping, not just listing.** `↑` / `↓`, `Enter` / `Shift+Enter`, or a click on any result row moves to that hit and scrolls it to the middle of the window.
- **A collapsed node opens itself.** The index walks the *data*, not the DOM, so a match buried in a collapsed node is still found. Every hit carries the chain of fold ids that contains it, and a jump forces exactly those open through the same `useFolds` table a manual click uses. Because an explicit `true` outranks the "collapse all" mode, a jump still reveals its hit after collapsing everything.
- **Matching** is case-insensitive literal substring, deliberately not a regular expression: the payload is full of `(`, `[`, `\` and `*`, and a half-typed pattern must never throw. A long string is searchable both as its quoted tree row and as its raw body.
- **Escape** clears the box while it has text; an empty box (or a second Escape) closes the window.

The pure half of this — `matchText`, `highlightText`, `collectValueHits`, `collectCodeHits`, `collectFieldHits`, `attrEscape` — is exported as `internals` on the module, the same convention `dsh-web-app` uses, so the offline test can exercise the index without a DOM. Hits are plain records, `{ id, openIds, path, label, preview, kind, origin? }`, and the only contract a view has to keep is that every rendered node carries `data-ci-id` equal to its fold id.

## What is read, and where it comes from

`dsh-agent-loop`'s `buildRequest()` freezes one object and passes it to `llm.stream()`:

```js
markAgentLoopRequest(Object.freeze({
  ...header.config,           // provider, model, reasoningEffort?, temperature?, maxTokens?, stop?
  messages: boundaryMessages, // session.deriveMessages()
  toolHistory: session.toolHistory(),
  ...header.tools !== void 0 ? { tools: header.tools } : {},
  sessionId: this.session.id,
  signal
}))
```

Every part of that object is recoverable from the durable log, and the loop package's own invariant (`dsh-agent-loop/invariant.js`) asserts that the live request equals the fold of the logged events:

| Payload field | Log source | Fold |
|---|---|---|
| `provider`, `model`, `reasoningEffort`, `temperature`, `maxTokens`, `stop` | `request/header` → `header.config` | latest snapshot wins (`dsh-session/request-header.js`) |
| `tools` | `request/header` → `header.tools` | same snapshot; empty list is omitted, as `canonicalHeader` does |
| `messages` | `system/message`, `developer/message`, `user/message`, `assistant/message`, `tool/result` | surface order, positional `surfaceOp` replacements applied, empty-content system/developer/assistant nodes dropped (`deriveEventMessage`) |
| `toolHistory` | `request/header` + `developer/message` | a port of `ToolHistoryProjection`, including the series baseline and the declared/available reconciliation |
| `sessionId` | the Session being rendered | filled in by the browser, which knows it |
| `signal` | — | a live `AbortSignal`; shown as a marker |

Beyond the payload, the window also shows what the harness recorded around it:

| Source | Log event | Sent to the model? |
|---|---|---|
| Request envelope | `request/header` | yes |
| Tool schemas | `request/header.tools` | yes |
| System prompt | `system/message` | yes, as `messages[0]` |
| User / injected / assistant / developer messages | the matching surface event | yes |
| Tool calls | `tool-call` blocks inside `assistant/message`, titled by `tool/call` | yes |
| Tool results | `tool/result` | yes |
| Routing metadata | `request/context` | no — adapter routing facts |
| Hooks | `hook/invoked`, `hook/result` | no — harness interception |
| Lifecycle | `turn/start`, `step/start`, `compaction/*` | no — boundaries |

### Two honest limits, shown in the window

1. **`GenerateOptions.system` is always `undefined`.** The loop never sets it; the rendered prompt travels as a `role: 'system'` message. The window marks `system` as an absent field and says why instead of inventing a value.
2. **This is the logical payload, not the wire body.** `dsh-llm`'s `adapterStream()` may still project it on the way out — file references to text, images to text on text-only routes, tool-schema rewriting for `modelInfo.toolUpdate` — and compaction/session-title sub-requests carry `purpose` without passing through this fold at all.

## Source classification, and how to extend it

The Host emits a stable `origin` id on every record; the browser owns the single presentation table `ORIGINS` in `client.js` (glyph, colour token, order, and whether the source is sent). An unknown id falls back to a neutral style, so a Host that emits a new source before the browser knows it still renders.

To add a source:

1. Emit its id from `originForSurface()` / a new branch in `applyEvent()` in `index.js`.
2. Add one entry to `ORIGINS` in `client.js` with four `origin.<id>` dictionary keys (label, description, and the `en`/`zh` pair).

Nothing else changes. The test asserts that every origin and kind the Host can emit has an `en` and a `zh` string.

## Files

| File | Role |
|---|---|
| [`index.js`](index.js) | Host half: the `contextPayload` Session projection and its log fold |
| [`client.js`](client.js) | Browser half: the module factory, the composer button, the window, both views, styles, dictionaries |
| [`cordis.patch.yml`](cordis.patch.yml) | Bundle layer: one row whose exact bare package specifier also lets `dsh-client-modules` find the browser bundle |
| [`package.json`](package.json) | `dsh.bundle.patch` + `dsh.client` (`platform: web`, `immediately`, package-order `inject`) |
| [`locale/`](locale) | Plugin Manager display metadata (`meta.title` / `meta.description`) |
| [`test/smoke.mjs`](test/smoke.mjs) | Offline checks for the fold and the client wiring |

### Why a Session projection

The shipped `cordis-plugin-development` skill (`references/practices.md`) says per-Session state derived from the log belongs in a `ctx.sessionProjections` unit, and "when the Client needs a value derived from a session, declare `wire.view` on the Host projection — the value reaches the Client already computed; the Client does not fold session events itself." That is exactly what this plugin does. The unit folds committed events synchronously, returns the same state reference for events it ignores, and memoizes its view per state, which is what keeps the registry's `Object.is` publication gate honest.

`stateVersion` is `1`; bump it whenever the state fields or fold semantics change so a stale persisted checkpoint is discarded rather than reinterpreted. Projection state is JSON-plain by contract, because the projection cache checkpoints it.

The registry transports whole values, so the window's data is republished whenever the Session commits an event. That is the price of the supported `wire.view` channel, and it is why the view carries the payload once and lets records reference it by path instead of duplicating message bodies.

**Every state and view value must be lossless JSON.** The projection value travels as a Remote argument inside a `SessionSummary`, and `isRemoteJsonValue` (in `dsh-typert-protocol`) refuses a nested `undefined` — `undefined` is not JSON, and `JSON.stringify` would silently drop the key. One nested `undefined` makes the Host refuse the forwarded `api-session/added` event, and **every new Session then fails to create** while the plugin is enabled. That is not hypothetical: an unrouted Session once produced `payload.provider = undefined`, and only Sessions without a `request/header` failed — which is exactly the new-Session path. Spread optional fields conditionally instead of assigning `undefined`, and let the offline test's mirrored `isRemoteJsonValue` guard catch it: the empty-state view is a required case, not an edge case.

### A rebuilt file is not a reloaded module

Replacing an installed copy of this package does **not** change what a running Host executes. The Loader imports the row's `file://` URL, and Node's ES module map is keyed by URL for the process lifetime, so re-importing the same path returns the cached instance. Uninstall and reinstall is therefore not enough — the process has to restart to load a fresh module generation.

### Why the bundle imports no Harness Client package

The same practices reference forbids `require('@deepseek-ai/dsh-client-ui-primitives')` and every other Harness Client package from an authored plugin: they change without notice and a throwing component blanks the slot entry. React therefore comes from the browser module table, every control is written here, and all colour comes from the `Theme.listTokens` tokens — `--dsw-alias-bg-overlay`, `--dsw-alias-label-primary`, `--dsw-alias-border-l1`, `--dsw-alias-state-success-primary` and friends — with `color-mix()` deriving the per-source tints. `dsh.client.inject` only orders package arrival and injects no code.

### Why two slot entries and one module-level store

`conversation.input.right` is Session-scoped and carries `useProjection`; `shell.overlay` is root-scoped and is the documented additive seat for a frame-wide surface. The button is the only registration that can read the projection, so it publishes the projection value — the whole wire view, `{ payload, fields, omitted, records, hooks, marks, stats }` — into a small observable store that the window subscribes to with `useSyncExternalStore`. The payload the model receives is `view.payload`, and every record's `path` is a JSON pointer into that object; the window never resolves a path against the view. No DOM is written outside a component and nothing is portalled to `document.body` (also required by the practices reference). Leaving the Session closes the window.

### Relationship to the shipped Trajectory view

`dsh-client-ui-trajectory` was read first, and it is the closest existing thing to this plugin. What it does: it is a pure-consumer client plugin (`lib/index.js` is an empty `apply`) that registers **event Definitions** into `ctx.uiConversation.events.register(...)` for a `trajectory` target, registers a snapshot builder in `ctx.uiConversation.views`, renders as a `conversation.view` tab, and reads the request envelope by matching `request/header` and the prompt through the shared `ctx.uiConversation.inspectSystemPrompt` / `inspectRequestPrompt` services. Its System Prompt / Tools / Options inspector is the nearest neighbour of this window.

Reused:

- The same provenance decision: the Session log is the only source of truth, and the request is a pure function of it.
- The same reading of `request/header` as the canonical envelope (latest snapshot wins), and of the surface events as the message list.
- The same slot-registration conventions (`ctx.slots.inject` + `ctx.slots.register`, an id, an order, a `locale` namespace), and the same refusal to import Harness Client packages.

Deliberately not reused, and why:

- **Trajectory folds on the browser; this folds on the Host.** The shipped practices reference asks for `wire.view` on a Host projection whenever the Client needs a session-derived value, and says the Client should not fold session events itself. Folding on the Host also avoids the client window's paging limits: the projection drives over the complete committed log, so a message the browser has not paged in yet is still counted.
- **Trajectory is a View tab; this is a button plus a frame-wide window.** The requested entry point is a control in the send UI, and the requested surface is a popup, which `shell.overlay` owns. A `conversation.view` tab would have competed with Chat and Trajectory for the transcript seat instead of opening over it.
- **Trajectory renders a ledger of activity; this renders the outgoing request.** Here `hook/invoked` and `hook/result` are shown, but explicitly in a *harness-side, not sent* section, because they never reach the model.

## Install

This plugin ships inside a repository that is itself a DSH bundle, so the usual install is one
spec — see the [repository README](../README.md) for the mechanics.

**From the DSH Desktop GUI:** sidebar → **Plugins** → **Add plugin**:

```
github:Leo-Yossi/DSH-Plugin
```

(A bare `owner/repo` is refused by the field's parser — it reads as an npm package name. Use the
`github:` prefix, or `https://github.com/Leo-Yossi/DSH-Plugin`.)

**From the `plugin_manager` tool** (same spec):

```
install_bundle(target: "github:Leo-Yossi/DSH-Plugin")
```

**From this directory, for development:**

```powershell
# the absolute package directory as target
install_bundle(target: "<path to this repo>\dsh-context-inspector")
```

`install_bundle` runs `pnpm add <spec>` in the profile, appends the bundle to `dsh.profile.bundles`,
and applies it. Do not edit the profile's `package.json` or `cordis.patch.yml` by hand.

Install **one of the two, not both**: the repository install and the directory install produce two
Loader rows for the same package name, which `dsh-client-modules` refuses with *"resolves from
multiple active Loader sources"*. The directory install links rather than copies, so `index.js` and
`client.js` edits are live — that is the one to use while working on it; the repository install is
for other machines and clean setups. Neither needs a runtime dependency, so both install offline
apart from fetching the repository.

## Test

```powershell
node test/smoke.mjs
```

241 checks, all offline: the fold against a synthetic log (including positional surface replacement, the empty-content system drop, the tool-history series, the ignored-event reference gate, and view memoization), the wire contract (every record `path` must resolve inside `view.payload`, and the payload must not sit at the top level of the view), the search index (case-insensitive matching, a hit found inside a collapsed subtree carries the whole ancestor chain, a long string anchors on its expandable row, a field-view body hit opens its group and record, and no hit is reported twice), plus the client wiring and a cross-check that every origin and kind has `en` and `zh` copy.

## Verification status

Verified on the live Desktop profile:

- `plugin_manager install_bundle` → `application: applied`, no warnings; `list_bundles` lists the bundle enabled and `installed: true` with row `context-inspector`.
- The Host row is live: `Config.listConfigs` reports `status: "absent"`, which `dsh-tool-cordis`'s projector emits only when the entry's fiber exists, is not disabled, and simply exports no `Config` schema — i.e. `apply()` ran without throwing.
- Both browser entries are live: `Slots.listSubTree` shows `context-inspector-button` in `conversation.input.right` and `context-inspector-panel` in `shell.overlay`, both `active: true`.
- `node test/smoke.mjs` passes 241/241.

**Not verified:** the rendered appearance. No browser control is available in this environment, so the visual result — spacing, the light/dark token rendering, the JSON tree's fold behaviour, and the window's placement over the composer — has not been observed.
