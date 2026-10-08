import type { EditRequest } from '../shared/protocol.ts'

/**
 * Listen mode: agents long-poll POST /api/requests/wait, and each request the
 * window sends goes to exactly one of them. Kept apart from the HTTP layer so the
 * lifecycle (deliver once, release on disconnect, timeout, FIFO, listening flag) is
 * tested without sockets.
 */

/** One open wait, as the HTTP handler sees it. */
export interface WaitSink {
  /**
   * Write `request` to the client. Call `written(true)` once the response is out,
   * `written(false)` when the client went away first; the request then goes to the
   * next waiter. Extra calls are ignored.
   */
  deliver(request: EditRequest, written: (ok: boolean) => void): void
  /** Nothing arrived within the timeout. */
  timeout(): void
}

export interface WaitHubOptions {
  /** Requests that may be handed out, oldest first. */
  pending(): EditRequest[]
  /** The response carrying `id` reached the client: the request is now being worked on. */
  delivered(id: string): void
  /**
   * A request handed out by a wait is still being worked on (not replied to, not cleared).
   * While one is, the agent counts as listening. Default: never.
   */
  stillWorking?(id: string): boolean
  /** The window's "agent listening" indicator. */
  listeningChanged(listening: boolean): void
  /** An agent still counts as listening this long after its last wait ended. */
  graceMs?: number
  /**
   * A handed-out request that is still `working` keeps the flag on at most this long after
   * the wait that handed it out ended: an agent that crashed or was quit before replying must not look
   * like it listens forever. The request itself stays `working`.
   */
  workingHoldMs?: number
  now?: () => number
}

export const LISTEN_GRACE_MS = 10_000
export const WORKING_HOLD_MS = 15 * 60_000

interface Waiter {
  sink: WaitSink
  timer: ReturnType<typeof setTimeout>
}

export class WaitHub {
  private waiters: Waiter[] = []
  /** Handed to a waiter, response not yet written: no other waiter may get it. */
  private reserved = new Set<string>()
  private lastEndedAt = Number.NEGATIVE_INFINITY
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private announced = false
  /** Handed out through a wait and not yet settled → when; pruned with stillWorking(). */
  private handedOut = new Map<string, number>()
  private readonly graceMs: number
  private readonly workingHoldMs: number
  private readonly now: () => number

  constructor(private readonly opts: WaitHubOptions) {
    this.graceMs = opts.graceMs ?? LISTEN_GRACE_MS
    this.workingHoldMs = opts.workingHoldMs ?? WORKING_HOLD_MS
    this.now = opts.now ?? Date.now
  }

  get openWaits(): number {
    return this.waiters.length
  }

  /**
   * Pure: reads state, changes nothing, so it gives the same answer wherever it is
   * called (health, ready, update). An open wait ends by an event; a working request by
   * an event (refresh() after a reply or a clear) or by its hold running out; the grace
   * period by time. update() keeps a timer armed for whichever time limit comes next.
   */
  get listening(): boolean {
    return this.waiters.length > 0 || this.inGrace() || this.working()
  }

  private inGrace(): boolean {
    return this.now() - this.lastEndedAt < this.graceMs
  }

  private held(handedOutAt: number): boolean {
    return this.now() - handedOutAt < this.workingHoldMs
  }

  /**
   * Re-evaluates the listening flag after a request changed status outside the hub
   * (a reply closed it, the queue was cleared). Announces a change, if any.
   */
  refresh(): void {
    this.update()
  }

  /** A request handed out by a wait is still open. A long silence never requeues it. */
  private working(): boolean {
    const still = this.opts.stillWorking
    for (const [id, at] of this.handedOut) if (this.held(at) && still?.(id)) return true
    // A response still being written counts too, so the flag does not blink off between
    // the wait ending and the request turning `working`.
    return this.reserved.size > 0
  }

  /** Forgets handed-out requests that are no longer working (replied, cleared). */
  private prune(): void {
    const still = this.opts.stillWorking
    for (const id of this.handedOut.keys()) if (!still?.(id)) this.handedOut.delete(id)
  }

  /** Last moment an agent was waiting (now, while one is). */
  get lastActiveAt(): number {
    return this.waiters.length ? this.now() : this.lastEndedAt
  }

  /**
   * Opens a wait. A pending request is handed out at once; otherwise the sink gets
   * the next one that arrives, or `timeout()` after `timeoutMs`. The returned
   * function cancels the wait (client disconnected) without consuming anything.
   */
  wait(sink: WaitSink, timeoutMs: number): () => void {
    const waiter: Waiter = {
      sink,
      timer: setTimeout(() => {
        if (!this.remove(waiter)) return
        this.ended()
        sink.timeout()
      }, timeoutMs),
    }
    this.waiters.push(waiter)
    this.update()
    this.dispatch()
    return () => {
      if (this.remove(waiter)) this.ended()
    }
  }

  /** Hands pending requests to open waits, oldest request to the oldest wait. */
  dispatch(): void {
    while (this.waiters.length) {
      const request = this.opts.pending().find((r) => !this.reserved.has(r.id))
      if (!request) return
      const waiter = this.waiters.shift()!
      clearTimeout(waiter.timer)
      this.reserved.add(request.id)
      this.ended()
      let settled = false
      waiter.sink.deliver(request, (ok) => {
        if (settled) return
        settled = true
        this.reserved.delete(request.id)
        if (ok) {
          this.handedOut.set(request.id, this.now())
          this.opts.delivered(request.id)
          this.update()
        } else {
          this.update()
          this.dispatch()
        }
      })
    }
  }

  /** Stops every timer (server shutdown, tests). Open waits are left to their sockets. */
  close(): void {
    for (const w of this.waiters) clearTimeout(w.timer)
    this.waiters = []
    this.handedOut.clear()
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = null
  }

  private remove(waiter: Waiter): boolean {
    const i = this.waiters.indexOf(waiter)
    if (i === -1) return false
    clearTimeout(waiter.timer)
    this.waiters.splice(i, 1)
    return true
  }

  private ended(): void {
    this.lastEndedAt = this.now()
    this.update()
  }

  private update(): void {
    this.prune()
    const listening = this.listening
    if (listening !== this.announced) {
      this.announced = listening
      this.opts.listeningChanged(listening)
    }
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = null
    if (this.waiters.length) return
    // Two reasons end by time alone: the grace period and the hold of a working request.
    // Keep a timer for the next of those limits that is still ahead, whatever else holds
    // the flag now (a working request may be closed before the grace ends), so its end
    // is re-evaluated and announced.
    const limits: number[] = []
    if (this.inGrace()) limits.push(this.lastEndedAt + this.graceMs)
    for (const at of this.handedOut.values()) if (this.held(at)) limits.push(at + this.workingHoldMs)
    if (limits.length) {
      const left = Math.max(0, Math.min(...limits) - this.now())
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null
        this.update()
      }, left + 1)
      this.graceTimer.unref?.()
    }
  }
}
