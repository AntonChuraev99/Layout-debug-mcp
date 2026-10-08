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

/** Far above any real page; a bigger "snapshot" is a bug or an abuse. */
export const MAX_SNAPSHOT_NODES = 50_000

const OPTIONAL_ANCHORS = ['sourceLoc', 'domId', 'testId', 'className', 'text'] as const

function rectProblem(v: unknown, where: string): string | null {
  if (!isObject(v)) return `${where} is not an object`
  for (const k of ['x', 'y', 'w', 'h'] as const) if (!isNumber(v[k])) return `${where}.${k} is not a number`
  return null
}

/**
 * Every field the MCP formatters and Session.buildRequest read, so a node from a
 * page that is not our inspector cannot make them throw later.
 */
function nodeProblem(v: unknown, key: string): string | null {
  const where = `snapshot.nodes[${JSON.stringify(key.slice(0, 40))}]`
  if (!isObject(v)) return `${where} is not an object`
  if (typeof v.id !== 'string') return `${where}.id is not a string`
  if (v.parentId !== null && typeof v.parentId !== 'string') return `${where}.parentId is not a string or null`
  if (!Array.isArray(v.childIds) || v.childIds.some((c) => typeof c !== 'string')) {
    return `${where}.childIds is not an array of strings`
  }
  if (!isNumber(v.depth)) return `${where}.depth is not a number`
  if (typeof v.kind !== 'string') return `${where}.kind is not a string`
  if (typeof v.label !== 'string') return `${where}.label is not a string`
  const rect = rectProblem(v.bounds, `${where}.bounds`)
  if (rect) return rect
  const a = v.anchors
  if (!isObject(a)) return `${where}.anchors is not an object`
  if (typeof a.path !== 'string') return `${where}.anchors.path is not a string`
  for (const k of OPTIONAL_ANCHORS) {
    if (a[k] != null && typeof a[k] !== 'string') return `${where}.anchors.${k} is not a string`
  }
  if (!isObject(v.styles) || Object.values(v.styles).some((s) => typeof s !== 'string')) {
    return `${where}.styles is not an object of strings`
  }
  return null
}

function snapshotProblem(v: unknown): string | null {
  if (!isObject(v)) return 'snapshot is not an object'
  if (typeof v.rootId !== 'string') return 'snapshot.rootId is not a string'
  if (!isObject(v.nodes)) return 'snapshot.nodes is not an object'
  if (v.target !== 'web' && v.target !== 'android') return 'snapshot.target is not web/android'
  if (!isNumber(v.pxPerUnit)) return 'snapshot.pxPerUnit is not a number'
  if (v.unit != null && v.unit !== 'css-px' && v.unit !== 'dp') return 'snapshot.unit is not css-px/dp'
  if (v.viewport != null) {
    if (!isObject(v.viewport) || !isNumber(v.viewport.w) || !isNumber(v.viewport.h)) {
      return 'snapshot.viewport is not {w, h} numbers'
    }
  }
  const entries = Object.entries(v.nodes)
  if (entries.length > MAX_SNAPSHOT_NODES) return `snapshot has ${entries.length} nodes, more than ${MAX_SNAPSHOT_NODES}`
  for (const [key, node] of entries) {
    const p = nodeProblem(node, key)
    if (p) return p
  }
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
    case 'telemetryNoticeDismissed':
    case 'androidCapture':
    case 'androidClearOverrides':
      return { ok: true, msg: data as UiToServer }
    default:
      return { ok: false, reason: `unknown message type ${JSON.stringify(data.t)}`, t }
  }
}
