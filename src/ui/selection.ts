import type { LayoutNode, NodeId, Snapshot } from '../shared/protocol.ts'
import { findNode, sameElement } from './thread.ts'

/** The selected element as the window last saw it: its id then, and the anchors that outlive the id. */
export interface SelectionAnchor {
  id: NodeId
  anchors: LayoutNode['anchors']
}

/**
 * A React key / effect dependency for "the same element", stable while its node id is not:
 * built from the anchors `sameElement` compares (path and source location), which a recapture
 * of the same element repeats.
 */
export function elementKey(node: Pick<LayoutNode, 'anchors'>): string {
  return `${node.anchors.path}\u0000${node.anchors.sourceLoc ?? ''}`
}

/**
 * The selected element in `snapshot`, in the very render that brings the snapshot.
 *
 * Node ids do not survive a device recapture (Android, every ~0.8 s) or a page that replaced
 * the element (a re-render, hot reload). The window moves the selection to the new id in an
 * effect, one render later; read by id alone, that render has no selected element, so the
 * palette or the open chat unmount and mount again: the chat loses its scroll position and
 * takes the focus back. Here the element is followed by its anchors right away.
 *
 * `last` is where the selection was last seen; it only counts while it still names
 * `selectedId` (a fresh pick is read by id).
 */
export function resolveSelected(
  snapshot: Snapshot | null,
  selectedId: NodeId | null,
  last: SelectionAnchor | null,
  index?: NodeIndex,
): LayoutNode | undefined {
  if (!snapshot || !selectedId) return undefined
  const cur = snapshot.nodes[selectedId]
  if (!last || last.id !== selectedId) return cur
  if (cur && sameElement(cur, last)) return cur
  return index && index.snapshot === snapshot ? findIndexed(index, last) : findNode(snapshot, last)
}

/** A snapshot's nodes grouped by anchor path, built once per snapshot (see findIndexed). */
export interface NodeIndex {
  snapshot: Snapshot
  byPath: Map<string, LayoutNode[]>
}

export function indexByPath(snapshot: Snapshot): NodeIndex {
  const byPath = new Map<string, LayoutNode[]>()
  for (const node of Object.values(snapshot.nodes)) {
    const list = byPath.get(node.anchors.path)
    if (list) list.push(node)
    else byPath.set(node.anchors.path, [node])
  }
  return { snapshot, byPath }
}

/**
 * `findNode` over an index: the same answer (same node, same order of preference), without
 * walking every node for every request on every snapshot. `sameElement` needs equal paths,
 * so only the nodes of that path can match.
 */
export function findIndexed(index: NodeIndex, target: SelectionAnchor): LayoutNode | undefined {
  const direct = index.snapshot.nodes[target.id]
  if (direct && sameElement(direct, target)) return direct
  return index.byPath.get(target.anchors.path)?.find((node) => sameElement(node, target))
}
