import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import { stripFrameAncestors, windowOnlyFrameAncestors } from '../shared/framing.ts'
import { checkProxyRequest, proxyUpstreamUrl, tlsOptionsFor } from './security.ts'

/**
 * Opt-in dev proxy for a web target that forbids framing (`X-Frame-Options`, CSP
 * `frame-ancestors`). It listens on 127.0.0.1, forwards every request to the configured
 * target's origin and nowhere else, and changes only the framing headers: they are dropped,
 * and one `frame-ancestors` naming the layout-debug window takes their place, so the page
 * can be framed by the window and by no other site. Bodies pass through untouched.
 * Decision record: docs/decisions/framing-proxy-2026-10-20.md.
 */

/** Hop-by-hop headers (RFC 9110 §7.6.1): they describe one connection and are never forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Header names the `Connection` header lists are hop-by-hop too. */
function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const raw = headers.connection
  const list = Array.isArray(raw) ? raw.join(',') : (raw ?? '')
  return new Set(list.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
}

/**
 * `value` with a leading `from` origin replaced by `to`; anything else as it is. A
 * scheme-relative `//host:port/…` naming `from`'s host is replaced too (with `to` in full:
 * resolved against the proxy it would keep the target's host).
 */
function swapOrigin(value: string, from: string, to: string): string {
  const startsWith = (prefix: string) =>
    value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`) || value.startsWith(`${prefix}#`)
  if (startsWith(from)) return to + value.slice(from.length)
  const schemeRelative = from.replace(/^[a-z][a-z0-9+.-]*:/i, '')
  if (startsWith(schemeRelative)) return to + value.slice(schemeRelative.length)
  return value
}

/**
 * Cookies of the proxied page live on host 127.0.0.1, which browsers share across every
 * port. So each proxy keeps its own namespace: Set-Cookie names get this prefix, and only
 * cookies carrying it go to the target (prefix stripped). Cookies of other local servers
 * never reach the target, and the target's cookies don't collide with theirs.
 */
export function cookiePrefixFor(proxyOrigin: string): string {
  return `ldp${new URL(proxyOrigin).port}_`
}

/** The `Cookie` header for the target: only this proxy's cookies, unprefixed; null for none. */
export function proxyRequestCookies(header: string | string[] | undefined, prefix: string): string | null {
  if (!header) return null
  const kept: string[] = []
  for (const pair of (Array.isArray(header) ? header.join('; ') : header).split(';')) {
    const p = pair.trim()
    if (p.startsWith(prefix) && p.length > prefix.length) kept.push(p.slice(prefix.length))
  }
  return kept.length ? kept.join('; ') : null
}

/** One `Set-Cookie` of the target, renamed into this proxy's namespace, with `Domain` dropped (host-only on 127.0.0.1). */
export function proxySetCookie(value: string, prefix: string): string {
  const [first, ...attrs] = value.split(';')
  const kept = attrs.filter((a) => !/^\s*domain\s*=/i.test(a))
  return [`${prefix}${first!.trim()}`, ...kept.map((a) => a.trim())].join('; ')
}

/**
 * Request headers as the target should see them: its own Host (dev servers check it), and
 * Origin / Referer of the proxy rewritten to the target, so the page's own requests still
 * look same-origin to it. A WebSocket upgrade keeps `Connection` / `Upgrade`.
 */
export function proxyRequestHeaders(
  headers: IncomingHttpHeaders,
  target: URL,
  proxyOrigin: string,
  upgrade = false,
): OutgoingHttpHeaders {
  const listed = connectionTokens(headers)
  const out: OutgoingHttpHeaders = {}
  for (const [name, v] of Object.entries(headers)) {
    if (v === undefined) continue
    const key = name.toLowerCase()
    if (!upgrade && (HOP_BY_HOP.has(key) || listed.has(key))) continue
    if (key === 'host') continue
    if (key === 'cookie') {
      const kept = proxyRequestCookies(v, cookiePrefixFor(proxyOrigin))
      if (kept) out.cookie = kept
      continue
    }
    if (key === 'origin' || key === 'referer') {
      out[key] = swapOrigin(String(v), proxyOrigin, target.origin)
      continue
    }
    out[key] = v
  }
  out.host = target.host
  return out
}

/**
 * Response headers as the window should see them: `X-Frame-Options` dropped, the
 * `frame-ancestors` directive taken out of every enforced CSP (every other directive kept),
 * one CSP added that lets only the window frame the page, and redirects to the target
 * pointed back at the proxy.
 */
export function proxyResponseHeaders(
  headers: IncomingHttpHeaders,
  target: URL,
  proxyOrigin: string,
  windowOrigins: readonly string[],
): OutgoingHttpHeaders {
  const listed = connectionTokens(headers)
  const out: OutgoingHttpHeaders = {}
  const csp: string[] = []
  for (const [name, v] of Object.entries(headers)) {
    if (v === undefined) continue
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key) || listed.has(key)) continue
    if (key === 'x-frame-options') continue
    if (key === 'content-security-policy') {
      const kept = stripFrameAncestors(Array.isArray(v) ? v.join(', ') : String(v))
      if (kept) csp.push(kept)
      continue
    }
    if (key === 'location') {
      out[key] = swapOrigin(String(v), target.origin, proxyOrigin)
      continue
    }
    if (key === 'set-cookie') {
      const prefix = cookiePrefixFor(proxyOrigin)
      out[key] = (Array.isArray(v) ? v : [String(v)]).map((c) => proxySetCookie(c, prefix))
      continue
    }
    out[key] = v
  }
  // A comma-separated list is several policies, each enforced: the page's own, and the framing rule.
  out['content-security-policy'] = [...csp, windowOnlyFrameAncestors(windowOrigins)].join(', ')
  return out
}

