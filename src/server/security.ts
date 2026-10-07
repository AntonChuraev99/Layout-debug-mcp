import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SERVER_PORT, UI_ORIGINS, UI_PORT } from '../shared/ports.ts'

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
  if (UI_ORIGINS.includes(origin)) return OK
  return deny(`Origin "${origin}" is not the layout-debug window (allowed: ${UI_ORIGINS.join(', ')})`)
}

/** WebSocket `/ws`: the chat, the agent and the device live behind it. */
export function checkWsUpgrade(headers: Headers): Verdict {
  const host = checkHost(headers)
  return host.ok ? checkOrigin(headers) : host
}

/**
 * HTTP `/api/*`. On top of Host and Origin: a cross-site GET (`<img src>`) carries
 * no Origin, but modern browsers label it with Sec-Fetch-Site. The window itself
 * reaches the API through the Vite proxy, so it is always `same-origin`.
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

/** `/inspector.js`, `/demo`: public static, loaded from any page — only Host matters. */
export function checkStaticRequest(headers: Headers): Verdict {
  return checkHost(headers)
}

// --- where the agent may write ----------------------------------------------

/**
 * Canonical path of `p`, following symlinks and junctions even when the file
 * itself does not exist yet: the nearest existing ancestor is resolved and the
 * missing tail is appended. A dangling link is followed to where it points,
 * since that is where a write would land.
 */
function resolveReal(p: string, hops = 0): string | null {
  if (hops > 64) return null
  try {
    return realpathSync.native(p)
  } catch {
    // does not exist (yet) or is a dangling link — handled below
  }
  try {
    if (lstatSync(p).isSymbolicLink()) return resolveReal(resolve(dirname(p), readlinkSync(p)), hops + 1)
  } catch {
    // nothing at p at all
  }
  const parent = dirname(p)
  if (parent === p) return null
  const realParent = resolveReal(parent, hops + 1)
  return realParent === null ? null : join(realParent, basename(p))
}

/**
 * Windows treats `.git.`, `.git ` and `.git::$INDEX_ALLOCATION` as `.git`, and
 * NTFS is case-insensitive. Normalizing the same way everywhere only ever
 * makes the deny list stricter.
 */
function normalizeSegment(segment: string): string {
  return segment.split(':')[0]!.replace(/[. ]+$/, '').toLowerCase()
}

/**
 * Where the chat agent may write: inside `projectDir` after resolving symlinks,
 * never into `.git/` or `.claude/`, never `.mcp.json` or `.env*`.
 */
export function checkWritePath(projectDir: string, target: unknown): Verdict {
  if (typeof target !== 'string' || !target.trim()) return deny('no file path given')
  // `a/link/../b` means different files lexically and on disk; refuse the ambiguity.
  if (target.split(/[\\/]+/).includes('..')) return deny(`paths with ".." are not accepted: ${target}`)

  let root: string
  try {
    root = realpathSync.native(projectDir)
  } catch {
    return deny(`projectDir is not accessible: ${projectDir}`)
  }

  const real = resolveReal(resolve(root, target))
  if (real === null) return deny(`could not resolve the path: ${target}`)

  const rel = relative(root, real)
  if (!rel) return deny('the path points at the project directory itself, not at a file')
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    return deny(`${target} is outside the project (${root}); writes are allowed only inside it`)
  }

  const segments = rel.split(sep).map(normalizeSegment)
  if (segments.includes('.git')) return deny(`${target}: .git/ is internal, the agent may not write there`)
  // The agent loads project settings on every run: a hook or MCP server written
  // here would run as a command next time, past the Bash ban.
  if (segments.includes('.claude')) {
    return deny(`${target}: .claude/ holds Claude Code settings and hooks, the agent may not write there`)
  }
  if (segments.includes('.mcp.json')) {
    return deny(`${target}: .mcp.json registers MCP servers (runs commands), the agent may not change it`)
  }
  if (segments[segments.length - 1]!.startsWith('.env')) {
    return deny(`${target}: .env* files hold environment secrets, the agent may not change them`)
  }
  return OK
}
