import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { CAPTURE_MAX_WAIT_MS, captureDelay } from './schedule.ts'

/**
 * Replays a page's asks through the same rules as scheduleCapture in index.ts:
 * every ask replaces the pending timer; a fired timer clears the pending mark.
 * Returns the times captures went out.
 */
function simulate(asks: Array<{ at: number; delay: number }>, until: number): number[] {
  const fired: number[] = []
  let pendingSince: number | null = null
  let due: number | null = null
  let i = 0
  for (let now = 0; now <= until; now++) {
    if (due !== null && now >= due) {
      fired.push(now)
      due = null
      pendingSince = null
    }
    while (i < asks.length && asks[i]!.at === now) {
      if (pendingSince === null) pendingSince = now
      due = now + captureDelay(now, asks[i]!.delay, pendingSince)
      i++
    }
  }
  return fired
}

describe('captureDelay', () => {
  test('a lone ask waits its own delay', () => {
    assert.equal(captureDelay(500, 250, 500), 250)
    assert.equal(captureDelay(500, 0, 500), 0)
  })

  test('a later ask never pushes the capture past maxWait from the first one', () => {
    assert.equal(captureDelay(900, 250, 0), 100)
    assert.equal(captureDelay(1000, 250, 0), 0)
    assert.equal(captureDelay(1400, 250, 0), 0, 'overdue: right away, never negative')
  })

  test('a quiet page keeps the plain debounce: one capture 250 ms after the last mutation', () => {
    assert.deepEqual(simulate([{ at: 0, delay: 250 }, { at: 100, delay: 250 }, { at: 200, delay: 250 }], 2000), [450])
  })

  test('mutations every 100 ms for 3 s still give a snapshot at least once a second', () => {
    const asks = Array.from({ length: 30 }, (_, k) => ({ at: k * 100, delay: 250 }))
    const fired = simulate(asks, 4000)
    // Without the ceiling this would be a single capture at 3150.
    assert.deepEqual(fired, [CAPTURE_MAX_WAIT_MS, 2000, 3000])
    for (let k = 1; k < fired.length; k++) assert.ok(fired[k]! - fired[k - 1]! <= CAPTURE_MAX_WAIT_MS)
  })
})
