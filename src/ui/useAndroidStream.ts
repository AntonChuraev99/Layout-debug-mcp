import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { decodePacket, STREAM_PATH, type StreamErrorCode, type StreamToUi } from '../shared/stream.ts'
import { avcCodecString, withConfig } from './h264.ts'

/**
 * `off`: not asked for. `connecting`: the server is starting scrcpy, no frame decoded yet
 * (the snapshot picture stays up meanwhile). `live`: frames are being drawn on the canvas.
 * `failed`: the stream ended; `failure` says why, and the window is back on snapshots.
 */
export type StreamPhase = 'off' | 'connecting' | 'live' | 'failed'

export interface StreamFailure {
  /**
   * The server's code, or one of the window's own: `unsupported` (no WebCodecs in this
   * browser), `decoder` (WebCodecs refused the stream), `closed` (the socket closed without
   * saying why: the server went away, or is older than the live video).
   */
  code: StreamErrorCode | 'unsupported' | 'decoder' | 'closed'
  detail: string
}

export interface AndroidStream {
  phase: StreamPhase
  failure: StreamFailure | null
  /** Size of the video (pixels): from the server's session message, then from each drawn frame. */
  size: { w: number; h: number } | null
  /** The scrcpy version the server is starting (its `starting` message); null before. */
  version: string | null
  /** Start again after a failure. */
  retry: () => void
}

/** WebCodecs is in Chromium-based browsers (and recent Safari / Firefox); the rest stay on snapshots. */
export function hasWebCodecs(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'
}

/**
 * The live Android screen: opens `/ws/stream` while `enabled`, decodes the H.264 packets with
 * WebCodecs and draws each frame on `canvas`. Closing (disabled, unmounted) closes the socket,
 * which stops scrcpy on the device. Any failure ends the stream with a reason; nothing retries
 * on its own except a new `enabled` (the server coming back online).
 */
export function useAndroidStream(enabled: boolean, canvas: RefObject<HTMLCanvasElement | null>): AndroidStream {
  const [phase, setPhase] = useState<StreamPhase>('off')
  const [failure, setFailure] = useState<StreamFailure | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [version, setVersion] = useState<string | null>(null)
  const sizeRef = useRef<{ w: number; h: number } | null>(null)

  useEffect(() => {
    sizeRef.current = null
    setSize(null)
    setVersion(null)
    if (!enabled) {
      setPhase('off')
      setFailure(null)
      return
    }
    let done = false
    let cleanUp = () => {}
    const fail = (f: StreamFailure) => {
      if (done) return
      done = true
      console.warn(`[layout-debug] live video stopped (${f.code})`, f.detail)
      setFailure(f)
      setPhase('failed')
      cleanUp()
    }
    if (!hasWebCodecs()) {
      fail({ code: 'unsupported', detail: navigator.userAgent })
      return
    }

    setFailure(null)
    setPhase('connecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}${STREAM_PATH}`)
    ws.binaryType = 'arraybuffer'
    let decoder: VideoDecoder | null = null
    let config: Uint8Array | null = null
    let needKey = true
    let drawn = false
    const resize = (w: number, h: number) => {
      if (done || (sizeRef.current?.w === w && sizeRef.current?.h === h)) return
      sizeRef.current = { w, h }
      setSize({ w, h })
    }

    cleanUp = () => {
      ws.onclose = null
      ws.close()
      if (decoder && decoder.state !== 'closed') decoder.close()
    }

    const draw = (frame: VideoFrame) => {
      const el = canvas.current
      if (el && !done) {
        const w = frame.displayWidth
        const h = frame.displayHeight
        if (el.width !== w || el.height !== h) {
          el.width = w
          el.height = h
        }
        el.getContext('2d')?.drawImage(frame, 0, 0, w, h)
        resize(w, h)
        if (!drawn) {
          drawn = true
          setPhase('live')
        }
      }
      frame.close()
    }

    const configure = (packet: Uint8Array) => {
      const codec = avcCodecString(packet)
      if (!codec) return fail({ code: 'stream_protocol', detail: 'the config packet has no SPS' })
      config = packet.slice()
      if (!decoder || decoder.state === 'closed') {
        decoder = new VideoDecoder({
          output: draw,
          error: (err) => fail({ code: 'decoder', detail: `${err.name}: ${err.message}` }),
        })
      }
      // A new session (rotation) brings new SPS/PPS: the decoder starts over from its key frame.
      decoder.configure({ codec, optimizeForLatency: true })
      needKey = true
    }

    ws.onmessage = (event) => {
      if (done) return
      if (typeof event.data === 'string') {
        let msg: StreamToUi
        try {
          msg = JSON.parse(event.data) as StreamToUi
        } catch {
          return fail({ code: 'stream_protocol', detail: `not JSON: ${event.data.slice(0, 80)}` })
        }
        if (msg.t === 'error') fail({ code: msg.code, detail: msg.detail })
        else if (msg.t === 'starting') setVersion(msg.version)
        // The size is known before the first frame decodes: the canvas is placed right away
        // (and again on a rotation, before the new session's key frame).
        else if (msg.t === 'session') resize(msg.width, msg.height)
        return
      }
      const packet = decodePacket(event.data as ArrayBuffer)
      if (!packet) return fail({ code: 'stream_protocol', detail: 'a video packet shorter than its header' })
      if (packet.config) return configure(packet.data)
      if (!decoder || decoder.state !== 'configured' || !config) return
      if (needKey && !packet.key) return
      needKey = false
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: packet.key ? 'key' : 'delta',
            timestamp: packet.pts,
            data: packet.key ? withConfig(config, packet.data) : packet.data,
          }),
        )
      } catch (err) {
        fail({ code: 'decoder', detail: err instanceof Error ? err.message : String(err) })
      }
    }
    ws.onclose = () => fail({ code: 'closed', detail: '' })

    return () => {
      done = true
      cleanUp()
    }
  }, [enabled, attempt, canvas])

  const retry = useCallback(() => setAttempt((a) => a + 1), [])
  return { phase, failure, size, version, retry }
}
