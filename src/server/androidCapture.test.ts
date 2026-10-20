import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Budget, Coalescer, FrameCache, parseFrameParam } from './androidCapture.ts'

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setImmediate(r))

describe('Coalescer', () => {
  test('callers that come while a run is in flight share it: one task call', async () => {
    const gates: ReturnType<typeof deferred<number>>[] = []
    const c = new Coalescer(() => {
      const d = deferred<number>()
      gates.push(d)
      return d.promise
    })
    const a = c.join()
    const b = c.join()
    const d = c.join()
    assert.equal(gates.length, 1)
    assert.equal(c.busy, true)
    gates[0]!.resolve(7)
    assert.deepEqual(await Promise.all([a, b, d]), [7, 7, 7])
    assert.equal(c.busy, false)
  })

  test('a call after the run settled starts a new one', async () => {
    let calls = 0
    const c = new Coalescer(async () => ++calls)
    assert.equal(await c.join(), 1)
    assert.equal(await c.join(), 2)
  })

  test('a failure reaches every caller of that run, and the next call starts afresh', async () => {
    let calls = 0
    const c = new Coalescer(async () => {
      calls++
      if (calls === 1) throw new Error('device gone')
      return 'ok'
    })
    const results = await Promise.allSettled([c.join(), c.join()])
    assert.equal(calls, 1)
    assert.deepEqual(
      results.map((r) => r.status),
      ['rejected', 'rejected'],
    )
    assert.equal(await c.join(), 'ok')
    assert.equal(calls, 2)
  })

  test('a synchronous throw in the task still frees the slot', async () => {
    let calls = 0
    const c = new Coalescer<number>(() => {
      calls++
      if (calls === 1) throw new Error('sync')
      return Promise.resolve(calls)
    })
    await assert.rejects(c.join(), /sync/)
    assert.equal(await c.join(), 2)
  })

  test('fresh() waits for the run in flight and gets a run that started after it was called', async () => {
    const gates: ReturnType<typeof deferred<string>>[] = []
    const c = new Coalescer(() => {
      const d = deferred<string>()
      gates.push(d)
      return d.promise
    })
    const stale = c.join()
    const fresh1 = c.fresh()
    const fresh2 = c.fresh()
    assert.equal(gates.length, 1, 'fresh() does not start a second run while one is in flight')
    gates[0]!.resolve('before the edit')
    assert.equal(await stale, 'before the edit')
    await tick()
    assert.equal(gates.length, 2, 'one more run after the one in flight')
    gates[1]!.resolve('after the edit')
    assert.deepEqual(await Promise.all([fresh1, fresh2]), ['after the edit', 'after the edit'])
  })

  test('fresh() with nothing in flight just starts a run', async () => {
    let calls = 0
    const c = new Coalescer(async () => ++calls)
    assert.equal(await c.fresh(), 1)
  })

  test('fresh() still runs when the run in flight failed', async () => {
    let calls = 0
    const first = deferred<number>()
    const c = new Coalescer(() => (++calls === 1 ? first.promise : Promise.resolve(calls)))
    const stale = c.join()
    const fresh = c.fresh()
    first.reject(new Error('timeout'))
    await assert.rejects(stale, /timeout/)
    assert.equal(await fresh, 2)
  })
})

