# layout-debug-mcp

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-pre--1.0-orange.svg)](#roadmap)

**Point at a layer in a running UI, drag it — the real screen moves — then tell your AI agent what to change.**
The agent gets the exact element (source `file:line` when available, anchors, box, parents, siblings, your live tweaks) instead of a vague description.

One window, two targets, one snapshot format:

- **Web** — any real DOM page on your dev server (React, Vue, plain HTML; Tailwind classes become strong grep anchors).
- **Android** — Jetpack Compose / Compose Multiplatform on a device or emulator via `adb`: full composition tree with `file:line` from the compiler, and live overrides on the device without a rebuild.

[Русская версия](./README.ru.md)

> **What the tool sees.** It captures screenshots and the layout tree of the UI you point it at and hands them to the agent you connect. Don't run it against screens that show data you wouldn't paste into that agent.

## Features

- **Select any layer** — hover highlights, click selects; breadcrumbs go up to parents, the "Inside" list goes down to children. Works on wrappers and containers, not only on accessible nodes.
- **Live edit** — drag to move, corner handle to resize. On the web it's inline styles; on Android the override is applied to the running composition, no Gradle build.
- **Hand-off to an agent** — write a comment, send it; the element's artifacts go with it. Live tweaks are passed as a measured intent (delta in `dp` / `css-px`, box before and after, parent and siblings), with an instruction to express it via padding / gap / size in code.
- **Two ways in** — an MCP server for any MCP client (Claude Code, Cursor, VS Code, …), or an optional built-in chat on the Claude Agent SDK.
- **Local only** — window, server and MCP process run on your machine. No cloud, no telemetry.

## Requirements

- Node.js 20+
- For Android: `adb` in `PATH`, an app built in **debug** with the on-device agent (see [Android](#android))

## Quick start

Try it on the bundled demo page — no configuration:

```bash
git clone https://github.com/AntonChuraev99/Layout-debug-mcp.git
cd Layout-debug-mcp
npm install
npm run dev
```

Open **http://localhost:5174**. The demo page is already loaded: hover, click, drag, write a comment.

`npm run dev` starts three processes: the inspector bundle in watch mode, the server on `127.0.0.1:5175`, and the UI on `5174`. **Keep it running** — the MCP server is a thin client of this server.

Then [connect your MCP client](#connect-your-mcp-client) and ask the agent: *"take the pending layout requests and apply them"*.

## Connect your MCP client

The MCP server is a stdio process: `npx tsx <repo>/src/mcp/index.ts`. Use an **absolute path** to the cloned repo — clients don't start it from the repo directory.

> One-command install (`npx layout-debug-mcp`, MCP Registry, Claude Code plugin) is on the [roadmap](#roadmap).

### Claude Code

```bash
claude mcp add --transport stdio --scope user layout-debug -- npx tsx /abs/path/to/Layout-debug-mcp/src/mcp/index.ts
```

On native Windows `npx` needs a shell wrapper (PowerShell or cmd; in Git Bash write `cmd //c`, otherwise MSYS rewrites `/c` into a path):

```powershell
claude mcp add --transport stdio --scope user layout-debug -- cmd /c npx tsx C:/path/to/Layout-debug-mcp/src/mcp/index.ts
```

`--scope user` makes it available in every project. `--scope project` writes it into the project's shared `.mcp.json` — with an absolute path that only works on your machine.

Check it: `claude mcp list` in a terminal, or `/mcp` inside a session. A server added mid-session shows up after the session restarts.

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "layout-debug": {
      "command": "npx",
      "args": ["tsx", "/abs/path/to/Layout-debug-mcp/src/mcp/index.ts"]
    }
  }
}
```

### VS Code

`.vscode/mcp.json` — note the key is `servers` and `type` is required:

```json
{
  "servers": {
    "layout-debug": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/abs/path/to/Layout-debug-mcp/src/mcp/index.ts"]
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`, macOS: `~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "layout-debug": {
      "command": "npx",
      "args": ["tsx", "/abs/path/to/Layout-debug-mcp/src/mcp/index.ts"]
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.layout-debug]
command = "npx"
args = ["tsx", "/abs/path/to/Layout-debug-mcp/src/mcp/index.ts"]
```

### Windsurf, Gemini CLI, others

Same `command` / `args` pair under `mcpServers` in the client's MCP config (Windsurf: `~/.codeium/windsurf/mcp_config.json`, Gemini CLI: `settings.json`).

## Tools

| Tool | What it does | Parameters |
|---|---|---|
| `layout_snapshot` | Tree of the latest snapshot: nodes, sizes, anchors for finding them in code. Depth-limited | `maxDepth` (1–30, default 8) |
| `selected_element` | What the user has selected in the window right now: box, anchors, parent chain, live tweaks | — |
| `pending_requests` | Requests sent from the window: comment + element artifacts + drag measurements | `includeConsumed` (default `false`), `markConsumed` (default `true`) |
| `reply_in_window` | Writes to the window's chat — what changed, which files, what's left. The user watches the window, not the terminal | `text`, `role` (`assistant` \| `system`) |

The first three read state, the last one adds to it. If the window is closed, the reply is kept and shown next time it opens.

## Using the window

| Action | What happens |
|---|---|
| Hover | Highlights the element under the cursor (the tightest box) |
| Click | Selects the layer; breadcrumbs go up to parents, the "Inside" list goes down to children |
| Drag | Moves the element **in the page / on the device**; the panel shows the offset |
| Corner handle | Resizes |
| Selection mode off | Clicks go to the page — press buttons and navigate the app |
| Reset edits | Removes all live tweaks |
| Send | Comment + artifacts go to the built-in agent, or to the queue for MCP |

## Connect your own web project

1. Add the inspector to your page, **dev only**:

   ```html
   <script src="http://127.0.0.1:5175/inspector.js"></script>
   ```

   It talks only to the parent window (the tool's UI) and sends nothing anywhere else.

2. Copy `layout-debug.config.example.json` to `layout-debug.config.json` in the tool's directory:

   ```json
   {
     "targetUrl": "http://localhost:3000",
     "projectDir": "/abs/path/to/my-web-app"
   }
   ```

   `projectDir` is the repo the built-in chat agent may edit. Without it the chat is off and requests queue up for MCP.

For source mapping add a build step that writes `data-source-loc="file:line"` on JSX elements; without it the agent finds the element by `data-testid`, id and the class string.

## Android

The on-device agent is a small debug-only component: it walks the real Compose tree via `ui-tooling` (`asTree()` gives boxes and compiler source info), serves it with a `PixelCopy` screenshot over HTTP, and applies live overrides. The tool reaches it through `adb forward`, which it sets up and re-establishes by itself.

> **Status:** the agent works in a spike app and is **not yet packaged as a library**. Publishing it to Maven Central as a one-line `debugImplementation` is the next Android milestone. Until then Android mode is for early testers.

Run the tool in Android mode:

```bash
LD_TARGET=android LD_DEVICE=emulator-5554 LD_PROJECT_DIR=/abs/path/to/my-app npm run dev
```

PowerShell:

```powershell
$env:LD_TARGET='android'; $env:LD_DEVICE='emulator-5554'; $env:LD_PROJECT_DIR='C:/path/to/my-app'; npm run dev
```

`LD_DEVICE` is needed only when more than one device is attached. The app must be running in a debug build.

## Configuration

Environment variables override `layout-debug.config.json`, which overrides defaults.

| Env var | Config key | Default | Meaning |
|---|---|---|---|
| `LD_TARGET` | `target` | `web` | `web` or `android` |
| `LD_TARGET_URL` | `targetUrl` | bundled demo | Page to inspect (web) |
| `LD_PROJECT_DIR` | `projectDir` | — | Repo the built-in chat agent may edit; unset = chat off |
| `LD_DEVICE` | `device` | — | `adb -s` serial (android) |
| `LD_ANDROID_PORT` | `androidPort` | `8790` | On-device agent port (android) |
| `LD_SERVER_URL` | — | `http://127.0.0.1:5175` | Where the MCP process finds the server |

Ports: UI `5174`, server `5175`.

## How it works

```
 target page / Android app          your machine
 ┌────────────────────┐   postMessage / adb forward   ┌──────────────────────┐
 │ inspector / agent  │ ◄───────────────────────────► │ server 127.0.0.1:5175│
 └────────────────────┘                               │ snapshot · selection │
                                                      │ request queue        │
          ┌──────────────┐        WebSocket           └───┬──────────────┬───┘
          │ UI :5174     │ ◄──────────────────────────────┘   local HTTP │
          │ frame+overlay│                                ┌──────────────▼───┐
          │ chat         │                                │ MCP stdio server │ ◄── your agent
          └──────────────┘                                └──────────────────┘
```

Both adapters produce the same normalized snapshot — nodes with boxes in frame pixels, `pxPerUnit` to convert to `dp` / `css-px`, anchors (`sourceLoc`, test id, classes, text) and a flat bag of platform properties. The UI, the chat and MCP don't know which platform the data came from.

## Security

- The server listens on `127.0.0.1` only and checks `Origin` and `Host` on HTTP and WebSocket requests, so a web page open in your browser can't drive it (including via DNS rebinding).
- The built-in chat agent may use only `Read`, `Edit`, `Write`, `Grep`, `Glob`; writes are limited to `projectDir`, and `.git/`, `.claude/`, `.mcp.json` and `.env*` are off limits. It loads the project's settings and `CLAUDE.md`, not your user-level Claude Code settings. Reads are not limited yet — see [SECURITY.md](./SECURITY.md) for known gaps.
- Nothing leaves your machine except what goes to the agent you connect: through MCP, your client's agent; through the built-in chat, Claude via the Claude Agent SDK.
- The web inspector is added only in dev. The Android agent lives in the debug source set; the spike app still keeps a small inert bridge in the main source set, which the library will split into `-agent` / `-noop` artifacts.

Found a vulnerability? See [SECURITY.md](./SECURITY.md).

## Limitations

- Live edits are a **preview**, not code: they vanish on page reload or app rebuild.
- Tool output, UI and prompts are in Russian for now; English is planned.
- `npm audit` reports a moderate issue in `@hono/node-server`, a transitive dependency of the MCP SDK's HTTP transport. This project uses only the stdio transport, so that code never runs; downgrading the SDK breaks the Agent SDK's peer dependency.
- **Web:** the page is shown in an `iframe` — a target that sends `X-Frame-Options` / `frame-ancestors` won't render. Tree capture is capped at 4000 nodes and synced at most once a second.
- **Android:** the frame is a snapshot on request, not a video stream. What moves is the selected node: select an inner `Row` and its content moves while the background stays — go up the breadcrumbs. An override lives until that composable recomposes; the tool re-applies active overrides after each tree refresh. `@UiToolingDataApi` has no compatibility guarantees; verified on Compose Multiplatform 1.11 / Kotlin 2.3.20. Element text isn't in the artifacts yet — `asTree()` doesn't expose it without parsing parameters; the `file:line` anchor is more precise anyway.

## Troubleshooting

| Symptom | Check |
|---|---|
| MCP tools answer "server unavailable" | `npm run dev` is running; `curl http://127.0.0.1:5175/api/health` returns `{"ok":true,…}` |
| Client doesn't list the server | Absolute path in the config; `node -v` ≥ 20 in the environment the client starts from (GUI apps may have a different `PATH`); restart the session |
| Windows: `spawn npx ENOENT` | Use the `cmd /c npx …` form |
| Server exits with "port 5175 is taken" | Another instance or another dev server holds the port — stop it |
| Window says the inspector didn't respond | The script tag is in the page, the target allows framing (`X-Frame-Options`, CSP `frame-ancestors`), CSP `script-src` allows `127.0.0.1:5175` |

## Roadmap

Pre-1.0. Next up:

1. Android agent as a published library (Maven Central, `debugImplementation`).
2. One-command install: `npx`, MCP Registry, Claude Code plugin.
3. Visible errors for every failure path (adb, device, empty tree, blocked iframe), English UI, tests and CI.
4. Checked with Claude Code, Cursor, Codex CLI and VS Code.

Later, driven by demand: Compose Desktop, Android Views, Flutter, live video stream from the device.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports and ideas — [issues](https://github.com/AntonChuraev99/Layout-debug-mcp/issues).

## License

[MIT](./LICENSE)
