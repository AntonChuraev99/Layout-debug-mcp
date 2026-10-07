/**
 * Where the MCP process looks for the layout-debug server, and what to tell the
 * agent when nothing answers there. Kept apart from index.ts (which connects
 * stdio at import time) so the wording can be unit-tested.
 */
import { DEFAULT_SERVER_PORT } from '../shared/ports.ts'

type Env = Record<string, string | undefined>

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
        'Check that the server listens there (npm run dev prints "[layout-debug] server http://...").',
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
  lines.push('If the server is not running: npm run dev in the layout-debug-mcp directory, and keep it running.')
  return lines.join('\n')
}
