/**
 * MCP entry point. Runs as its own stdio process (Claude Code spawns it), so it
 * cannot share memory with the layout-debug server — it reads the live session
 * over the server's local HTTP API instead.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { SERVER_PORT } from '../shared/ports.ts'
import { resolveServerBase, unreachableMessage } from './connection.ts'
import type {
  ApiErrorBody,
  ConsumeRequestsBody,
  ConsumeRequestsResponse,
  EditRequest,
  LayoutNode,
  PostChatBody,
  PostChatResponse,
  Snapshot,
} from '../shared/protocol.ts'

const BASE = resolveServerBase(process.env, SERVER_PORT)

/** The server answered, but with an error status — it is running, the request was wrong. */
class ApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly reason: string,
  ) {
    super(`${path} → HTTP ${status}: ${reason}`)
    this.name = 'ApiError'
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  if (!res.ok) {
    let reason = res.statusText || 'no reason given'
    try {
      const body = (await res.json()) as Partial<ApiErrorBody>
      if (typeof body.error === 'string' && body.error) reason = body.error
    } catch {
      // Not JSON (an old server or a proxy page); the status text is all there is.
    }
    throw new ApiError(path, res.status, reason)
  }
  return (await res.json()) as T
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

function fail(err: unknown) {
  if (err instanceof ApiError) {
    return text(
      `The layout-debug server (${BASE}) refused the call: ${err.message}\n` +
        (err.status === 403
          ? 'The server only accepts local, non-browser calls; check LD_SERVER_URL points at it.'
          : err.status === 404
            ? 'The server is older than this MCP build; restart npm run dev in the layout-debug-mcp directory.'
            : 'Fix the arguments and call the tool again.'),
    )
  }
  // fetch() says only "fetch failed"; the useful part (ECONNREFUSED, ENOTFOUND) is in `cause`.
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
  const message = (err instanceof Error ? err.message : String(err)) + cause
  return text(unreachableMessage(BASE, message, process.env))
}

/** Full trees run to thousands of nodes; MCP consumers want the shape, not every div. */
function compactTree(snapshot: Snapshot, maxDepth: number): string {
  const lines: string[] = []
  // Sizes here must match `selected_element`, which reports in `unit`, not frame px.
  const q = (px: number) => Math.round(px / (snapshot.pxPerUnit || 1))
  const walk = (id: string, depth: number) => {
    const node = snapshot.nodes[id]
    if (!node || depth > maxDepth) return
    const anchor = node.anchors.sourceLoc ?? node.anchors.testId ?? node.anchors.className?.split(/\s+/)[0]
    lines.push(
      `${'  '.repeat(depth)}${node.id} ${node.kind}${anchor ? ` [${anchor}]` : ''} ` +
        `${q(node.bounds.w)}×${q(node.bounds.h)}${snapshot.unit === 'dp' ? 'dp' : ''}` +
        (node.anchors.text ? ` "${node.anchors.text}"` : ''),
    )
    for (const child of node.childIds) walk(child, depth + 1)
  }
  walk(snapshot.rootId, 0)
  return lines.join('\n')
}

function describeNode(node: LayoutNode, ancestors: LayoutNode[], unit: string, pxPerUnit: number): string {
  const a = node.anchors
  const q = (px: number) => Math.round((px / (pxPerUnit || 1)) * 10) / 10
  const lines = [
    `Selected: ${node.label}`,
    `Kind: ${node.kind}`,
    `Box: ${q(node.bounds.w)}×${q(node.bounds.h)} ${unit} @ ${q(node.bounds.x)},${q(node.bounds.y)}`,
  ]
  if (a.sourceLoc) lines.push(`Source: ${a.sourceLoc}`)
  if (a.testId) lines.push(`data-testid: ${a.testId}`)
  if (a.domId) lines.push(`id: ${a.domId}`)
  if (a.className) lines.push(`Classes: ${a.className}`)
  if (a.text) lines.push(`Text: ${JSON.stringify(a.text)}`)
  lines.push(`Path: ${a.path}`)
  const styles = Object.entries(node.styles)
  if (styles.length) lines.push(`Properties: ${styles.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  if (ancestors.length) {
    lines.push(`Ancestors: ${ancestors.map((x) => x.kind).join(' > ')}`)
  }
  return lines.join('\n')
}

function describeRequest(req: EditRequest): string {
  const lines = [
    `requestId: ${req.id}`,
    `[${req.consumed ? 'read' : 'NEW'}] ${new Date(req.createdAt).toISOString()}` +
      (req.status ? ` · status: ${req.status}` : '') +
      (req.status === 'error' && req.errorMessage ? ` (${req.errorMessage})` : ''),
    `Comment: ${req.comment}`,
    `Element: ${req.node.label} (${req.node.kind})`,
  ]
  if (req.node.anchors.sourceLoc) lines.push(`Source: ${req.node.anchors.sourceLoc}`)
  if (req.node.anchors.className) lines.push(`Classes: ${req.node.anchors.className}`)
  lines.push(`Path: ${req.node.anchors.path}`)
  const q = (px: number) => Math.round((px / (req.pxPerUnit || 1)) * 10) / 10
  for (const o of req.overrides) {
    const parts: string[] = []
    if (o.dx || o.dy) parts.push(`offset ${q(o.dx)}, ${q(o.dy)} ${req.unit}`)
    if (o.width != null || o.height != null) {
      parts.push(`size ${o.width != null ? q(o.width) : '—'}×${o.height != null ? q(o.height) : '—'} ${req.unit}`)
    }
    if (o.hidden) parts.push('hidden')
    if (parts.length) lines.push(`Live edit (${o.nodeId}): ${parts.join(', ')}`)
  }
  return lines.join('\n')
}

const server = new McpServer({ name: 'layout-debug', version: '0.1.0' })

server.registerTool(
  'layout_snapshot',
  {
    title: 'Layout tree',
    description:
      'Tree of the latest snapshot of the live UI: nodes, sizes, anchors for finding them in code. Truncated by depth.',
    inputSchema: { maxDepth: z.number().int().min(1).max(30).default(8).describe('Tree depth') },
  },
  async ({ maxDepth }) => {
    try {
      const { snapshot } = await api<{ snapshot: Snapshot | null }>('/api/snapshot')
      if (!snapshot) return text('No snapshot yet: open the page in the layout-debug window.')
      return text(
        `Target: ${snapshot.target}, unit: ${snapshot.unit}, ` +
          `viewport ${snapshot.viewport.w}×${snapshot.viewport.h}, nodes: ${Object.keys(snapshot.nodes).length}\n\n` +
          compactTree(snapshot, maxDepth),
      )
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'selected_element',
  {
    title: 'Selected element',
    description:
      'What the user has selected in the layout-debug window right now: box, anchors for finding it in code, ancestor chain, live edits.',
    inputSchema: {},
  },
  async () => {
    try {
      const data = await api<{
        node: LayoutNode | null
        ancestors: LayoutNode[]
        overrides: EditRequest['overrides']
        unit: string | null
        pxPerUnit: number | null
      }>('/api/selected')
      if (!data.node) return text('Nothing is selected. Ask the user to select an element in the layout-debug window.')
      const scale = data.pxPerUnit || 1
      const q = (px: number) => Math.round((px / scale) * 10) / 10
      const body = describeNode(data.node, data.ancestors, data.unit ?? 'px', scale)
      if (!data.overrides.length) return text(body)
      const tweaks = data.overrides
        .map(
          (o) =>
            `- ${o.nodeId}: offset ${q(o.dx)}, ${q(o.dy)}` +
            (o.width != null ? `, size ${q(o.width)}×${q(o.height ?? 0)}` : ''),
        )
        .join('\n')
      return text(`${body}\n\nLive edits (preview only, not in the code):\n${tweaks}`)
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'pending_requests',
  {
    title: 'Edit queue',
    description:
      'Edits the user sent from the layout-debug window: comment + element artifacts + drag measurements. ' +
      'Each edit starts with its requestId. Once you have handled an edit, report back via reply_in_window with ' +
      'that requestId: the user is watching the window, not the terminal, and the id marks that edit as done there.',
    inputSchema: {
      includeConsumed: z.boolean().default(false).describe('Also show already read edits'),
      markConsumed: z.boolean().default(true).describe('Mark the returned edits as read'),
    },
  },
  async ({ includeConsumed, markConsumed }) => {
    try {
      const { requests } = await api<{ requests: EditRequest[] }>('/api/requests')
      const list = includeConsumed ? requests : requests.filter((r) => !r.consumed)
      if (!list.length) return text('The queue is empty.')
      const body = list.map(describeRequest).join('\n\n---\n\n')
      const footer =
        `\n\n---\n\n${list.length} edit(s). After handling one, call reply_in_window with its requestId ` +
        '(e.g. requestId: "' + list[0]!.id + '") so the window marks exactly that edit as done.'
      if (markConsumed) {
        // Only what this call returned: an edit that arrived in between stays NEW.
        const consumeBody: ConsumeRequestsBody = { ids: list.map((r) => r.id) }
        await api<ConsumeRequestsResponse>('/api/requests/consume', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(consumeBody),
        })
      }
      return text(body + footer)
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'reply_in_window',
  {
    title: 'Reply in the layout-debug window',
    description:
      'Write into the chat of the layout-debug window. Call it after handling an edit from pending_requests: ' +
      'the user is watching the window, not the terminal, and without this they will not know what you did. ' +
      'Keep it short: what you changed, in which files, what is left. If the edit could not be made, say why here too. ' +
      'Write in the same language as the user\'s comment.',
    inputSchema: {
      text: z.string().min(1).describe('Text for the window chat'),
      role: z
        .enum(['assistant', 'system'])
        .default('assistant')
        .describe('assistant — a reply to the user, system — a service note'),
      requestId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Reply to a specific request: the requestId shown by pending_requests. The window ties the message to ' +
            'that edit and marks it done. Omit it to reply generally (no edit changes status).',
        ),
    },
  },
  // `text` is also the name of the response helper, so the argument is renamed.
  async ({ text: content, role, requestId }) => {
    try {
      const payload: PostChatBody = { text: content, role }
      if (requestId) payload.requestId = requestId
      const body = await api<PostChatResponse>('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const tie = !requestId
        ? ''
        : body.requestId === requestId
          ? ` Edit ${requestId} is marked done.`
          : ` Note: the server did not match requestId ${requestId} (cleared, mistyped, or a server older than ` +
            'this MCP build), so the message was posted ' +
            'as a general reply and no edit changed status. Check the id with pending_requests (includeConsumed: true).'
      if (!body.delivered) {
        return text(
          'Sent, but the layout-debug window is closed right now; the message will appear when it is opened.' + tie,
        )
      }
      return text(`Sent to the window (${body.delivered}).${tie}`)
    } catch (err) {
      return fail(err)
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
