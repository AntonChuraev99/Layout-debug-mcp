/**
 * Pure rules of the single-mode window (DESIGN_SPEC "один режим"): which layer an Alt
 * pick lands on, how the wheel walks the parent chain, when a layer counts as "large",
 * how corner handles and arrow keys turn into an override, and what Escape closes.
 *
 * No DOM and no React here: node --test covers all of it (pick.test.ts).
 */
import type { NodeId, Override, Rect } from '../shared/protocol.ts'

export interface Point {
  x: number
  y: number
}

/** A repeated Alt+click within this distance of the previous one climbs to the parent. */
export const REPEAT_PICK_PX = 4

/**
 * A layer whose visible part covers at least this share of the frame (body, html,
 * Scaffold) does not take the mouse by its body: the page under it stays clickable.
 */
export const LARGE_LAYER_SHARE = 0.6

/** Wheel distance (px) that makes one level step. A mouse notch is ~100, a trackpad sends many small deltas. */
export const WHEEL_STEP_PX = 50
/** A pause longer than this starts a new gesture: the leftover distance is dropped. */
export const WHEEL_IDLE_MS = 250

/** The node itself, then its parents up to the root. */
export function chainOf(id: NodeId, parentOf: (id: NodeId) => NodeId | null | undefined): NodeId[] {
  const chain: NodeId[] = []
  const seen = new Set<NodeId>()
  let cur: NodeId | null | undefined = id
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    chain.push(cur)
    cur = parentOf(cur)
  }
  return chain
}

export type PickResult = { kind: 'select'; id: NodeId } | { kind: 'top' }

/**
 * What an Alt+click (or a pipette click) selects.
 * - Within REPEAT_PICK_PX of the previous pick, with something selected: one level up
 *   from the selection. On the root there is nowhere to go: `top`, which the window shows.
 * - Otherwise the layer the hover shows: the tightest one under the cursor, raised by
 *   `level` steps of the wheel.
 */
export function decidePick(args: {
  point: Point
  prev: Point | null
  selectedId: NodeId | null
  /** Tightest layer under the cursor first, then its parents. */
  chain: NodeId[]
  level: number
  parentOf: (id: NodeId) => NodeId | null | undefined
}): PickResult | null {
  const { point, prev, selectedId, chain, level, parentOf } = args
  if (prev && selectedId && Math.hypot(point.x - prev.x, point.y - prev.y) <= REPEAT_PICK_PX) {
    const parent = parentOf(selectedId)
    return parent ? { kind: 'select', id: parent } : { kind: 'top' }
  }
  if (!chain.length) return null
  return { kind: 'select', id: chain[Math.min(Math.max(0, level), chain.length - 1)]! }
}

export interface WheelOutcome {
  /** New hover level under the cursor (index into the chain). */
  level: number
  /** The selection moves along with the level (it lay under the cursor). */
  select?: NodeId
  /** Asked to go above the root: the window shows "Top layer". */
  top: boolean
}

/**
 * One level step of Alt+wheel. `dir` 1 = up (towards the root), -1 = back down towards
 * the tightest layer. When the selection is in the chain under the cursor, the step
 * moves the selection itself; otherwise only the hover level changes.
 */
export function wheelStep(args: { chain: NodeId[]; level: number; selectedId: NodeId | null; dir: 1 | -1 }): WheelOutcome {
  const { chain, selectedId, dir } = args
  if (!chain.length) return { level: 0, top: false }
  const at = selectedId ? chain.indexOf(selectedId) : -1
  const from = at >= 0 ? at : Math.min(Math.max(0, args.level), chain.length - 1)
  const next = from + dir
  if (next >= chain.length) return { level: from, top: true }
  if (next < 0) return { level: 0, top: false }
  return at >= 0 ? { level: next, select: chain[next], top: false } : { level: next, top: false }
}

/**
 * Turns raw wheel deltas into whole level steps: one step per notch, not per event.
 * Returns the steps to apply now (signed, up = +1) and the state to keep.
 */
export function accumulateWheel(
  state: { acc: number; at: number },
  deltaY: number,
  now: number,
): { steps: number; state: { acc: number; at: number } } {
  let acc = now - state.at > WHEEL_IDLE_MS ? 0 : state.acc
  // Wheel up (negative deltaY) climbs towards the parent.
  acc += -deltaY
  let steps = 0
  while (acc >= WHEEL_STEP_PX) {
    steps++
    acc -= WHEEL_STEP_PX
  }
  while (acc <= -WHEEL_STEP_PX) {
    steps--
    acc += WHEEL_STEP_PX
  }
  // A full mouse notch is one step, never two: a 100 px notch would otherwise climb twice.
  if (steps > 1) steps = 1
  if (steps < -1) steps = -1
  if (steps !== 0) acc = 0
  return { steps, state: { acc, at: now } }
}

export function intersectArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** The visible part of the box covers LARGE_LAYER_SHARE of the frame or more. */
export function isLargeLayer(box: Rect, frame: { w: number; h: number }): boolean {
  const area = frame.w * frame.h
  if (area <= 0) return false
  return intersectArea(box, { x: 0, y: 0, w: frame.w, h: frame.h }) >= LARGE_LAYER_SHARE * area
}

/** Nothing of the box is inside the frame: the palette has nowhere to point. */
export function isOffscreen(box: Rect, frame: { w: number; h: number }): boolean {
  return intersectArea(box, { x: 0, y: 0, w: frame.w, h: frame.h }) === 0 && !(box.w === 0 || box.h === 0)
}

