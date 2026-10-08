/**
 * Origins the window talks to. Pure functions: the call sites pass `location` and the build
 * mode, so these run under node:test as they are.
 */

/**
 * Origin of the page in the frame, for `postMessage` and for checking what comes back.
 * Null when the address has no usable origin (`about:blank`, `file:`, `data:`, garbage):
 * `postMessage` cannot target an opaque origin, and nothing from one is trusted.
 */
export function frameOrigin(src: string | null | undefined): string | null {
  if (!src) return null
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.origin
}

export interface WindowLocation {
  protocol: string
  port: string
}

/**
 * Where the layout-debug server answers, as the target page should load it
 * (`<script src="…/inspector.js">`, the copy in hints).
 *
 * - Packaged: the server serves this window itself, so the window's own port is the server
 *   port, whatever LD_SERVER_PORT it was started with. The port baked into the bundle at
 *   build time would be wrong for any non-default one.
 * - Dev (`npm run dev`): the window comes from Vite on the UI port; the server port is the
 *   one Vite was started with (`bakedPort`).
 *
 * The host is always 127.0.0.1: the server binds there and nothing else.
 */
export function serverOrigin(loc: WindowLocation, dev: boolean, bakedPort: number): string {
  const port = dev || !loc.port ? String(bakedPort) : loc.port
  const protocol = loc.protocol === 'https:' ? 'https:' : 'http:'
  return `${protocol}//127.0.0.1:${port}`
}
