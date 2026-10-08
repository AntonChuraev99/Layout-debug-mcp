---
title: "MCP as the only agent entry, with listen mode"
date: 2026-10-08
type: decision
keywords: [mcp, long-poll, wait_for_message, open_window, npx, claude-agent-sdk, agent-agnostic]
---

# MCP as the only agent entry, with listen mode

## Context

Up to v0.1 the window had two agent entries: a built-in chat on `@anthropic-ai/claude-agent-sdk` and an MCP server that an agent had to be asked to poll. For `npx` the SDK was a problem: it pulls the Claude Code binary for the platform (about 250 MB unpacked; source: `npm view @anthropic-ai/claude-agent-sdk-win32-x64 dist.unpackedSize`, 0.3.293), which every MCP-only user would download without using. The built-in agent also carried most of the security surface.

## Decision

- Remove the built-in agent and the SDK. The window's chat is answered by the agent the user connected over MCP. The package depends only on `@modelcontextprotocol/sdk`, `ws` and `zod`.
- Listen mode instead of push. `open_window` starts the server (detached, `process.execPath`, no shell), opens the browser and tells the agent to loop. `wait_for_message` is a long-poll on `POST /api/requests/wait`: it returns a queued request at once, or "no message yet" after the timeout (default in `src/mcp/connection.ts`, `LD_WAIT_SECONDS`).
- The loop rule is written in three places: server `instructions` (under 450 characters), the `open_window` result and the footer of every `wait_for_message` result.
- A request is marked `working` only after the wait response is written; a dropped call releases the waiter without consuming. The window shows "agent listening" while a wait is open, for a short grace after it (`src/server/waiters.ts`), and while a request handed out by a wait is still `working`.
- Default bin is the MCP server, so every client uses `npx -y layout-debug-mcp`; `window` runs the server in the foreground.

## Why this way

- MCP has no universal server-to-agent push: sampling is deprecated in the 2026-07-28 spec, elicitation shows the client's own form, and Claude Code channels work in one client only. A long-poll tool works in all of them.
- Most clients cut a tool call at about 60 s (source: Codex, Claude Code MCP docs and Cursor forum, checked 2026-10-08), and progress notifications don't reliably extend it. The default wait stays under that.
- Spawning the user's agent CLI would not cover IDE agents.

## Consequences

- An idle listening agent spends some context per empty poll.
- An agent may leave the loop; the window then says "No agent listening" and how to resume.
- The write guard and its known gaps went away with `src/server/agent.ts`.
