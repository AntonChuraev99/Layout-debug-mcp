import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LayoutNode, NodeId, Override, Snapshot } from '../shared/protocol.ts'

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
    if (tree.error) throw new Error(`агент на устройстве: ${tree.error}`)
    return normalize(tree)
  }

  async screenshot(): Promise<Buffer> {
    const res = await this.request('/screenshot')
    if (!res.ok) throw new Error(`скриншот: HTTP ${res.status}`)
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
        movable: n.movable ? 'да' : 'нет',
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
