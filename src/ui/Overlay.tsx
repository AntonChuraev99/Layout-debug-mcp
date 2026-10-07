import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LayoutNode, NodeId, Override, Rect, Snapshot } from '../shared/protocol.ts'
import { placeLabel } from './geometry.ts'
import { useT } from './i18n.ts'
import { IconInbox, Spinner } from './icons.tsx'
import { fmtSigned } from './thread.ts'

export function effectiveRect(node: LayoutNode, override: Override | undefined): Rect {
  if (!override) return node.bounds
  return {
    x: node.bounds.x + override.dx,
    y: node.bounds.y + override.dy,
    w: override.width ?? node.bounds.w,
    h: override.height ?? node.bounds.h,
  }
}

export type Tool = 'select' | 'move' | 'hand'

export interface Mark {
  nodeId: NodeId
  /** `refresh`: the agent is done, the blur stays until the refreshed frame is in. */
  kind: 'work' | 'refresh' | 'queued' | 'done'
}

interface Props {
  snapshot: Snapshot
  overrides: Record<NodeId, Override>
  selectedId: NodeId | null
  tool: Tool
  /** Whether pressing on this node starts a move. Selecting never requires it. */
  canMove: (id: NodeId) => boolean
  /** Corner handle on the selected box. */
  resizable: boolean
  /**
   * Display scale of the frame. Node bounds stay in frame pixels, so pointer
   * coordinates — which arrive in screen pixels — have to be divided by this.
   */
  scale: number
  /** Where the frame sits in the canvas, and the canvas width — labels stay inside it. */
  offset: { x: number; y: number }
  canvasWidth: number
  marks: Mark[]
  unread: ReadonlySet<NodeId>
  /** The selected element has a request in work: the spinner goes into its own label. */
  selectedWorking: boolean
  /** Fires on drag start and end, so polling and the palette can stand aside. */
  onDragChange: (dragging: boolean) => void
  onSelect: (id: NodeId | null) => void
  onOverride: (override: Override) => void
}

type Drag =
  | { mode: 'move'; nodeId: NodeId; startX: number; startY: number; baseDx: number; baseDy: number; origin: Rect }
  | { mode: 'resize'; nodeId: NodeId; startX: number; startY: number; baseW: number; baseH: number; origin: Rect }

