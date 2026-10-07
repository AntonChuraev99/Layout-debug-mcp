import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  EditRequest,
  ErrorCode,
  LayoutNode,
  NodeId,
  Override,
  Rect,
  RequestStatus,
  Snapshot,
} from '../shared/protocol.ts'

/** Enough to catch up a window that reloaded, small enough to never think about. */
const CHAT_HISTORY_LIMIT = 200

/**
 * Single in-memory session. Written by the UI over the WebSocket, read by the
 * agent bridge and by the MCP server. Deliberately not persisted: overrides and
 * snapshots describe a running UI and are meaningless once it reloads.
 */
export class Session {
  snapshot: Snapshot | null = null
  selectedId: NodeId | null = null
  overrides: Override[] = []
  requests: EditRequest[] = []
  /**
   * Kept server-side so the window survives a reload without losing the thread, and
   * so a Claude Code session working over MCP can post into the same conversation.
   */
  chat: ChatMessage[] = []

  addChat(message: ChatMessage): ChatMessage {
    const existing = this.chat.findIndex((m) => m.id === message.id)
    if (existing === -1) this.chat.push(message)
    else this.chat[existing] = message
    if (this.chat.length > CHAT_HISTORY_LIMIT) this.chat.splice(0, this.chat.length - CHAT_HISTORY_LIMIT)
    return message
  }

  setSnapshot(snapshot: Snapshot) {
    this.snapshot = snapshot
    if (this.selectedId && !snapshot.nodes[this.selectedId]) this.selectedId = null
  }

  selectedNode(): LayoutNode | null {
    if (!this.snapshot || !this.selectedId) return null
    return this.snapshot.nodes[this.selectedId] ?? null
  }

  ancestorsOf(id: NodeId): LayoutNode[] {
    const snapshot = this.snapshot
    if (!snapshot) return []
    const chain: LayoutNode[] = []
    let cur = snapshot.nodes[id]
    while (cur?.parentId) {
      const parent = snapshot.nodes[cur.parentId]
      if (!parent) break
      chain.unshift(parent)
      cur = parent
    }
    return chain
  }

  /**
   * Builds the artifact bundle that makes the whole tool worth having: not just
   * "the user said X" but which element, where it sits, and what moved.
   */
  buildRequest(comment: string): EditRequest | null {
    const snapshot = this.snapshot
    const node = this.selectedNode()
    if (!snapshot || !node) return null

    const parent = node.parentId ? snapshot.nodes[node.parentId] : undefined
    const siblings = (parent?.childIds ?? [])
      .filter((id) => id !== node.id)
      .map((id) => snapshot.nodes[id])
      .filter((n): n is LayoutNode => Boolean(n))
      .slice(0, 12)
      .map((n) => ({ kind: n.kind, label: n.label, bounds: n.bounds }))

    const request: EditRequest = {
      id: randomUUID(),
      createdAt: Date.now(),
      target: snapshot.target,
      comment,
      node: {
        id: node.id,
        kind: node.kind,
        label: node.label,
        bounds: node.bounds,
        anchors: node.anchors,
        styles: node.styles,
      },
      ancestors: this.ancestorsOf(node.id).map((a) => ({
        kind: a.kind,
        label: a.label,
        anchors: a.anchors,
      })),
      siblings,
      parentBounds: parent?.bounds ?? null,
      overrides: this.overrides,
      unit: snapshot.unit,
      pxPerUnit: snapshot.pxPerUnit,
      consumed: false,
      status: 'queued',
    }

    this.requests.push(request)
    return request
  }

  /**
   * Marks requests as read by an MCP client. `ids` limits it to those requests;
   * omitted means every unconsumed one (older MCP builds). A request that flips goes
   * `working` unless it already finished (`done`/`error` are never demoted).
   * Returns the ids that actually flipped from unconsumed to consumed.
   */
  markConsumed(ids?: string[]): string[] {
    const flipped: string[] = []
    for (const r of this.requests) {
      if (r.consumed || (ids && !ids.includes(r.id))) continue
      r.consumed = true
      flipped.push(r.id)
      this.setStatus(r.id, 'working')
    }
    return flipped
  }

  /**
   * Moves a request to `status`. Returns false (and changes nothing) for an unknown
   * id, for no change, and for a move away from a finished state: `done` is final,
   * and `error` can only be resolved to `done` (an MCP reply that names the request).
   */
  setStatus(id: string, status: RequestStatus, code?: ErrorCode, message?: string): boolean {
    const r = this.requests.find((x) => x.id === id)
    if (!r) return false
    const current = r.status ?? 'queued'
    if (current === 'done') return false
    if (current === 'error' && status !== 'done') return false
    if (current === status && status !== 'error') return false
    r.status = status
    if (status === 'error') {
      r.errorCode = code ?? 'agent_failed'
      r.errorMessage = message
    } else {
      delete r.errorCode
      delete r.errorMessage
    }
    return true
  }

  /**
   * A chat message from an MCP client (`reply_in_window`). With a `requestId` that
   * names a known request the message carries it and that request — only that one —
   * goes `done`. An unknown id still delivers the message, untied, so a typo never
   * swallows the reply. Returns the message and whether the id matched.
   *
   * A reply is proof the request was read, so it is also marked consumed: otherwise a
   * client that peeked with `markConsumed:false` (or got the id another way) would see
   * the answered request as NEW on its next `pending_requests` and apply it twice.
   */
  addReply(text: string, role: 'assistant' | 'system', requestId?: string): { message: ChatMessage; matched: boolean } {
    const request = requestId ? this.requests.find((r) => r.id === requestId) : undefined
    const matched = Boolean(request)
    const message: ChatMessage = { id: `mcp-${randomUUID()}`, role, text }
    if (request) {
      message.requestId = request.id
      request.consumed = true
      this.setStatus(request.id, 'done')
    }
    this.addChat(message)
    return { message, matched }
  }

  clearRequests() {
    this.requests = []
  }
}

export function formatRect(r: Rect, unit: string): string {
  return `${round(r.w)}×${round(r.h)}${unit} @ ${round(r.x)},${round(r.y)}`
}

function round(n: number) {
  return Math.round(n * 10) / 10
}
