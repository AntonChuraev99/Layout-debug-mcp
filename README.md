# layout-debug-mcp

[![Release](https://img.shields.io/github/v/release/AntonChuraev99/Layout-debug-mcp?include_prereleases)](https://github.com/AntonChuraev99/Layout-debug-mcp/releases)
[![npm](https://img.shields.io/npm/v/layout-debug-mcp?logo=npm)](https://www.npmjs.com/package/layout-debug-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-22.12%2B%20%7C%2020.19%2B-brightgreen.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-pre--1.0-orange.svg)](#roadmap)

**Click the element. Drag it. Your agent knows exactly which one.**

Tired of screenshotting UI, circling a button and describing it to your AI agent in words? Point at it instead. Select any layer in your running page or Android app, move it on the real screen, and send the change to your agent together with the element's anchors, box, parents and the measured delta.

[![layout-debug-mcp: select a card, drag it, ask the agent, the frame refreshes with the change](./.github/media/hero.gif)](./.github/media/hero.mp4)

<sub>18-second loop recorded from the real tool. [Watch the MP4](./.github/media/hero.mp4) for full quality.</sub>

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
- **Hand-off to your agent.** Each element has its own chat thread. A message carries the element's artifacts: anchors (`file:line`, test id, id, class string, text), box, parent chain, siblings, and your live tweaks as a measured delta in `dp` / `css-px` with box before and after.
- **Your agent answers in the window.** Whatever agent you use (Claude Code, Codex, Cursor, Copilot, Gemini CLI…) listens to the window over MCP: you write in the element chat, it edits the code and replies in the same chat.
- **Watch it happen.** A shimmer covers the element while the agent works. When the agent replies, the window refreshes the frame on its own, restores your selection and re-applies your other live edits.
- **Inbox.** Every request with its status (Queued, Agent editing, Done, Error) and time, plus replies that aren't tied to an element.
- **Light install.** `npx -y layout-debug-mcp` downloads only this package: no agent runtime, no model SDK.
- **English and Russian UI**, switchable in the header.
- **Local only.** Window, server and MCP process run on your machine. No cloud; only anonymous usage counts leave it, and one variable turns them off ([Telemetry](#telemetry)).

## Requirements

- Node.js 22.12+ (20.19+ also works)
- Any MCP client: Claude Code, Codex CLI, Cursor, VS Code (Copilot), Claude Desktop, Gemini CLI, Devin Desktop, Zed, or an agent built on an SDK with MCP support
- Chrome, Edge, Firefox or another current browser for the window
- For Android: `adb` in `PATH` and an app built in **debug** with the on-device agent (see [Android](#android))

## Quick start

1. Add the MCP server to your client ([snippets below](#connect-your-mcp-client)). It's one line:

   ```json
   { "command": "npx", "args": ["-y", "layout-debug-mcp"] }
   ```

2. In your project, tell your agent:

   > *Open the layout-debug window and listen for my edits.*

   The agent calls `open_window`: the tool starts its local server, opens the window in your browser (with a bundled demo page until you set your own, see [Connect your own web project](#connect-your-own-web-project)) and starts listening.

3. In the window hold `Alt` and click an element, drag it or type what to change, press `Enter`. Your agent gets the request with the element's anchors and measurements, edits the code and answers in the same chat. Then it waits for your next message.

The header shows **Agent listening** while an agent is connected. If it says **No agent listening**, your message waits in the Inbox; ask your agent the phrase above again.

The window runs on `http://127.0.0.1:5175`. Started by `open_window`, it stops by itself after 30 minutes with no window and no agent. Prefer to start it yourself? `npx layout-debug-mcp window` runs it in the foreground until you stop it.

## Connect your MCP client

The server is the npm package `layout-debug-mcp`, started over stdio. Every client takes the same command:

```
command: npx
args:    -y layout-debug-mcp
```

The agent's project folder matters: the tool reads `layout-debug.config.json` from the folder the client starts it in (usually your project), and shortens file paths relative to it. Desktop apps (Claude Desktop and similar) may start it elsewhere; then set `LD_PROJECT_DIR` or `LD_CONFIG` in `env`. Use `env` for settings (see [Configuration](#configuration)).

Setup is verified end to end with Claude Code; the other snippets follow each client's current documentation.

### Claude Code

```bash
claude mcp add --transport stdio --scope user layout-debug -- npx -y layout-debug-mcp
```

Check it: `claude mcp get layout-debug` should print `Status: √ Connected`; inside a session use `/mcp`. A server added mid-session shows up after the session restarts.

### Codex CLI

`~/.codex/config.toml` (shared by the Codex CLI, IDE extension and desktop app):

```toml
[mcp_servers.layout-debug]
command = "npx"
args = ["-y", "layout-debug-mcp"]
# env = { LD_TARGET_URL = "http://localhost:3000" }
```

Or: `codex mcp add layout-debug -- npx -y layout-debug-mcp`.

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "layout-debug": {
      "command": "npx",
      "args": ["-y", "layout-debug-mcp"],
      "env": { "LD_TARGET_URL": "http://localhost:3000" }
    }
  }
}
```

The `env` block is optional. The same shape works in Claude Desktop, Devin Desktop and Gemini CLI configs.

### VS Code (Copilot agent mode)

Command **MCP: Open User Configuration**, or `.vscode/mcp.json` in a workspace. The key is `servers` and `type` is required:

```json
{
  "servers": {
    "layout-debug": { "type": "stdio", "command": "npx", "args": ["-y", "layout-debug-mcp"] }
  }
}
```

### Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "layout-debug": { "command": "npx", "args": ["-y", "layout-debug-mcp"] }
  }
}
```

**Fully quit and restart** Claude Desktop after editing.

### Gemini CLI, Devin Desktop, Zed, others

Same `command` / `args` / `env`:

- **Gemini CLI**: `~/.gemini/settings.json` under `mcpServers`, or `gemini mcp add layout-debug npx -y layout-debug-mcp`.
- **Devin Desktop** (formerly Windsurf): `mcp_config.json` under `mcpServers`, or `devin mcp add layout-debug -- npx -y layout-debug-mcp`.
- **Zed**: `context_servers` in settings, `"command": "npx", "args": ["-y", "layout-debug-mcp"]`.
- **Agent SDKs** (OpenAI Agents SDK, Vercel AI SDK, LangChain, Claude Agent SDK): use their stdio MCP client with the same command.

On Windows, if a client fails with `spawn npx ENOENT`, use `"command": "cmd", "args": ["/c", "npx", "-y", "layout-debug-mcp"]`.

### Tools

| Tool | What it does | Parameters |
|---|---|---|
| `open_window` | Starts the local server if it isn't running, opens the window, and tells the agent to start listening | none |
| `wait_for_message` | Waits for the next message or edit from the window and returns it with the element's artifacts. Returns "no message yet" after the timeout, and the agent calls it again | `timeoutSec` (5–50, default 40) |
| `reply_in_window` | Writes to the window's chat: what changed, which files, what's left. With `requestId` it closes exactly that request | `text`, `requestId`, `status` (`done` \| `error`), `role` |
| `layout_snapshot` | Tree of the latest snapshot: nodes, sizes, anchors for finding them in code. Depth-limited | `maxDepth` (1–30, default 8) |
| `selected_element` | What the user has selected in the window right now: box, anchors, parent chain, live tweaks | none |
| `pending_requests` | All requests sent from the window, for agents that don't listen | `includeConsumed`, `markConsumed` |

**Listen mode.** MCP can't push a message to an agent, so the agent waits for it: `wait_for_message` returns as soon as you send something, and returns "no message yet" before common client timeouts (about 60 s), so the agent simply calls it again. The server instructions, `open_window` and every `wait_for_message` result repeat this loop, so any agent follows it. Ask the agent to stop listening when you're done.

Text from the inspected page reaches the agent inside a block marked as untrusted page data, with length limits, so page content can't pose as instructions.

## Using the window

<p>
  <img src="./.github/media/selected-palette.png" width="49%" alt="A card selected: breadcrumbs of parents above it, the action palette next to it">
  <img src="./.github/media/element-chat.png" width="49%" alt="Element chat with a queued request">
</p>

### Selecting a layer

There are no modes: on the web the page stays live, so clicks, scrolling and typing go to it. Layers are picked on top of it:

| Action | What it does |
|---|---|
| Hold `Alt` (`⌥ Option` on macOS) | Highlights the tightest box under the cursor; the hint in the header lights up and a "Select to chat" bubble appears next to the cursor |
| `Alt`+click | Selects the layer and opens its action palette. Another `Alt`+click on the same spot goes up to the parent |
| `Alt`+wheel | Up to the parent / back down to the tightest layer under the cursor |
| Drag the selected layer | Moves the element **in the page / on the device**; corner handles resize. A layer covering most of the frame is dragged by its label, so the page under it stays clickable |
| `Esc` or ✕ in the palette | Clears the selection |

Clicks outside the selected layer go to the page and keep the selection. On Android the window can't send clicks to the device yet, so a plain hover highlights and a plain click selects.

With the frame focused: `Enter` goes down to the first child, `Shift+Enter` up to the parent, `Tab` / `Shift+Tab` to siblings. `Esc` closes the first-run hint, the chat, Details and arrow nudging in turn, then clears the selection. Shortcuts also work with a non-Latin keyboard layout.

On the web the header also has a **Page address** field: paste any dev server URL and press Open.

### Action palette

Appears next to the selected element, with breadcrumbs of its parents on top:

| Action | What it does |
|---|---|
| Message field (`C`) | Always open under the title: type the edit and press `Enter` — it goes to the agent and the element's chat opens with the reply. `C` puts the caret there; selecting an element does not, so the frame keeps its keys. `Esc` with text typed leaves the field and keeps the draft |
| Chat with AI | Under the field, with the number of earlier edits: opens the element's thread (history and replies) |
| Move | Nudge with the arrow keys: 1 unit, `Shift` for 8; `Enter` finishes. Dragging works without it. A moved element leaves a faint copy on its old place until it is reset |
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
2. A listening agent receives it at once through `wait_for_message`. With no agent listening the request is **queued**: the element gets a "queued" mark and the window says how to connect an agent; the request goes out as soon as one listens.
3. While the agent works, a shimmering blur covers the element.
4. When the agent replies (`reply_in_window` with the `requestId`), the window waits about 1.5 s for your dev server's hot reload. If the frame didn't update, it reloads the page (Android: grabs a fresh frame), restores the selection by anchor, re-applies your other live edits and removes the blur. The reply appears in the element's thread.

### Inbox

<img src="./.github/media/inbox-progress.png" width="70%" alt="Inbox with a request in the Agent editing state">

The Inbox icon in the header shows a counter of open requests. Inside: every request with its status (Queued, Agent editing, Done, Error) and time, replies that aren't tied to an element, and errors with the next step. Filter by Active or All.

### Language

The window is in English by default. The `EN | RU` switch in the header changes it to Russian; the choice is stored in your browser, and server messages follow it. MCP tool output and agent prompts stay in English; the agent replies in the language of your comment.

## Connect your own web project

1. Add the inspector to your page, **dev only**:

   ```html
   <script src="http://127.0.0.1:5175/inspector.js"></script>
   ```

   Use your `LD_SERVER_PORT` if you changed it. The script talks only to the parent window (the tool's UI) and sends nothing anywhere else.

2. Tell the tool where your page is. Either put `layout-debug.config.json` in your project root (the folder your MCP client starts in):

   ```json
   { "targetUrl": "http://localhost:3000" }
   ```

   or set `LD_TARGET_URL` in the client's `env`, or paste the URL into the window's **Page address** field.

For source mapping add a build step that writes `data-source-loc="file:line"` on JSX elements; without it the agent finds the element by `data-testid`, id and the class string.

## Android

The on-device agent is a small debug-only component: it walks the real Compose tree via `ui-tooling` (`asTree()` gives boxes and compiler source info), serves it with a `PixelCopy` screenshot over HTTP, and applies live overrides by swapping the `LayoutNode` modifier on the running composition. The tool reaches it through `adb forward`, which it sets up and re-establishes by itself. Screenshot and tree come from one call, so they always match.

> **Status:** the agent works in a spike app and is **not yet packaged as a library**. Publishing it to Maven Central as a one-line `debugImplementation` is the next Android milestone. Until then Android mode is for early testers.

Switch the tool to Android mode with `{ "target": "android" }` in `layout-debug.config.json` in your project, or with `env` in the MCP client config:

```json
{ "command": "npx", "args": ["-y", "layout-debug-mcp"], "env": { "LD_TARGET": "android", "LD_DEVICE": "emulator-5554" } }
```

`LD_DEVICE` is needed only when more than one device is attached. The app must be running in a debug build.

In Android mode the window shows the device frame instead of an iframe, with the same overlay, selection, drag and reset. The frame refreshes on its own (paused while you drag, backing off when captures fail), and the header chip shows the device model. The first snapshot of a session resets the device's live overrides, so stale ones from a previous window don't linger.

## Configuration

Environment variables (set them in the MCP client's `env`) override `layout-debug.config.json` in the folder the tool starts in (`LD_CONFIG` points to another file), which overrides defaults.

| Env var | Config key | Default | Meaning |
|---|---|---|---|
| `LD_TARGET` | `target` | `web` | `web` or `android` |
| `LD_TARGET_URL` | `targetUrl` | bundled demo | Page to inspect (web) |
| `LD_PROJECT_DIR` | `projectDir` | start folder | Your project; file paths in the window are shown relative to it |
| `LD_DEVICE` | `device` | none | `adb -s` serial (android) |
| `LD_ANDROID_PORT` | `androidPort` | `8790` | On-device agent port (android) |
| `LD_SERVER_PORT` | none | `5175` | Port of the server and the window |
| `LD_SERVER_URL` | none | `http://127.0.0.1:5175` | Where the MCP process finds the server (overrides `LD_SERVER_PORT` there) |
| `LD_WAIT_SECONDS` | none | `40` | How long `wait_for_message` waits before "no message yet" (5–50) |
| `LD_NO_BROWSER` | none | unset | `1` = don't open the browser, only print the window URL |
| `LD_IDLE_EXIT_MINUTES` | none | `30` from `open_window`, off otherwise | Stop the server after this many minutes with no window and no agent; `0` = never |
| `LD_TELEMETRY` | none | on | `0` = send no usage data (see [Telemetry](#telemetry)) |
| `LD_TELEMETRY_DEBUG` | none | unset | `1` = print each usage event to stderr instead of sending it |

An invalid server setting or a broken config file stops the server at start with a message instead of falling back to the default. An invalid `LD_WAIT_SECONDS` keeps the default and writes a warning to the MCP log.

## How it works

```
 target page / Android app          your machine
 ┌────────────────────┐   postMessage / adb forward   ┌──────────────────────┐
 │ inspector / agent  │ ◄───────────────────────────► │ server 127.0.0.1:5175│
 └────────────────────┘                               │ snapshot · selection │
                                                      │ request queue        │
          ┌──────────────┐        WebSocket           └───┬──────────────┬───┘
          │ window :5175 │ ◄──────────────────────────────┘   local HTTP │
          │ frame+overlay│                                ┌──────────────▼───┐
          │ chat · inbox │                                │ MCP stdio server │ ◄── your agent
          └──────────────┘                                └──────────────────┘
```

Both adapters produce the same normalized snapshot: nodes with boxes in frame pixels, `pxPerUnit` to convert to `dp` / `css-px`, anchors (`sourceLoc`, test id, classes, text) and a flat bag of platform properties. The UI, the chat and MCP don't know which platform the data came from.

The server owns each request's status (`queued`, `working`, `done`, `error`) and sends it to the window with typed error codes, so the window never guesses state from message text.

## Security

- The server listens on `127.0.0.1` only and checks `Origin` and `Host` on HTTP and WebSocket requests, so a web page open in your browser can't drive it (including via DNS rebinding).
- The tool has no agent of its own and never edits your code. Your agent does, with the permissions your MCP client gives it.
- Page text (class names, text, anchors) reaches the agent marked as untrusted page data and length-capped.
- Nothing leaves your machine except what goes to the agent you connect, and anonymous usage counts ([Telemetry](#telemetry)) unless you turn them off.
- The web inspector is added only in dev. The Android agent lives in the debug source set; the spike app still keeps a small inert bridge in the main source set, which the library will split into `-agent` / `-noop` artifacts.

Found a vulnerability? See [SECURITY.md](./SECURITY.md).

## Telemetry

layout-debug-mcp sends anonymous usage data so we can see which clients and targets people use and where the tool fails. It is on by default and off in CI.

**Turn it off** with any of:

- `LD_TELEMETRY=0` in the MCP client's `env`
- `DO_NOT_TRACK=1`
- `npx layout-debug-mcp telemetry off` (saved for every later run; `telemetry status` shows the state and why, `telemetry on` undoes it)

**What is sent:** tool names and their outcome (`ok`, `unreachable`, `empty`…), how long a call took (bucketed), the window's error codes (`device_no_adb`, `device_not_found`…), funnel steps (window opened, element tree received, edit sent, agent replied done or error), session counts in buckets, the error class name and system code (`ECONNRESET`…) of a crash, and the package version, OS, CPU architecture, Node major version and the MCP client's name and version (`claude-code`, `cursor`…).

**What is never sent:** page or app content, URLs, file paths, class names, element text, your comments, the agent's replies, error messages, stack traces, host or user names. The code allows only fixed property names per event: [`src/shared/telemetry.ts`](./src/shared/telemetry.ts).

**Identity:** a random id stored in `telemetry.json` in `%APPDATA%\layout-debug-mcp` (Windows) or `~/.config/layout-debug-mcp`; not linked to you or your machine. The IP address is not stored or used for location. Events go to [Amplitude](https://amplitude.com) (US).

**See what is sent:** `LD_TELEMETRY_DEBUG=1` prints every event to stderr and sends nothing. To delete your data, open an issue with the id from `telemetry status`.

## Limitations

- Live edits are a **preview**, not code: they vanish on page reload or app rebuild until the agent writes them into the source.
- The agent has to be listening. Some agents stop the loop on their own after a while; if the header says **No agent listening**, ask again. A request the agent took stays "Agent editing" until it replies with its `requestId`, or you press "Stop waiting".
- **Web:** the page is shown in an `iframe`, so a target that sends `X-Frame-Options` / `frame-ancestors` won't render. Tree capture is capped at 4000 nodes; the tree syncs 250 ms after the page settles and at least once a second while it keeps changing. `file:line` needs your own `data-source-loc` build step (no plugin shipped yet). In a text field inside a closed shadow root (`mode: 'closed'`), C and Esc still type but also reach the window (open the chat, clear the selection): from outside, such a field can't be told apart from a plain element.
- **Android:** the frame is a refreshed snapshot, not a video stream. What moves is the selected node: select an inner `Row` and its content moves while the background stays, so go up the breadcrumbs. Hide isn't available yet. An override lives until that composable recomposes; the tool re-applies active overrides after each tree refresh. `@UiToolingDataApi` has no compatibility guarantees; verified on Compose Multiplatform 1.11 / Kotlin 2.3.20. Element text isn't in the artifacts yet: `asTree()` doesn't expose it without parsing parameters, and the `file:line` anchor is more precise anyway.

## Troubleshooting

| Symptom | Check |
|---|---|
| Header says **No agent listening** | Tell your agent: *"Open the layout-debug window and listen for my edits."* Check that the client lists the `layout-debug` server (`/mcp` in Claude Code) |
| MCP tools answer "server is unreachable at …" | The message names the address it tried and the network error. Ask the agent to call `open_window`, which starts the server. On another port: set the same `LD_SERVER_PORT` (or `LD_SERVER_URL`) in the client's `env`. `curl http://127.0.0.1:5175/api/health` returns `{"ok":true,…}`. Server log: `layout-debug-mcp-<port>.log` in the system temp folder |
| Window shows "The window didn't start" | The cause line says what failed (a window script didn't load, or nothing rendered within 15 s). Ask the agent to call `open_window` again, then press "Reload page" |
| Client doesn't list the server | `node -v` is 20.19+ / 22.12+ in the environment the client starts from. GUI apps started from the Start menu or Dock may not see a Node from nvm / Volta / fnm: put the absolute path to `npx` as `command`. Restart the session (Claude Desktop: fully quit) |
| Windows: `spawn npx ENOENT` | Use `"command": "cmd", "args": ["/c", "npx", "-y", "layout-debug-mcp"]` |
| Window says the inspector didn't respond | The script tag is in the page, the target allows framing (`X-Frame-Options`, CSP `frame-ancestors`), CSP `script-src` allows `127.0.0.1:5175` |
| Android: "adb not found" / "No device connected" | `adb devices` lists exactly one device with status `device` (or set `LD_DEVICE`); the window picks it up without a reload |
| Android: "The device is there, but the app is silent" | The app runs as a debug build with the agent, listening on `LD_ANDROID_PORT` (8790) |

## Roadmap

Pre-1.0. Next up:

1. Android agent as a published library (Maven Central, `debugImplementation`, `-agent` / `-noop` split).
2. A Claude Code plugin.
3. Clean-machine install checks with Cursor, VS Code, Codex CLI and other clients.
4. Live video stream from the device over scrcpy (H.264 decoded in the browser with WebCodecs) instead of refreshed snapshots.

Later, driven by demand: before/after snapshot diff, a source-location plugin for Vite/Babel, Compose Desktop, Android Views, Flutter.

## Contributing

To work on the tool itself: clone the repo, `npm install`, `npm run dev` (window on `127.0.0.1:5174` with hot reload, server on `5175`, demo page loaded). See [CONTRIBUTING.md](./CONTRIBUTING.md), [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) and [CHANGELOG.md](./CHANGELOG.md). Bug reports and ideas: [issues](https://github.com/AntonChuraev99/Layout-debug-mcp/issues).

## License

[MIT](./LICENSE)
