# DSH Plugin

Plugins for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web GUI.

Each plugin lives in its own sub-project directory, is self-contained, and is installed into a
DSH profile with the `plugin_manager` tool. Nothing here is published to npm; every plugin is
installed from its directory.

## Sub-projects

| Sub-project | What it does |
|---|---|
| [`dsh-context-inspector/`](dsh-context-inspector/) | Adds a button to the composer that opens a window showing **the exact payload the Session sends to the model** — every field, not just `messages` — in a code view and a field view grouped by source, with fold/expand and search. |

## Install a sub-project

Every sub-project is a DSH *bundle*: its `package.json` declares both `dsh.bundle.patch` (the
loader row) and, where it has a browser half, `dsh.client`. Install it by pointing
`plugin_manager` at the directory:

```
plugin_manager(action: "install_bundle", target: "<absolute path to this repo>/dsh-context-inspector")
```

`install_bundle` runs `pnpm add <dir>` inside the profile, appends the bundle to
`dsh.profile.bundles`, and applies it. Do not hand-edit the profile's `package.json` or
`cordis.patch.yml`: the manager performs those writes, and each hand-made edit needs its own
approval.

Because the install is a link rather than a copy, editing a plugin's `index.js` or `client.js` in
place changes what the running profile serves.

Removing one:

```
plugin_manager(action: "remove_bundle", target: "@local/dsh-context-inspector")
```

## Layout

```
.
├── dsh-context-inspector/   # sub-project: the plugin (manifest, host half, browser half, tests)
└── tools/                   # development tooling shared by the sub-projects
    ├── cdp.mjs                    # minimal Chrome DevTools Protocol client (no dependencies)
    ├── browser-cdp.mjs            # ad-hoc CLI: list / shot / text / eval / click / push
    ├── verify-context-inspector.mjs  # one-command visual runbook for the inspector
    └── asar-cat.mjs               # read files inside an Electron app.asar
```

## Development tooling

The DSH implementation ships inside the Desktop app's `app.asar`, which shell tools, `ripgrep`
and Node cannot traverse as a directory. `tools/asar-cat.mjs` reads it directly:

```powershell
node tools/asar-cat.mjs list "dsh-client-ui-trajectory"
node tools/asar-cat.mjs cat  "dsh/node_modules/@deepseek-ai/dsh-session/README.md"
```

Verifying a UI plugin visually needs the Harness window itself, because the web surface
authenticates every method and stream with a cookie exchanged from a fresh process token in the
startup URL — an external browser at the bare loopback URL gets 401. The authenticated browser is
the Desktop app's own window, so start the app with Chromium's standard debugging switch and
attach to it:

```powershell
& "D:\DSH-desktop\DeepSeek Harness.exe" --remote-debugging-port=9222
node tools/browser-cdp.mjs list
node tools/verify-context-inspector.mjs
```

**Quit the app completely first (including the tray icon).** The shell takes a single-instance
lock and calls `application.quit()` in any later process, so launching with the switch while an
instance is already running silently focuses the existing window instead of opening the port.

## License

MIT — see [LICENSE](LICENSE).
