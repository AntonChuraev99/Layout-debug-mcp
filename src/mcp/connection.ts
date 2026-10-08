/**
 * Where the MCP process looks for the layout-debug server, and what to tell the
 * agent when nothing answers there. Kept apart from index.ts (which connects
 * stdio at import time) so the wording can be unit-tested.
 */
import { DEFAULT_SERVER_PORT } from '../shared/ports.ts'
import { WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS, WAIT_MIN_SECONDS } from '../shared/wait.ts'

type Env = Record<string, string | undefined>

/**
 * Default timeout of wait_for_message: LD_WAIT_SECONDS when it is a whole number
 * from 5 to 50, else 40. A bad value is reported (stderr, never stdout) rather than
 * silently replaced: `warning` is set then.
 */
export function resolveWaitSeconds(env: Env): { seconds: number; warning?: string } {
  const raw = env.LD_WAIT_SECONDS?.trim()
  if (!raw) return { seconds: WAIT_DEFAULT_SECONDS }
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (Number.isInteger(n) && n >= WAIT_MIN_SECONDS && n <= WAIT_MAX_SECONDS) return { seconds: n }
  return {
    seconds: WAIT_DEFAULT_SECONDS,
    warning:
      `[layout-debug] LD_WAIT_SECONDS="${env.LD_WAIT_SECONDS}" is not a whole number from ${WAIT_MIN_SECONDS} ` +
      `to ${WAIT_MAX_SECONDS}; wait_for_message uses ${WAIT_DEFAULT_SECONDS} s`,
  }
}

/** `LD_SERVER_URL` wins when set and non-blank (same convention as the other LD_* vars). */
export function resolveServerBase(env: Env, serverPort: number): string {
  const url = env.LD_SERVER_URL?.trim()
  return url ? url.replace(/\/+$/, '') : `http://127.0.0.1:${serverPort}`
}

/**
 * Message for "fetch failed": names the URL that was tried and the variable it
 * came from. The common trap is a server started on a custom LD_SERVER_PORT while
 * this process, launched by the MCP client with its own env, still uses the default.
 */
export function unreachableMessage(base: string, reason: string, env: Env): string {
  const lines = [`The layout-debug server is unreachable at ${base}: ${reason}`]
  const url = env.LD_SERVER_URL?.trim()
  const port = env.LD_SERVER_PORT?.trim()
  if (url) {
    lines.push(
      `This MCP process takes the address from LD_SERVER_URL=${url}. ` +
        'Check that the server listens there (it prints "[layout-debug] server http://..." on start).',
    )
  } else if (port) {
    lines.push(
      `This MCP process uses LD_SERVER_PORT=${port}. ` +
        'The server must be started with the same LD_SERVER_PORT; otherwise change it in this MCP client\'s config.',
    )
  } else {
    lines.push(
      `This MCP process uses the default port ${DEFAULT_SERVER_PORT} (LD_SERVER_PORT is not set here). ` +
        'If npm run dev was started with LD_SERVER_PORT=<port>, put the same LD_SERVER_PORT ' +
        '(or LD_SERVER_URL=http://127.0.0.1:<port>) into the env of this MCP server in the client config, ' +
        'then restart the client session.',
    )
  }
  lines.push(
    'If the server is not running: call open_window, which starts it ' +
      '(in a layout-debug-mcp checkout, npm run dev starts it too).',
  )
  return lines.join('\n')
}
