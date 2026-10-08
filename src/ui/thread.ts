import type {
  Anchors,
  ChatMessage,
  EditRequest,
  ErrorCode,
  LayoutNode,
  NodeId,
  RequestStatus as ServerRequestStatus,
  Snapshot,
} from '../shared/protocol.ts'

interface Addressable {
  id: NodeId
  anchors: Anchors
}

/**
 * Node ids are only stable while the page lives — an iframe reload or a device
 * recapture hands out new ones. The DOM/composable path survives, so it is the key;
 * a source location, when both sides have one, has to agree as well.
 */
export function sameElement(a: Addressable, b: Addressable): boolean {
  if (a.anchors.path !== b.anchors.path) return false
  if (a.anchors.sourceLoc && b.anchors.sourceLoc && a.anchors.sourceLoc !== b.anchors.sourceLoc) return false
  return true
}

export function requestsForNode(requests: EditRequest[], node: Addressable): EditRequest[] {
  return requests.filter((r) => sameElement(r.node, node))
}

/** The node a request was made about, in the current snapshot. */
export function findNode(snapshot: Snapshot, target: Addressable): LayoutNode | undefined {
  const direct = snapshot.nodes[target.id]
  if (direct && sameElement(direct, target)) return direct
  for (const node of Object.values(snapshot.nodes)) if (sameElement(node, target)) return node
  return undefined
}

export interface ChatAnalysis {
  /** Message id → the requests it belongs to. Unowned messages are absent. */
  owners: Map<string, string[]>
  /** Requests the agent has answered. */
  done: Set<string>
  /** Requests the server parked in the MCP queue (`<id>-queued`): no agent in the window. */
  queued: Set<string>
  /** Requests whose built-in agent reply is still streaming (`<id>-reply`, pending). */
  streaming: Set<string>
  /** Requests with at least one message of their own in the thread. */
  seen: Set<string>
}

/**
 * Ties the flat chat thread back to the requests that produced it.
 *
 * A message that names its request (`requestId`) belongs to it — that is how the server
 * marks the built-in agent's output and MCP replies that pass an id. Older messages are
 * matched by id: the built-in agent names them after the request (`<id>`, `<id>-reply`,
 * `<id>-reply-<tool>`, `<id>-queued`).
 *
 * Legacy only: a server that does not report request status (`EditRequest.status`
 * absent) leaves no other way to tell when an MCP session answered, so an `mcp-*` reply
 * there is attributed to whatever was taken from the queue and still open. With a
 * status-reporting server an MCP reply without `requestId` stays unowned.
 */
export function analyzeChat(chat: ChatMessage[], requests: EditRequest[]): ChatAnalysis {
  const byId = new Map(requests.map((r) => [r.id, r]))
  // Longest first, so `abc-1` is not mistaken for a prefix match of `abc`.
  const ids = [...byId.keys()].sort((a, b) => b.length - a.length)
  const owners = new Map<string, string[]>()
  const done = new Set<string>()
  const queued = new Set<string>()
  const streaming = new Set<string>()
  const seen = new Set<string>()
  const open: string[] = []

  for (const m of chat) {
    if (m.requestId && byId.has(m.requestId) && m.id !== m.requestId) {
      const rid = m.requestId
      seen.add(rid)
      owners.set(m.id, [rid])
      if (m.id === `${rid}-queued`) queued.add(rid)
      if (m.id === `${rid}-reply` && m.role === 'assistant') {
        if (m.pending) streaming.add(rid)
        else streaming.delete(rid)
      }
      continue
    }
    if (byId.has(m.id)) {
      seen.add(m.id)
      owners.set(m.id, [m.id])
      if (!open.includes(m.id)) open.push(m.id)
      continue
    }
    const rid = ids.find((id) => m.id.startsWith(`${id}-`))
    if (rid) {
      seen.add(rid)
      owners.set(m.id, [rid])
      if (m.id === `${rid}-queued`) queued.add(rid)
      if (m.id === `${rid}-reply` && m.role === 'assistant') {
        if (m.pending) {
          streaming.add(rid)
        } else {
          streaming.delete(rid)
          done.add(rid)
          const at = open.indexOf(rid)
          if (at !== -1) open.splice(at, 1)
        }
      }
      continue
    }
    if (m.id.startsWith('mcp-') && !m.requestId) {
      const taken = open.filter((id) => {
        const r = byId.get(id)
        return r?.consumed && r.status === undefined
      })
      if (taken.length === 0) continue
      owners.set(m.id, taken)
      if (m.role === 'assistant') {
        for (const id of taken) {
          done.add(id)
          open.splice(open.indexOf(id), 1)
        }
      }
    }
  }
  return { owners, done, queued, streaming, seen }
}

