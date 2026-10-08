# Security policy

## Supported versions

The project is pre-1.0: only the latest `main` gets fixes.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub private vulnerability reporting: [Security → Report a vulnerability](https://github.com/AntonChuraev99/Layout-debug-mcp/security/advisories/new).

Include what you can: affected component (server, UI, inspector, MCP, Android agent), steps to reproduce, impact. You'll get an answer within 7 days.

## Threat model

layout-debug-mcp is a local development tool. It runs a server on your machine, captures screenshots and layout trees of apps you point it at, and hands them to the agent you connect over MCP. It has no agent of its own and never edits files. What it protects against:

| Risk | Protection |
|---|---|
| A web page open in your browser talks to the local server (CSRF, cross-site WebSocket, DNS rebinding) | Server binds `127.0.0.1` only; every request needs a loopback `Host`; state-changing HTTP and WebSocket requests with a foreign `Origin` or a cross-site `Sec-Fetch-Site` are rejected with `403`; no CORS on the API (only the public `inspector.js` bundle is served with `Access-Control-Allow-Origin: *`); the window page can't be framed |
| Page content poses as instructions to your agent (prompt injection) | Text from the inspected page reaches the agent in a block marked as untrusted page data, quoted and length-capped |
| A foreign site embeds your dev page and talks to the inspector | The inspector accepts messages only from its parent window when that window is the tool's origin, and posts only to that origin; the window accepts messages only from its own iframe at the target's origin and posts only to it |
| Oversized or malformed input crashes the server | Request bodies are capped at 256 KB and the connection is dropped past it; snapshots are validated node by node; static paths reject `..`, drive letters and Windows device names |
| Tool code in production | Web inspector is dev-only; Android agent is debug-only |

Known gaps, tracked for 1.0:

- Marking page data reduces prompt injection but can't rule it out: what your agent does with it is up to the agent and the permissions your MCP client gives it.
- The Android on-device agent still lives in a spike app; the published library will listen on loopback / a local abstract socket only.

What the tool does **not** protect against: anything with access to your user account on the machine, and the agent you connect — it receives screenshots and layout data by design.
