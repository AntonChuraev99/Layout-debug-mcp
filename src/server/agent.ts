import { query, type HookCallback } from '@anthropic-ai/claude-agent-sdk'
import type { EditRequest } from '../shared/protocol.ts'
import { checkWritePath } from './security.ts'

/** File edits are the point; shell access is not, so it stays blocked. */
const ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob']
const DISALLOWED_TOOLS = ['Bash', 'WebFetch', 'WebSearch']
/** Tools that write a file, and the input field holding its path. */
const WRITE_PATH_FIELD: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/**
 * The trust boundary for the chat agent. It is a PreToolUse hook, not
 * `canUseTool`: the SDK never consults `canUseTool` for tools auto-approved by
 * `allowedTools` or by the user's own settings, while hooks run first for
 * every call and their deny wins over any allow.
 *
 * `cwd` is not a sandbox, so the path is checked here. Tools beyond the list
 * above (MCP servers and plugins from the user's settings) are refused too —
 * they are another way to write outside the project.
 */
function toolGuard(projectDir: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const name = input.tool_name
    let reason: string | null = null
    if (!ALLOWED_TOOLS.includes(name)) {
      reason = `the ${name} tool is not granted to the layout-debug agent; available: ${ALLOWED_TOOLS.join(', ')}`
    } else if (WRITE_PATH_FIELD[name]) {
      const target = (input.tool_input as Record<string, unknown> | null)?.[WRITE_PATH_FIELD[name]!]
      const verdict = checkWritePath(projectDir, target)
      if (!verdict.ok) reason = verdict.reason
    }
    if (!reason) return {}
    console.warn(`[layout-debug] agent denied (${name}): ${reason}`)
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `layout-debug: ${reason}`,
      },
    }
  }
}

export function buildPrompt(req: EditRequest): string {
  const n = req.node
  const u = req.unit
  const lines: string[] = []
  /** Every measurement arrives in frame pixels; source code is written in `unit`. */
  const q = (px: number) => r(px / (req.pxPerUnit || 1))

  lines.push('The user is working with a live UI through layout-debug: they selected an element on screen and described an edit.')
  lines.push('')
  lines.push('## The edit, in the user\'s words')
  lines.push(req.comment)
  lines.push('')
  lines.push('## Selected element')
  lines.push(`- ${req.target === 'android' ? 'composable' : 'tag'}: ${n.kind}`)
  lines.push(`- label: ${n.label}`)
  lines.push(`- box: ${q(n.bounds.w)}×${q(n.bounds.h)} ${u} at ${q(n.bounds.x)},${q(n.bounds.y)}`)
  if (n.anchors.sourceLoc) lines.push(`- source: ${n.anchors.sourceLoc}`)
  if (n.anchors.domId) lines.push(`- id: ${n.anchors.domId}`)
  if (n.anchors.testId) lines.push(`- data-testid: ${n.anchors.testId}`)
  if (n.anchors.className) lines.push(`- classes: ${n.anchors.className}`)
  if (n.anchors.text) lines.push(`- text: ${JSON.stringify(n.anchors.text)}`)
  lines.push(`- tree path: ${n.anchors.path}`)
  const styles = Object.entries(n.styles)
  if (styles.length) {
    lines.push(`- properties: ${styles.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }

  if (req.ancestors.length) {
    lines.push('')
    lines.push('## Ancestors (outermost first)')
    for (const a of req.ancestors.slice(-6)) {
      const cls = a.anchors.className ? ` .${a.anchors.className.split(/\s+/).slice(0, 3).join('.')}` : ''
      lines.push(`- ${a.kind}${cls}${a.anchors.sourceLoc ? ` (${a.anchors.sourceLoc})` : ''}`)
    }
  }

  if (req.parentBounds) {
    lines.push('')
    lines.push(
      `## Parent box\n${q(req.parentBounds.w)}×${q(req.parentBounds.h)} ${u} at ${q(req.parentBounds.x)},${q(req.parentBounds.y)}`,
    )
  }

  if (req.siblings.length) {
    lines.push('')
    lines.push('## Siblings in the same parent')
    for (const s of req.siblings) {
      lines.push(`- ${s.label} — ${q(s.bounds.w)}×${q(s.bounds.h)} @ ${q(s.bounds.x)},${q(s.bounds.y)}`)
    }
  }

  if (req.overrides.length) {
    lines.push('')
    lines.push('## What the user moved by hand')
    for (const o of req.overrides) {
      const parts: string[] = []
      if (o.dx || o.dy) {
        parts.push(`offset ${o.dx >= 0 ? '+' : ''}${q(o.dx)}, ${o.dy >= 0 ? '+' : ''}${q(o.dy)} ${u}`)
      }
      if (o.width != null || o.height != null) {
        parts.push(`size ${o.width != null ? q(o.width) : '—'}×${o.height != null ? q(o.height) : '—'} ${u}`)
      }
      if (o.hidden) parts.push('hidden')
      const self = o.nodeId === n.id ? 'selected element' : `node ${o.nodeId}`
      lines.push(`- ${self}: ${parts.join(', ')}`)
    }
    lines.push('')
    lines.push(
      req.target === 'android'
        ? 'This is a live preview: the on-device agent swapped the `Modifier` of the running LayoutNode. It is not ' +
            'in the code and will be gone after a rebuild. Treat it as a measurement of intent, and make the edit in ' +
            'source the way this project does it: `padding`, `Arrangement.spacedBy`, `Spacer`, element order, sizes ' +
            'from the design system — not `Modifier.offset`.'
        : 'This is a visual preview via inline `translate`/`width` styles — it is not in the code. ' +
            'Treat it as a measurement of intent, and make the edit in source the way this project does it: ' +
            'padding, margin, gap, element order, sizes as tokens — not `translate`.',
    )
  }

  lines.push('')
  lines.push('## Task')
  lines.push(
    'Find this element in the project sources (anchors above — classes, text, data-testid, path), make the edit and briefly say what you changed. ' +
      'If you could not find the element, say so and list the files you checked; do not guess.',
  )
  lines.push('Reply in the same language as the user\'s comment.')

  return lines.join('\n')
}

