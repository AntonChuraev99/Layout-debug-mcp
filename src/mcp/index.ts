/**
 * MCP entry point: a stdio MCP server that any MCP client can start (`npx -y
 * layout-debug-mcp`). It runs as its own process, so it cannot share memory with
 * the layout-debug server; it reads the live session over the server's local HTTP
 * API and starts that server when `open_window` finds none.
 *
 * stdout carries MCP frames only: diagnostics go to stderr, child processes write
 * to a log file or nowhere.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { PACKAGE_NAME, PACKAGE_VERSION } from '../shared/paths.ts'
import { SERVER_PORT } from '../shared/ports.ts'
import type {
  ApiErrorBody,
  ConsumeRequestsBody,
  ConsumeRequestsResponse,
  EditRequest,
  LayoutNode,
  PostChatBody,
  PostChatResponse,
  Snapshot,
  WaitResponse,
} from '../shared/protocol.ts'
import { WAIT_MAX_SECONDS, WAIT_MIN_SECONDS } from '../shared/wait.ts'
import { resolveServerBase, resolveWaitSeconds, unreachableMessage } from './connection.ts'
import { compactTree, describeNode, describeRequest, WAIT_FOOTER, waitTimeoutText } from './format.ts'
import { openWindow } from './launch.ts'

const BASE = resolveServerBase(process.env, SERVER_PORT)
const EXTERNAL_SERVER = Boolean(process.env.LD_SERVER_URL?.trim())
const wait = resolveWaitSeconds(process.env)
if (wait.warning) console.error(wait.warning)

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

/** Nothing answered at BASE (connection refused, reset, DNS). */
class UnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnreachableError'
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, init)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    // fetch() says only "fetch failed"; the useful part (ECONNREFUSED, ENOTFOUND) is in `cause`.
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
    throw new UnreachableError((err instanceof Error ? err.message : String(err)) + cause)
  }
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
            ? 'The server is older than this MCP server; call open_window, which replaces an older server ' +
              'when no window is connected to it.'
            : 'Fix the arguments and call the tool again.'),
    )
  }
  if (err instanceof UnreachableError) return text(unreachableMessage(BASE, err.message, process.env))
  // Anything else is a fault in this process (bad data, a bug), not a dead server: say what it was.
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  console.error(`[layout-debug] MCP tool failed: ${err instanceof Error ? err.stack : message}`)
  return text(
    `The layout-debug MCP server failed while preparing the result: ${message}. ` +
      'The server itself answered; this is a bug in layout-debug-mcp. Try the call again; ' +
      'if it repeats, report it at https://github.com/AntonChuraev99/Layout-debug-mcp/issues.',
  )
}

const INSTRUCTIONS =
  'Loop rule: after open_window, call wait_for_message; when it returns a message, do the work, call ' +
  'reply_in_window(requestId, text, status), then call wait_for_message again. A timeout result is normal: call ' +
  'it again at once. Stop only when the user says so. Start with open_window when the user wants to debug a ' +
  'layout or asks to open layout-debug. The window shows a live UI; the user selects and moves elements there.'

