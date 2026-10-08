---
title: "Trust boundary of the local server and the chat agent"
date: 2026-09-21
type: decision
keywords: [dns-rebinding, websocket-origin, cors, PreToolUse, claude-agent-sdk, postMessage, loopback]
---

# Trust boundary of the local server and the chat agent

## Context

The server listened on all interfaces, the WebSocket did not check `Origin`, and responses carried `Access-Control-Allow-Origin: *`. Any open tab could connect to `ws://localhost:5175/ws`, send `submit`, and make the chat agent write files in `projectDir`.

## Decision

- Listen on `127.0.0.1`; default addresses use `127.0.0.1`, not `localhost`.
- `checkHost`: loopback host names on the tool's ports only (DNS rebinding). The window port is allowed too: the Vite proxy forwards `/ws` without `changeOrigin`.
- `checkOrigin`: no `Origin` (MCP, curl) or one of `UI_ORIGINS`; `/api/*` also rejects `Sec-Fetch-Site: cross-site | same-site`.
- WebSocket upgrade goes through `checkWsUpgrade`; a refusal is a 403 plus a log line.
- Agent writes go through `checkWritePath` in a PreToolUse hook: real path inside `projectDir`, no `..`, `.git`, `.claude`, `.mcp.json`, `.env*`. Tools outside `ALLOWED_TOOLS` are denied. `settingSources: ['project']` keeps user-level settings out of the agent.
- The inspector accepts messages only from `window.parent` with an origin from `UI_ORIGINS` and posts only there.

## Why this way

- `canUseTool` is not called for tools listed in `allowedTools`; a PreToolUse deny wins over any allow.
- Without `settingSources` the SDK loads every source, so the agent could write a command hook into the target project's Claude Code settings file.
- `event.source` alone is not enough: a site that embeds the dev page becomes `window.parent` itself.

## Rule

Every new endpoint or MCP tool goes through `src/server/security.ts`. Threat model and known gaps: `SECURITY.md`.

## Update 2026-10-08

The chat agent was removed in v0.2 ([MCP as the only agent entry](mcp-only-listen-mode-2026-10-08.md)), and with it `checkWritePath`, `ALLOWED_TOOLS`, `settingSources` and the `toolGuard` hook. The packaged server also serves the window on its own port, so the allowed origins are the Vite window and the server port. The window posts to the iframe's origin and accepts messages only from it.