/**
 * What the server renders from one agent run.
 *
 * - `text` / `tool` — progress for the chat.
 * - `retry` — the SDK hit a retryable API error and will try again; the run goes on.
 * - `error` — the run failed. `code: 'agent_auth'` means it cannot sign in at all, so
 *   retrying is pointless; `agent_failed` is any other failure. `text` is the raw
 *   reason (may be empty — the server then uses its own localized text).
 * - `done` — the run finished without an error. Never follows an `error`.
 */
export type AgentEvent =
  | { kind: 'text' | 'tool' | 'done'; text: string }
  | { kind: 'retry'; text: string; attempt: number; maxRetries: number }
  | { kind: 'error'; text: string; code: 'agent_auth' | 'agent_failed' }

/** SDK error kinds that mean the credentials themselves are rejected. */
const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed'])
/** What the CLI prints when it has no usable credentials, e.g. "Invalid API key · Please run /login". */
const AUTH_TEXT = /invalid api key|please run \/login|not logged in|authentication[_ ]failed|api error:? 401\b/i

/**
 * Runs one agent turn against the target repo, yielding a flat event stream the
 * UI can render. The SDK's message shapes vary across versions, so extraction is
 * intentionally defensive rather than typed to one release.
 */
export async function* runAgent(req: EditRequest, projectDir: string): AsyncGenerator<AgentEvent> {
  const prompt = buildPrompt(req)
  const abort = new AbortController()
  let messages: AsyncIterable<unknown>
  try {
    messages = query({
      prompt,
      options: {
        cwd: projectDir,
        allowedTools: ALLOWED_TOOLS,
        disallowedTools: DISALLOWED_TOOLS,
        hooks: { PreToolUse: [{ hooks: [toolGuard(projectDir)] }] },
        // 'project' brings the target's CLAUDE.md; the user's ~/.claude (hooks, MCP,
        // plugins) and settings.local.json stay out of a tool-driven agent.
        settingSources: ['project'],
        maxTurns: 24,
        abortController: abort,
      },
    })
  } catch (err) {
    yield { kind: 'error', code: 'agent_failed', text: err instanceof Error ? err.message : String(err) }
    return
  }
  yield* agentEvents(messages, () => abort.abort())
}

/**
 * Turns the SDK message stream into AgentEvents, with the run-level rules on top of
 * per-message extraction:
 * - an auth failure is fatal: `stop()` aborts the query (the SDK would otherwise keep
 *   retrying a 401 for minutes) and nothing else is yielded;
 * - only the first `retry` of a run is yielded — the window needs to know once that
 *   the API is struggling, not on every attempt;
 * - after the first `error`, later errors (the SDK often throws "process exited" right
 *   after a failed result) and `done` are swallowed, so a run reports exactly one
 *   outcome;
 * - a successful `result` repeats the final assistant text that already streamed, so
 *   its text is used only when the run streamed no assistant text at all.
 */
