import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import type { LayoutNode, NodeId, Override, Rect, Snapshot } from '../shared/protocol.ts'
import { altHeld } from '../inspector/keys.ts'
import { placeLabel } from './geometry.ts'
import { useT } from './i18n.ts'
import { GripDots, IconInbox, Spinner } from './icons.tsx'
import {
  accumulateWheel,
  chainOf,
  cornersFor,
  decidePick,
  handleOrigin,
  isLargeLayer,
  resizeFromCorner,
  wheelStep,
  type Corner,
  type Point,
} from './pick.ts'
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

/** How a pick was made: the window counts Alt picks and turns the pipette off after one. */
export type PickSource = 'alt' | 'pipette' | 'click'

export interface Mark {
  nodeId: NodeId
  /** `refresh`: the agent is done, the blur stays until the refreshed frame is in. */
  kind: 'work' | 'refresh' | 'queued' | 'done'
}

export interface OverlayApi {
  /** A pick the inspector caught inside the page (Alt+click before the overlay took the mouse). Frame display px. */
  pickAt: (x: number, y: number, source: PickSource) => void
  /** The cursor rests here (Alt just went down, no move yet): show the hover now. Frame display px. */
  hoverAt: (x: number, y: number) => void
}

const TOP_FLASH_MS = 1200
/** Height of the selected layer's label (styles.css `.chip--selected`). */
const SELECTED_CHIP_H = 24

interface Props {
  snapshot: Snapshot
  overrides: Record<NodeId, Override>
  selectedId: NodeId | null
  /** Alt is held: the whole frame is the overlay's — hover inspects, click selects. */
  alt: boolean
  /** The header pipette is on: like Alt, for one pick. */
  pipette: boolean
  /** Android: no input channel to the device, so a plain hover inspects and a plain click selects. */
  clickSelects: boolean
  /** Live tweaks can be sent (false: Android without the server). The selected layer can be dragged and sized. */
  canTweak: boolean
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
  /** The page is scrolling: every box is stale until the next snapshot, so they step aside. */
  stale: boolean
  /** Fires on drag start and end, so polling and the palette can stand aside. */
  onDragChange: (dragging: boolean) => void
  onSelect: (id: NodeId | null) => void
  /** A pick gesture ended; `empty`: it landed on no layer (the selection was dropped). */
  onPicked: (source: PickSource, empty?: boolean) => void
  onOverride: (override: Override) => void
  /** Web: a wheel over the selected layer's body belongs to the page under it. */
  onForwardWheel?: (x: number, y: number, dx: number, dy: number) => void
  apiRef?: Ref<OverlayApi>
}

type Drag =
  | { mode: 'move'; nodeId: NodeId; startX: number; startY: number; baseDx: number; baseDy: number; origin: Rect }
  | {
      mode: 'resize'
      corner: Corner
      nodeId: NodeId
      startX: number
      startY: number
      base: { dx: number; dy: number; w: number; h: number }
      origin: Rect
    }

