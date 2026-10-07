import type { Rect } from '../shared/protocol.ts'

export type Side = 'right' | 'left' | 'bottom' | 'top' | 'corner'

export interface Placement {
  x: number
  y: number
  side: Side
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)))

/**
 * Where a floating card (palette, chat) goes next to the selection. All numbers share
 * one space — the canvas. `anchor` is the selection box joined with its label.
 *
 * 1. right of it, 2. left of it — both vertically clamped into the canvas;
 * 3. below, then above, right-aligned to the anchor; 4. top-right corner of the canvas.
 */
export function placePopover(
  anchor: Rect,
  size: { w: number; h: number },
  canvas: { w: number; h: number },
  gap = 12,
  margin = 12,
): Placement {
  const { w, h } = size
  const sideY = clamp(anchor.y, margin, canvas.h - h - margin)

  const right = anchor.x + anchor.w + gap
  if (right + w <= canvas.w - margin) return { x: right, y: sideY, side: 'right' }

  const left = anchor.x - gap - w
  if (left >= margin) return { x: left, y: sideY, side: 'left' }

  const x = clamp(anchor.x + anchor.w - w, margin, canvas.w - w - margin)
  const below = anchor.y + anchor.h + gap
  if (below + h <= canvas.h - margin) return { x, y: below, side: 'bottom' }
  const above = anchor.y - gap - h
  if (above >= margin) return { x, y: above, side: 'top' }

  return { x: Math.max(margin, canvas.w - w - margin), y: margin, side: 'corner' }
}

export interface LabelPlacement {
  vertical: 'above' | 'below'
  align: 'left' | 'right'
}

/** Room a label above its box needs: 20px chip + 4px gap + 2px slack. */
const LABEL_ROOM = 26

/**
 * A box label sits above the box on the left. Too close to the top edge it goes below
 * (never inside — it would cover what is being measured); past the right edge it
 * aligns to the box's right side instead. `box` is in canvas pixels.
 */
export function placeLabel(box: Rect, labelWidth: number, canvasWidth: number): LabelPlacement {
  return {
    vertical: box.y < LABEL_ROOM ? 'below' : 'above',
    align: box.x - 1.5 + labelWidth > canvasWidth - 4 ? 'right' : 'left',
  }
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}
