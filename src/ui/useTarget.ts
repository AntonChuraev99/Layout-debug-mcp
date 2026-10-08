import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PROTOCOL_TAG,
  type InspectorToUi,
  type NodeId,
  type Override,
  type Snapshot,
  type UiToInspector,
} from '../shared/protocol.ts'
import { isKeyMessage } from '../inspector/keys.ts'
import { frameOrigin } from './origins.ts'

/** Boxes reappear only this long after the page's last scroll (with the fresh snapshot). */
const SCROLL_SETTLE_MS = 90
/** A scroll whose snapshot never comes (a page that throws in capture) must not hide the selection forever. */
const SCROLL_FALLBACK_MS = 700

export interface TargetEvents {
  /** The selection modifier, as the page saw it while it had focus. */
  onAlt?: (down: boolean, blur: boolean) => void
  /** An Alt+click the page swallowed: select at this point of the frame. */
  onAltPick?: (x: number, y: number) => void
  /** Where the cursor rests over the page (answer to `queryPointer`). */
  onPointer?: (x: number, y: number) => void
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Origins already reported as unusable, so a drag does not print one warning per pixel. */
const warnedOrigins = new Set<string>()

/**
 * Commands go to the frame's own origin, never `*`: if the frame navigated to another site,
 * the browser drops the message instead of handing live-edit commands to that site.
 */
function postTo(frame: HTMLIFrameElement | null, msg: UiToInspector) {
  const win = frame?.contentWindow
  if (!frame || !win) return
  const origin = frameOrigin(frame.src)
  if (!origin) {
    // The status pill already says the inspector does not answer; this says why.
    if (!warnedOrigins.has(frame.src)) {
      warnedOrigins.add(frame.src)
      console.warn(`[layout-debug] the frame address ${JSON.stringify(frame.src)} has no http(s) origin; the inspector can't be reached there`)
    }
    return
  }
  win.postMessage(msg, origin)
}

/**
 * Bridge to the inspector running inside the target page. Cross-origin by
 * design: we never touch the iframe's DOM, we only exchange messages with it.
 */
export function useTarget(iframeRef: React.RefObject<HTMLIFrameElement | null>, events?: React.RefObject<TargetEvents>) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<Record<NodeId, Override>>({})
  const [scrolling, setScrolling] = useState(false)
  const overridesRef = useRef(overrides)
  overridesRef.current = overrides
  /** Guards the one-time reset of tweaks left in the page by a previous UI session. */
  const syncedRef = useRef(false)
  const scroll = useRef<{ at: number; timer: number | undefined }>({ at: 0, timer: undefined })

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only the page in the frame, and only from the address the window opened there: a page
      // that navigated the frame elsewhere, or any other window, cannot feed keys or snapshots.
      const frame = iframeRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const origin = frameOrigin(frame.src)
      if (!origin || event.origin !== origin) return

      if (isKeyMessage(event.data)) {
        // A window key pressed while focus sits in the live page. Replayed as a keydown on
        // the window, so the one key handler in App applies all its guards (open chat,
        // Escape order, nudge on or off) exactly as for a key typed here.
        const { key, shift } = event.data
        const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
        window.dispatchEvent(new KeyboardEvent('keydown', { key, code, shiftKey: Boolean(shift), cancelable: true }))
        return
      }
      const data = event.data as InspectorToUi | undefined
      if (!data || typeof data !== 'object' || data.tag !== PROTOCOL_TAG || data.from !== 'inspector') return

