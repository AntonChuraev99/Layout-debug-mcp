import type { UiToServer } from '../shared/protocol.ts'

/** On failure `t` is the frame's type when it had a string one, so the caller can settle that flow. */
export type ParsedUiMessage = { ok: true; msg: UiToServer } | { ok: false; reason: string; t?: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function overrideProblem(v: unknown): string | null {
  if (!isObject(v)) return 'override is not an object'
  if (typeof v.nodeId !== 'string') return 'override.nodeId is not a string'
  if (!isNumber(v.dx) || !isNumber(v.dy)) return 'override.dx/dy are not numbers'
  if (v.width != null && !isNumber(v.width)) return 'override.width is not a number'
  if (v.height != null && !isNumber(v.height)) return 'override.height is not a number'
  if (v.hidden != null && typeof v.hidden !== 'boolean') return 'override.hidden is not a boolean'
  return null
}

function snapshotProblem(v: unknown): string | null {
  if (!isObject(v)) return 'snapshot is not an object'
  if (typeof v.rootId !== 'string') return 'snapshot.rootId is not a string'
  if (!isObject(v.nodes)) return 'snapshot.nodes is not an object'
  if (v.target !== 'web' && v.target !== 'android') return 'snapshot.target is not web/android'
  if (!isNumber(v.pxPerUnit)) return 'snapshot.pxPerUnit is not a number'
  return null
}

/**
 * One WebSocket text frame from a window → a typed message, or the reason it is not
 * one. Checks the shape every handler relies on, so a frame like `null`, `5` or
 * `{"t":"submit"}` is refused with a reason instead of throwing inside the ws
 * listener (which would kill the server) or reaching the agent as "undefined".
 * Pure; exported for tests.
 */
export function parseUiMessage(raw: string): ParsedUiMessage {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'not valid JSON' }
  }
  if (!isObject(data)) return { ok: false, reason: `expected an object, got ${data === null ? 'null' : typeof data}` }
  const t = typeof data.t === 'string' ? data.t : undefined
  const bad = (reason: string): ParsedUiMessage => ({ ok: false, reason: `${String(data.t)}: ${reason}`, t })

  switch (data.t) {
    case 'locale':
      // The value itself is checked by resolveLocale, which keeps the current one.
      return { ok: true, msg: data as UiToServer }
    case 'snapshot': {
      const p = snapshotProblem(data.snapshot)
      return p ? bad(p) : { ok: true, msg: data as UiToServer }
    }
    case 'select':
      return data.nodeId === null || typeof data.nodeId === 'string'
        ? { ok: true, msg: data as UiToServer }
        : bad('nodeId is not a string or null')
    case 'overrides': {
      if (!Array.isArray(data.overrides)) return bad('overrides is not an array')
      for (const o of data.overrides) {
        const p = overrideProblem(o)
        if (p) return bad(p)
      }
      return { ok: true, msg: data as UiToServer }
    }
    case 'submit':
      return typeof data.comment === 'string' ? { ok: true, msg: data as UiToServer } : bad('comment is not a string')
    case 'androidOverride': {
      const p = overrideProblem(data.override)
      return p ? bad(p) : { ok: true, msg: data as UiToServer }
    }
    case 'clearRequests':
    case 'androidCapture':
    case 'androidClearOverrides':
      return { ok: true, msg: data as UiToServer }
    default:
      return { ok: false, reason: `unknown message type ${JSON.stringify(data.t)}`, t }
  }
}
