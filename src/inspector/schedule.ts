/**
 * Snapshot debounce with a ceiling. Each page mutation asks for a capture `delay` ms later
 * and pushes the previous ask back; on a page that never stops mutating (a clock, a
 * spinner, a carousel) a plain debounce would never fire, and the window would keep
 * showing the boxes of the first snapshot. So no capture is held back longer than
 * `maxWait` after the first ask that is still waiting.
 */
export const CAPTURE_MAX_WAIT_MS = 1000

/**
 * How long from `now` to wait for a capture asked with `delay`, when the oldest ask still
 * waiting was made at `pendingSince` (pass `now` for the first ask).
 */
export function captureDelay(now: number, delay: number, pendingSince: number, maxWait = CAPTURE_MAX_WAIT_MS): number {
  return Math.max(0, Math.min(delay, pendingSince + maxWait - now))
}
