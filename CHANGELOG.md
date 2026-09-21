# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Web target: inspector script for the target page, window with iframe and SVG overlay, layer selection with breadcrumbs, live drag and resize via inline styles, bundled demo page.
- Android target: adapter over `adb forward` to an on-device debug agent — Compose tree with compiler `file:line`, `PixelCopy` screenshot, live overrides without a rebuild.
- Normalized snapshot shared by both targets (`pxPerUnit`, anchors, flat properties).
- Built-in chat on the Claude Agent SDK and an edit request queue.
- MCP stdio server with `layout_snapshot`, `selected_element`, `pending_requests`, `reply_in_window`.

### Security

- Server listens on `127.0.0.1` only; `Origin` / `Host` checks on HTTP and WebSocket; wildcard CORS removed.
- Chat agent writes limited to `projectDir`, excluding `.git/`, `.claude/`, `.mcp.json` and `.env*`; the agent loads project settings only, not user-level ones.
- Inspector accepts messages only from its parent window.
