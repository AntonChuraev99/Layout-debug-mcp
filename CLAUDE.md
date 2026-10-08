# layout-debug-mcp

A local tool: shows a running UI (an Android device over adb, or a page in the browser), lets you select any layout layer on the picture, **move elements from the computer so the real screen changes without a rebuild**, and send the edit to an AI agent together with what it needs to find the element in code.

User-facing docs: [README](./README.md). Release notes: [CHANGELOG](./CHANGELOG.md). Plans and bugs: GitHub issues.

## This repository is public

Everything committed here — code, docs, this file, commit messages, PR and issue texts — is published at `github.com/AntonChuraev99/Layout-debug-mcp`. Before writing any of it:

- No secrets, keys, tokens, or hints about them (which key exists, whether it is revoked).
- Nothing about the maintainer's machine, accounts or personal to-dos ("remove the variable", "revoke the key", local paths with a user name).
- No names, files or screens of private apps used for testing — say "a real KMP app" and use `com.example.*` / `<your-project>`.
- Personal working notes go to `.notes/` (git-ignored), never to `docs/`.

## Docs

English, minimal, written for the next contributor, not as a task diary.

| Where | What | Size |
|---|---|---|
| `docs/decisions/` | ADR: context, decision, why, consequences | ≤ 400 words |
| `docs/solutions/` | a non-obvious bug: symptom, cause, fix, test | ≤ 400 words |
| `docs/solutions/INDEX.md` | one row per doc, newest first | — |
| `CHANGELOG.md` | user-visible changes per release | — |
| `.notes/` (git-ignored) | plans, task logs, iteration notes, any language | free |

No `docs/active/`, `docs/archive/`, `docs/todos/` or `docs/backlog/` in this repo: open work is a GitHub issue, history is the ADR, the solution doc, the CHANGELOG and the PR. This overrides the global docs-structure rule for this project; a `doc-task` stub goes to `.notes/`.

## Targets

| Target | Stack | Capture |
|---|---|---|
| **Web** | real DOM (React, Tailwind, anything) | inspector script injected into the page |
| **Android** | Jetpack Compose / Compose Multiplatform | debug-only on-device agent + `adb forward` |

Compose Multiplatform on wasmJs (canvas) is not a target.

## Architecture

The core is a **normalized snapshot**: both adapters return the same format, so the window, the chat and MCP do not know where the data came from.

- `src/server/` — the only part that talks to adb and the target page. Holds the session: snapshot, selection, request queue. HTTP + WebSocket on `127.0.0.1`.
- `src/ui/` — the window (Vite + React): frame (iframe or device screenshot), SVG overlay, action palette, element chat, Inbox.
- `src/inspector/` — the script injected into the web target: DOM snapshot, live edits via inline styles, ghost copy.
- `src/mcp/` — stdio MCP server: `layout_snapshot`, `selected_element`, `pending_requests`, `reply_in_window`.
- `src/shared/` — protocol types, ports.
- `demo/` — a bundled demo page; `tests/e2e/` — Playwright suite driving the window and a real MCP client.

### One agent entry: MCP, for any agent

The tool has no agent of its own. The element chat in the window is answered by whatever agent the user connected over MCP.

MCP is not tied to Claude Code. It must work the same with any MCP client (Claude Code, Claude Desktop, Codex CLI, Cursor, VS Code / Copilot, Devin Desktop, Gemini CLI, Zed) and with the MCP adapters of popular agent SDKs (OpenAI Agents SDK, Vercel AI SDK, LangChain / LangGraph, Claude Agent SDK).

- Only standard MCP over stdio: tools with JSON Schema input and text output. No client-specific extensions, prompts or resources that a tool depends on; no assumptions about which model or client calls it.
- Tool names, descriptions and results are plain English and self-contained: an agent that never saw the README can use them.
- Install is light: connecting the MCP downloads only this package, never an agent runtime or model SDK.
- README setup covers several clients, not only Claude Code; a client-specific config is an example, not the default.

**Listen mode.** MCP is pull-only: the window cannot wake an agent. So when the agent starts a debug session through our tool, the tool result tells it to listen: call the waiting tool, which returns as soon as the user sends a message or an edit from the window. The agent does the work, answers in the window, and waits again until the user ends the session. The waiting tool returns before common client tool-call timeouts, so the agent simply calls it again. The window shows whether an agent is listening; when none is, a sent message stays in the Inbox and the window says how to connect one.

Why it is built this way:

- A browser page, not Electron: no packaging, updates or signing.
- adb is called directly via `child_process`, not through a wrapper like adbkit, so adb errors reach the user as they are.
- On "apply", the window sends raw facts (delta in dp, boxes before and after, parent and siblings, the node's overrides); whether a move becomes padding, offset or a spacer is the agent's call.

Key decisions: [server trust boundary](docs/decisions/local-server-hardening-2026-09-21.md), [Android tree and live overrides](docs/decisions/android-compose-tree-and-live-overrides-2026-07-26.md).

## Commands

```bash
npm run dev          # window + server (+ demo target)
npm run typecheck
npm test             # unit (node:test)
npm run test:e2e     # Playwright
npm run build
```

## Conventions

- The tool never edits the target app's code itself; it collects context and hands it to an agent.
- No silent failures: adb missing, no device, empty dump, agent not attached, target not responding — each shows a visible message with the cause and the next step.
- No tool code in the target's release build: Android agent is `debugImplementation` only, a web build plugin is serve-only.
- Device, ports and project paths are configuration (`layout-debug.config.json`, `LD_*` env), not hard-coded.
- Every new endpoint or MCP tool goes through `src/server/security.ts`.
- Page data (class names, text, anchors, user comments) reaches the agent as marked, length-capped data, never as instructions.
