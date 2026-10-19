import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

const INTERVAL_MS = 800
const MAX_BACKOFF_MS = 10_000
/** A capture that neither lands nor fails within this is counted as a failure. */
const WATCHDOG_MS = 8_000

interface Options {
  enabled: boolean
  /** True while the user drags: a new frame mid-drag would fight the pointer. */
  paused: boolean
  /** Server's frame counter — it moves when a snapshot lands. */
  frame: number
  /** Server's capture-error counter — it moves when a device capture fails. */
  errorSeq: number
  capture: () => boolean
}

export interface AutoRefresh {
  /** Consecutive failed captures; 0 while frames keep landing. */
  failures: number
  /**
   * A capture is on the wire right now. Read, not rendered: it flips twice per device frame,
   * and a state for it would re-render the whole window each time. A control that shows it
   * subscribes with `useInflight`.
   */
  isInflight: () => boolean
  subscribeInflight: (onChange: () => void) => () => void
  /** Capture now instead of waiting for the next tick (still one at a time). */
  refreshNow: () => void
}

/** Re-renders only the caller when a capture goes out or answers (a "Capturing…" button). */
export function useInflight(refresh: AutoRefresh): boolean {
  return useSyncExternalStore(refresh.subscribeInflight, refresh.isInflight)
}

/**
 * Keeps the device frame fresh without a button: one capture at a time, the next
 * one scheduled only after the previous answered, backing off while it keeps failing
 * so a dead device produces one visible error instead of a stream of them.
 *
 * Only `failures` is state (the window shows it); the in-flight flag and the schedule
 * live in refs, so a healthy capture loop costs the window no render of its own.
 */
export function useAndroidAutoRefresh({ enabled, paused, frame, errorSeq, capture }: Options): AutoRefresh {
  const captureRef = useRef(capture)
  captureRef.current = capture
  const gate = useRef({ enabled, paused })
  gate.current = { enabled, paused }

  const inflightRef = useRef(false)
  const listeners = useRef(new Set<() => void>())
  const setInflight = useCallback((on: boolean) => {
    if (inflightRef.current === on) return
    inflightRef.current = on
    for (const l of listeners.current) l()
  }, [])

  const [failures, setFailures] = useState(0)
  const failuresRef = useRef(0)
  const setFailureCount = useCallback((n: number) => {
    if (failuresRef.current === n) return
    failuresRef.current = n
    setFailures(n)
  }, [])

  const watchdog = useRef<number | undefined>(undefined)
  const timer = useRef<number | undefined>(undefined)
  const fireRef = useRef<() => void>(() => {})

  /** The next capture after the usual pause, or a longer one while captures keep failing. */
  const schedule = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    const { enabled: on, paused: held } = gate.current
    if (!on || held || inflightRef.current) return
    const f = failuresRef.current
    const delay = f ? Math.min(INTERVAL_MS * 2 ** f, MAX_BACKOFF_MS) : INTERVAL_MS
    timer.current = window.setTimeout(() => fireRef.current(), delay)
  }, [])

  const settle = useCallback(
    (ok: boolean) => {
      if (!inflightRef.current) {
        // A frame can also land without our asking (an override refetch): that is still proof of life.
        if (ok && failuresRef.current) {
          setFailureCount(0)
          schedule()
        }
        return
      }
      setInflight(false)
      window.clearTimeout(watchdog.current)
      setFailureCount(ok ? 0 : failuresRef.current + 1)
      schedule()
    },
    [schedule, setFailureCount, setInflight],
  )

  const fire = useCallback(() => {
    if (inflightRef.current) return
    window.clearTimeout(timer.current)
    timer.current = undefined
    // Socket down: no capture now. `enabled` follows the connection, so the loop starts
    // again on its own when it is back.
    if (!captureRef.current()) return
    setInflight(true)
    watchdog.current = window.setTimeout(() => settle(false), WATCHDOG_MS)
  }, [settle, setInflight])
  fireRef.current = fire

  const first = useRef(true)
  useEffect(() => {
    if (first.current) return
    settle(true)
  }, [frame, settle])
  useEffect(() => {
    if (first.current) return
    settle(false)
  }, [errorSeq, settle])
  useEffect(() => {
    first.current = false
  }, [])

  // Turned on, resumed after a drag, or back online: the loop picks up from here.
  useEffect(() => {
    schedule()
    return () => {
      window.clearTimeout(timer.current)
      timer.current = undefined
    }
  }, [enabled, paused, schedule])

  useEffect(() => () => window.clearTimeout(watchdog.current), [])

  const subscribeInflight = useCallback((onChange: () => void) => {
    listeners.current.add(onChange)
    return () => {
      listeners.current.delete(onChange)
    }
  }, [])
  const isInflight = useCallback(() => inflightRef.current, [])

  return useMemo(() => ({ failures, isInflight, subscribeInflight, refreshNow: fire }), [failures, isInflight, subscribeInflight, fire])
}