export function Overlay({
  snapshot,
  overrides,
  selectedId,
  tool,
  canMove,
  resizable,
  scale,
  offset,
  canvasWidth,
  marks,
  unread,
  selectedWorking,
  onDragChange,
  onSelect,
  onOverride,
}: Props) {
  const { t } = useT()
  const [hoveredId, setHoveredId] = useState<NodeId | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const hittable = useMemo(
    () => Object.values(snapshot.nodes).filter((n) => n.bounds.w > 0 && n.bounds.h > 0),
    [snapshot],
  )

  const rectOf = useCallback((node: LayoutNode) => effectiveRect(node, overrides[node.id]), [overrides])

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

  const startDrag = (d: Drag, e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = d
    setDrag(d)
    e.currentTarget.setPointerCapture(e.pointerId)
    onDragChange(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    const { x, y } = localPoint(e)

    if (d) {
      const prev = overrides[d.nodeId]
      if (d.mode === 'move') {
        const dx = Math.round(d.baseDx + (x - d.startX))
        const dy = Math.round(d.baseDy + (y - d.startY))
        // A plain click must not register as a tweak — an empty override would
        // show up in the agent's prompt as a real measurement.
        if (!prev && dx === 0 && dy === 0) return
        onOverride({ nodeId: d.nodeId, dx, dy, width: prev?.width, height: prev?.height, hidden: prev?.hidden })
      } else {
        const width = Math.max(1, Math.round(d.baseW + (x - d.startX)))
        const height = Math.max(1, Math.round(d.baseH + (y - d.startY)))
        if (!prev && width === Math.round(d.baseW) && height === Math.round(d.baseH)) return
        onOverride({ nodeId: d.nodeId, dx: prev?.dx ?? 0, dy: prev?.dy ?? 0, width, height, hidden: prev?.hidden })
      }
      return
    }

    setHoveredId(hitTest(x, y)?.id ?? null)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const { x, y } = localPoint(e)
    const target = e.target as HTMLElement

    if (target.dataset.handle === 'resize' && selectedId && resizable) {
      const node = snapshot.nodes[selectedId]
      if (node) {
        const r = rectOf(node)
        startDrag({ mode: 'resize', nodeId: selectedId, startX: x, startY: y, baseW: r.w, baseH: r.h, origin: r }, e)
        return
      }
    }

    const hit = hitTest(x, y)
    onSelect(hit?.id ?? null)
    if (hit && canMove(hit.id)) {
      const prev = overrides[hit.id]
      startDrag(
        {
          mode: 'move',
          nodeId: hit.id,
          startX: x,
          startY: y,
          baseDx: prev?.dx ?? 0,
          baseDy: prev?.dy ?? 0,
          origin: rectOf(hit),
        },
        e,
      )
    }
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) onDragChange(false)
    dragRef.current = null
    setDrag(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const hovered = hoveredId && tool !== 'hand' && !drag ? snapshot.nodes[hoveredId] : undefined
  const selected = selectedId && tool !== 'hand' ? snapshot.nodes[selectedId] : undefined
  const unitSuffix = snapshot.unit === 'dp' ? ' dp' : ''
  const inUnit = (px: number) => Math.round(px / (snapshot.pxPerUnit || 1))
  const toCanvas = (r: Rect): Rect => ({ x: offset.x + r.x * scale, y: offset.y + r.y * scale, w: r.w * scale, h: r.h * scale })
  const place = (r: Rect) => ({ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale })

  const selectedLabel = (node: LayoutNode, r: Rect): ReactNode => {
    if (drag?.nodeId === node.id && drag.mode === 'move') {
      const ov = overrides[node.id]
      return (
        <>
          <b>{node.kind}</b> <span className="chip__dim">Δ {fmtSigned(inUnit(ov?.dx ?? 0))}, {fmtSigned(inUnit(ov?.dy ?? 0))} {snapshot.unit}</span>
        </>
      )
    }
    if (drag?.nodeId === node.id && drag.mode === 'resize') {
      return (
        <>
          <b>{node.kind}</b> <span className="chip__dim">{inUnit(r.w)} × {inUnit(r.h)} {snapshot.unit}</span>
        </>
      )
    }
    return (
      <>
        {selectedWorking && <Spinner />}
        <b>{node.kind}</b>
        <span className="chip__dim">
          {inUnit(r.w)} × {inUnit(r.h)}
          {unitSuffix}
        </span>
      </>
    )
  }

  return (
    <div
      ref={rootRef}
      className={`overlay overlay--${tool}${hoveredId && tool !== 'hand' && canMove(hoveredId) ? ' overlay--can-move' : ''}`}
      style={{ left: offset.x, top: offset.y, width: snapshot.viewport.w * scale, height: snapshot.viewport.h * scale }}
      onPointerMove={tool === 'hand' ? undefined : onPointerMove}
      onPointerDown={tool === 'hand' ? undefined : onPointerDown}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => setHoveredId(null)}
    >
      {marks.map((m) => {
        const node = snapshot.nodes[m.nodeId]
        if (!node) return null
        const r = rectOf(node)
        const isSelected = m.nodeId === selectedId && tool !== 'hand'
        return (
          <div key={`${m.kind}-${m.nodeId}`} className={`mark mark--${m.kind}`} style={place(r)}>
            {m.kind === 'work' && !isSelected && (
              <Label canvasBox={toCanvas(r)} canvasWidth={canvasWidth} className="chip chip--work">
                <Spinner />
                {t('tag.work')}
              </Label>
            )}
            {m.kind === 'queued' && !isSelected && (
              <Label canvasBox={toCanvas(r)} canvasWidth={canvasWidth} className="chip chip--queued">
                <IconInbox size={12} />
                {t('tag.queued')}
              </Label>
            )}
          </div>
        )
      })}

      {drag && <div className="ghost" style={place(drag.origin)} />}

      {hovered && hovered.id !== selectedId && (
        <div className="box box--hover" style={place(rectOf(hovered))}>
          <Label canvasBox={toCanvas(rectOf(hovered))} canvasWidth={canvasWidth} className="chip chip--hover">
            <b>{hovered.kind}</b>
            <span className="chip__dim">
              {inUnit(rectOf(hovered).w)} × {inUnit(rectOf(hovered).h)}
              {unitSuffix}
            </span>
          </Label>
        </div>
      )}

      {selected && (() => {
        const r = rectOf(selected)
        return (
          <div className="box box--selected" style={place(r)} data-anchor="box">
            <Label canvasBox={toCanvas(r)} canvasWidth={canvasWidth} className="chip chip--selected" anchor>
              {selectedLabel(selected, r)}
            </Label>
            {resizable && (
              <span className="handle" data-handle="resize" aria-hidden="true">
                <span className="handle__dot" />
              </span>
            )}
          </div>
        )
      })()}

      {[...unread].map((id) => {
        const node = snapshot.nodes[id]
        if (!node) return null
        const r = place(rectOf(node))
        return <span key={`u-${id}`} className="unread-dot" style={{ left: r.left + r.width, top: r.top }} aria-hidden="true" />
      })}
    </div>
  )
}

/**
 * A chip over its box. Its width is only known after layout, so placement is a DOM
 * write in a layout effect — no extra render, and the palette, measured right after,
 * already sees the final position.
 */
function Label({
  canvasBox,
  canvasWidth,
  className,
  anchor,
  children,
}: {
  canvasBox: Rect
  canvasWidth: number
  className: string
  anchor?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLSpanElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const p = placeLabel(canvasBox, el.offsetWidth, canvasWidth)
    el.style.top = p.vertical === 'above' ? '' : 'calc(100% + 4px)'
    el.style.bottom = p.vertical === 'above' ? 'calc(100% + 4px)' : ''
    el.style.left = p.align === 'left' ? '-1.5px' : ''
    el.style.right = p.align === 'right' ? '-1.5px' : ''
  })
  return (
    <span ref={ref} className={className} data-anchor={anchor ? 'label' : undefined}>
      {children}
    </span>
  )
}
