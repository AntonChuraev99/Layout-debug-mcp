# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-08

First public release. Install is clone-based (`npm install` + `npm run dev`); one-command install via `npx` and the MCP Registry is planned for 0.2.

### Added

- Web target: inspector script for the target page, window with iframe and SVG overlay, layer selection with breadcrumbs, live drag and resize via inline styles, bundled demo page.
- Android target: adapter over `adb forward` to an on-device debug agent: Compose tree with compiler `file:line`, `PixelCopy` screenshot, live overrides without a rebuild.
- Normalized snapshot shared by both targets (`pxPerUnit`, anchors, flat properties).
- Built-in chat on the Claude Agent SDK and an edit request queue.
- MCP stdio server with `layout_snapshot`, `selected_element`, `pending_requests`, `reply_in_window`.
- No modes: the page stays live by default; hold `Alt` (`⌥ Option` on macOS) to highlight a layer, `Alt`+click to select, `Alt`+wheel or a repeated `Alt`+click for the parent. Header pipette for a one-shot pick and an always-visible `Alt` hint; one-time first-run hint. The selected layer is dragged by its body or label and resized by four corner handles; Move / Resize in the palette nudge with the arrow keys. On Android a plain click selects. Keyboard navigation of the tree on the frame (`Enter`, `Shift+Enter`, `Tab`); shortcuts work with non-Latin layouts.
- Action palette next to the selected element: an always-open message field (`C` focuses it, `Enter` sends and opens the chat), Chat with AI (thread history), Move, Resize, Hide / Show, Copy anchor, Reset edits, Stop waiting, Details (children and properties).
- A moved element leaves a faint, non-clickable copy on its old place until the edit is reset (web: a copy in the page outside `<body>`, clipped by scrolling containers; Android: a crop of the frame).
- While picking (`Alt` or the header pipette) a small "Select to chat" bubble follows the standard arrow cursor; it folds to "•••" once picking is learned and hides over the palette, while dragging and when `Alt` is released.
- Per-element chat popover with thread history, tied to the element's anchor.
- Shimmering blur over an element while the agent works, queued and done marks.
- Automatic frame refresh after the agent replies: waits for HMR, otherwise reloads the page (Android: fresh frame), restores the selection by anchor and re-applies other live edits.
- Inbox in the header: every request with status (Queued, Agent editing, Done, Error), agent steps and time; Active / All filter; replies not tied to an element and agent errors with the next step.
- Server-owned request status (`queued` / `working` / `done` / `error`) with typed error codes, sent to the window as `requestStatus` events.
- `reply_in_window` accepts an optional `requestId` and marks exactly that request done; `pending_requests` prints `requestId` and `[NEW]` for each request.
- English UI by default with a Russian option (`EN | RU` switch, stored in the browser); server errors and system messages follow the window's language. MCP output and agent prompts are English.
- Configurable ports: `LD_UI_PORT` / `LD_SERVER_PORT` (validated at start); the server writes the window's origins into `/inspector.js` when serving it.
- Android: automatic frame refresh with back-off (paused while dragging), device model in the header chip, visible states for missing `adb`, no device and a silent app.
- Unit tests for the server, protocol, ports, i18n, refresh and thread logic; Playwright e2e suite driving the window and a real MCP stdio client (`npm run test:e2e`).
- README media: hero loop (GIF + MP4) and screenshots of the main flow.
- Boot-error screen in the window: if the app script fails to load, rendering crashes or nothing renders within 15 s, the window shows the cause, a hint about `npm run dev` and a "Reload page" button instead of a blank page.
- Window favicon.
- `engines` in `package.json`: Node `^20.19.0 || >=22.12.0` (what Vite 7 requires).

### Changed

- The right-hand side panel and the header "Rebuild tree" / "Reset edits" buttons are replaced by the action palette, element chat and Inbox. Server and inspector indicators show up only when something is wrong.
- Window redesign: dark graphite chrome with a single magenta accent and a white halo around the selection.
- Hit test picks the tightest box under the cursor; depth only breaks ties.
- `pending_requests` with `markConsumed` marks only the requests it returned; one that arrived in between stays new.
- The window works from status and error codes instead of parsing message text.
- README (EN and RU) rewritten for the release: hook, window guide, per-client MCP setup with the `node …/tsx/dist/cli.mjs` command, Windows forms and custom ports, updated limitations and troubleshooting.
- The window's dev server listens on `127.0.0.1`; the window URL is `http://127.0.0.1:<LD_UI_PORT>` (`localhost` still works).
- `npm run dev` starts its children without a shell or `npx` and runs them as one unit: if the server fails to start or any child exits, it stops the others, prints the reason and exits with code 1.

### Fixed

- The built-in agent no longer stays silent for minutes on an authentication failure: the error and a sign-in hint show up within seconds, and retries are visible.
- An agent error result is no longer shown as a normal reply and the request is no longer marked done.
- The frame didn't refresh after the agent finished until a manual reload.
- Under React StrictMode a late `onclose` of a discarded socket showed "Server not responding" while connected.
- Web live edits restore the element's own inline styles when cleared, size overrides work on flex items, and moved elements are measured without counting the move twice.
- Blank white window when the browser reached it over IPv4 while Vite listened only on `::1`.
- `Alt`, `C` and `Esc` stopped working once focus moved into the page; the inspector now forwards them to the window (not while typing in a field).
- MCP "server is unreachable" now names the address it tried, the network error and the variable the address came from, with a hint for a server started on a custom `LD_SERVER_PORT`. A blank `LD_SERVER_URL` falls back to the port instead of an empty address.
- `npm run dev` kept running half-started when the server port was taken.
- The element chat jumped across the screen while it grew; it now stays anchored next to the element.
- Reloading the frame after the agent's reply flashed a white page and "Connecting inspector…"; the old frame now stays visible until the new one sends its first snapshot.
- The selection box and the editing blur jumped back to the pre-drag position for one frame when the reloaded frame took over.
- Killing the dev runner (`scripts/dev.mjs`) outright on Windows instead of pressing Ctrl+C left orphaned node processes holding the ports. The runner now kills whole process trees when it stops, and a detached watchdog takes the runner and its children down when either the runner itself or its parent process (`npm`, or the `cmd`/`sh` it runs the script through) is killed outright — so killing only the `npm` pid no longer leaves vite/tsx holding the ports.

### Security

- Server listens on `127.0.0.1` only; `Origin` / `Host` checks on HTTP and WebSocket; wildcard CORS removed.
- Chat agent writes limited to `projectDir`, excluding `.git/`, `.claude/`, `.mcp.json` and `.env*`; the agent loads project settings only, not user-level ones.
- Inspector accepts messages only from its parent window, whose origins now follow the configured UI port.
- Lockfile refreshed with `npm audit fix` (patch / minor bumps of transitive dependencies: fast-uri, hono, ip-address, nanoid, proxy-addr, qs, source-map-js); `npm audit` reports 0 vulnerabilities.

[Unreleased]: https://github.com/AntonChuraev99/Layout-debug-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AntonChuraev99/Layout-debug-mcp/releases/tag/v0.1.0
