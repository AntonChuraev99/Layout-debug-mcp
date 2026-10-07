/**
 * Ports of the tool, resolved once from the environment. Node-only: the server,
 * the MCP process and vite.config.ts all import this module, so every Node side
 * sees the same value. The browser bundles never import it — the inspector gets
 * its origins from the server at serve time, the UI through Vite `define`.
 */

export const DEFAULT_UI_PORT = 5174
export const DEFAULT_SERVER_PORT = 5175

/**
 * `raw` unset or blank → `fallback` (same convention as the other LD_* vars).
 * Anything else must be an integer 1..65535; a typo fails loudly instead of
 * silently landing on the default port.
 */
export function parsePort(raw: string | undefined, name: string, fallback: number): number {
  const value = raw?.trim()
  if (!value) return fallback
  const port = /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[layout-debug] ${name}="${raw}" — expected an integer port number from 1 to 65535`)
  }
  return port
}

/** Origins the layout-debug window is served from (Vite dev server). */
export function uiOriginsFor(uiPort: number): readonly string[] {
  return [`http://localhost:${uiPort}`, `http://127.0.0.1:${uiPort}`]
}

function resolvePorts(env: NodeJS.ProcessEnv): { ui: number; server: number } {
  const ui = parsePort(env.LD_UI_PORT, 'LD_UI_PORT', DEFAULT_UI_PORT)
  const server = parsePort(env.LD_SERVER_PORT, 'LD_SERVER_PORT', DEFAULT_SERVER_PORT)
  if (ui === server) {
    throw new Error(`[layout-debug] LD_UI_PORT and LD_SERVER_PORT are the same (${ui}); the window and the server need different ports`)
  }
  return { ui, server }
}

const ports = resolvePorts(process.env)

export const UI_PORT = ports.ui
export const SERVER_PORT = ports.server

/**
 * The only browser pages allowed to drive the server, and the only parent the
 * inspector talks to.
 */
export const UI_ORIGINS: readonly string[] = uiOriginsFor(UI_PORT)
