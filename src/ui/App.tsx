import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChatPanel } from './ChatPanel.tsx'
import { NodePanel } from './NodePanel.tsx'
import { Overlay } from './Overlay.tsx'
import { useServer } from './useServer.ts'
import { useTarget } from './useTarget.ts'
import type { NodeId, Override } from '../shared/protocol.ts'

/** Slow enough that adb keeps up, fast enough that dragging still feels live. */
const ANDROID_OVERRIDE_INTERVAL_MS = 150

export function App() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const web = useTarget(iframeRef)
  const { state, send, submit } = useServer()
  const isAndroid = state.target === 'android'

  const [url, setUrl] = useState('')
  const [urlDraft, setUrlDraft] = useState('')
  const [selectedId, setSelectedId] = useState<NodeId | null>(null)
  const [inspecting, setInspecting] = useState(true)
  const [androidOverrides, setAndroidOverrides] = useState<Record<NodeId, Override>>({})

  // First `ready` from the server seeds the web target URL from config.
  useEffect(() => {
    if (!isAndroid && state.targetUrl && !url) {
      setUrl(state.targetUrl)
      setUrlDraft(state.targetUrl)
    }
  }, [isAndroid, state.targetUrl, url])

  // --- one vocabulary over both adapters ---
  const snapshot = isAndroid ? state.androidSnapshot : web.snapshot
  const overrides = isAndroid ? androidOverrides : web.overrides
  const connected = isAndroid ? Boolean(state.androidSnapshot) : web.connected

  // A drag fires a pointermove per pixel. On web that is a postMessage; on Android it
  // is an adb round-trip plus a screenshot refetch, so it has to be rate-limited —
  // with a trailing send, or the element stops one move short of where it was dropped.
  const lastSentAt = useRef(0)
  const trailing = useRef<number | undefined>(undefined)

  const setOverride = useCallback(
    (override: Override) => {
      if (!isAndroid) {
        web.setOverride(override)
        return
      }
      setAndroidOverrides((prev) => ({ ...prev, [override.nodeId]: override }))

      const flush = () => {
        lastSentAt.current = Date.now()
        send({ t: 'androidOverride', override })
      }
      window.clearTimeout(trailing.current)
      const since = Date.now() - lastSentAt.current
      if (since >= ANDROID_OVERRIDE_INTERVAL_MS) flush()
      else trailing.current = window.setTimeout(flush, ANDROID_OVERRIDE_INTERVAL_MS - since)
    },
    [isAndroid, send, web],
  )

  const clearOverride = useCallback(
    (nodeId: NodeId) => {
      if (isAndroid) {
        // The device agent has no per-node undo: clear everything, then re-apply the rest.
        const rest = Object.values(androidOverrides).filter((o) => o.nodeId !== nodeId)
        setAndroidOverrides(Object.fromEntries(rest.map((o) => [o.nodeId, o])))
        send({ t: 'androidClearOverrides' })
        for (const o of rest) send({ t: 'androidOverride', override: o })
      } else {
        web.clearOverride(nodeId)
      }
    },
    [androidOverrides, isAndroid, send, web],
  )

  const clearAllOverrides = useCallback(() => {
    if (isAndroid) {
      setAndroidOverrides({})
      send({ t: 'androidClearOverrides' })
    } else {
      web.clearAllOverrides()
    }
  }, [isAndroid, send, web])

  const capture = useCallback(() => {
    if (isAndroid) send({ t: 'androidCapture' })
    else web.capture()
  }, [isAndroid, send, web])

  // The web adapter owns its snapshot, so the server needs a copy for MCP consumers.
  // A 4000-node tree on every mutation would flood the socket — once a second is plenty.
  useEffect(() => {
    if (isAndroid || !web.snapshot) return
    const timer = window.setTimeout(() => send({ t: 'snapshot', snapshot: web.snapshot! }), 800)
    return () => window.clearTimeout(timer)
  }, [isAndroid, web.snapshot, send])

  // The device keeps its tweaks across a desktop reload, but the ids that addressed
  // them are gone — so the first snapshot of a session resets the device to a state
  // the window can actually manage.
  const androidSynced = useRef(false)
  useEffect(() => {
    if (!isAndroid || !state.androidSnapshot || androidSynced.current) return
    androidSynced.current = true
    send({ t: 'androidClearOverrides' })
  }, [isAndroid, state.androidSnapshot, send])

  useEffect(() => {
    send({ t: 'select', nodeId: selectedId })
  }, [selectedId, send])

  const overrideList = useMemo(() => Object.values(overrides), [overrides])
  useEffect(() => {
    send({ t: 'overrides', overrides: overrideList })
  }, [overrideList, send])

  const nodeCount = snapshot ? Object.keys(snapshot.nodes).length : 0

  // A phone screen is taller than any desktop panel, so the device frame is scaled to
  // fit. Bounds stay in device pixels; only the pointer maths has to know about this.
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [frameBox, setFrameBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setFrameBox({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const deviceScale =
    isAndroid && snapshot && frameBox.w > 0
      ? Math.min(1, (frameBox.w - 24) / snapshot.viewport.w, (frameBox.h - 24) / snapshot.viewport.h)
      : 1

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">layout-debug</strong>

        {isAndroid ? (
          <span className="target-badge">
            android{state.device ? ` · ${state.device}` : ''}
          </span>
        ) : (
          <form
            className="urlbar"
            onSubmit={(e) => {
              e.preventDefault()
              setSelectedId(null)
              setUrl(urlDraft)
            }}
          >
            <input value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} placeholder="http://localhost:3000" />
            <button type="submit">Открыть</button>
          </form>
        )}

        <label className="switch">
          <input type="checkbox" checked={inspecting} onChange={(e) => setInspecting(e.target.checked)} />
          Режим выделения
        </label>

        <button onClick={capture} disabled={!state.online}>
          Пересобрать дерево
        </button>
        <button onClick={clearAllOverrides} disabled={overrideList.length === 0}>
          Сбросить правки ({overrideList.length})
        </button>

        <span className={`dot dot--${connected ? 'on' : 'off'}`} title={isAndroid ? 'Агент на устройстве' : 'Инспектор в странице'}>
          {isAndroid ? 'устройство' : 'инспектор'}
        </span>
        <span className={`dot dot--${state.online ? 'on' : 'off'}`} title="Локальный сервер">
          сервер
        </span>
        {nodeCount > 0 && <span className="muted">{nodeCount} узлов</span>}
      </header>

      {web.error && !isAndroid && <div className="banner banner--warn">Инспектор: {web.error}</div>}
      {state.error && <div className="banner banner--warn">{state.error}</div>}
      {!isAndroid && url && !web.connected && (
        <div className="banner">
          Инспектор не отозвался. Добавь в страницу:{' '}
          <code>&lt;script src="http://127.0.0.1:5175/inspector.js"&gt;&lt;/script&gt;</code>
        </div>
      )}
      {isAndroid && !state.androidSnapshot && (
        <div className="banner">
          Жду устройство. Приложение должно быть запущено в debug-сборке с агентом layout-debug.
        </div>
      )}

      <main className="stage">
        <div ref={frameRef} className={`frame${isAndroid ? ' frame--device' : ''}`}>
          {isAndroid ? (
            snapshot && (
              <div
                className="device"
                style={{
                  width: snapshot.viewport.w,
                  height: snapshot.viewport.h,
                  transform: `scale(${deviceScale})`,
                  transformOrigin: 'top center',
                  marginBottom: snapshot.viewport.h * (deviceScale - 1),
                }}
              >
                <img
                  className="device__shot"
                  src={`/api/android/screenshot?f=${state.androidFrame}`}
                  alt="экран устройства"
                />
                <Overlay
                  snapshot={snapshot}
                  overrides={overrides}
                  selectedId={selectedId}
                  active={inspecting}
                  scale={deviceScale}
                  onSelect={setSelectedId}
                  onOverride={setOverride}
                />
              </div>
            )
          ) : url ? (
            <>
              <iframe ref={iframeRef} src={url} title="target" onLoad={web.onFrameLoad} />
              {snapshot && (
                <Overlay
                  snapshot={snapshot}
                  overrides={overrides}
                  selectedId={selectedId}
                  active={inspecting}
                  onSelect={setSelectedId}
                  onOverride={setOverride}
                />
              )}
            </>
          ) : (
            <div className="frame__empty">Укажи адрес dev-сервера сверху</div>
          )}
        </div>

        <aside className="side">
          {snapshot ? (
            <NodePanel
              snapshot={snapshot}
              selectedId={selectedId}
              overrides={overrides}
              onSelect={setSelectedId}
              onClearOverride={clearOverride}
            />
          ) : (
            <div className="panel panel--empty">Дерево ещё не пришло</div>
          )}

          <ChatPanel
            chat={state.chat}
            busy={state.busy}
            online={state.online}
            agentAvailable={state.agentAvailable}
            hasSelection={selectedId !== null}
            tweakCount={overrideList.length}
            onSubmit={submit}
          />
        </aside>
      </main>
    </div>
  )
}
