# DSH Plugin

Plugins for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web GUI.

The repository **is** a DSH bundle: its root `package.json` declares `dsh.bundle.patch`, and that
patch inserts every sub-project. Installing the repository therefore installs the plugins it
contains — one spec, no per-plugin step.

## Install

### From the DSH Desktop GUI

Sidebar → **Plugins** → **Add plugin**, paste:

```
Leo-Yossi/DSH-Plugin
```

then **Install**, and **Enable now** when it finishes. Any pnpm Git spec works equally:
`github:Leo-Yossi/DSH-Plugin`, `git+https://github.com/Leo-Yossi/DSH-Plugin.git`, or the path of a
local clone.

### From the `plugin_manager` tool

```
plugin_manager(action: "install_bundle", target: "github:Leo-Yossi/DSH-Plugin")
```

`install_bundle` runs `pnpm add <spec>` inside the profile, appends the bundle to
`dsh.profile.bundles`, and applies it — restart-free when the profile has HMR. Do not hand-edit the
profile's `package.json` or `cordis.patch.yml`: the manager performs those writes.

### Remove the local install first

If the same sub-project is *also* installed directly (for example from a local path during
development), both Loader rows resolve to a package with the same name, and `dsh-client-modules`
refuses the composition with *"resolves from multiple active Loader sources"*. Keep one of the two:

```
plugin_manager(action: "remove_bundle", target: "@local/dsh-context-inspector")
```

For ordinary development the local install is the better one — it links rather than copies, so
editing `index.js` or `client.js` in place changes what the profile serves. The Git install is for
other machines and clean setups.

### Updating

Git installs do not update themselves. Uninstall and install again to move to a newer commit.

## How one spec installs a sub-project

`cordis.patch.yml` names each sub-project by a **relative path**:

```yaml
- insert:
    - id: context-inspector
      name: './dsh-context-inspector/index.js'
```

The Host converts a relative plugin name to a `file://` URL anchored beside the patch file
(`anchorInsertedPluginNames` in `dsh-app-boot`), so the row resolves inside the installed package
rather than to a registry package of the same name. Two details are load-bearing:

- **The name must point at the entry file, not the directory.** An ES module import of a directory
  URL fails with `ERR_UNSUPPORTED_DIR_IMPORT`; naming `./dsh-context-inspector` alone would leave
  the row unable to mount.
- **The browser half is found by walking up from that file.** `dsh-client-modules` resolves the
  row's specifier, walks to the nearest `package.json` — the sub-project's own manifest — and
  serves its bundle from the `dsh.client` declaration there.

Adding a plugin to this repository is therefore: create the sub-project directory, then add one
`insert` entry.

## Sub-projects

| Sub-project | What it does |
|---|---|
| [`dsh-context-inspector/`](dsh-context-inspector/) | Adds a button to the composer that opens a window showing **the exact payload the Session sends to the model** — every field, not just `messages` — in a code view and a field view grouped by source, with fold/expand and search. |

## Layout

```
.
├── package.json             # the root bundle: dsh.bundle.patch
├── cordis.patch.yml         # inserts each sub-project by relative path
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