/**
 * - `queued`   — waiting in the queue, no agent has taken it;
 * - `work`     — an agent took it (wait_for_message or pending_requests) and has not replied;
 * - `done`     — the agent answered;
 * - `error`    — the agent's run failed (the server says why);
 * - `dismissed`— the user stopped waiting ("Не ждать агента");
 * - `stale`    — taken before this window opened and never answered: no live evidence
 *                that anyone still works on it, so it is not shown as in progress.
 */
export type RequestStatus = 'queued' | 'work' | 'done' | 'error' | 'dismissed' | 'stale'

/** What the server last said about one request (`requestStatus` event or `EditRequest.status`). */
export interface ServerStatus {
  status: ServerRequestStatus
  code?: ErrorCode
  message?: string
}
export type StatusMap = ReadonlyMap<string, ServerStatus>

/** One `requestStatus` event applied. Returns the same map when nothing changed. */
export function applyStatusEvent(
  map: StatusMap,
  ev: { id: string; status: ServerRequestStatus; code?: ErrorCode; message?: string },
): StatusMap {
  const prev = map.get(ev.id)
  if (prev && prev.status === ev.status && prev.code === ev.code && prev.message === ev.message) return map
  const next = new Map(map)
  next.set(ev.id, { status: ev.status, code: ev.code, message: ev.message })
  return next
}

/**
 * A `requests` frame is the server's current state, so its statuses replace what the
 * events said. Requests without a status (a server that does not report it) are left
 * out, and so are ids the frame no longer has (cleared requests).
 */
export function seedStatuses(map: StatusMap, requests: EditRequest[]): StatusMap {
  const next = new Map<string, ServerStatus>()
  for (const r of requests) {
    if (r.status) next.set(r.id, { status: r.status, code: r.errorCode, message: r.errorMessage })
    else {
      // An event may land before the frame that lists its request carries a status.
      const ev = map.get(r.id)
      if (ev) next.set(r.id, ev)
    }
  }
  return next
}

export interface StatusContext {
  /** Window session start: older unanswered requests are `stale`, not `work`. */
  since: number
  dismissed: ReadonlySet<string>
  /** Server-reported status by request id. A request missing here falls back to the chat. */
  server: StatusMap
}

export function requestStatus(r: EditRequest, a: ChatAnalysis, ctx: StatusContext): RequestStatus {
  if (ctx.dismissed.has(r.id)) return 'dismissed'
  const s = ctx.server.get(r.id)
  if (s) {
    switch (s.status) {
      case 'done':
        return 'done'
      case 'error':
        return 'error'
      case 'queued':
        return 'queued'
      case 'working':
        // Taken from the MCP queue before this window opened: nothing shows anyone still
        // works on it. A built-in agent run the server reports as working is live.
        return a.queued.has(r.id) && r.createdAt < ctx.since ? 'stale' : 'work'
    }
  }
  // Legacy server (no status): inferred from the chat thread.
  if (a.done.has(r.id)) return 'done'
  if (a.queued.has(r.id)) {
    if (!r.consumed) return 'queued'
    return r.createdAt >= ctx.since ? 'work' : 'stale'
  }
  // Built-in agent path: the server always closes a run with a final reply, so a
  // thread without one is still running. Only a request whose messages were trimmed
  // from the history (or never arrived) falls back to its age.
  if (a.streaming.has(r.id) || a.seen.has(r.id)) return 'work'
  return r.createdAt >= ctx.since ? 'work' : 'stale'
}

export const isOpen = (s: RequestStatus) => s === 'queued' || s === 'work'

