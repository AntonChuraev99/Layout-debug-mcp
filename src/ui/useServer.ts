import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatMessage,
  EditRequest,
  ServerToUi,
  Snapshot,
  TargetKind,
  UiToServer,
} from '../shared/protocol.ts'

export interface ServerState {
  online: boolean
  target: TargetKind
  agentAvailable: boolean
  projectDir: string | null
  targetUrl: string | null
  device: string | null
  chat: ChatMessage[]
  requests: EditRequest[]
  busy: boolean
  error: string | null
  /** Android target only: the device is reachable only through the server. */
  androidSnapshot: Snapshot | null
  androidFrame: number
}

export function useServer() {
  const [state, setState] = useState<ServerState>({
    online: false,
    target: 'web',
    agentAvailable: false,
    projectDir: null,
    targetUrl: null,
    device: null,
    chat: [],
    requests: [],
    busy: false,
    error: null,
    androidSnapshot: null,
    androidFrame: 0,
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

      ws.onopen = () => setState((s) => ({ ...s, online: true, error: null }))
      ws.onclose = () => {
        setState((s) => ({ ...s, online: false, busy: false }))
        if (!closed) retry = window.setTimeout(connect, 1500)
      }
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as ServerToUi
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
              }
            case 'androidSnapshot':
              return { ...s, androidSnapshot: msg.snapshot, androidFrame: msg.frame, error: null }
            case 'chat': {
              const idx = s.chat.findIndex((m) => m.id === msg.message.id)
              const chat = idx === -1 ? [...s.chat, msg.message] : s.chat.map((m, i) => (i === idx ? msg.message : m))
              return { ...s, chat }
            }
            case 'chatDone':
              return { ...s, busy: false }
            case 'requests':
              return { ...s, requests: msg.requests }
            case 'error':
              return { ...s, error: msg.message, busy: false }
          }
        })
      }
    }

    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      wsRef.current?.close()
    }
  }, [])

  const send = useCallback((msg: UiToServer) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }, [])

  const submit = useCallback(
    (comment: string) => {
      setState((s) => ({ ...s, busy: true, error: null }))
      send({ t: 'submit', comment })
    },
    [send],
  )

  return { state, send, submit }
}
