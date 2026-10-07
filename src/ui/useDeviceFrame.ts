import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiErrorBody } from '../shared/protocol.ts'

export interface DeviceFrameError {
  frame: number
  /** The server's reason (`ApiErrorBody.error`), or the HTTP/network failure; empty when nobody said. */
  message: string
}

async function reasonOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>
    if (typeof body.error === 'string' && body.error) return body.error
  } catch {
    // Not JSON: fall through to the status line.
  }
  return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
}

/**
 * The device picture for capture `frame`, fetched instead of handed to `<img src>`.
 *
 * The server answers a failed device screenshot with 502 and a JSON reason. An `<img>`
 * swallows that into a broken-image icon; fetching keeps the reason, so the window can say
 * what went wrong. The last good picture stays on screen while a newer one fails, and a
 * slow answer for an older frame never replaces a newer picture.
 */
export function useDeviceFrame(frame: number, enabled: boolean) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<DeviceFrameError | null>(null)
  /** Newest frame whose answer (picture or failure) has been applied. */
  const applied = useRef(-1)
  const current = useRef<string | null>(null)

  /** Frame already asked for: StrictMode re-runs the effect, and each request is a device round-trip. */
  const requested = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) {
      requested.current = null
      return
    }
    if (requested.current === frame) return
    requested.current = frame
    // No cancel on cleanup: the answer is ordered by frame number instead, so a re-run
    // (StrictMode) or a newer frame never drops a picture nobody else is fetching.
    const settle = (ok: boolean) => {
      if (frame < applied.current) return false
      applied.current = frame
      if (ok) setError(null)
      return true
    }
    fetch(`/api/android/screenshot?f=${frame}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          const message = await reasonOf(res)
          if (settle(false)) setError({ frame, message })
          return
        }
        const blob = await res.blob()
        if (!settle(true)) return
        const url = URL.createObjectURL(blob)
        if (current.current) URL.revokeObjectURL(current.current)
        current.current = url
        setSrc(url)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[layout-debug] device frame request failed', err)
        if (settle(false)) setError({ frame, message })
      })
  }, [frame, enabled])

  // StrictMode unmounts and remounts at once while `src` keeps pointing at the URL: the
  // revoke waits a microtask and only happens if nothing mounted again.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      queueMicrotask(() => {
        if (mounted.current || !current.current) return
        URL.revokeObjectURL(current.current)
        current.current = null
      })
    }
  }, [])

  /** The picture arrived but the browser could not decode it. */
  const onDecodeError = useCallback(() => {
    setError({ frame: applied.current, message: '' })
  }, [])

  return { src, error, onDecodeError }
}
