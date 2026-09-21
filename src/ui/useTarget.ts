import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PROTOCOL_TAG,
  type InspectorToUi,
  type NodeId,
  type Override,
  type Snapshot,
  type UiToInspector,
} from '../shared/protocol.ts'

/**
 * Bridge to the inspector running inside the target page. Cross-origin by
 * design: we never touch the iframe's DOM, we only exchange messages with it.
 */
export function useTarget(iframeRef: React.RefObject<HTMLIFrameElement | null>) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<Record<NodeId, Override>>({})
  const overridesRef = useRef(overrides)
  overridesRef.current = overrides
  /** Guards the one-time reset of tweaks left in the page by a previous UI session. */
  const syncedRef = useRef(false)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as InspectorToUi | undefined
      if (!data || typeof data !== 'object' || data.tag !== PROTOCOL_TAG || data.from !== 'inspector') return
      if (event.source !== iframeRef.current?.contentWindow) return

      switch (data.t) {
        case 'hello':
          setConnected(true)
          setError(null)
          break
        case 'snapshot':
          setConnected(true)
          setSnapshot(data.snapshot)
          // The UI can reload (HMR, refresh) while the page keeps the inline
          // styles from a previous session. Those tweaks are unmanageable once
          // we've lost their ids, so the first snapshot resets the page.
          if (!syncedRef.current) {
            syncedRef.current = true
            iframeRef.current?.contentWindow?.postMessage(
              { tag: PROTOCOL_TAG, from: 'ui', t: 'clearAllOverrides' } satisfies UiToInspector,
              '*',
            )
          }
          break
        case 'error':
          setError(data.message)
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [iframeRef])

  const send = useCallback(
    (msg: UiToInspector) => {
      iframeRef.current?.contentWindow?.postMessage(msg, '*')
    },
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

  /** The iframe reloaded — the inspector will say hello again on its own. */
  const onFrameLoad = useCallback(() => {
    setConnected(false)
    setSnapshot(null)
    setOverrides({})
    syncedRef.current = true // a fresh page carries no stale inline styles
  }, [])

  return {
    snapshot,
    connected,
    error,
    overrides,
    overridesRef,
    capture,
    setOverride,
    clearOverride,
    clearAllOverrides,
    onFrameLoad,
  }
}
