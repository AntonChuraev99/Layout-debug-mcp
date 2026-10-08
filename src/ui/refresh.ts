import type { Anchors, EditRequest, NodeId, Override, Snapshot, TargetKind } from '../shared/protocol.ts'
import { findNode } from './thread.ts'

/**
 * What the window does once the agent says it is done with an edit:
 * - `keep`           — the page already re-rendered on its own (HMR): nothing to do;
 * - `reload-frame`   — web page without hot reload: reload the iframe;
 * - `capture-device` — Android: ask the device for a fresh frame right away.
 */
export type RefreshAction = 'keep' | 'reload-frame' | 'capture-device'

/** Id prefix of the window's own system lines about a refresh (they never come from the server). */
export const REFRESH_NOTE_PREFIX = 'refresh-note-'

/**
 * Content of a snapshot without the parts that change on their own: node ids, the
 * snapshot id and timestamp, and the document scroll (bounds are taken relative to the
 * root, so scrolling the page moves nothing here). Two snapshots with the same
 * fingerprint show the same page.
 */
export function snapshotFingerprint(snapshot: Snapshot | null): string | null {
  if (!snapshot) return null
  const root = snapshot.nodes[snapshot.rootId]
  if (!root) return null
  const r = (n: number) => Math.round(n * 10) / 10
  const parts: string[] = []
  const walk = (id: NodeId) => {
    const node = snapshot.nodes[id]
    if (!node) return
    const a = node.anchors
    const b = node.bounds
    const styles = Object.keys(node.styles)
      .sort()
      .map((k) => `${k}=${node.styles[k]}`)
      .join(';')
    parts.push(
      [a.path, node.kind, a.className ?? '', a.text ?? '', a.sourceLoc ?? '', styles, r(b.x - root.bounds.x), r(b.y - root.bounds.y), r(b.w), r(b.h)].join('|'),
    )
    for (const child of node.childIds) walk(child)
  }
  walk(snapshot.rootId)
  return parts.join('\n')
}

/**
 * Decides whether the frame has to be refreshed after an agent finished.
 *
 * `baseline` is the page fingerprint at the moment of "done", `latest` the one after the
 * grace period. A changed page means hot reload already brought the edit in; an
 * unchanged (or missing) one means nothing will move unless the window reloads it.
 */
export function decideRefresh(target: TargetKind, baseline: string | null, latest: string | null): RefreshAction {
  if (target === 'android') return 'capture-device'
  if (baseline !== null && latest !== null && baseline !== latest) return 'keep'
  return 'reload-frame'
}

/**
 * The live edit of the requested element itself, if it was sent with the request: the agent
 * moved it into code, so it has to go before the refreshed page shows the code version (or
 * it applies twice). A request carries every live edit of the page, but only the element's
 * own one is the subject of the edit — the rest stay with the user. Only ids still present
 * in the current overrides count.
 */
export function overridesHandedOver(overrides: Readonly<Record<NodeId, Override>>, requests: readonly EditRequest[]): Set<NodeId> {
  const out = new Set<NodeId>()
  for (const r of requests) {
    if (r.overrides.some((o) => o.nodeId === r.node.id) && overrides[r.node.id]) out.add(r.node.id)
  }
  return out
}

/**
 * The web frames to render, in DOM order. A refresh the window starts itself loads the page
 * into a new iframe and keeps the old one (`held`) on screen over it until the new page has
 * reported its first snapshot: a reused iframe paints white between two documents, a fresh
 * one is white until its first paint. The held frame comes last, so it covers the new one
 * without a z-index (which would also lift it over the overlay), and the new frame is always
 * inserted before it — an iframe that is moved in the DOM reloads.
 */
export function frameStack(current: number, held: number | null): Array<{ key: number; held: boolean }> {
  const out = [{ key: current, held: false }]
  if (held !== null && held !== current) out.push({ key: held, held: true })
  return out
}

/** The old page held on screen during a refresh, as the window drew it when the reload began. */
export interface HeldView<S, O> {
  snapshot: S | null
  overrides: O
  /** When the new frame fired `load`; null while it is still loading. */
  loadedAt: number | null
}

/**
 * What the overlay draws, and whether the old frame is still held on screen.
 *
 * The boxes must match the picture. While the old page is held, the picture is the old
 * document with its live edits (a dragged element sits where it was dragged), so the overlay
 * draws the snapshot and edits saved when the reload began — not the live state: the new
 * frame's `load` empties the live edits and the snapshot long before the new page is
 * painted with its own. The hold ends with the first snapshot taken after that `load`, and
 * the same value switches both: the frame stack drops the old page and the overlay takes
 * the new boxes in one render, so no frame shows one without the other.
 */
export function overlaySource<S extends { createdAt: number }, O>(
  held: HeldView<S, O> | null,
  live: { snapshot: S | null; overrides: O },
): { snapshot: S | null; overrides: O; holding: boolean } {
  const newPageIn = held !== null && held.loadedAt !== null && live.snapshot !== null && live.snapshot.createdAt >= held.loadedAt
  if (held && !newPageIn) return { snapshot: held.snapshot, overrides: held.overrides, holding: true }
  return { snapshot: live.snapshot, overrides: live.overrides, holding: false }
}

/**
 * "Connecting inspector…" (and the loading bar) mean the window has no live page: the
 * first load, a page the user opened, a page that went away. During a refresh the window
 * started itself the old page stays on screen until the new one is in, so there is nothing
 * to announce — and a one-frame flash of it is noise in the middle of the agent's reply.
 */
export function showsConnecting(s: { url: string; connected: boolean; silent: boolean; swapping: boolean }): boolean {
  return Boolean(s.url) && !s.connected && !s.silent && !s.swapping
}

export interface CarriedOverride {
  override: Override
  /** Where the edit was, in the page that is about to go away. */
  anchors: Anchors
}

/**
 * Re-addresses live edits from the page before a reload to the page after it. Node ids
 * do not survive a reload; the element is found again by its anchors. An edit whose
 * element is gone is counted, not dropped silently.
 */
export function reapplyPlan(carried: readonly CarriedOverride[], snapshot: Snapshot): { apply: Override[]; lost: number } {
  const apply: Override[] = []
  let lost = 0
  for (const c of carried) {
    const node = findNode(snapshot, { id: c.override.nodeId, anchors: c.anchors })
    if (node) apply.push({ ...c.override, nodeId: node.id })
    else lost++
  }
  return { apply, lost }
}
