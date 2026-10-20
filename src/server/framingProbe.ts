import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { FramingProbeResponse } from '../shared/protocol.ts'
import { checkProbeTarget, tlsOptionsFor } from './security.ts'

const PROBE_TIMEOUT_MS = 4000
const MAX_REDIRECTS = 5
/** Header values the window gets back; a policy longer than this is cut (the window shows 200 chars at most). */
const MAX_HEADER_CHARS = 4000

export class ProbeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const cap = (v: string | null) => (v === null ? null : v.slice(0, MAX_HEADER_CHARS))

/** Several headers of one name as the browser combines them: joined with ", ". */
function headerValue(res: IncomingMessage, name: string): string | null {
  const v = res.headers[name]
  if (v === undefined) return null
  return Array.isArray(v) ? v.join(', ') : String(v)
}

/**
 * One GET, headers only (the body is not read). node:http rather than fetch, so TLS follows
 * the same rule as the framing proxy (tlsOptionsFor): a self-signed loopback dev server is
 * read, not refused.
 */
function getHeaders(url: URL): Promise<IncomingMessage> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        timeout: PROBE_TIMEOUT_MS,
        ...(url.protocol === 'https:' ? tlsOptionsFor(url) : {}),
      },
      (res) => {
        resolve(res)
        res.destroy()
      },
    )
    req.on('timeout', () => req.destroy(new Error(`no answer in ${PROBE_TIMEOUT_MS / 1000} s`)))
    req.on('error', reject)
    req.end()
  })
}

/**
 * Fetches `raw` the way the iframe will (GET, redirects followed) and returns the framing
 * headers of the page it ends on. Every hop must pass checkProbeTarget: a redirect to some
 * other host is not followed, and the window falls back to its generic timeout message.
 */
export async function probeFraming(raw: string | null, allowedOrigins: readonly string[]): Promise<FramingProbeResponse> {
  let verdict = checkProbeTarget(raw, allowedOrigins)
  for (let hop = 0; ; hop++) {
    if (!verdict.ok) throw new ProbeError(verdict.reason, 400)
    const url = verdict.url
    let res: IncomingMessage
    try {
      res = await getHeaders(url)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      throw new ProbeError(`${url.origin} did not answer: ${code ?? (err as Error).message}`, 502)
    }
    const status = res.statusCode ?? 0
    const location = headerValue(res, 'location')
    if (status >= 300 && status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new ProbeError(`more than ${MAX_REDIRECTS} redirects from ${raw}`, 502)
      let next: string
      try {
        next = new URL(location, url).href
      } catch {
        throw new ProbeError(`${url.href} redirects to an invalid address`, 502)
      }
      verdict = checkProbeTarget(next, allowedOrigins)
      continue
    }
    return {
      url: url.href,
      status,
      xFrameOptions: cap(headerValue(res, 'x-frame-options')),
      contentSecurityPolicy: cap(headerValue(res, 'content-security-policy')),
    }
  }
}
