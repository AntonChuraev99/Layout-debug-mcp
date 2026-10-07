import { useCallback, useEffect, useRef, useState } from 'react'

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
  /** A capture is on the wire right now. */
  inflight: boolean
  /** Capture now instead of waiting for the next tick (still one at a time). */
  refreshNow: () => void
}

/**
 * Keeps the device frame fresh without a button: one capture at a time, the next
 * one scheduled only after the previous answered, backing off while it keeps failing
 * so a dead device produces one visible error instead of a stream of them.
 */
export function useAndroidAutoRefresh({ enabled, paused, frame, errorSeq, capture }: Options): AutoRefresh {
  const captureRef = useRef(capture)
  captureRef.current = capture
  const inflightRef = useRef(false)
  const watchdog = useRef<number | undefined>(undefined)
  const [failures, setFailures] = useState(0)
  const [inflight, setInflight] = useState(false)
  const [tick, setTick] = useState(0)

  const settle = useCallback((ok: boolean) => {
    if (!inflightRef.current) {
      // A frame can also land without our asking (an override refetch): that is still proof of life.
      if (ok) setFailures(0)
      return
    }
    inflightRef.current = false
    setInflight(false)
    window.clearTimeout(watchdog.current)
    setFailures((f) => (ok ? 0 : f + 1))
    setTick((t) => t + 1)
  }, [])

  const fire = useCallback(() => {
    if (inflightRef.current) return
    if (!captureRef.current()) return
    inflightRef.current = true
    setInflight(true)
    watchdog.current = window.setTimeout(() => settle(false), WATCHDOG_MS)
  }, [settle])

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

  useEffect(() => {
    if (!enabled || paused || inflightRef.current) return
    const delay = failures ? Math.min(INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS) : INTERVAL_MS
    const timer = window.setTimeout(fire, delay)
    return () => window.clearTimeout(timer)
  }, [enabled, paused, tick, failures, fire])

  useEffect(() => () => window.clearTimeout(watchdog.current), [])

  return { failures, inflight, refreshNow: fire }
}
