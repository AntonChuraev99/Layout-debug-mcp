/**
 * Pure scheduling helpers of the Android capture path: one device capture shared by
 * every window that asks while it runs, the device picture of the latest frame kept
 * in memory, and a time budget that keeps a capture shorter than the window's
 * watchdog. No I/O, so they are unit-tested directly (androidCapture.test.ts).
 */

/**
 * Single-flight for an async task. `join()` shares the run in flight, or starts one:
 * three windows polling the device cost one capture, not three. `fresh()` is for a
 * caller that changed the device (a live edit reset) and needs a run that *starts*
 * after now: it waits for the run in flight and then starts one more, shared by every
 * `fresh()` caller that came meanwhile.
 */
export class Coalescer<T> {
  private running: Promise<T> | null = null
  private queued: Promise<T> | null = null

  constructor(private readonly task: () => Promise<T>) {}

  /** A run is in flight right now. */
  get busy(): boolean {
    return this.running !== null
  }

  join(): Promise<T> {
    return this.running ?? this.start()
  }

  fresh(): Promise<T> {
    if (!this.running) return this.start()
    if (this.queued) return this.queued
    const settled = this.running.then(
      () => undefined,
      () => undefined,
    )
    const queued = settled.then(() => {
      this.queued = null
      // Someone may have started a run between the two (a join after the settle):
      // it also started after the fresh() call, so it is fresh enough to share.
      return this.join()
    })
    this.queued = queued
    return queued
  }

  private start(): Promise<T> {
    const run = (async () => this.task())().finally(() => {
      if (this.running === run) this.running = null
    })
    this.running = run
    return run
  }
}

/**
 * The device picture of one frame. Holds exactly one picture (the newest), so memory
 * stays bounded however many frames go by. A request for frame N gets the cached
 * picture when it is frame N or newer; otherwise one load runs for the current frame
 * and every request that comes meanwhile shares it.
 */
export class FrameCache<T> {
  private latest: { frame: number; value: T } | null = null
  private pending: { frame: number; promise: Promise<T> } | null = null

  private edits = 0

  /**
   * Bumped by `changed()`. A capture reads it when it starts and hands it to `put`:
   * a picture requested before a live edit must never be published as a frame that
   * comes after the edit — the element would jump back to its old place on screen.
   */
  get epoch(): number {
    return this.edits
  }

  /**
   * What the device shows changed (a live edit, a reset): pictures taken before now
   * are no longer kept, and the one held is dropped, so the next request for a newer
   * frame is fetched live.
   */
  changed(): void {
    this.edits++
    this.latest = null
    this.pending = null
  }

  /**
   * Keeps `value` as the picture of `frame` unless a newer one is already held, or
   * unless it was taken (`takenAt`, the `epoch` when it was requested) before the
   * device last changed.
   */
  put(frame: number, value: T, takenAt: number = this.edits): void {
    if (takenAt !== this.edits) return
    if (this.latest && this.latest.frame > frame) return
    this.latest = { frame, value }
  }

  /** The cached frame number, or null. */
  get frame(): number | null {
    return this.latest?.frame ?? null
  }

  /**
   * The picture for `requested` (null: whatever is newest). `current` is the frame
   * the server is on now: a load started here is stored under it.
   */
  get(requested: number | null, current: number, load: () => Promise<T>): Promise<T> {
    const target = requested ?? this.latest?.frame ?? current
    if (this.latest && this.latest.frame >= target) return Promise.resolve(this.latest.value)
    if (this.pending && this.pending.frame >= target) return this.pending.promise
    // Stored under the server's frame, never ahead of it: a bogus `?f=` from the future
    // must not shadow the next real capture.
    const frame = current
    const takenAt = this.edits
    const promise = load().then((value) => {
      this.put(frame, value, takenAt)
      return value
    })
    const entry = { frame, promise }
    this.pending = entry
    const clear = () => {
      if (this.pending === entry) this.pending = null
    }
    promise.then(clear, clear)
    return promise
  }
}

/** `?f=12` (the window) or `?frame=12` → 12; absent or not a whole number → null. */
export function parseFrameParam(params: URLSearchParams): number | null {
  const raw = params.get('f') ?? params.get('frame')
  if (raw === null || !/^\d{1,15}$/.test(raw.trim())) return null
  return Number(raw.trim())
}

/**
 * Wall-clock budget of one capture. Every device request takes at most
 * `min(perRequestMs, what is left)`, and a retry happens only while at least
 * `minRetryMs` is left, so a hung agent ends the capture inside the budget instead
 * of piling requests up behind the window's watchdog.
 */
export class Budget {
  private readonly endsAt: number

  constructor(
    totalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.endsAt = this.now() + totalMs
  }

  remaining(): number {
    return Math.max(0, this.endsAt - this.now())
  }

  /** Timeout for the next request: capped by `perRequestMs` and by what is left (at least 1 ms). */
  timeout(perRequestMs: number): number {
    return Math.max(1, Math.min(perRequestMs, this.remaining()))
  }

  /** Is there time for another attempt of at least `minMs`? */
  allows(minMs: number): boolean {
    return this.remaining() >= minMs
  }
}
