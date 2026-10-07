# layout-debug-mcp

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-22.12%2B%20%7C%2020.19%2B-brightgreen.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-pre--1.0-orange.svg)](#roadmap)

**Click the element. Drag it. Your agent knows exactly which one.**

Tired of screenshotting UI, circling a button and describing it to your AI agent in words? Point at it instead. Select any layer in your running page or Android app, move it on the real screen, and send the change to your agent together with the element's anchors, box, parents and the measured delta.

[![layout-debug-mcp: select a card, drag it, ask the agent, the frame refreshes with the change](./.github/media/hero.gif)](./.github/media/hero.mp4)

<sub>20-second loop recorded from the real tool. [Watch the MP4](./.github/media/hero.mp4) for full quality.</sub>

[Русская версия](./README.ru.md)

> **What the tool sees.** It captures screenshots and the layout tree of the UI you point it at and hands them to the agent you connect. Don't run it against screens that show data you wouldn't paste into that agent.

## Why

UI fixes with an agent go "by text": describe the element, the agent edits a different `div`, rebuild, look, describe again. Half the time goes into explaining *which* element you mean.

layout-debug-mcp is a local window over your running UI. You pick the element on the picture, so there's nothing to explain. If you want it 16 px lower, you drag it and the real page (or the phone) moves, no rebuild. The agent gets measurements, not adjectives.

One window, two targets, one snapshot format:

- **Web**: any real DOM page from your dev server (React, Vue, plain HTML; Tailwind class strings make strong grep anchors).
- **Android**: Jetpack Compose / Compose Multiplatform on a device or emulator over `adb`. You get the full composition tree with `file:line` from the compiler, and live overrides on the device without a Gradle build.

Web has precedents (Onlook, LocatorJS, code-inspector). Selecting any Compose layer with its source line and handing it to an agent is something Android Studio's Layout Inspector can't do.

## Features

- **Select any layer.** Hover highlights the tightest box under the cursor, click selects. Breadcrumbs go up to parents, "Details" goes down to children. Works on wrappers and containers, not only on accessible nodes.
- **Live edit.** Drag to move, corner handle to resize, hide and show. On the web it's inline styles; on Android the override is applied to the running composition.
- **Hand-off to an agent.** Each element has its own chat thread. A message carries the element's artifacts: anchors (`file:line`, test id, id, class string, text), box, parent chain, siblings, and your live tweaks as a measured delta in `dp` / `css-px` with box before and after.
- **Watch it happen.** A shimmer covers the element while the agent works. When the agent replies, the window refreshes the frame on its own, restores your selection and re-applies your other live edits.
- **Inbox.** Every request with its status (Queued, Agent editing, Done, Error), the agent's steps and time, plus replies that aren't tied to an element.
- **Two ways in.** An MCP server (stdio) for any MCP client, or an optional built-in chat on the Claude Agent SDK.
- **English and Russian UI**, switchable in the header.
- **Local only.** Window, server and MCP process run on your machine. No cloud, no telemetry.

## Requirements

- Node.js 22.12+ (20.19+ also works; Vite 7 needs one of these)
- Chrome, Edge, Firefox or another current browser for the window
- For Android: `adb` in `PATH` and an app built in **debug** with the on-device agent (see [Android](#android))

Playwright and its browsers are only needed to run the e2e tests, not to use the tool.

## Quick start

Try it on the bundled demo page, no configuration:

```bash
git clone https://github.com/AntonChuraev99/Layout-debug-mcp.git
cd Layout-debug-mcp
npm install
npm run dev
```

Open **http://127.0.0.1:5174**. The demo page is already loaded: hover, click, drag, write a comment.

`npm run dev` starts three processes: the inspector bundle in watch mode, the server on `127.0.0.1:5175` and the window on `127.0.0.1:5174`. **Keep it running in its own terminal for the whole session.** The MCP server is a thin client of this server and does nothing on its own.

Ports taken? `npm run dev` then stops with the reason (for example `port … is already in use`) instead of running half-started. Start on another pair, for example `LD_UI_PORT=5184 LD_SERVER_PORT=5185 npm run dev` (PowerShell: `$env:LD_UI_PORT='5184'; $env:LD_SERVER_PORT='5185'; npm run dev`). Then give your MCP client the same `LD_SERVER_PORT`, see below.

Then [connect your MCP client](#connect-your-mcp-client), select something in the window, send a comment and ask the agent: *"take the pending layout requests and apply them"*.

## Connect your MCP client

The MCP server is a stdio process started from the cloned repo. Use **absolute paths**: clients start it from their own working directory, not from the repo. The recommended command runs the repo's own `tsx` with `node`, so it needs no shell wrapper on Windows, no network and no download:

```
command: node
args:    /abs/path/to/Layout-debug-mcp/node_modules/tsx/dist/cli.mjs
         /abs/path/to/Layout-debug-mcp/src/mcp/index.ts
```

On Windows write paths with forward slashes (`C:/Users/you/Layout-debug-mcp/...`); every client below accepts them, and JSON needs no escaping.

**Changed the server port?** The MCP process looks for the server at `http://127.0.0.1:5175`. If you started `npm run dev` with `LD_SERVER_PORT`, pass the same value to the MCP process (`env` in the snippets below), or set `LD_SERVER_URL`.

The client can show the server as connected before `npm run dev` is up; the tools only fail at call time with "server is unreachable". Setup is verified end to end with Claude Code; the other snippets follow each client's current documentation.

### Claude Code

```bash
claude mcp add --transport stdio --scope user layout-debug -- node /abs/path/to/Layout-debug-mcp/node_modules/tsx/dist/cli.mjs /abs/path/to/Layout-debug-mcp/src/mcp/index.ts
```

With a custom server port:

```bash
claude mcp add --transport stdio --scope user layout-debug -e LD_SERVER_PORT=5185 -- node /abs/path/to/Layout-debug-mcp/node_modules/tsx/dist/cli.mjs /abs/path/to/Layout-debug-mcp/src/mcp/index.ts
```

Windows, PowerShell or cmd:

```powershell
claude mcp add --transport stdio --scope user layout-debug -- node C:/path/to/Layout-debug-mcp/node_modules/tsx/dist/cli.mjs C:/path/to/Layout-debug-mcp/src/mcp/index.ts
```

Check it: `claude mcp get layout-debug` should print `Status: √ Connected`; inside a session use `/mcp`. A server added mid-session shows up after the session restarts.

`--scope user` makes it available in every project. `--scope project` writes it into the project's shared `.mcp.json`, and with an absolute path that only works on your machine.

<details>
<summary>Alternative: <code>npx tsx</code></summary>

```bash
claude mcp add --transport stdio --scope user layout-debug -- npx tsx /abs/path/to/Layout-debug-mcp/src/mcp/index.ts
```

This works too, with a caveat: started outside the repo, `npx` doesn't see the repo's `tsx` and downloads the latest one from the registry on first run (network needed, a few seconds slower, not pinned by the lockfile). If a client fails with `spawn npx ENOENT` on Windows, wrap it: `-- cmd /c npx tsx C:/path/...`. In Git Bash write `cmd //c`, otherwise MSYS rewrites `/c` into a path.

</details>

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "layout-debug": {
      "command": "node",
      "args": [
        "/abs/path/to/Layout-debug-mcp/node_modules/tsx/dist/cli.mjs",
        "/abs/path/to/Layout-debug-mcp/src/mcp/index.ts"
      ],
      "env": { "LD_SERVER_PORT": "5175" }
    }
  }
}
```

The `env` block is optional; it's shown here because it's where a changed port goes. The same `env` object works in Claude Desktop, Devin Desktop and Gemini CLI configs.

### VS Code (Copilot agent mode)

User level (command **MCP: Open User Configuration**, fits best since the path is absolute anyway) or `.vscode/mcp.json` in a workspace. Note the key is `servers` and `type` is required:

```json
{
  "servers": {
    "layout-debug": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/abs/path/to/Layout-debug-mcp/node_modules/tsx/dist/cli.mjs",
        "/abs/path/to/Layout-debug-mcp/src/mcp/index.ts"
      ]
    }
  }
}
```

### Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`, macOS: `~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "layout-debug": {
      "command": "node",
      "args": [
        "/abs/path/to/Layout-debug-mcp/node_modules/tsx/dist/cli.mjs",
        "/abs/path/to/Layout-debug-mcp/src/mcp/index.ts"
      ]
    }
  }
}
```

