# Contributing

Thanks for looking into this. The project is pre-1.0 and moves fast — open an issue before a large change so we agree on the approach first.

## Dev setup

Node.js `^20.19.0 || >=22.12.0` (the `engines` field in `package.json`; Vite 7 needs it).

```bash
git clone https://github.com/AntonChuraev99/Layout-debug-mcp.git
cd Layout-debug-mcp
npm install
npm run dev        # inspector (watch) + server :5175 + UI :5174
```

Ports are overridable: `LD_UI_PORT` (window, default 5174) and `LD_SERVER_PORT` (server, default 5175), e.g. `LD_UI_PORT=5284 LD_SERVER_PORT=5285 npm run dev` (PowerShell: `$env:LD_UI_PORT=5284; $env:LD_SERVER_PORT=5285; npm run dev`). Use them to run a second instance next to one that is already up.

`npm run dev` (`scripts/dev.mjs`) starts the children without a shell and treats them as one unit: if the server fails to start or any child exits, it stops the rest, prints the reason and exits with code 1. Stopping it kills the whole process tree. A detached watchdog (`scripts/dev-watchdog.mjs`) polls twice a second and takes the runner and its children down when the runner is killed outright or when its parent goes away — the parent being the process that started it, captured at start (`npm` or the `cmd`/`sh` npm runs the script through). So Task Manager "End task" on npm, `Stop-Process -Id <npm pid>` or a tool that kills only the pid it spawned no longer leaves anything holding the ports. Not covered: killing the watchdog together with the runner, and a launcher that has already exited by the time the runner starts (then there is no parent to watch). Ctrl+C remains the normal way to stop.

| Script | What it does |
|---|---|
| `npm run dev` | Everything for local development, demo page at http://127.0.0.1:5174 |
| `npm run server` | Server only, with reload |
| `npm run mcp` | MCP stdio server (normally started by your MCP client) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Inspector bundle + UI |
| `npm test` | Unit tests (`node:test`) |
| `npm run test:e2e` | Playwright e2e suite (window + real MCP stdio client) |

## Layout

```
src/shared/protocol.ts   snapshot format and every message — the shared vocabulary of all processes
src/inspector/           script inside the target page: DOM walk + live overrides
src/ui/                  React window: iframe / device frame, overlay, selection, drag, chat
src/server/              Node: session state, WebSocket, adb adapter, Claude Agent SDK bridge
src/mcp/                 stdio MCP server over the server's local HTTP API
demo/                    page for trying the tool without setup
```

Design decisions and the history of the Android spikes are in [CLAUDE.md](./CLAUDE.md) (in Russian; it doubles as instructions for coding agents).

## Rules the code follows

- **No silent failures.** adb missing, no device, empty tree, agent not in the app, dev server down, iframe blocked — every case shows a visible message in the UI with the reason and the next step.
- **Nothing in release builds.** The web inspector is dev-only; Android code is `debugImplementation` only.
- **Paths and ports are config, not literals.** The tool must move between projects and machines.
- **stdout is the MCP protocol.** In `src/mcp/` never write to stdout — logs go to stderr, or the JSON-RPC stream breaks.
- **The tool doesn't edit the target app itself.** It collects context and hands it to an agent.
- **Snapshot format is shared.** A change in `src/shared/protocol.ts` touches the inspector, the server, the UI, MCP and the Android agent — update them together.

## Tests

Pure logic (tree collapsing, hit testing, unit conversion, config precedence, security checks) gets unit tests next to the code as `*.test.ts`. UI wiring and platform integration are verified by running the tool.

## Pull requests

- Branch from `main`, one topic per PR.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(android): ...`, `fix(server): ...`, `docs: ...`.
- Before opening: `npm run typecheck && npm run build && npm test`.
- UI changes: attach a before/after screenshot.
- Behaviour visible to users goes into `CHANGELOG.md` under `Unreleased`.