export type Corner = 'tl' | 'tr' | 'bl' | 'br'
export const CORNERS: readonly Corner[] = ['tl', 'tr', 'bl', 'br']
/** Hit zone of a corner handle (WCAG 2.5.8 target size). */
export const HANDLE_PX = 24

/** A box narrower or shorter than one handle gets one handle only: four would cover it. */
export function cornersFor(box: { w: number; h: number }): readonly Corner[] {
  return box.w < HANDLE_PX || box.h < HANDLE_PX ? ['br'] : CORNERS
}

/**
 * Top-left of a corner's hit zone, in the same space as `box`. Centred on the corner;
 * a large layer keeps its handles inside the box, and every handle stays inside the frame.
 * A corner that is itself outside the frame (the layer scrolled or hangs off it) gets no
 * handle: pulled into the frame it would sit where no corner is. Large layers keep theirs.
 */
export function handleOrigin(corner: Corner, box: Rect, frame: { w: number; h: number }, inside: boolean): Point | null {
  const half = HANDLE_PX / 2
  const right = corner === 'tr' || corner === 'br'
  const bottom = corner === 'bl' || corner === 'br'
  const cx = right ? box.x + box.w : box.x
  const cy = bottom ? box.y + box.h : box.y
  const slack = 1
  if (!inside && (cx < -slack || cy < -slack || cx > frame.w + slack || cy > frame.h + slack)) return null
  let x = inside ? (right ? cx - HANDLE_PX : cx) : cx - half
  let y = inside ? (bottom ? cy - HANDLE_PX : cy) : cy - half
  x = Math.min(Math.max(0, x), Math.max(0, frame.w - HANDLE_PX))
  y = Math.min(Math.max(0, y), Math.max(0, frame.h - HANDLE_PX))
  return { x, y }
}

export interface SizeBase {
  dx: number
  dy: number
  w: number
  h: number
}

/**
 * Dragging one corner by `delta` (frame px): that corner follows the pointer, the
 * opposite one stays put. A left or top corner also shifts the element (dx/dy), so its
 * far edge does not move. Size never drops below `min`.
 */
export function resizeFromCorner(corner: Corner, base: SizeBase, delta: Point, min = 1): SizeBase {
  const left = corner === 'tl' || corner === 'bl'
  const top = corner === 'tl' || corner === 'tr'
  let w: number
  let dx = base.dx
  if (left) {
    const d = Math.min(delta.x, base.w - min)
    w = base.w - d
    dx = base.dx + d
  } else {
    w = Math.max(min, base.w + delta.x)
  }
  let h: number
  let dy = base.dy
  if (top) {
    const d = Math.min(delta.y, base.h - min)
    h = base.h - d
    dy = base.dy + d
  } else {
    h = Math.max(min, base.h + delta.y)
  }
  return { dx: Math.round(dx), dy: Math.round(dy), w: Math.round(w), h: Math.round(h) }
}

export type NudgeKind = 'move' | 'resize'
export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
export const ARROW_KEYS: readonly ArrowKey[] = ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']

export function isArrowKey(key: string): key is ArrowKey {
  return (ARROW_KEYS as readonly string[]).includes(key)
}

/** With Shift an arrow step is this many units. */
export const NUDGE_SHIFT = 8

/**
 * One arrow-key step of the palette's "nudge" rows, as the next override.
 * - move: 1 unit (8 with Shift) in the arrow's direction;
 * - resize: ← narrower, → wider, ↑ shorter, ↓ taller; the top-left corner stays, min 1 unit.
 * Units are converted to frame px with `pxPerUnit` (dp on Android, css-px on web).
 */
export function nudgeOverride(
  kind: NudgeKind,
  key: ArrowKey,
  shift: boolean,
  nodeId: NodeId,
  prev: Override | undefined,
  rect: { w: number; h: number },
  pxPerUnit: number,
): Override {
  const unit = pxPerUnit > 0 ? pxPerUnit : 1
  const step = (shift ? NUDGE_SHIFT : 1) * unit
  const sx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0
  const sy = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0
  const base: Override = { nodeId, dx: prev?.dx ?? 0, dy: prev?.dy ?? 0, width: prev?.width, height: prev?.height, hidden: prev?.hidden }
  if (kind === 'move') {
    return { ...base, dx: Math.round(base.dx + sx * step), dy: Math.round(base.dy + sy * step) }
  }
  const w = base.width ?? rect.w
  const h = base.height ?? rect.h
  return {
    ...base,
    width: sx ? Math.max(unit, Math.round(w + sx * step)) : base.width,
    height: sy ? Math.max(unit, Math.round(h + sy * step)) : base.height,
  }
}

/** What Escape closes, in this order (DESIGN_SPEC §4 "Порядок Esc"); null — nothing. */
export type EscapeStep = 'coach' | 'chat' | 'details' | 'nudge' | 'pipette' | 'selection'

export function escapeStep(s: {
  coach: boolean
  chat: boolean
  details: boolean
  nudge: boolean
  pipette: boolean
  selected: boolean
}): EscapeStep | null {
  if (s.coach) return 'coach'
  if (s.chat) return 'chat'
  if (s.details) return 'details'
  if (s.nudge) return 'nudge'
  if (s.pipette) return 'pipette'
  if (s.selected) return 'selection'
  return null
}

/** After this many successful Alt picks the header hint folds down to its key cap (from the next load on). */
export const COMPACT_AFTER_PICKS = 3
