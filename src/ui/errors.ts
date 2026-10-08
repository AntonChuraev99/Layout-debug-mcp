import { AGENT_ERROR_CODES, DEVICE_ERROR_CODES, type ErrorCode } from '../shared/protocol.ts'

/**
 * Where a server `error` goes in the window. Decided by `code` only — the text is
 * localized and changes with the window language, so it is never parsed.
 *
 * - `capture`  — the device capture path failed: the Android "connect" screen / stale pill;
 * - `request`  — the agent closed one request as failed: that request shows the error;
 * - `general`  — anything else: the status pill and the inbox's "not tied to an element".
 */
export type ErrorRoute = 'capture' | 'request' | 'general'

export function errorRoute(code: ErrorCode | undefined, requestId: string | undefined): ErrorRoute {
  if (code && DEVICE_ERROR_CODES.includes(code)) return 'capture'
  // An agent error without a request id has nobody to attach to; the pill still shows it.
  if (code && AGENT_ERROR_CODES.includes(code) && requestId) return 'request'
  return 'general'
}

/**
 * Errors with which the server answers a `submit` instead of building a request: the
 * message typed in the chat never became one, so its optimistic copy is marked as not sent.
 */
export function rejectsSubmit(code: ErrorCode | undefined): boolean {
  return code === 'nothing_selected' || code === 'bad_message'
}

/**
 * - `no-agent`     — adb reaches the device, the app's debug bridge does not answer;
 * - `device-error` — adb itself failed for another reason (several devices without
 *                    LD_DEVICE, a device that dropped mid-call, no usable frame): the
 *                    server's adb text is the cause, the bridge steps would mislead.
 */
export type AndroidState = 'live' | 'connecting' | 'no-device' | 'no-adb' | 'no-agent' | 'device-error'

/** What a failed device capture means for the person in front of the window. */
export function androidStateFor(code: ErrorCode | null): AndroidState {
  switch (code) {
    case null:
      return 'connecting'
    case 'device_no_adb':
      return 'no-adb'
    case 'device_not_found':
      return 'no-device'
    case 'device_no_bridge':
      return 'no-agent'
    // `device`, `screenshot` and any code this window does not know yet: nothing says the
    // bridge is at fault, so the raw cause is shown instead of the bridge setup steps.
    default:
      return 'device-error'
  }
}

/** A server `error` frame that names a request, with the window language it arrived in. */
export interface RequestErrorFrame {
  requestId?: string
  code?: ErrorCode
  message: string
  /** The locale this window had reported when the frame arrived; the server wrote the text in it. */
  locale: string
}

/** A request's server status, as far as errors go. */
export interface RequestErrorStatus {
  status: string
  code?: ErrorCode
  message?: string
}

export interface RequestError {
  code: ErrorCode | null
  message: string
}

/**
 * Why each request's run failed, in this window's language.
 *
 * The `error` frame is written for this window (the server localizes it per socket), so it
 * wins. The status message is rendered once, in whatever language the server last heard
 * from any window, so it is only used when this window never got a frame for the request
 * (it opened after the failure). A frame that arrived in another language than the window
 * has now is replaced with `fallback(code)` — the window's own wording.
 */
export function resolveRequestErrors(
  frames: readonly RequestErrorFrame[],
  statuses: ReadonlyMap<string, RequestErrorStatus>,
  locale: string,
  fallback: (code: ErrorCode | null) => string,
): Map<string, RequestError> {
  const latest = new Map<string, RequestErrorFrame>()
  for (const f of frames) if (f.requestId) latest.set(f.requestId, f)
  const map = new Map<string, RequestError>()
  for (const [id, f] of latest) {
    const code = f.code ?? null
    map.set(id, { code, message: f.locale === locale && f.message ? f.message : fallback(code) })
  }
  for (const [id, s] of statuses) {
    if (s.status !== 'error') continue
    const frame = map.get(id)
    const code = s.code ?? frame?.code ?? null
    map.set(id, { code, message: frame?.message || s.message || fallback(code) })
  }
  return map
}
