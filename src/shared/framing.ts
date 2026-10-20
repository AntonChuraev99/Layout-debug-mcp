/**
 * Framing headers: whether a response lets the window show it in an iframe, and how the
 * opt-in framing proxy rewrites them. Pure, no Node or DOM APIs: the window (detection)
 * and the server (proxy) both import it, and node:test runs it as is.
 *
 * Follows the HTML "X-Frame-Options" processing model and the CSP3 `frame-ancestors`
 * directive, for the one ancestor this tool has: the window itself.
 */

/** What the server's probe of the frame address saw (GET /api/framing). */
export interface FramingHeaders {
  /** Raw `X-Frame-Options` (several headers joined with ", "), or null. */
  xFrameOptions: string | null
  /** Raw enforced `Content-Security-Policy` (several joined with ", "), or null. Report-Only never blocks. */
  contentSecurityPolicy: string | null
}

/** The header that keeps the page out of the window, as the window names it to the user. */
export interface FramingBlock {
  header: 'X-Frame-Options' | 'Content-Security-Policy'
  /** `DENY`, or the `frame-ancestors …` directive alone (not the rest of the policy). */
  value: string
}

/** Longest header value the window repeats back; the rest is cut with an ellipsis. */
const MAX_SHOWN = 200
const shown = (v: string) => (v.length > MAX_SHOWN ? `${v.slice(0, MAX_SHOWN - 1)}…` : v)

// --- X-Frame-Options -----------------------------------------------------------

/** The distinct lowercased values of an `X-Frame-Options` header list; empty for none. */
export function parseXFrameOptions(raw: string | null | undefined): Set<string> {
  const values = new Set<string>()
  if (!raw) return values
  for (const part of raw.split(',')) {
    const v = part.trim().toLowerCase()
    if (v) values.add(v)
  }
  return values
}

/**
 * Whether `X-Frame-Options` alone blocks a page at `targetOrigin` framed by `parentOrigin`
 * (HTML spec): several different values block when one of them is DENY or SAMEORIGIN, and
 * allow otherwise; `ALLOW-FROM` and any other value are invalid and allow.
 */
export function xFrameOptionsBlocks(raw: string | null | undefined, targetOrigin: string, parentOrigin: string): boolean {
  const values = parseXFrameOptions(raw)
  if (values.size > 1) return values.has('deny') || values.has('sameorigin')
  if (values.has('deny')) return true
  if (values.has('sameorigin')) return targetOrigin !== parentOrigin
  return false
}

// --- Content-Security-Policy ----------------------------------------------------

/** One directive of a policy: its lowercased name and the raw text after it. */
interface Directive {
  name: string
  value: string
  raw: string
}

function directivesOf(policy: string): Directive[] {
  const out: Directive[] = []
  for (const token of policy.split(';')) {
    const raw = token.trim()
    if (!raw) continue
    const m = /^(\S+)\s*([\s\S]*)$/.exec(raw)!
    out.push({ name: m[1]!.toLowerCase(), value: m[2]!.trim(), raw })
  }
  return out
}

/** A header value may carry several policies separated by commas (several CSP headers, joined). */
const policiesOf = (csp: string): string[] => csp.split(',')

/**
 * The source list of the first `frame-ancestors` directive of one policy, or null when the
 * policy has none (a repeated directive is ignored, as browsers do).
 */
export function frameAncestorsOf(policy: string): string[] | null {
  const d = directivesOf(policy).find((x) => x.name === 'frame-ancestors')
  if (!d) return null
  return d.value.split(/\s+/).filter(Boolean)
}

/**
 * The policy list without its `frame-ancestors` directives, every other directive kept as
 * written. Null when nothing is left, so the caller drops the header instead of sending an
 * empty one.
 */
