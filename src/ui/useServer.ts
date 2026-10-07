import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatMessage,
  EditRequest,
  ErrorCode,
  Locale,
  ServerToUi,
  Snapshot,
  TargetKind,
  UiToServer,
} from '../shared/protocol.ts'
import { errorRoute } from './errors.ts'
import { applyStatusEvent, seedStatuses, type StatusMap } from './thread.ts'

/** Matches the copy in the "server is down" popover. */
export const RECONNECT_MS = 2000

export interface ServerError {
  seq: number
  /** Absent only from a server older than error codes. */
  code?: ErrorCode
  message: string
  /** Set when the error belongs to one request's agent run. */
  requestId?: string
  /** The locale this window had reported when it arrived: the server wrote `message` in it. */
  locale: Locale
  at: number
}

/** The agent's API call for a request is being retried; the server's own wording. */
export interface RetryNote {
  message: string
  at: number
}

export interface ServerState {
  online: boolean
  /** When the current socket opened. */
  openedAt: number
  /**
   * Bumps when the first `requests` frame of a socket lands. That frame is the server's
   * state at connect time — a request it already shows as done finished before this
   * socket, so it is the window's starting point, not a change to react to. Everything
   * after it on the same socket is live.
   */
  requestsSeed: number
  target: TargetKind
  agentAvailable: boolean
  projectDir: string | null
  targetUrl: string | null
  device: string | null
  /** `ro.product.model` of the device, e.g. "Pixel 8"; null on web or when adb cannot tell. */
  deviceModel: string | null
  chat: ChatMessage[]
  requests: EditRequest[]
  /** Status the server reported per request; empty with a server that does not report it. */
  statuses: StatusMap
  /** Requests whose agent is retrying an API call right now. Cleared by the next reply or a final status. */
  retrying: ReadonlyMap<string, RetryNote>
  busy: boolean
  /** Last error that is not a device capture failure; null once dismissed or a new submit goes out. */
  error: string | null
  /** Bumps on every server error, so a repeat of the same message is still seen. */
  errorSeq: number
  /** Recent errors, newest last — the inbox lists those no request owns. */
  errors: ServerError[]
  /** Android target only: the device is reachable only through the server. */
  androidSnapshot: Snapshot | null
  androidFrame: number
  /** Bumps on every failed device capture; separate so an override error does not count as one. */
  captureErrorSeq: number
  captureError: string | null
  captureCode: ErrorCode | null
}

const ERROR_HISTORY = 20

function without<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  const next = new Map(map)
  next.delete(key)
  return next
}

