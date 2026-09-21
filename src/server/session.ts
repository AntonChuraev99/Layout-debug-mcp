import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  EditRequest,
  LayoutNode,
  NodeId,
  Override,
  Rect,
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
    }

    this.requests.push(request)
    return request
  }

  markConsumed(ids?: string[]) {
    for (const r of this.requests) {
      if (!ids || ids.includes(r.id)) r.consumed = true
    }
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
