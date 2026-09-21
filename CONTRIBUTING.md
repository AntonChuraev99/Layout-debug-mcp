# Contributing

Thanks for looking into this. The project is pre-1.0 and moves fast — open an issue before a large change so we agree on the approach first.

## Dev setup

```bash
git clone https://github.com/AntonChuraev99/Layout-debug-mcp.git
cd Layout-debug-mcp
npm install
npm run dev        # inspector (watch) + server :5175 + UI :5174
```

| Script | What it does |
|---|---|
| `npm run dev` | Everything for local development, demo page at http://localhost:5174 |
| `npm run server` | Server only, with reload |
| `npm run mcp` | MCP stdio server (normally started by your MCP client) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Inspector bundle + UI |
| `npm test` | Unit tests (`node:test`) |

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