**Fully quit and restart** Claude Desktop after editing. Logs: `%APPDATA%\Claude\logs\mcp-server-layout-debug.log` on Windows, `~/Library/Logs/Claude/` on macOS.

### Codex CLI

`~/.codex/config.toml` (or `.codex/config.toml` in a trusted project; shared by the Codex CLI, IDE extension and desktop app):

```toml
[mcp_servers.layout-debug]
command = "node"
args = ["/abs/path/to/Layout-debug-mcp/node_modules/tsx/dist/cli.mjs", "/abs/path/to/Layout-debug-mcp/src/mcp/index.ts"]
# env = { LD_SERVER_PORT = "5185" }
```

Or from the terminal:

```bash
codex mcp add layout-debug -- node /abs/path/to/Layout-debug-mcp/node_modules/tsx/dist/cli.mjs /abs/path/to/Layout-debug-mcp/src/mcp/index.ts
```

### Devin Desktop (formerly Windsurf), Gemini CLI, others

Same `command` / `args` / `env` under `mcpServers`:

- **Devin Desktop** (Windsurf was renamed in June 2026): `~/.config/devin/mcp_config.json` on macOS/Linux, `%APPDATA%\devin\mcp_config.json` on Windows, or project `.devin/mcp_config.json`. CLI: `devin mcp add layout-debug -- node <args>`.
- **Gemini CLI**: `~/.gemini/settings.json` (user) or `.gemini/settings.json` (project). CLI: `gemini mcp add layout-debug node <args>`.

