import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ErrorCode, LayoutNode, NodeId, Override, Snapshot } from '../shared/protocol.ts'
import { LocalizedError } from './i18n.ts'

const exec = promisify(execFile)

/** What the on-device agent serves at /tree. */
interface DeviceNode {
  id: string
  parentId: string | null
  childIds: string[]
  depth: number
  kind: string
  label: string
  bounds: { x: number; y: number; w: number; h: number }
  source: { file: string; line: number } | null
  movable: boolean
}

interface DeviceTree {
  target: 'android'
  unit: 'dp'
  pxPerUnit: number
  viewport: { w: number; h: number; scale: number }
  rootId: string
  nodes: Record<string, DeviceNode>
  error?: string
}

export class AndroidAdapter {
  private forwarded = false

  constructor(
    private readonly port: number,
    private readonly device: string | null,
  ) {}

  private get base(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /**
   * `adb forward` is idempotent, but running it on every request costs a process
   * spawn per capture, so it happens once and is retried only after a failure.
   */
  async ensureForward(): Promise<void> {
    if (this.forwarded) return
    const args = this.device ? ['-s', this.device] : []
    await exec('adb', [...args, 'forward', `tcp:${this.port}`, `tcp:${this.port}`])
    this.forwarded = true
  }

  private async request(path: string): Promise<Response> {
    await this.ensureForward()
    try {
      return await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(15_000) })
    } catch (err) {
      // A dropped forward looks exactly like a dead agent from here; re-arm and retry
      // once so replugging the device does not require restarting the tool.
      this.forwarded = false
      await this.ensureForward()
      return fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(15_000) })
    }
  }

  async capture(): Promise<Snapshot> {
    const res = await this.request('/tree')
    const tree = (await res.json()) as DeviceTree
    if (tree.error) throw new LocalizedError('deviceAgentError', { reason: tree.error })
    return normalize(tree)
  }

  async screenshot(): Promise<Buffer> {
    const res = await this.request('/screenshot')
    if (!res.ok) throw new LocalizedError('deviceScreenshotError', { status: res.status })
    return Buffer.from(await res.arrayBuffer())
  }

  async setOverride(override: Override): Promise<void> {
    const params = new URLSearchParams({
      id: override.nodeId,
      dx: String(Math.round(override.dx)),
      dy: String(Math.round(override.dy)),
      w: override.width != null ? String(Math.round(override.width)) : '-1',
      h: override.height != null ? String(Math.round(override.height)) : '-1',
    })
    const res = await this.request(`/override?${params}`)
    const body = (await res.json()) as { ok?: boolean; error?: string }
    if (body.error) throw new Error(body.error)
  }

  async clearOverrides(): Promise<void> {
    await this.request('/overrides/clear')
  }

  private model: string | null = null

  /**
   * `ro.product.model` ("Pixel 8") for the window's device chip. Null when adb cannot
   * tell — no adb, no device, several devices without LD_DEVICE — logged, never thrown:
   * a missing model must not keep the window from getting `ready`. Only a found model
   * is cached, so plugging the device in later is picked up by the next window.
   */
  async deviceModel(): Promise<string | null> {
    if (this.model) return this.model
    const args = this.device ? ['-s', this.device] : []
    try {
      const { stdout } = await exec('adb', [...args, 'shell', 'getprop', 'ro.product.model'], { timeout: 3_000 })
      const model = stdout.trim()
      if (!model) {
        console.warn('[layout-debug] adb returned an empty ro.product.model; the device chip shows a generic name')
        return null
      }
      this.model = model
      return model
    } catch (err) {
      console.warn(
        `[layout-debug] could not read the device model via adb (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); ` +
          'the device chip shows a generic name',
      )
      return null
    }
  }

  /** Which devices adb can see — used to explain "no device" with actual data. */
  static async devices(): Promise<string[]> {
    const { stdout } = await exec('adb', ['devices'])
    return stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.endsWith('device'))
      .map((line) => line.split(/\s+/)[0]!)
  }
}

/**
 * Why a device capture failed, as an ErrorCode the window branches on (the
 * localized text next to it is for people only). Pure; exported for tests.
 */
export function classifyCaptureError(err: unknown): ErrorCode {
  if (err instanceof LocalizedError) {
    if (err.key === 'deviceAgentError') return 'device_no_bridge'
    if (err.key === 'deviceScreenshotError') return 'screenshot'
  }
  const e = err as { code?: unknown; message?: unknown; stderr?: unknown; cause?: { code?: unknown } } | null
  const text = [e?.message, e?.stderr].filter((s) => typeof s === 'string').join('\n')
  if (e?.code === 'ENOENT' || /ENOENT|not recognized|spawn adb/i.test(text)) return 'device_no_adb'
  if (/no devices|no emulators|device .*not found|device offline|unauthorized/i.test(text)) return 'device_not_found'
  // adb forward worked but nothing answers on the port: the app is not running or has no bridge.
  if (
    /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|timed? ?out|aborted/i.test(text) ||
    e?.cause?.code === 'ECONNREFUSED' ||
    e?.cause?.code === 'ECONNRESET'
  ) {
    return 'device_no_bridge'
  }
  return 'device'
}

/**
 * Device tree → the same Snapshot shape the web adapter produces, so the UI, the MCP
 * server and the agent prompt stay identical across targets.
 */
function normalize(tree: DeviceTree): Snapshot {
  const nodes: Record<NodeId, LayoutNode> = {}

  for (const [id, n] of Object.entries(tree.nodes)) {
    const dp = (px: number) => `${Math.round((px / tree.pxPerUnit) * 10) / 10}dp`
    nodes[id] = {
      id,
      parentId: n.parentId,
      childIds: n.childIds,
      depth: n.depth,
      kind: n.kind,
      label: n.kind,
      bounds: n.bounds,
      anchors: {
        sourceLoc: n.source ? `${n.source.file}:${n.source.line}` : undefined,
        path: pathOf(tree, id),
      },
      styles: {
        composable: n.kind,
        width: dp(n.bounds.w),
        height: dp(n.bounds.h),
        x: dp(n.bounds.x),
        y: dp(n.bounds.y),
        // Compose tweaks land on the node that owns the modifier chain; a node without
        // one can be selected and described but not dragged.
        movable: n.movable ? 'yes' : 'no',
      },
    }
  }

  return {
    id: `android-${Date.now()}`,
    target: 'android',
    createdAt: Date.now(),
    unit: 'dp',
    pxPerUnit: tree.pxPerUnit,
    viewport: { w: tree.viewport.w, h: tree.viewport.h },
    rootId: tree.rootId,
    nodes,
  }
}

/** `Scaffold > Column > Row > Text` — the readable trail an agent can search by. */
function pathOf(tree: DeviceTree, id: string): string {
  const parts: string[] = []
  let cur: DeviceNode | undefined = tree.nodes[id]
  while (cur && parts.length < 8) {
    parts.unshift(cur.kind)
    cur = cur.parentId ? tree.nodes[cur.parentId] : undefined
  }
  return parts.join(' > ')
}
