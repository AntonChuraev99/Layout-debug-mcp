import { useCallback, useMemo, useRef, useState } from 'react'
import type { LayoutNode, NodeId, Override, Rect, Snapshot } from '../shared/protocol.ts'

export function effectiveRect(node: LayoutNode, override: Override | undefined): Rect {
  if (!override) return node.bounds
  return {
    x: node.bounds.x + override.dx,
    y: node.bounds.y + override.dy,
    w: override.width ?? node.bounds.w,
    h: override.height ?? node.bounds.h,
  }
}

interface Props {
  snapshot: Snapshot
  overrides: Record<NodeId, Override>
  selectedId: NodeId | null
  /** When off, clicks fall through to the page so the app stays usable. */
  active: boolean
  /**
   * Display scale of the frame. Node bounds stay in frame pixels, so pointer
   * coordinates — which arrive in screen pixels — have to be divided by this.
   */
  scale?: number
  onSelect: (id: NodeId | null) => void
  onOverride: (override: Override) => void
}

type Drag =
  | { mode: 'move'; nodeId: NodeId; startX: number; startY: number; baseDx: number; baseDy: number }
  | { mode: 'resize'; nodeId: NodeId; startX: number; startY: number; baseW: number; baseH: number }

export function Overlay({ snapshot, overrides, selectedId, active, scale = 1, onSelect, onOverride }: Props) {
  const [hoveredId, setHoveredId] = useState<NodeId | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const hittable = useMemo(
    () => Object.values(snapshot.nodes).filter((n) => n.bounds.w > 0 && n.bounds.h > 0),
    [snapshot],
  )

  const rectOf = useCallback(
    (node: LayoutNode) => effectiveRect(node, overrides[node.id]),
    [overrides],
  )

  const hitTest = useCallback(
    (x: number, y: number): LayoutNode | null => {
      let best: LayoutNode | null = null
      let bestArea = Infinity
      for (const node of hittable) {
        const r = rectOf(node)
        if (x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) continue
        const area = r.w * r.h
        // Tightest box wins, depth only breaks ties. Picking the deepest node instead
        // is wrong on Compose, where sibling branches sit at very different depths and
        // a full-screen wrapper can be deeper than the element under the cursor.
        if (!best || area < bestArea || (area === bestArea && node.depth > best.depth)) {
          best = node
          bestArea = area
        }
      }
      return best
    },
    [hittable, rectOf],
  )

  const localPoint = (e: React.PointerEvent) => {
    const box = rootRef.current?.getBoundingClientRect()
    return {
      x: (e.clientX - (box?.left ?? 0)) / scale,
      y: (e.clientY - (box?.top ?? 0)) / scale,
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const { x, y } = localPoint(e)

    if (drag) {
      const prev = overrides[drag.nodeId]
      if (drag.mode === 'move') {
        const dx = Math.round(drag.baseDx + (x - drag.startX))
        const dy = Math.round(drag.baseDy + (y - drag.startY))
        // A plain click must not register as a tweak — an empty override would
        // show up in the badge and in the agent's prompt as a real measurement.
        if (!prev && dx === 0 && dy === 0) return
        onOverride({ nodeId: drag.nodeId, dx, dy, width: prev?.width, height: prev?.height })
      } else {
        const width = Math.max(1, Math.round(drag.baseW + (x - drag.startX)))
        const height = Math.max(1, Math.round(drag.baseH + (y - drag.startY)))
        if (!prev && width === Math.round(drag.baseW) && height === Math.round(drag.baseH)) return
        onOverride({ nodeId: drag.nodeId, dx: prev?.dx ?? 0, dy: prev?.dy ?? 0, width, height })
      }
      return
    }

    setHoveredId(hitTest(x, y)?.id ?? null)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const { x, y } = localPoint(e)
    const target = e.target as HTMLElement

    if (target.dataset.handle === 'resize' && selectedId) {
      const node = snapshot.nodes[selectedId]
      if (!node) return
      const r = rectOf(node)
      dragRef.current = { mode: 'resize', nodeId: selectedId, startX: x, startY: y, baseW: r.w, baseH: r.h }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }

    const hit = hitTest(x, y)
    onSelect(hit?.id ?? null)
    if (hit) {
      const prev = overrides[hit.id]
      dragRef.current = {
        mode: 'move',
        nodeId: hit.id,
        startX: x,
        startY: y,
        baseDx: prev?.dx ?? 0,
        baseDy: prev?.dy ?? 0,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  if (!active) return null

  const hovered = hoveredId ? snapshot.nodes[hoveredId] : undefined
  const selected = selectedId ? snapshot.nodes[selectedId] : undefined

  return (
    <div
      ref={rootRef}
      className="overlay"
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHoveredId(null)}
    >
      {hovered && hovered.id !== selectedId && <Box rect={rectOf(hovered)} kind="hover" label={hovered.label} />}
      {selected && <Box rect={rectOf(selected)} kind="selected" label={selected.label} resizable />}
    </div>
  )
}

function Box({
  rect,
  kind,
  label,
  resizable,
}: {
  rect: Rect
  kind: 'hover' | 'selected'
  label: string
  resizable?: boolean
}) {
  return (
    <div className={`box box--${kind}`} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <span className="box__label">
        {label} · {Math.round(rect.w)}×{Math.round(rect.h)}
      </span>
      {resizable && <span className="box__handle" data-handle="resize" />}
    </div>
  )
}