const server = new McpServer({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, { instructions: INSTRUCTIONS })

server.registerTool(
  'open_window',
  {
    title: 'Open the layout-debug window',
    description:
      'Start the layout-debug server if it is not running and open its window in the browser. The window shows the ' +
      'live UI (a web page or an Android device); the user selects elements, moves them and writes requests there. ' +
      'Returns the window URL and how to listen for the user\'s messages (wait_for_message).',
    inputSchema: {},
  },
  async () => {
    try {
      return text(await openWindow({ base: BASE, port: SERVER_PORT, env: process.env, external: EXTERNAL_SERVER }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'wait_for_message',
  {
    title: 'Wait for the next message from the window',
    description:
      'Wait until the user sends a message or an edit from the layout-debug window, then return it: the comment, ' +
      'the element (anchors for finding it in code) and the live-edit measurements. Returns before common tool ' +
      'timeouts; a timeout result is normal, call it again. Call open_window first.',
    inputSchema: {
      timeoutSec: z
        .number()
        .int()
        .min(WAIT_MIN_SECONDS)
        .max(WAIT_MAX_SECONDS)
        .optional()
        .describe(`How long to wait, in seconds (default ${wait.seconds})`),
    },
  },
  async ({ timeoutSec }, extra) => {
    const seconds = timeoutSec ?? wait.seconds
    try {
      // The server answers within `seconds`; the margin only covers a server that hangs.
      const signal = AbortSignal.any([extra.signal, AbortSignal.timeout((seconds + 15) * 1000)])
      const body = await api<WaitResponse>(`/api/requests/wait?timeout=${seconds}`, { method: 'POST', signal })
      if ('timeout' in body) return text(waitTimeoutText(seconds))
      return text(`${describeRequest(body.request)}\n\n${WAIT_FOOTER(body.request.id)}`)
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        if (extra.signal.aborted) return text('Cancelled by the client; nothing was taken from the queue.')
        return text(
          `The layout-debug server at ${BASE} did not answer within ${seconds + 15} s. ` +
            'Call open_window to check it, then wait_for_message again.',
        )
      }
      if (err instanceof UnreachableError) {
        return text(
          `${unreachableMessage(BASE, err.message, process.env)}\n` +
            'Call open_window to start the server and open the window, then wait_for_message again.',
        )
      }
      return fail(err)
    }
  },
)

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
      if (!snapshot) return text('No snapshot yet: open the page in the layout-debug window (open_window).')
      return text(compactTree(snapshot, maxDepth))
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
      return text(describeNode(data.node, data.ancestors ?? [], data.unit ?? 'css-px', data.pxPerUnit ?? 1, data.overrides ?? []))
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
      'Edits the user sent from the layout-debug window that no agent has taken yet: comment + element facts + ' +
      'drag measurements. Each edit starts with its requestId. In listen mode use wait_for_message instead. Once ' +
      'you have handled an edit, report back via reply_in_window with that requestId: the user is watching the ' +
      'window, and the id marks that edit as done there.',
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
      'Write into the chat of the layout-debug window. Call it after handling a message from wait_for_message or ' +
      'pending_requests: the user is watching the window, and without this they will not know what you did. ' +
      'Keep it short: what you changed, in which files, what is left. If the edit could not be made, say why and ' +
      'pass status "error". Write in the same language as the user\'s comment.',
    inputSchema: {
      text: z.string().min(1).describe('Text for the window chat'),
      requestId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'The requestId of the message you are answering (from wait_for_message or pending_requests). The window ' +
            'ties the reply to that edit and closes it. Omit it for a general note (no edit changes status).',
        ),
      status: z
        .enum(['done', 'error'])
        .default('done')
        .describe('With requestId: "done" when the edit is made, "error" when it could not be made'),
      role: z
        .enum(['assistant', 'system'])
        .default('assistant')
        .describe('assistant — a reply to the user, system — a service note'),
    },
  },
  // `text` is also the name of the response helper, so the argument is renamed.
  async ({ text: content, requestId, status, role }) => {
    try {
      const payload: PostChatBody = { text: content, role }
      if (requestId) {
        payload.requestId = requestId
        payload.status = status
      }
      const body = await api<PostChatResponse>('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const tie = !requestId
        ? ''
        : body.requestId === requestId
          ? ` Edit ${requestId} is marked ${status === 'error' ? 'failed' : 'done'}.`
          : ` Note: the server did not match requestId ${requestId} (cleared or mistyped), so the message was ` +
            'posted as a general reply and no edit changed status. Check the id with pending_requests ' +
            '(includeConsumed: true).'
      const next = ' Now call wait_for_message again.'
      if (!body.delivered) {
        return text(
          'Sent, but the layout-debug window is closed right now; the message will appear when it is opened.' +
            tie +
            next,
        )
      }
      return text(`Sent to the window (${body.delivered}).${tie}${next}`)
    } catch (err) {
      return fail(err)
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
