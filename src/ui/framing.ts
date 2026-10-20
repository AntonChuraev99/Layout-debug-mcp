import type { FramingProxyInfo } from '../shared/protocol.ts'
import { frameOrigin } from './origins.ts'

/**
 * The next step the "can't be shown in a frame" banner offers. Pure, so node:test runs it.
 *
 * - `enableProxy`: no proxy yet; restart with it on for this page.
 * - `otherTarget`: the proxy is on, but for another origin than this page.
 * - `redirectedAway`: the frame goes through the proxy, but the page redirected to an origin
 *   the proxy doesn't cover (`origin`); restarting with this page as the target changes nothing.
 */
export type FramingFix =
  | { kind: 'enableProxy' }
  | { kind: 'otherTarget'; target: string }
  | { kind: 'redirectedAway'; origin: string; target: string }

/** `frameSrc`: what the iframe loads; `probeUrl`: where the probe's redirects ended. */
export function framingFix(frameSrc: string, probeUrl: string, proxy: FramingProxyInfo | null): FramingFix {
  if (!proxy) return { kind: 'enableProxy' }
  const ended = frameOrigin(probeUrl)
  if (frameOrigin(frameSrc) === proxy.origin && ended && ended !== proxy.origin) {
    return { kind: 'redirectedAway', origin: ended, target: proxy.target }
  }
  return { kind: 'otherTarget', target: proxy.target }
}

/** Settings as they go into an MCP client's config: `"env": { "NAME": "value", … }`. */
export function envSnippet(vars: Record<string, string>): string {
  const pairs = Object.entries(vars).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
  return `"env": { ${pairs.join(', ')} }`
}