      switch (data.t) {
        case 'hello':
          setConnected(true)
          setError(null)
          break
        case 'alt':
          if (typeof data.down === 'boolean') events?.current?.onAlt?.(data.down, data.blur === true)
          break
        case 'altPick':
          if (isNum(data.x) && isNum(data.y)) events?.current?.onAltPick?.(data.x, data.y)
          break
        case 'pointer':
          if (isNum(data.x) && isNum(data.y)) events?.current?.onPointer?.(data.x, data.y)
          break
        case 'scrolling': {
          const s = scroll.current
          s.at = Date.now()
          window.clearTimeout(s.timer)
          s.timer = window.setTimeout(() => setScrolling(false), SCROLL_FALLBACK_MS)
          setScrolling(true)
          break
        }
        case 'snapshot':
          setConnected(true)
          setSnapshot(data.snapshot)
          if (Date.now() - scroll.current.at >= SCROLL_SETTLE_MS) {
            window.clearTimeout(scroll.current.timer)
            setScrolling(false)
          }
          // The UI can reload (HMR, refresh) while the page keeps the inline
          // styles from a previous session. Those tweaks are unmanageable once
          // we've lost their ids, so the first snapshot resets the page.
          if (!syncedRef.current) {
            syncedRef.current = true
            postTo(iframeRef.current, { tag: PROTOCOL_TAG, from: 'ui', t: 'clearAllOverrides' })
          }
          break
        case 'error':
          setError(data.message)
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(scroll.current.timer)
    }
  }, [iframeRef, events])

  const send = useCallback(
    (msg: UiToInspector) => postTo(iframeRef.current, msg),
    [iframeRef],
  )

  const capture = useCallback(() => send({ tag: PROTOCOL_TAG, from: 'ui', t: 'capture' }), [send])

  const setOverride = useCallback(
    (override: Override) => {
      setOverrides((prev) => ({ ...prev, [override.nodeId]: override }))
      send({ tag: PROTOCOL_TAG, from: 'ui', t: 'setOverride', override })
    },
    [send],
  )

  const clearOverride = useCallback(
    (nodeId: NodeId) => {
      setOverrides((prev) => {
        const next = { ...prev }
        delete next[nodeId]
        return next
      })
      send({ tag: PROTOCOL_TAG, from: 'ui', t: 'clearOverride', nodeId })
    },
    [send],
  )

  const clearAllOverrides = useCallback(() => {
    setOverrides({})
    send({ tag: PROTOCOL_TAG, from: 'ui', t: 'clearAllOverrides' })
  }, [send])

  /** The overlay caught a wheel over the selected layer: scroll the page under that point. */
  const forwardWheel = useCallback(
    (x: number, y: number, dx: number, dy: number) => send({ tag: PROTOCOL_TAG, from: 'ui', t: 'wheel', x, y, dx, dy }),
    [send],
  )

  /** Arrows typed in the page go to the window while the palette's nudge row is on. */
  const setNudge = useCallback((on: boolean) => send({ tag: PROTOCOL_TAG, from: 'ui', t: 'nudge', on }), [send])

  /** Only scrolls that move this layer hide the window's boxes. */
  const setSelected = useCallback((nodeId: NodeId | null) => send({ tag: PROTOCOL_TAG, from: 'ui', t: 'selected', nodeId }), [send])

  /** Alt went down in the window: the page answers with the resting cursor, if it is over it. */
  const queryPointer = useCallback(() => send({ tag: PROTOCOL_TAG, from: 'ui', t: 'pointerQuery' }), [send])

  /** A pick during the current Alt press: the page's keyup handler keeps it from the browser menu. */
  const notifyPicked = useCallback(() => send({ tag: PROTOCOL_TAG, from: 'ui', t: 'picked' }), [send])

  /** The iframe reloaded — the inspector will say hello again on its own. */
  const onFrameLoad = useCallback(() => {
    setConnected(false)
    setSnapshot(null)
    setOverrides({})
    setScrolling(false)
    syncedRef.current = true // a fresh page carries no stale inline styles
  }, [])

  return {
    snapshot,
    connected,
    error,
    scrolling,
    forwardWheel,
    setNudge,
    setSelected,
    queryPointer,
    notifyPicked,
    overrides,
    overridesRef,
    capture,
    setOverride,
    clearOverride,
    clearAllOverrides,
    onFrameLoad,
  }
}