describe('FrameCache', () => {
  test('the picture put with a frame is served for that frame without loading', async () => {
    const cache = new FrameCache<string>()
    cache.put(3, 'png-3')
    let loads = 0
    assert.equal(await cache.get(3, 3, async () => `live-${++loads}`), 'png-3')
    assert.equal(loads, 0)
  })

  test('holds one frame: a newer put replaces it, an older one is ignored', async () => {
    const cache = new FrameCache<string>()
    cache.put(1, 'png-1')
    cache.put(2, 'png-2')
    cache.put(1, 'late png-1')
    assert.equal(cache.frame, 2)
    // An older frame number gets the newest picture: the window never shows an older one anyway.
    assert.equal(await cache.get(1, 2, async () => 'live'), 'png-2')
  })

  test('a frame with no picture (a live edit moved the frame on) loads once, shared, and is kept', async () => {
    const cache = new FrameCache<string>()
    cache.put(4, 'png-4')
    const gate = deferred<string>()
    let loads = 0
    const load = () => {
      loads++
      return gate.promise
    }
    const a = cache.get(5, 5, load)
    const b = cache.get(5, 5, load)
    assert.equal(loads, 1)
    gate.resolve('live-5')
    assert.deepEqual(await Promise.all([a, b]), ['live-5', 'live-5'])
    assert.equal(cache.frame, 5)
    assert.equal(await cache.get(5, 5, async () => 'again'), 'live-5')
  })

  test('without a frame number: the newest picture in memory, or a live load when there is none', async () => {
    const cache = new FrameCache<string>()
    assert.equal(await cache.get(null, 0, async () => 'live'), 'live')
    cache.put(2, 'png-2')
    assert.equal(await cache.get(null, 9, async () => 'live again'), 'png-2')
  })

  test('a failed load is not cached: the next request tries again', async () => {
    const cache = new FrameCache<string>()
    await assert.rejects(
      cache.get(1, 1, async () => {
        throw new Error('HTTP 500')
      }),
      /HTTP 500/,
    )
    assert.equal(cache.frame, null)
    assert.equal(await cache.get(1, 1, async () => 'ok'), 'ok')
  })

  test('a slow live load does not overwrite the picture of a newer capture', async () => {
    const cache = new FrameCache<string>()
    const gate = deferred<string>()
    const slow = cache.get(5, 5, () => gate.promise)
    cache.put(6, 'png-6')
    gate.resolve('live-5')
    assert.equal(await slow, 'live-5')
    assert.equal(cache.frame, 6)
    assert.equal(await cache.get(6, 6, async () => 'live'), 'png-6')
  })

  test('a picture taken before a live edit is not kept for a frame that comes after it', async () => {
    // Capture C starts at frame 4; the device sends its picture before the edit lands.
    const cache = new FrameCache<string>()
    cache.put(4, 'png-4')
    const takenAt = cache.epoch
    // The edit lands: the frame moves to 5 with no picture, the window fetches it live.
    cache.changed()
    assert.equal(await cache.get(5, 5, async () => 'live-5 (moved)'), 'live-5 (moved)')
    // C finishes and is published as frame 6 with its pre-edit picture.
    cache.put(6, 'png pre-edit', takenAt)
    let loads = 0
    const shown = await cache.get(6, 6, async () => {
      loads++
      return 'live-6 (moved)'
    })
    assert.equal(shown, 'live-6 (moved)', 'frame 6 must not show the element back at its old place')
    assert.equal(loads, 1)
  })

  test('a live load that started before an edit is answered but not kept', async () => {
    const cache = new FrameCache<string>()
    const gate = deferred<string>()
    const slow = cache.get(5, 5, () => gate.promise)
    cache.changed()
    gate.resolve('pre-edit')
    assert.equal(await slow, 'pre-edit', 'whoever asked still gets an answer')
    assert.equal(cache.frame, null)
  })

  test('a picture taken with no edit since is kept as before', () => {
    const cache = new FrameCache<string>()
    const takenAt = cache.epoch
    cache.put(2, 'png-2', takenAt)
    assert.equal(cache.frame, 2)
  })

  test('a frame number from the future is loaded live but stored under the current frame', async () => {
    const cache = new FrameCache<string>()
    assert.equal(await cache.get(99, 3, async () => 'live'), 'live')
    assert.equal(cache.frame, 3)
    cache.put(4, 'png-4')
    assert.equal(await cache.get(4, 4, async () => 'other'), 'png-4')
  })
})

describe('parseFrameParam', () => {
  const p = (q: string) => parseFrameParam(new URLSearchParams(q))
  test('f (the window) and frame are read; anything else is no frame', () => {
    assert.equal(p('f=12'), 12)
    assert.equal(p('frame=3'), 3)
    assert.equal(p('f=0'), 0)
    assert.equal(p(''), null)
    assert.equal(p('f='), null)
    assert.equal(p('f=-1'), null)
    assert.equal(p('f=1.5'), null)
    assert.equal(p('f=abc'), null)
    assert.equal(p('f=1e3'), null)
    assert.equal(p(`f=${'9'.repeat(30)}`), null)
  })
})

describe('Budget', () => {
  test('a request gets the per-request cap while the budget has room, then what is left', () => {
    let now = 1_000
    const b = new Budget(7_000, () => now)
    assert.equal(b.timeout(6_000), 6_000)
    now += 6_000
    assert.equal(b.remaining(), 1_000)
    assert.equal(b.timeout(6_000), 1_000)
  })

  test('a retry is allowed only while enough of the budget is left', () => {
    let now = 0
    const b = new Budget(7_000, () => now)
    assert.equal(b.allows(1_500), true)
    now = 5_400
    assert.equal(b.allows(1_500), true)
    now = 5_600
    assert.equal(b.allows(1_500), false)
  })

  test('a spent budget never yields a zero or negative timeout', () => {
    let now = 0
    const b = new Budget(100, () => now)
    now = 10_000
    assert.equal(b.remaining(), 0)
    assert.equal(b.timeout(6_000), 1)
  })

  test('the worst case of one capture stays under the window watchdog (8 s)', () => {
    // Mirrors android.ts: first request times out at the cap, a retry only fits if
    // MIN_RETRY_MS is left, and it gets no more than what is left.
    let now = 0
    const b = new Budget(7_000, () => now)
    now += b.timeout(6_000)
    if (b.allows(1_500)) now += b.timeout(6_000)
    assert.ok(now <= 7_000, `capture took ${now} ms`)
  })
})