### Tools

| Tool | What it does | Parameters |
|---|---|---|
| `layout_snapshot` | Tree of the latest snapshot: nodes, sizes, anchors for finding them in code. Depth-limited | `maxDepth` (1–30, default 8) |
| `selected_element` | What the user has selected in the window right now: box, anchors, parent chain, live tweaks | none |
| `pending_requests` | Requests sent from the window: `requestId`, comment, element artifacts, drag measurements. New ones are marked `[NEW]` | `includeConsumed` (default `false`), `markConsumed` (default `true`) |
| `reply_in_window` | Writes to the window's chat: what changed, which files, what's left. With `requestId` it marks exactly that request Done | `text`, `role` (`assistant` \| `system`), `requestId` (optional) |

The first three read state, the last one adds to it. If the window is closed, the reply is kept and shown next time it opens, so "agent first, window later" works.

MCP is pull-only: the agent doesn't hear about new requests by itself. Ask it to take the pending requests each time, or use the built-in chat.

## Using the window

<p>
  <img src="./.github/media/selected-palette.png" width="49%" alt="A card selected: breadcrumbs of parents above it, the action palette next to it">
  <img src="./.github/media/element-chat.png" width="49%" alt="Element chat with a queued request">
</p>

### Selecting a layer

There are no modes: on the web the page stays live, so clicks, scrolling and typing go to it. Layers are picked on top of it:

| Action | What it does |
|---|---|
| Hold `Alt` (`⌥ Option` on macOS) | Highlights the tightest box under the cursor; the hint in the header lights up |
| `Alt`+click | Selects the layer and opens its action palette. Another `Alt`+click on the same spot goes up to the parent |
| `Alt`+wheel | Up to the parent / back down to the tightest layer under the cursor |
| Pipette (header) | Picks one layer without a key, then turns itself off |
| Drag the selected layer | Moves the element **in the page / on the device**; corner handles resize. A layer covering most of the frame is dragged by its label, so the page under it stays clickable |
| `Esc` or ✕ in the palette | Clears the selection |

Clicks outside the selected layer go to the page and keep the selection. On Android the window can't send clicks to the device yet, so a plain hover highlights and a plain click selects.

With the frame focused: `Enter` goes down to the first child, `Shift+Enter` up to the parent, `Tab` / `Shift+Tab` to siblings. `Esc` closes the first-run hint, the chat, Details, arrow nudging and the pipette in turn, then clears the selection. Shortcuts also work with a non-Latin keyboard layout.

On the web the header also has a **Page address** field: paste any dev server URL and press Open.

### Action palette

Appears next to the selected element, with breadcrumbs of its parents on top:

| Action | What it does |
|---|---|
| Chat with AI (`C`) | Opens the element's thread: history for this element and a composer |
| Move | Nudge with the arrow keys: 1 unit, `Shift` for 8; `Enter` finishes. Dragging works without it |
| Resize | Change width and height with the arrow keys; corner handles work without it |
| Hide / Show | Hide the element, its space stays reserved (web only for now) |
| Copy anchor | Copies the best anchor for finding it in code (`file:line`, then test id, id, class string, path) |
| Reset edits | Restores the element as it is in code |
| Stop waiting | Removes the "agent is editing" mark if the agent never replied |
| Details | Box, source, classes, path, live edits, and the "Inside" list of children |

### Element chat, shimmer and auto refresh

<p>
  <img src="./.github/media/agent-editing-shimmer.png" width="49%" alt="Shimmering blur over the button while the agent edits it">
  <img src="./.github/media/agent-done.png" width="49%" alt="Frame refreshed with the change and the agent's reply in the chat">
</p>

