/**
 * Long-poll limits of listen mode, shared by the server (POST /api/requests/wait) and
 * the MCP tool (wait_for_message), so both accept exactly the same range. The upper
 * bound stays under common MCP client tool-call timeouts (60 s).
 */
export const WAIT_MIN_SECONDS = 5
export const WAIT_MAX_SECONDS = 50
export const WAIT_DEFAULT_SECONDS = 40

/**
 * `?timeout=` of POST /api/requests/wait: absent or blank → the default; otherwise a
 * whole number of seconds within the limits, or null when it is not one.
 */
export function parseWaitTimeout(raw: string | null | undefined): number | null {
  const value = raw?.trim()
  if (!value) return WAIT_DEFAULT_SECONDS
  if (!/^\d+$/.test(value)) return null
  const n = Number(value)
  return n >= WAIT_MIN_SECONDS && n <= WAIT_MAX_SECONDS ? n : null
}
