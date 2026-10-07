/** Pure geometry of the origin ghost (src/inspector/index.ts); node --test covers it (ghost.test.ts). */

export interface Area {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Inset {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * clip-path insets that cut `box` (viewport px) down to `area`, the part its clipping
 * containers still show. Null when nothing of the box is left: the ghost is hidden then.
 */
export function ghostInset(box: { x: number; y: number; w: number; h: number }, area: Area): Inset | null {
  const left = Math.max(0, area.left - box.x)
  const top = Math.max(0, area.top - box.y)
  const right = Math.max(0, box.x + box.w - area.right)
  const bottom = Math.max(0, box.y + box.h - area.bottom)
  if (box.w <= 0 || box.h <= 0 || left + right >= box.w || top + bottom >= box.h) return null
  const px = (v: number) => Math.round(v * 100) / 100
  return { top: px(top), right: px(right), bottom: px(bottom), left: px(left) }
}