1. Select an element, press `C`, describe the change, `Enter` to send (`Shift+Enter` for a new line). Live tweaks on that element go along as measurements.
2. With `projectDir` set, the built-in agent picks it up. Without it the request is **queued for MCP** and the element gets a "queued" mark.
3. While the agent works, a shimmering blur covers the element.
4. When the agent replies (`reply_in_window` with the `requestId`, or the built-in chat finishes), the window waits about 1.5 s for your dev server's hot reload. If the frame didn't update, it reloads the page (Android: grabs a fresh frame), restores the selection by anchor, re-applies your other live edits and removes the blur. The reply appears in the element's thread.

### Inbox

<img src="./.github/media/inbox-progress.png" width="70%" alt="Inbox with a request in the Agent editing state">

The Inbox icon in the header shows a counter of open requests. Inside: every request with its status (Queued, Agent editing, Done, Error), the agent's steps and time, replies that aren't tied to an element, and agent errors with the next step (for example, how to sign in when the built-in agent can't reach Claude). Filter by Active or All.

### Language

The window is in English by default. The `EN | RU` switch in the header changes it to Russian; the choice is stored in your browser, and server messages follow it. MCP tool output and agent prompts stay in English; the agent replies in the language of your comment.

## Connect your own web project

1. Add the inspector to your page, **dev only**:

   ```html
   <script src="http://127.0.0.1:5175/inspector.js"></script>
   ```

   Use your `LD_SERVER_PORT` if you changed it. The script talks only to the parent window (the tool's UI) and sends nothing anywhere else.

2. Copy `layout-debug.config.example.json` to `layout-debug.config.json` in the tool's directory:

   ```json
   {
     "targetUrl": "http://localhost:3000",
     "projectDir": "/abs/path/to/my-web-app"
   }
   ```

   `projectDir` is the repo the built-in chat agent may edit. Without it the built-in chat is off and requests queue up for MCP.

For source mapping add a build step that writes `data-source-loc="file:line"` on JSX elements; without it the agent finds the element by `data-testid`, id and the class string.

## Android

The on-device agent is a small debug-only component: it walks the real Compose tree via `ui-tooling` (`asTree()` gives boxes and compiler source info), serves it with a `PixelCopy` screenshot over HTTP, and applies live overrides by swapping the `LayoutNode` modifier on the running composition. The tool reaches it through `adb forward`, which it sets up and re-establishes by itself. Screenshot and tree come from one call, so they always match.

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

In Android mode the window shows the device frame instead of an iframe, with the same overlay, selection, drag and reset. The frame refreshes on its own (paused while you drag, backing off when captures fail), and the header chip shows the device model. The first snapshot of a session resets the device's live overrides, so stale ones from a previous window don't linger.

## Configuration

Environment variables override `layout-debug.config.json` (in the root of the cloned tool), which overrides defaults.

| Env var | Config key | Default | Meaning |
|---|---|---|---|
| `LD_TARGET` | `target` | `web` | `web` or `android` |
| `LD_TARGET_URL` | `targetUrl` | bundled demo | Page to inspect (web) |
| `LD_PROJECT_DIR` | `projectDir` | none | Repo the built-in chat agent may edit; unset = built-in chat off, requests queue for MCP |
| `LD_DEVICE` | `device` | none | `adb -s` serial (android) |
| `LD_ANDROID_PORT` | `androidPort` | `8790` | On-device agent port (android) |
| `LD_UI_PORT` | none | `5174` | Port of the window |
| `LD_SERVER_PORT` | none | `5175` | Port of the server; the MCP process reads it too |
| `LD_SERVER_URL` | none | `http://127.0.0.1:5175` | Where the MCP process finds the server (overrides `LD_SERVER_PORT` there) |

Both ports must differ; an invalid value fails at start with a message instead of falling back to the default.

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
          │ chat · inbox │                                │ MCP stdio server │ ◄── your agent
          └──────────────┘                                └──────────────────┘
```

Both adapters produce the same normalized snapshot: nodes with boxes in frame pixels, `pxPerUnit` to convert to `dp` / `css-px`, anchors (`sourceLoc`, test id, classes, text) and a flat bag of platform properties. The UI, the chat and MCP don't know which platform the data came from.

The server owns each request's status (`queued`, `working`, `done`, `error`) and sends it to the window with typed error codes, so the window never guesses state from message text.

## Security

- The server listens on `127.0.0.1` only and checks `Origin` and `Host` on HTTP and WebSocket requests, so a web page open in your browser can't drive it (including via DNS rebinding).
- The built-in chat agent may use only `Read`, `Edit`, `Write`, `Grep`, `Glob`; writes are limited to `projectDir`, and `.git/`, `.claude/`, `.mcp.json` and `.env*` are off limits. It loads the project's settings and `CLAUDE.md`, not your user-level Claude Code settings. Reads are not limited yet; see [SECURITY.md](./SECURITY.md) for known gaps.
- Nothing leaves your machine except what goes to the agent you connect: through MCP, your client's agent; through the built-in chat, Claude via the Claude Agent SDK.
- The web inspector is added only in dev. The Android agent lives in the debug source set; the spike app still keeps a small inert bridge in the main source set, which the library will split into `-agent` / `-noop` artifacts.

Found a vulnerability? See [SECURITY.md](./SECURITY.md).

## Limitations

- Live edits are a **preview**, not code: they vanish on page reload or app rebuild until the agent writes them into the source.
- MCP is pull-only. A request sent to the MCP queue stays "Agent editing" until the agent replies with its `requestId`, or you press "Stop waiting".
- On npm 11, `npm install` may print an `allow-scripts` warning for `esbuild`; it's harmless (the binary comes from esbuild's platform package).
- **Web:** the page is shown in an `iframe`, so a target that sends `X-Frame-Options` / `frame-ancestors` won't render. Tree capture is capped at 4000 nodes and synced at most once a second. `file:line` needs your own `data-source-loc` build step (no plugin shipped yet). In a text field inside a closed shadow root (`mode: 'closed'`), C and Esc still type but also reach the window (open the chat, clear the selection): from outside, such a field can't be told apart from a plain element.
- **Android:** the frame is a refreshed snapshot, not a video stream. What moves is the selected node: select an inner `Row` and its content moves while the background stays, so go up the breadcrumbs. Hide isn't available yet. An override lives until that composable recomposes; the tool re-applies active overrides after each tree refresh. `@UiToolingDataApi` has no compatibility guarantees; verified on Compose Multiplatform 1.11 / Kotlin 2.3.20. Element text isn't in the artifacts yet: `asTree()` doesn't expose it without parsing parameters, and the `file:line` anchor is more precise anyway.

## Troubleshooting

| Symptom | Check |
|---|---|
| MCP tools answer "server is unreachable at …" | The message names the address it tried, the network error and which variable the address came from. Not running: start `npm run dev`. Running on another `LD_SERVER_PORT`: put the same value (or `LD_SERVER_URL`) into the MCP server's `env` in the client config and restart the session. `curl http://127.0.0.1:5175/api/health` returns `{"ok":true,…}` |
| Window shows "The window didn't start" | The cause line says what failed (a window script didn't load, or nothing rendered within 15 s). Check that `npm run dev` is still running in its terminal and has no errors, then press "Reload page" |
| Client doesn't list the server | Absolute paths in the config; `node -v` is 20.19+ / 22.12+ in the environment the client starts from. GUI apps started from the Start menu or Dock may not see a Node from nvm / Volta / fnm: put the absolute path to `node` as `command`. Restart the session (Claude Desktop: fully quit) |
| Windows: `spawn npx ENOENT` | Use the `node …/tsx/dist/cli.mjs` form, or wrap with `cmd /c npx …` |
| Window says the inspector didn't respond | The script tag is in the page, the target allows framing (`X-Frame-Options`, CSP `frame-ancestors`), CSP `script-src` allows `127.0.0.1:5175` |
| Inbox shows "The agent can't sign in to Claude" | The built-in chat has no credentials: run `claude login` in a terminal or set `ANTHROPIC_API_KEY` for the server, restart it, send again |
| Android: "adb not found" / "No device connected" | `adb devices` lists exactly one device with status `device` (or set `LD_DEVICE`); the window picks it up without a reload |
| Android: "The device is there, but the app is silent" | The app runs as a debug build with the agent, listening on `LD_ANDROID_PORT` (8790) |

## Roadmap

Pre-1.0. Next up:

1. Android agent as a published library (Maven Central, `debugImplementation`, `-agent` / `-noop` split).
2. One-command install: `npx layout-debug-mcp` for the window and `npx -y layout-debug-mcp mcp` for MCP clients, a listing in the official MCP Registry, and a Claude Code plugin.
3. Clean-machine install checks on Windows, macOS and Linux with Claude Code, Cursor, VS Code and Codex CLI; CI.
4. Live video stream from the device over scrcpy (H.264 decoded in the browser with WebCodecs) instead of refreshed snapshots.

Later, driven by demand: before/after snapshot diff, a source-location plugin for Vite/Babel, Compose Desktop, Android Views, Flutter.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CHANGELOG.md](./CHANGELOG.md). Bug reports and ideas: [issues](https://github.com/AntonChuraev99/Layout-debug-mcp/issues).

## License

[MIT](./LICENSE)