/** `locale` goes to the server on every (re)connect and on every change: its own texts follow it. */
export function useServer(locale: Locale) {
  const localeRef = useRef(locale)
  localeRef.current = locale
  const [state, setState] = useState<ServerState>({
    online: false,
    openedAt: 0,
    requestsSeed: 0,
    target: 'web',
    agentAvailable: false,
    projectDir: null,
    targetUrl: null,
    device: null,
    deviceModel: null,
    chat: [],
    requests: [],
    statuses: new Map(),
    retrying: new Map(),
    busy: false,
    error: null,
    errorSeq: 0,
    errors: [],
    androidSnapshot: null,
    androidFrame: 0,
    captureErrorSeq: 0,
    captureError: null,
    captureCode: null,
  })
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let closed = false
    let retry: number | undefined

    const connect = () => {
      if (closed) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/ws`)
      wsRef.current = ws
      // Per socket: the server sends `requests` right after `ready` on every connect.
      let seeded = false

      ws.onopen = () => {
        if (wsRef.current !== ws) return
        // First thing on the wire, so what the server sends next is already in this language.
        ws.send(JSON.stringify({ t: 'locale', locale: localeRef.current } satisfies UiToServer))
        setState((s) => ({ ...s, online: true, openedAt: Date.now(), error: null }))
      }
      ws.onclose = () => {
        // A socket replaced by a newer one (StrictMode remount, reconnect) must not
        // mark the live connection as down when its late close event arrives.
        if (wsRef.current !== ws) return
        setState((s) => ({ ...s, online: false, busy: false }))
        if (!closed) retry = window.setTimeout(connect, RECONNECT_MS)
      }
      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return
        let msg: ServerToUi
        try {
          msg = JSON.parse(event.data as string) as ServerToUi
        } catch {
          console.error('[layout-debug] could not parse a server message', event.data)
          return
        }
        // Decided outside the updater: StrictMode runs updaters twice.
        const seed = msg.t === 'requests' && !seeded
        if (seed) seeded = true
        setState((s) => {
          switch (msg.t) {
            case 'ready':
              return {
                ...s,
                target: msg.target,
                agentAvailable: msg.agentAvailable,
                projectDir: msg.projectDir,
                targetUrl: msg.targetUrl,
                device: msg.device,
                // `?? null`: a server older than this field leaves it undefined.
                deviceModel: msg.deviceModel ?? null,
              }
            case 'androidSnapshot':
              return {
                ...s,
                androidSnapshot: msg.snapshot,
                androidFrame: msg.frame,
                // Only the capture failure is answered by a fresh frame. A general error
                // (a live edit the device refused, a reset that failed) stays until the user
                // dismisses it or the next action: Android re-captures every 800 ms, which
                // would otherwise wipe the pill before anyone can read it.
                captureError: null,
                captureCode: null,
              }
            case 'chat': {
              const idx = s.chat.findIndex((m) => m.id === msg.message.id)
              const chat = idx === -1 ? [...s.chat, msg.message] : s.chat.map((m, i) => (i === idx ? msg.message : m))
              // The agent is talking again: the retry it reported went through.
              const rid = msg.message.requestId
              const answered = rid && msg.message.role === 'assistant' && msg.message.text && s.retrying.has(rid)
              return { ...s, chat, retrying: answered ? without(s.retrying, rid) : s.retrying }
            }
            case 'chatDone':
              return { ...s, busy: false }
            case 'requests':
              return {
                ...s,
                requests: msg.requests,
                statuses: seedStatuses(s.statuses, msg.requests),
                requestsSeed: seed ? s.requestsSeed + 1 : s.requestsSeed,
              }
            case 'requestStatus': {
              const final = msg.status === 'done' || msg.status === 'error'
              return {
                ...s,
                statuses: applyStatusEvent(s.statuses, msg),
                retrying: final && s.retrying.has(msg.id) ? without(s.retrying, msg.id) : s.retrying,
              }
            }
            case 'error': {
              // Branch on the code only; the text is localized.
              const route = errorRoute(msg.code, msg.requestId)
              if (route === 'capture') {
                return {
                  ...s,
                  captureError: msg.message,
                  captureCode: msg.code,
                  captureErrorSeq: s.captureErrorSeq + 1,
                }
              }
              if (route === 'retrying') {
                if (!msg.requestId) {
                  console.warn('[layout-debug] agent_retrying without a requestId:', msg.message)
                  return s
                }
                // Not a failure: the request stays in work and `busy` stays on.
                const retrying = new Map(s.retrying)
                retrying.set(msg.requestId, { message: msg.message, at: Date.now() })
                return { ...s, retrying }
              }
              const seq = s.errorSeq + 1
              return {
                ...s,
                error: msg.message,
                errorSeq: seq,
                errors: [
                  ...s.errors,
                  { seq, code: msg.code, message: msg.message, requestId: msg.requestId, locale: localeRef.current, at: Date.now() },
                ].slice(-ERROR_HISTORY),
                retrying: msg.requestId && s.retrying.has(msg.requestId) ? without(s.retrying, msg.requestId) : s.retrying,
                busy: false,
              }
            }
            default:
              return s
          }
        })
      }
    }

    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      const ws = wsRef.current
      wsRef.current = null
      ws?.close()
    }
  }, [])

  /** False when the socket is down — callers must tell the user, not drop it silently. */
  const send = useCallback((msg: UiToServer): boolean => {
    const ws = wsRef.current
    if (ws?.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(msg))
    return true
  }, [])

  // The open handler covers (re)connects; this covers a switch while connected.
  useEffect(() => {
    send({ t: 'locale', locale })
  }, [locale, send])

  const submit = useCallback(
    (comment: string): boolean => {
      const sent = send({ t: 'submit', comment })
      if (sent) setState((s) => ({ ...s, busy: true, error: null }))
      return sent
    },
    [send],
  )

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), [])

  return { state, send, submit, clearError }
}
