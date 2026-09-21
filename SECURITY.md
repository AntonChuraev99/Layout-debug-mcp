# Security policy

## Supported versions

The project is pre-1.0: only the latest `main` gets fixes.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub private vulnerability reporting: [Security → Report a vulnerability](https://github.com/AntonChuraev99/Layout-debug-mcp/security/advisories/new).

Include what you can: affected component (server, UI, inspector, MCP, Android agent), steps to reproduce, impact. You'll get an answer within 7 days.

## Threat model

layout-debug-mcp is a local development tool. It runs a server on your machine, captures screenshots and layout trees of apps you point it at, and can let an AI agent edit files in a project directory. What it protects against:

| Risk | Protection |
|---|---|
| A web page open in your browser talks to the local server (CSRF, cross-site WebSocket, DNS rebinding) | Server binds `127.0.0.1` only; HTTP and WebSocket requests with a foreign `Origin`, a non-loopback `Host` or a cross-site `Sec-Fetch-Site` are rejected with `403`; no CORS on the API (only the public `inspector.js` bundle is served with `Access-Control-Allow-Origin: *`) |
| The built-in chat agent writes outside the project | A `PreToolUse` hook allows only `Read`, `Edit`, `Write`, `Grep`, `Glob`; writes must resolve (symlinks included) inside `projectDir` and never touch `.git/` or `.env*` |
| The chat agent plants config that executes later (a command hook in `.claude/settings.json`, a server in `.mcp.json`) | Writes to `.claude/` and `.mcp.json` are denied; the agent loads project settings only, never your user-level Claude Code settings, hooks, MCP servers or plugins |
| A foreign site embeds your dev page and talks to the inspector | The inspector accepts messages only from its parent window when that window is the tool's UI origin, and posts only to that origin |
| Tool code in production | Web inspector is dev-only; Android agent is debug-only |

Known gaps, tracked for 1.0:

- Page content (text, class names) is included in the chat agent's prompt as data. A dev page that renders untrusted content could try prompt injection against an agent that has write access to `projectDir`.
- The chat agent can **read** files outside `projectDir`. Together with prompt injection this is a path to leaking data into the project.
- Other files that tools execute on their own (for example `.vscode/tasks.json` with `runOn: folderOpen`, git hooks are already covered by `.git/`) are not on the deny list.
- The tool's window still posts commands to the iframe with target origin `*`; if the framed page navigates to another origin, that origin receives node ids and drag deltas.
- The Android on-device agent still lives in a spike app; the published library will listen on loopback / a local abstract socket only.

What the tool does **not** protect against: anything with access to your user account on the machine, and the agent you connect — it receives screenshots and layout data by design.
