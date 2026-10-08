# Local runtime pitfalls: white window, silent agent, orphan processes on Windows

Date: 2026-10-06.

## 1. The window sometimes opens blank

**Symptom.** About 1 cold start in 41 (approx.): React does not mount, the page is white, no error.

**Cause.** Vite without `server.host` listens on the first address Node resolves for `localhost`; on Windows 11 that is `::1`. The browser sometimes opens one connection over IPv4, a module request gets `ERR_CONNECTION_REFUSED`, and the import chain of `main.tsx` breaks.

**Fix.** `server.host: '127.0.0.1'` in `vite.config.ts`; e2e uses `http://127.0.0.1:<port>`. A boot watchdog in `index.html` shows the cause instead of a blank page.

## 2. The built-in agent hangs silently

**Symptom.** After an edit is sent, the element shows "Agent editing" for minutes; no error, no reply.

**Cause.** Without valid auth the Claude Agent SDK gets `401 authentication_failed` and retries 10 times as `system/api_retry` events, which `extract()` in `src/server/agent.ts` ignored. Also, the `result` string was read before `is_error`, so an error text reached the chat as a normal reply.

**Fix.** A 401 stops the request at once with an auth error and a sign-in hint; `is_error` is checked first; the request ends as `error`, not `done`. Covered by `src/server/agent.test.ts`.

## 3. Ports stay taken after `npm run dev` is stopped

**Symptom.** On Windows, after a stop from the IDE or a kill of the npm pid, ports 5174/5175 stay taken and the next start fails.

**Cause.** Children ran through `shell: true`; `child.kill()` killed `cmd`, not the tree. The runner's handlers do not run on a hard kill, and a kill of npm alone is not seen by the runner at all.

**Fix.** `scripts/dev.mjs` starts children as `node <bin>` without a shell and kills whole trees (`taskkill /T /F` on Windows, process groups on POSIX). `scripts/dev-watchdog.mjs` watches the runner and its parent and stops the children when either disappears. Verified on Windows; the POSIX path is not verified yet (#25).