export async function* agentEvents(messages: AsyncIterable<unknown>, stop: () => void): AsyncGenerator<AgentEvent> {
  let failed = false
  let retried = false
  let streamedText = false
  try {
    for await (const message of messages) {
      const isResult = (message as { type?: unknown } | null)?.type === 'result'
      for (const event of extractEvents(message)) {
        if (event.kind === 'text') {
          if (isResult && streamedText) continue
          streamedText = true
        }
        if (event.kind === 'retry') {
          if (retried) continue
          retried = true
        }
        if (event.kind === 'error') {
          if (failed) continue
          failed = true
          yield event
          if (event.code === 'agent_auth') {
            stop()
            return
          }
          continue
        }
        yield event
      }
    }
  } catch (err) {
    if (!failed) {
      failed = true
      const text = err instanceof Error ? err.message : String(err)
      yield { kind: 'error', code: AUTH_TEXT.test(text) ? 'agent_auth' : 'agent_failed', text }
    } else {
      console.warn(`[layout-debug] agent: ignoring an error after the run already failed: ${String(err)}`)
    }
    return
  }
  if (!failed) yield { kind: 'done', text: '' }
}

/** One SDK message → zero or more AgentEvents. Pure; exported for tests. */
export function extractEvents(message: unknown): AgentEvent[] {
  const m = message as Record<string, any>
  if (!m || typeof m !== 'object') return []

  // { type: 'system', subtype: 'api_retry', attempt, max_retries, error_status, error }
  if (m.type === 'system' && m.subtype === 'api_retry') {
    const reason = m.error_status != null ? `HTTP ${m.error_status}` : String(m.error ?? 'connection error')
    if (m.error_status === 401 || AUTH_ERRORS.has(m.error)) {
      return [{ kind: 'error', code: 'agent_auth', text: reason }]
    }
    return [
      {
        kind: 'retry',
        text: reason,
        attempt: Number(m.attempt) || 1,
        maxRetries: Number(m.max_retries) || 0,
      },
    ]
  }

  // Streaming assistant turn: { type: 'assistant', message: { content: [...] }, error? }
  const content = m.message?.content ?? (Array.isArray(m.content) ? m.content : undefined)
  if (Array.isArray(content)) {
    const out: AgentEvent[] = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ kind: 'text', text: block.text })
      } else if (block?.type === 'tool_use') {
        out.push({ kind: 'tool', text: toolLabel(block) })
      }
    }
    // An API failure arrives as a synthetic assistant turn with `error` set (auth,
    // billing_error, rate_limit, server_error, invalid_request, max_output_tokens, …)
    // and the API error text as its content ("Invalid API key · Please run /login",
    // "Credit balance is too low"). It is a failure, never the agent's reply.
    if (typeof m.error === 'string' && m.error) {
      const reason = out.filter((e) => e.kind === 'text').map((e) => e.text).join(' ').trim()
      const auth = AUTH_ERRORS.has(m.error) || AUTH_TEXT.test(reason)
      return [{ kind: 'error', code: auth ? 'agent_auth' : 'agent_failed', text: reason || m.error }]
    }
    return out
  }

  if (m.type === 'text' && typeof m.content === 'string') return [{ kind: 'text', text: m.content }]
  if (m.type === 'result') {
    // `is_error` first: a failed run can still carry a non-empty `result` string (the
    // error text), which must not be shown as the agent's reply.
    if (m.is_error || (typeof m.subtype === 'string' && m.subtype.startsWith('error'))) {
      const parts = [typeof m.result === 'string' ? m.result : '', ...(Array.isArray(m.errors) ? m.errors : [])]
      const text = parts.map(String).filter((s) => s.trim()).join('\n').trim()
      // An empty text makes the server fall back to its own localized "agent failed".
      return [{ kind: 'error', code: AUTH_TEXT.test(text) ? 'agent_auth' : 'agent_failed', text }]
    }
    if (typeof m.result === 'string' && m.result.trim()) return [{ kind: 'text', text: m.result }]
  }
  return []
}

function toolLabel(block: Record<string, any>): string {
  const name = block.name ?? 'tool'
  const input = block.input ?? {}
  const path = input.file_path ?? input.path ?? input.pattern ?? ''
  return path ? `${name} ${path}` : String(name)
}

function r(n: number) {
  return Math.round(n * 10) / 10
}