export function stripFrameAncestors(csp: string): string | null {
  const kept: string[] = []
  for (const policy of policiesOf(csp)) {
    const directives = directivesOf(policy)
    const rest = directives.filter((d) => d.name !== 'frame-ancestors')
    if (rest.length === directives.length) {
      if (policy.trim()) kept.push(policy.trim())
      continue
    }
    if (rest.length) kept.push(rest.map((d) => d.raw).join('; '))
  }
  return kept.length ? kept.join(', ') : null
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' }

function parseOrigin(origin: string): URL | null {
  try {
    return new URL(origin)
  } catch {
    return null
  }
}

/** A secure upgrade of `allowed` also matches (http → https, ws → wss), as CSP3 says. */
function schemeMatches(allowed: string, actual: string): boolean {
  if (allowed === actual) return true
  return (allowed === 'http:' && actual === 'https:') || (allowed === 'ws:' && actual === 'wss:')
}

/**
 * Whether one `frame-ancestors` source expression lets `parent` frame a page of `self`
 * (both origins). Keywords other than 'self' never match an ancestor; paths are ignored
 * (an ancestor is an origin).
 */
export function sourceMatches(source: string, parentOrigin: string, selfOrigin: string): boolean {
  const parent = parseOrigin(parentOrigin)
  if (!parent) return false
  const s = source.trim()
  const lower = s.toLowerCase()
  if (lower === "'self'") {
    const self = parseOrigin(selfOrigin)
    if (!self) return false
    return (
      parent.origin === self.origin ||
      (schemeMatches(self.protocol, parent.protocol) && parent.hostname === self.hostname &&
        (parent.port || DEFAULT_PORTS[parent.protocol]) === (self.port || DEFAULT_PORTS[self.protocol]))
    )
  }
  if (lower.startsWith("'")) return false
  if (s === '*') return parent.protocol in DEFAULT_PORTS
  // scheme-source: `https:`
  if (/^[a-z][a-z0-9+.-]*:$/i.test(s)) return schemeMatches(lower, parent.protocol)

  // host-source: [scheme "://"] host [":" port] [path]
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[^/:]+|\[[^\]]+\])(?::(\*|\d+))?(?:\/.*)?$/i.exec(s)
  if (!m) return false
  const [, scheme, host, port] = m
  if (scheme) {
    if (!schemeMatches(`${scheme.toLowerCase()}:`, parent.protocol)) return false
  } else {
    const self = parseOrigin(selfOrigin)
    // No scheme: the protected page's own scheme (and its secure upgrade).
    if (!self || !schemeMatches(self.protocol, parent.protocol)) return false
  }
  const h = host!.toLowerCase()
  const actualHost = parent.hostname.toLowerCase()
  if (h === '*') {
    // `*` with a scheme or port: any host.
  } else if (h.startsWith('*.')) {
    if (!actualHost.endsWith(h.slice(1))) return false
  } else if (h !== actualHost) {
    return false
  }
  if (port === '*') return true
  const actualPort = parent.port || DEFAULT_PORTS[parent.protocol]
  if (port === undefined) {
    const expected = scheme ? DEFAULT_PORTS[`${scheme.toLowerCase()}:`] : DEFAULT_PORTS[parent.protocol]
    // A source without a port allows the default port of its scheme, and of the upgrade.
    return actualPort === expected || (expected === '80' && actualPort === '443' && parent.protocol === 'https:')
  }
  return actualPort === port || (port === '80' && actualPort === '443' && parent.protocol === 'https:')
}

/** Whether a `frame-ancestors` source list lets `parent` frame the page: 'none' and an empty list match nothing. */
export function frameAncestorsAllow(sources: string[], parentOrigin: string, selfOrigin: string): boolean {
  return sources.some((src) => sourceMatches(src, parentOrigin, selfOrigin))
}

/**
 * Which header keeps a page at `targetOrigin` out of an iframe in `parentOrigin`, or null
 * when the page may be framed. A `frame-ancestors` directive in any enforced policy makes
 * the browser ignore `X-Frame-Options` altogether; every policy that has one must allow
 * the parent.
 */
export function framingBlock(headers: FramingHeaders, targetOrigin: string, parentOrigin: string): FramingBlock | null {
  let hasFrameAncestors = false
  for (const policy of headers.contentSecurityPolicy ? policiesOf(headers.contentSecurityPolicy) : []) {
    const sources = frameAncestorsOf(policy)
    if (!sources) continue
    hasFrameAncestors = true
    if (!frameAncestorsAllow(sources, parentOrigin, targetOrigin)) {
      return { header: 'Content-Security-Policy', value: shown(['frame-ancestors', ...sources].join(' ')) }
    }
  }
  if (hasFrameAncestors) return null
  if (xFrameOptionsBlocks(headers.xFrameOptions, targetOrigin, parentOrigin)) {
    return { header: 'X-Frame-Options', value: shown(headers.xFrameOptions!.trim()) }
  }
  return null
}

/**
 * The CSP the framing proxy adds in place of what it dropped: only the layout-debug window
 * may frame the page, so the proxy does not open it to framing by any other site.
 */
export function windowOnlyFrameAncestors(windowOrigins: readonly string[]): string {
  return `frame-ancestors ${windowOrigins.join(' ')}`
}
