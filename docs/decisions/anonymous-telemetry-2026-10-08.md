---
title: "Anonymous opt-out telemetry over Amplitude HTTP"
date: 2026-10-08
type: decision
keywords: [telemetry, amplitude, opt-out, DO_NOT_TRACK, privacy, analytics]
---

# Anonymous opt-out telemetry over Amplitude HTTP

## Context

After the npm release we could not see who uses the tool, with which client and target, or where it fails for people who never open an issue. MCP itself defines no telemetry, and the MCP-specific analytics SDKs we looked at (AgentCat/MCPcat, Sentry MCP monitoring, Shinzo) either add a `context` argument to every tool schema and capture tool arguments by default, or pull a large OpenTelemetry tree into every `npx` install. They also see only the MCP process, while the window funnel and adb errors live in the server process.

## Decision

- Own module `src/shared/telemetry.ts` on the global `fetch`, no new dependency. Events go to Amplitude HTTP V2 (`api2.amplitude.com/2/httpapi`), at most 10 per request, one retry on 5xx with the same `insert_id`, dropped otherwise.
- Typed events with a per-event allow-list of property names; strings capped at 64 characters; numbers sent as buckets. No `ip` field is sent, so Amplitude records no location (checked on a test event: city, country and IP are empty).
- Opt-out, on by default: off with `LD_TELEMETRY=0`, `DO_NOT_TRACK`, `CI`, or `layout-debug-mcp telemetry off` (persisted). `LD_TELEMETRY_DEBUG=1` prints events instead of sending. The first run prints a notice to stderr, the window shows a one-time notice, and `open_window` mentions it until that notice is closed.
- A random device id in a state file in the user config dir (`telemetryDir` in `telemetry.ts`), shared by the MCP and server processes, which also gets the client name via `LD_TELEMETRY_CLIENT`.
- Batched sends, flushed on a timer and on exit with a short deadline (`FLUSH_INTERVAL_MS`, `DEFAULT_FLUSH_DEADLINE_MS`); never throws, never writes to stdout. Tests run with `LD_TELEMETRY=0`.

## Why this way

- Opt-in would leave almost no data from organic users; opt-out with a notice and `DO_NOT_TRACK` is common for developer CLIs (source: nextjs.org/telemetry, turborepo.dev/docs/telemetry).
- Events are sent from the first run, so first-session failures (the most useful ones) are not lost.
- The Amplitude API key is a public ingestion key; spam is possible, and key rotation is the response.

## Consequences

- A random persistent id is pseudonymous, not anonymous, under GDPR; the README lists what is sent and how to request deletion.
- SIGKILL of the MCP process loses unflushed events.
- Adding an event means adding its type and allow-list entry in `telemetry.ts` and a README line.