export interface FramingProxyOptions {
  port: number
  /** The configured target URL; only its origin is proxied. */
  targetUrl: string
  windowOrigins: readonly string[]
  /** Text of the page shown in the frame when the target can't be reached (the window's language). */
  unreachableText: (target: string, reason: string) => string
}

export interface FramingProxy {
  server: Server
  /** `http://127.0.0.1:<port>`: what the window loads instead of the target origin. */
  origin: string
  /** The proxied origin. */
  target: string
}

const LISTEN_HOST = '127.0.0.1'

/** Starts the proxy; rejects with the listen error (port in use) so the server can say so at start. */
export function startFramingProxy(opts: FramingProxyOptions): Promise<FramingProxy> {
  const target = new URL(opts.targetUrl)
  // Set once listening: port 0 (tests) means "any free port".
  let port = opts.port
  let origin = `http://${LISTEN_HOST}:${port}`
  const secure = target.protocol === 'https:'
  const send = secure ? httpsRequest : httpRequest
  // The same TLS rule as the framing probe: loopback self-signed is fine, remote is checked.
  const tls = secure ? tlsOptionsFor(target) : {}

  const refuse = (req: IncomingMessage): string | null => {
    const verdict = checkProxyRequest(req.method, req.url, req.headers, port)
    if (!verdict.ok) {
      console.warn(`[layout-debug] framing proxy rejected ${req.method} ${req.url?.slice(0, 200)}: ${verdict.reason}`)
      return verdict.reason
    }
    return null
  }

  const server = createServer((req, res) => {
    const reason = refuse(req)
    const upstream = reason ? null : proxyUpstreamUrl(target, req.url!)
    if (reason || !upstream) {
      res.writeHead(reason ? 403 : 400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(reason ?? 'the request path does not stay on the proxied target')
      return
    }
    const up = send(upstream, { method: req.method, headers: proxyRequestHeaders(req.headers, target, origin), ...tls }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, proxyResponseHeaders(upRes.headers, target, origin, opts.windowOrigins))
      upRes.pipe(res)
      upRes.on('error', () => res.destroy())
    })
    up.on('error', (err) => {
      console.warn(`[layout-debug] framing proxy: ${req.method} ${upstream.href} failed: ${err.message}`)
      if (res.headersSent) return void res.destroy()
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(opts.unreachableText(target.origin, err.message))
    })
    req.pipe(up)
    req.on('error', () => up.destroy())
  })

  // WebSocket / HMR: the handshake goes to the target with the same header rewrite, then the
  // two sockets are piped as they are.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy())
    const reason = refuse(req)
    const upstream = reason ? null : proxyUpstreamUrl(target, req.url!)
    if (reason || !upstream) {
      socket.end(`HTTP/1.1 ${reason ? '403 Forbidden' : '400 Bad Request'}\r\nconnection: close\r\n\r\n`)
      return
    }
    const up = send(upstream, { method: req.method, headers: proxyRequestHeaders(req.headers, target, origin, true), ...tls })
    up.on('upgrade', (upRes, upSocket, upHead) => {
      upSocket.on('error', (err) => {
        console.warn(`[layout-debug] framing proxy: WebSocket ${upstream.href} dropped by the target: ${err.message}`)
        socket.destroy()
      })
      socket.on('error', (err) => console.warn(`[layout-debug] framing proxy: WebSocket ${upstream.href} dropped by the page: ${err.message}`))
      socket.on('close', () => upSocket.destroy())
      upSocket.on('close', () => socket.destroy())
      const lines = [`HTTP/1.1 101 ${upRes.statusMessage || 'Switching Protocols'}`]
      const prefix = cookiePrefixFor(origin)
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        const name = upRes.rawHeaders[i]!
        const value = upRes.rawHeaders[i + 1]!
        lines.push(`${name}: ${name.toLowerCase() === 'set-cookie' ? proxySetCookie(value, prefix) : value}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upHead.length) socket.write(upHead)
      if (head.length) upSocket.write(head)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })
    // The target answered without switching protocols (refused, 404): hand that answer back.
    up.on('response', (upRes) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? ''}`.trimEnd(), 'connection: close']
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      upRes.pipe(socket)
    })
    up.on('error', (err) => {
      console.warn(`[layout-debug] framing proxy: WebSocket to ${upstream.href} failed: ${err.message}`)
      socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n')
    })
    up.end()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, LISTEN_HOST, () => {
      server.off('error', reject)
      port = (server.address() as { port: number }).port
      origin = `http://${LISTEN_HOST}:${port}`
      server.on('error', (err) => console.warn(`[layout-debug] framing proxy error: ${err.message}`))
      resolve({ server, origin, target: target.origin })
    })
  })
}