const RESIZE_CURSOR: Record<Corner, string> = { tl: 'nwse-resize', br: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize' }

export function Overlay({
  snapshot,
  overrides,
  selectedId,
  alt,
  pipette,
  clickSelects,
  canTweak,
  scale,
  offset,
  canvasWidth,
  marks,
  unread,
  selectedWorking,
  stale,
  onDragChange,
  onSelect,
  onPicked,
  onOverride,
  onForwardWheel,
  apiRef,
}: Props) {
  const { t } = useT()
  /** Tightest layer under the cursor and how many parents up the wheel took the hover. */
  const [hover, setHover] = useState<{ base: NodeId; level: number } | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [topAt, setTopAt] = useState(0)
  const dragRef = useRef<Drag | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** Where the previous Alt / pipette pick landed (frame display px): a repeat within 4 px climbs. */
  const lastPick = useRef<Point | null>(null)
  const wheelAcc = useRef({ acc: 0, at: 0 })

  // Alt while dragging changes nothing: the drag goes on.
  const picking = (alt || pipette) && !drag
  const hoverOn = (picking || clickSelects) && !drag
  const zonesOn = !picking && canTweak && Boolean(selectedId)
  const pickSource: PickSource = pipette ? 'pipette' : alt ? 'alt' : 'click'

  useEffect(() => {
    if (!hoverOn) setHover(null)
  }, [hoverOn])

  useEffect(() => {
    if (!topAt) return
    const timer = window.setTimeout(() => setTopAt(0), TOP_FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [topAt])

  const hittable = useMemo(
    () => Object.values(snapshot.nodes).filter((n) => n.bounds.w > 0 && n.bounds.h > 0),
    [snapshot],
  )

  const rectOf = useCallback((node: LayoutNode) => effectiveRect(node, overrides[node.id]), [overrides])
  const parentOf = useCallback((id: NodeId) => snapshot.nodes[id]?.parentId ?? null, [snapshot])

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

  const toLocal = (clientX: number, clientY: number): Point => {
    const box = rootRef.current?.getBoundingClientRect()
    return { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) }
  }

  /** Frame display px → frame px (node bounds). */
  const toFrame = (p: Point): Point => ({ x: p.x / scale, y: p.y / scale })

  /** Selects what a pick at this point means (display px); see decidePick. */
  const pickAt = (p: Point, source: PickSource) => {
    const f = toFrame(p)
    const tight = hitTest(f.x, f.y)
    const chain = tight ? chainOf(tight.id, parentOf) : []
    const level = tight && hover?.base === tight.id ? hover.level : 0
    const repeat = source !== 'click'
    const result = decidePick({ point: p, prev: repeat ? lastPick.current : null, selectedId, chain, level, parentOf })
    lastPick.current = repeat ? p : null
    if (!result) {
      // A click on no layer at all (outside every box) deselects, as a pick of nothing.
      onSelect(null)
      onPicked(source, true)
      return
    }
    if (result.kind === 'top') {
      setTopAt(Date.now())
      // The answer goes in the hover label while Alt is still held (the selection shows no label then).
      const at = selectedId ? chain.indexOf(selectedId) : -1
      if (tight && at >= 0) setHover({ base: tight.id, level: at })
    } else {
      onSelect(result.id)
      // The hover follows the pick up the chain, so it never shows a child under a selected parent.
      const at = chain.indexOf(result.id)
      if (tight && at >= 0) setHover({ base: tight.id, level: at })
    }
    onPicked(source)
  }

  // The inspector hands over Alt+clicks it caught inside the page.
  const hoverAt = (p: Point) => {
    const f = toFrame(p)
    const tight = hitTest(f.x, f.y)
    setHover((h) => (!tight ? null : h?.base === tight.id ? h : { base: tight.id, level: 0 }))
  }
  const live = useRef({ pickAt, hoverAt })
  live.current = { pickAt, hoverAt }
  useImperativeHandle(
    apiRef,
    () => ({
      pickAt: (x, y, source) => live.current.pickAt({ x, y }, source),
      hoverAt: (x, y) => live.current.hoverAt({ x, y }),
    }),
    [],
  )

  const startDrag = (d: Drag, e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = d
    setDrag(d)
    e.currentTarget.setPointerCapture(e.pointerId)
    onDragChange(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    const { x, y } = toFrame(toLocal(e.clientX, e.clientY))

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
        const next = resizeFromCorner(d.corner, d.base, { x: x - d.startX, y: y - d.startY })
        const same = next.dx === d.base.dx && next.dy === d.base.dy && next.w === Math.round(d.base.w) && next.h === Math.round(d.base.h)
        if (!prev && same) return
        onOverride({ nodeId: d.nodeId, dx: next.dx, dy: next.dy, width: next.w, height: next.h, hidden: prev?.hidden })
      }
      return
    }

    if (!hoverOn && !altHeld(e)) return
    const tight = hitTest(x, y)
    setHover((h) => {
      if (!tight) return null
      // Onto another tightest layer: the wheel level starts over.
      if (h?.base === tight.id) return h
      return { base: tight.id, level: 0 }
    })
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const local = toLocal(e.clientX, e.clientY)
    const { x, y } = toFrame(local)
    const target = e.target as HTMLElement
    // The event's own altKey: the window may not have heard about Alt yet.
    const pickNow = picking || (altHeld(e) && !drag)

    if (!pickNow && zonesOn && selectedId) {
      const node = snapshot.nodes[selectedId]
      const corner = target.closest<HTMLElement>('[data-handle]')?.dataset.handle as Corner | undefined
      if (node && corner) {
        const r = rectOf(node)
        const prev = overrides[selectedId]
        startDrag(
          { mode: 'resize', corner, nodeId: selectedId, startX: x, startY: y, base: { dx: prev?.dx ?? 0, dy: prev?.dy ?? 0, w: r.w, h: r.h }, origin: r },
          e,
        )
        return
      }
      if (node && target.closest('[data-grab]')) {
        const prev = overrides[selectedId]
        startDrag({ mode: 'move', nodeId: selectedId, startX: x, startY: y, baseDx: prev?.dx ?? 0, baseDy: prev?.dy ?? 0, origin: rectOf(node) }, e)
        return
      }
    }
    if (pickNow || hoverOn) {
      e.preventDefault()
      pickAt(local, pickNow ? (pipette ? 'pipette' : 'alt') : 'click')
    }
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) onDragChange(false)
    dragRef.current = null
    setDrag(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // Wheel: a native listener, because React's is passive and preventDefault must hold.
  const wheelState = useRef({ picking, pipette, zonesOn, clickSelects, hover, selectedId, scale })
  wheelState.current = { picking, pipette, zonesOn, clickSelects, hover, selectedId, scale }
  const wheelFns = useRef({ hitTest, parentOf, onSelect, onForwardWheel, toLocal })
  wheelFns.current = { hitTest, parentOf, onSelect, onForwardWheel, toLocal }
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onWheel = (e: WheelEvent) => {
      const s = wheelState.current
      const f = wheelFns.current
      if (dragRef.current) return
      const local = f.toLocal(e.clientX, e.clientY)
      if (altHeld(e) || s.pipette || (s.picking && !s.clickSelects)) {
        e.preventDefault()
        const delta = e.deltaY || e.deltaX
        const { steps, state } = accumulateWheel(wheelAcc.current, e.deltaMode === 1 ? delta * 40 : delta, e.timeStamp)
        wheelAcc.current = state
        if (!steps) return
        const tight = f.hitTest(local.x / s.scale, local.y / s.scale)
        if (!tight) return
        const chain = chainOf(tight.id, f.parentOf)
        const level = s.hover?.base === tight.id ? s.hover.level : 0
        const out = wheelStep({ chain, level, selectedId: s.selectedId, dir: steps > 0 ? 1 : -1 })
        setHover({ base: tight.id, level: out.level })
        // A wheel step is an explicit level: the next Alt+click picks the hover, it does not climb again.
        lastPick.current = null
        if (out.select) f.onSelect(out.select)
        if (out.top) setTopAt(Date.now())
        return
      }
      // Over the selected layer's body the overlay holds the mouse, but the wheel is the page's.
      // Ctrl+wheel (and a trackpad pinch, which arrives as one) is the browser's zoom: left alone.
      if (!s.clickSelects && s.zonesOn && f.onForwardWheel && !e.ctrlKey) {
        e.preventDefault()
        const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? root.clientHeight : 1
        f.onForwardWheel(local.x / s.scale, local.y / s.scale, e.deltaX * k, e.deltaY * k)
      }
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [])

  const hoveredId = hover ? (chainOf(hover.base, parentOf)[hover.level] ?? hover.base) : null
  const hovered = hoverOn && hoveredId ? snapshot.nodes[hoveredId] : undefined
  const selected = selectedId ? snapshot.nodes[selectedId] : undefined
  const unitSuffix = snapshot.unit === 'dp' ? ' dp' : ''
  const inUnit = (px: number) => Math.round(px / (snapshot.pxPerUnit || 1))
  const toCanvas = (r: Rect): Rect => ({ x: offset.x + r.x * scale, y: offset.y + r.y * scale, w: r.w * scale, h: r.h * scale })
  const place = (r: Rect) => ({ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale })
  const frame = { w: snapshot.viewport.w * scale, h: snapshot.viewport.h * scale }
  const showTop = topAt > 0

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
          {showTop ? (
            t('pick.top')
          ) : (
            <>
              {inUnit(r.w)} × {inUnit(r.h)}
              {unitSuffix}
            </>
          )}
        </span>
      </>
    )
  }

  const rootClass = [
    'overlay',
    picking ? 'overlay--picking' : clickSelects ? 'overlay--click' : 'overlay--live',
    drag ? 'overlay--dragging' : '',
    stale ? 'overlay--stale' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={rootRef}
      className={rootClass}
      style={{ left: offset.x, top: offset.y, width: frame.w, height: frame.h, cursor: drag?.mode === 'resize' ? RESIZE_CURSOR[drag.corner] : undefined }}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => {
        if (!dragRef.current) setHover(null)
      }}
    >
      {marks.map((m) => {
        const node = snapshot.nodes[m.nodeId]
        if (!node) return null
        const r = rectOf(node)
        const isSelected = m.nodeId === selectedId
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

      {/* While picking, the hover owns the only label, also over the selection itself. */}
      {hovered && (hovered.id !== selectedId || picking) && (
        <div className="box box--hover" style={place(rectOf(hovered))}>
          <Label canvasBox={toCanvas(rectOf(hovered))} canvasWidth={canvasWidth} className="chip chip--hover">
            {hover && hover.level > 0 && (
              <span className="chip__lvl" aria-hidden="true">
                ↑
              </span>
            )}
            <b>{hovered.kind}</b>
            <span className="chip__dim">
              {showTop ? (
                t('pick.top')
              ) : (
                <>
                  {inUnit(rectOf(hovered).w)} × {inUnit(rectOf(hovered).h)}
                  {unitSuffix}
                </>
              )}
            </span>
          </Label>
        </div>
      )}

      {selected &&
        (() => {
          const r = rectOf(selected)
          const display = place(r)
          const large = isLargeLayer({ x: display.left, y: display.top, w: display.width, h: display.height }, frame)
          // While picking, the selection keeps its outline only (DESIGN_SPEC §4): the label of
          // what is under the cursor is the hover's, the "Top layer" answer included.
          const showChip = !picking
          const grip = zonesOn && !drag
          const grab = zonesOn && !large
          return (
            <>
              <div
                className={`box box--selected${grab ? ' box--grab' : ''}${drag?.nodeId === selected.id ? ' is-dragging' : ''}`}
                style={display}
                data-anchor="box"
                data-grab={grab ? '' : undefined}
              >
                {showChip && (
                  <Label
                    canvasBox={toCanvas(r)}
                    canvasWidth={canvasWidth}
                    className={`chip chip--selected${grip || drag ? ' chip--grip' : ''}`}
                    height={SELECTED_CHIP_H}
                    anchor
                    grab={grip}
                    title={large && grip ? t('palette.largeGrip') : undefined}
                  >
                    {(grip || drag) && <GripDots />}
                    {selectedLabel(selected, r)}
                  </Label>
                )}
              </div>
              {zonesOn &&
                !drag &&
                cornersFor(display.width > 0 ? { w: display.width, h: display.height } : { w: 0, h: 0 }).map((corner) => {
                  const o = handleOrigin(corner, { x: display.left, y: display.top, w: display.width, h: display.height }, frame, large)
                  if (!o) return null
                  return (
                    <span
                      key={corner}
                      className={`handle handle--${corner}`}
                      data-handle={corner}
                      style={{ left: o.x, top: o.y }}
                      aria-hidden="true"
                    >
                      <span className="handle__dot" />
                    </span>
                  )
                })}
            </>
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
  grab,
  height,
  title,
  children,
}: {
  canvasBox: Rect
  canvasWidth: number
  className: string
  anchor?: boolean
  /** The label is a drag handle of the selected layer. */
  grab?: boolean
  height?: number
  title?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLSpanElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const p = placeLabel(canvasBox, el.offsetWidth, canvasWidth, height)
    const inside = p.vertical === 'inside'
    el.style.top = p.vertical === 'below' ? 'calc(100% + 4px)' : inside ? '6px' : ''
    el.style.bottom = p.vertical === 'above' ? 'calc(100% + 4px)' : ''
    const edge = inside ? '18px' : '-1.5px'
    el.style.left = p.align === 'left' ? edge : ''
    el.style.right = p.align === 'right' ? edge : ''
  })
  return (
    <span ref={ref} className={className} data-anchor={anchor ? 'label' : undefined} data-grab={grab ? '' : undefined} title={title}>
      {children}
    </span>
  )
}
