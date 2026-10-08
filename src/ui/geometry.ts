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

export interface HeldPlacement extends Placement {
  /** The tallest the card may grow on this side; past it, its own content scrolls. */
  maxH: number
}

/** Less room than this above or below the element is no place for a card that holds a thread. */
export const MIN_HELD_ROOM = 160

/**
 * Placement of a card that grows while it is open (the chat: every reply adds a line).
 *
 * The first call (`held` null) picks the side as `placePopover` does. Later calls pass
 * that side back: the card stays there and grows toward the free edge, and once the room
 * on that side is used up it stops growing — `maxH` is that room, the card's own list
 * scrolls. Re-picking the side from the grown size would throw the card across the frame
 * each time a line no longer fits (above the element → top-right corner).
 *
 * A held side is dropped only when it cannot take the card at all any more: the window
 * got narrower than the card next to the element, or less than `minRoom` is left above or
 * below it (the element moved, the window got shorter).
 */
export function placeHeldPopover(
  anchor: Rect,
  size: { w: number; h: number },
  canvas: { w: number; h: number },
  held: Side | null,
  gap = 12,
  margin = 12,
  minRoom = MIN_HELD_ROOM,
): HeldPlacement {
  const { w, h } = size
  const fullH = canvas.h - margin * 2
  const sideY = clamp(anchor.y, margin, canvas.h - h - margin)
  const x = clamp(anchor.x + anchor.w - w, margin, canvas.w - w - margin)
  const below = anchor.y + anchor.h + gap
  const roomBelow = canvas.h - margin - below
  const roomAbove = anchor.y - gap - margin

  const kept = ((): HeldPlacement | null => {
    switch (held) {
      case 'right': {
        const right = anchor.x + anchor.w + gap
        return right + w <= canvas.w - margin ? { x: right, y: sideY, side: 'right', maxH: fullH } : null
      }
      case 'left': {
        const left = anchor.x - gap - w
        return left >= margin ? { x: left, y: sideY, side: 'left', maxH: fullH } : null
      }
      case 'bottom':
        return roomBelow >= Math.min(h, minRoom) ? { x, y: below, side: 'bottom', maxH: roomBelow } : null
      case 'top':
        // Bottom edge pinned `gap` above the element; the card grows upward into the room.
        return roomAbove >= Math.min(h, minRoom) ? { x, y: anchor.y - gap - Math.min(h, roomAbove), side: 'top', maxH: roomAbove } : null
      case 'corner':
        return { x: Math.max(margin, canvas.w - w - margin), y: margin, side: 'corner', maxH: fullH }
      default:
        return null
    }
  })()
  if (kept) return kept

  const p = placePopover(anchor, size, canvas, gap, margin)
  const maxH = p.side === 'top' ? roomAbove : p.side === 'bottom' ? roomBelow : fullH
  return { ...p, maxH }
}

export interface LabelPlacement {
  vertical: 'above' | 'below' | 'inside'
  align: 'left' | 'right'
}

/**
 * A box label sits above the box on the left. Too close to the top edge it goes below;
 * a box that is also taller than three labels (body, a full-screen Scaffold) would push a
 * label below off the useful part of the frame, so it goes inside, in the top corner.
 * Past the right edge the label aligns to the box's right side instead. `box` is in
 * canvas pixels; the room above is the label, a 4px gap and 2px slack.
 */
export function placeLabel(box: Rect, labelWidth: number, canvasWidth: number, labelHeight = 20): LabelPlacement {
  const room = labelHeight + 6
  return {
    vertical: box.y >= room ? 'above' : box.h > labelHeight * 3 ? 'inside' : 'below',
    align: box.x - 1.5 + labelWidth > canvasWidth - 4 ? 'right' : 'left',
  }
}

/**
 * The part of a device picture that shows `rect` (frame px). The picture may be decoded at
 * another size than the frame (`natural` vs `viewport`); the result is in picture pixels,
 * clipped to the picture. Null when nothing of the rect is on it.
 */
export function frameCropRect(rect: Rect, natural: { w: number; h: number }, viewport: { w: number; h: number }): Rect | null {
  if (viewport.w <= 0 || viewport.h <= 0 || natural.w <= 0 || natural.h <= 0) return null
  const kx = natural.w / viewport.w
  const ky = natural.h / viewport.h
  const x0 = clamp(rect.x * kx, 0, natural.w)
  const y0 = clamp(rect.y * ky, 0, natural.h)
  const x1 = clamp((rect.x + rect.w) * kx, 0, natural.w)
  const y1 = clamp((rect.y + rect.h) * ky, 0, natural.h)
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}