/**
 * Requests that finished between two status maps: became `done` from anything but `done`
 * (an open request, but also a failed run someone then handled from Claude Code —
 * `error → done` — and a request taken before this window opened — `stale → done`), or
 * became `error` from an open status. A `done` means the edit is in the code now, whatever
 * the window showed before, so the frame has to catch up.
 *
 * A request the previous map does not know is not a transition: its first status is where
 * it starts. The caller passes a seed frame (the server's state at connect) as `prev`,
 * never as a change, so a request that finished before the socket opened is not reported.
 * `dismissed` is the window's own overlay and never changes on its own, so it is skipped.
 */
export function finishedBetween(
  prev: ReadonlyMap<string, RequestStatus>,
  now: ReadonlyMap<string, RequestStatus>,
): string[] {
  const out: string[] = []
  for (const [id, s] of now) {
    const before = prev.get(id)
    if (!before || before === s || before === 'dismissed') continue
    if (s === 'done' || (s === 'error' && isOpen(before))) out.push(id)
  }
  return out
}

/** A line the window adds to a thread itself: the agent closed the request as failed. */
export const ERROR_LINE_PREFIX = 'ui-error:'

/** The first absolute path inside the project, made relative to it: that is what people read. */
export function shortenPath(line: string, projectDir: string | null): string {
  if (!projectDir) return line
  const norm = (s: string) => s.replace(/\\/g, '/')
  const root = norm(projectDir).replace(/\/+$/, '') + '/'
  const text = norm(line)
  const at = text.toLowerCase().indexOf(root.toLowerCase())
  return at === -1 ? line : text.slice(0, at) + text.slice(at + root.length)
}

/**
 * Every project path in an agent's reply, made relative (`C:\proj\src\A.tsx` → `src/A.tsx`).
 * Text without one comes back unchanged, separators included.
 */
export function shortenPaths(text: string, projectDir: string | null): string {
  if (!projectDir) return text
  let out = text
  // Each pass removes one root, so the loop ends; the cap only guards a pathological reply.
  for (let i = 0; i < 64; i++) {
    const next = shortenPath(out, projectDir)
    if (next === out) break
    out = next
  }
  return out
}

/** Messages no request claims: MCP notes before any request, stray agent output. */
export function unownedMessages(chat: ChatMessage[], analysis: ChatAnalysis): ChatMessage[] {
  return chat.filter((m) => m.role !== 'user' && !analysis.owners.has(m.id))
}

/** One decimal at most, minus sign as in typography: `−8`, `25.5`. */
export function fmt(n: number): string {
  const v = Math.round(n * 10) / 10
  return (v < 0 ? '−' : '') + String(Math.abs(v))
}

export function fmtSigned(n: number): string {
  const v = Math.round(n * 10) / 10
  return v > 0 ? `+${v}` : fmt(v)
}

/**
 * The part of a node label worth showing next to its kind. The web inspector writes
 * `h2 "Вторая карточка"` or `div.card`; Android writes the text or repeats the kind.
 * Text is wrapped in the window language's quotes.
 */
export function displayLabel(kind: string, label: string, quotes: readonly [string, string] = ['«', '»']): string {
  const [open, close] = quotes
  const quoted = /^(\S+) "([\s\S]*)"$/.exec(label)
  if (quoted && quoted[1] === kind) return `${open}${quoted[2]}${close}`
  if (!label || label === kind) return ''
  if (label.startsWith(`${kind}.`) || label.startsWith(`${kind}#`)) return label.slice(kind.length)
  return `${open}${label}${close}`
}

/** Truncate with an ellipsis so the result is at most `max` characters. */
export function ellipsize(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/** Messages that belong to any of the given requests, in thread order. */
export function threadFor(chat: ChatMessage[], analysis: ChatAnalysis, requestIds: string[]): ChatMessage[] {
  const wanted = new Set(requestIds)
  return chat.filter((m) => analysis.owners.get(m.id)?.some((id) => wanted.has(id)))
}

/** The strongest thing to paste into a search: source location first, the DOM path last. */
export function bestAnchor(anchors: Anchors): string {
  if (anchors.sourceLoc) return anchors.sourceLoc
  if (anchors.testId) return `[data-testid="${anchors.testId}"]`
  if (anchors.domId) return `#${anchors.domId}`
  if (anchors.className) return anchors.className
  return anchors.path
}
