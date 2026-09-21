---
title: "Граница доверия локального сервера и чат-агента"
summary: "Любая открытая вкладка могла через WebSocket управлять агентом с правом записи. Закрыто: bind 127.0.0.1, Host/Origin/Sec-Fetch-Site, PreToolUse-хук на запись, origin-allowlist в инспекторе."
date: 2026-09-21
type: decision
modules: [server, inspector, agent]
keywords: [permission, dns-rebinding, websocket-origin, cors, PreToolUse, canUseTool, claude-agent-sdk, postMessage, loopback, web, android]
project: layout-debug-mcp
---

# Граница доверия локального сервера и чат-агента

**Суть:** все проверки заголовков — чистые функции в `src/server/security.ts`, запись агента режет PreToolUse-хук `toolGuard` в `src/server/agent.ts`. Новый эндпоинт или инструмент агента проходит через них, иначе граница дырявая.

## Проблема / Контекст

Сервер слушал все интерфейсы, WebSocket не проверял `Origin`, на ответах стоял `Access-Control-Allow-Origin: *`. Страница evil.com открывала `ws://localhost:5175/ws`, слала `submit`, и чат-агент с `Write`/`Edit` менял файлы в `projectDir` — код исполнялся на следующем `npm run dev`.

## Решение

- `listen(SERVER_PORT, '127.0.0.1')`; адреса по умолчанию — `127.0.0.1`, не `localhost`.
- `checkHost`: только loopback-имя с портом 5175 или 5174 — от DNS rebinding.
- `checkOrigin`: Origin отсутствует (MCP, curl) или из `UI_ORIGINS`.
- `/api/*` дополнительно режет `Sec-Fetch-Site: cross-site | same-site`.
- WebSocket — `verifyClient` с `checkWsUpgrade`; отказ — 403 и строка в лог.
- Запись агента — `checkWritePath`: realpath внутри `projectDir`, без `..`, `.git`, `.claude`, `.mcp.json`, `.env*`; инструменты вне `ALLOWED_TOOLS` запрещены; `settingSources: ['project']` — пользовательские настройки в агент не грузятся.
- Инспектор принимает сообщения только от `window.parent` с origin из `UI_ORIGINS` и шлёт только туда.

## Почему именно так

`canUseTool` не зовётся для инструментов из `allowedTools` (источник: `sdk.d.ts` 0.3.220); отказ PreToolUse-хука сильнее любого allow. Без `settingSources` грузятся все источники — агент мог записать command-хук в `.claude/settings.json` (нашло ревью гейта). 5174 в `ALLOWED_HOSTS`: прокси Vite шлёт `/ws` без `changeOrigin`. `event.source` мало: встроивший dev-страницу сайт сам становится `window.parent`. `127.0.0.1`: у автора `[::1]:5175` занимал чужой Vite.

## Связанные файлы

- `src/server/security.ts`, `src/server/security.test.ts`
- `src/server/index.ts`, `src/server/agent.ts`, `src/inspector/index.ts`, `src/shared/ports.ts`
- `SECURITY.md` — модель угроз и известные пробелы
