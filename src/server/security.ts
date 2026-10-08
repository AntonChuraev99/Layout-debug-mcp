import type { IncomingHttpHeaders } from 'node:http'
import { join, relative, resolve, sep, isAbsolute } from 'node:path'
import { SERVER_PORT, UI_PORT, WINDOW_ORIGINS } from '../shared/ports.ts'

/**
 * Pure checks behind the server's trust boundary. Kept free of I/O on the
 * request side so they can be tested without a running server.
 */

export type Verdict = { ok: true } | { ok: false; reason: string }

const OK: Verdict = { ok: true }
const deny = (reason: string): Verdict => ({ ok: false, reason })

type Headers = IncomingHttpHeaders | Record<string, string | string[] | undefined>

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

// --- who may talk to the server ---------------------------------------------

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]']
/**
 * Direct hits carry the server port. The Vite proxy forwards `/ws` without
 * `changeOrigin`, so those arrive with the UI's Host (`localhost:5174`).
 */
const ALLOWED_HOSTS = new Set(LOOPBACK_NAMES.flatMap((name) => [SERVER_PORT, UI_PORT].map((p) => `${name}:${p}`)))

/**
 * DNS rebinding: a hostile page whose name now resolves to 127.0.0.1 reaches the
 * server as "same-origin", but its Host header still names the attacker's domain.
 */
export function checkHost(headers: Headers): Verdict {
  const host = header(headers, 'host')?.trim().toLowerCase()
  if (!host) return deny('no Host header')
  if (!ALLOWED_HOSTS.has(host)) return deny(`Host "${host}" is not a loopback address of this server (looks like DNS rebinding)`)
  return OK
}

/**
 * Browsers always send Origin on WebSocket handshakes and cross-origin POSTs.
 * No Origin at all means a local non-browser client (the MCP process, curl) —
 * those are already inside the trust boundary.
 */
export function checkOrigin(headers: Headers): Verdict {
  const origin = header(headers, 'origin')
  if (origin === undefined) return OK
  if (WINDOW_ORIGINS.includes(origin)) return OK
  return deny(`Origin "${origin}" is not the layout-debug window (allowed: ${WINDOW_ORIGINS.join(', ')})`)
}

/** WebSocket `/ws`: the chat, the request queue and the device live behind it. */
export function checkWsUpgrade(headers: Headers): Verdict {
  const host = checkHost(headers)
  return host.ok ? checkOrigin(headers) : host
}

/**
 * HTTP `/api/*`. On top of Host and Origin: a cross-site GET (`<img src>`) carries
 * no Origin, but modern browsers label it with Sec-Fetch-Site. The window itself
 * reaches the API from the server's own origin (package) or through the Vite proxy
 * (dev), so it is always `same-origin`.
 */
export function checkApiRequest(headers: Headers): Verdict {
  const base = checkWsUpgrade(headers)
  if (!base.ok) return base
  const site = header(headers, 'sec-fetch-site')
  if (site === 'cross-site' || site === 'same-site') {
    return deny(`request from another site (Sec-Fetch-Site: ${site})`)
  }
  return OK
}

/**
 * POST /api/shutdown: stops the whole server, so it is for local non-browser clients
 * only (open_window replacing a stale server). The demo page is same-origin with the
 * API in the package and would pass checkApiRequest; any browser request carries
 * Origin (POST) or Sec-Fetch-Site, the MCP process sends neither.
 */
export function checkShutdownRequest(headers: Headers): Verdict {
  const base = checkApiRequest(headers)
  if (!base.ok) return base
  if (header(headers, 'origin') !== undefined || header(headers, 'sec-fetch-site') !== undefined) {
    return deny('/api/shutdown is for local tools only, not for browser pages')
  }
  return OK
}

/**
 * `/inspector.js`, `/demo`, the window's own files: public static, loaded from any
 * page — only Host matters (it is what stops DNS rebinding from reading them).
 */
export function checkStaticRequest(headers: Headers): Verdict {
  return checkHost(headers)
}

// --- which file a static path names ----------------------------------------

/**
 * Windows opens a device instead of a file for these names in any directory and
 * with any extension (`nul.html`, `COM1.txt`), and ignores trailing dots and spaces.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i

function isReservedSegment(segment: string): boolean {
  const stem = segment.replace(/[. ]+$/, '').split('.')[0]!.trim()
  return WINDOWS_RESERVED.test(stem)
}

/**
 * The file under `root` that the URL path `rel` names, or null when it names
 * nothing servable: `..` segments, NUL bytes, drive letters or alternate data
 * streams (`:`), backslashes, Windows device names, or a result outside `root`.
 * Pure (no file system access), so it is tested directly.
 */
export function resolveStaticPath(root: string, rel: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    return null
  }
  if (/[\0\\:]/.test(decoded)) return null
  const segments = decoded.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.some((s) => s === '..' || isReservedSegment(s))) return null
  const base = resolve(root)
  const file = resolve(base, join(...(segments.length ? segments : ['.'])))
  const inside = relative(base, file)
  // `root` itself is a directory, never a file to serve.
  if (inside === '' || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) return null
  return file
}

