import { query } from '@anthropic-ai/claude-agent-sdk'
import type { EditRequest } from '../shared/protocol.ts'

/** File edits are the point; shell access is not, so it stays blocked. */
const ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob']
const DISALLOWED_TOOLS = ['Bash', 'WebFetch', 'WebSearch']

export function buildPrompt(req: EditRequest): string {
  const n = req.node
  const u = req.unit
  const lines: string[] = []
  /** Every measurement arrives in frame pixels; source code is written in `unit`. */
  const q = (px: number) => r(px / (req.pxPerUnit || 1))

  lines.push('Пользователь работает с живым UI через layout-debug: выделил элемент на экране и описал правку.')
  lines.push('')
  lines.push('## Правка словами')
  lines.push(req.comment)
  lines.push('')
  lines.push('## Выделенный элемент')
  lines.push(`- ${req.target === 'android' ? 'composable' : 'тег'}: ${n.kind}`)
  lines.push(`- подпись: ${n.label}`)
  lines.push(`- бокс: ${q(n.bounds.w)}×${q(n.bounds.h)} ${u} в точке ${q(n.bounds.x)},${q(n.bounds.y)}`)
  if (n.anchors.sourceLoc) lines.push(`- источник: ${n.anchors.sourceLoc}`)
  if (n.anchors.domId) lines.push(`- id: ${n.anchors.domId}`)
  if (n.anchors.testId) lines.push(`- data-testid: ${n.anchors.testId}`)
  if (n.anchors.className) lines.push(`- классы: ${n.anchors.className}`)
  if (n.anchors.text) lines.push(`- текст: ${JSON.stringify(n.anchors.text)}`)
  lines.push(`- путь в дереве: ${n.anchors.path}`)
  const styles = Object.entries(n.styles)
  if (styles.length) {
    lines.push(`- свойства: ${styles.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }

  if (req.ancestors.length) {
    lines.push('')
    lines.push('## Родители (снаружи внутрь)')
    for (const a of req.ancestors.slice(-6)) {
      const cls = a.anchors.className ? ` .${a.anchors.className.split(/\s+/).slice(0, 3).join('.')}` : ''
      lines.push(`- ${a.kind}${cls}${a.anchors.sourceLoc ? ` (${a.anchors.sourceLoc})` : ''}`)
    }
  }

  if (req.parentBounds) {
    lines.push('')
    lines.push(
      `## Бокс родителя\n${q(req.parentBounds.w)}×${q(req.parentBounds.h)} ${u} в точке ${q(req.parentBounds.x)},${q(req.parentBounds.y)}`,
    )
  }

  if (req.siblings.length) {
    lines.push('')
    lines.push('## Соседи в том же родителе')
    for (const s of req.siblings) {
      lines.push(`- ${s.label} — ${q(s.bounds.w)}×${q(s.bounds.h)} @ ${q(s.bounds.x)},${q(s.bounds.y)}`)
    }
  }

  if (req.overrides.length) {
    lines.push('')
    lines.push('## Что пользователь подвинул руками')
    for (const o of req.overrides) {
      const parts: string[] = []
      if (o.dx || o.dy) {
        parts.push(`сдвиг ${o.dx >= 0 ? '+' : ''}${q(o.dx)}, ${o.dy >= 0 ? '+' : ''}${q(o.dy)} ${u}`)
      }
      if (o.width != null || o.height != null) {
        parts.push(`размер ${o.width != null ? q(o.width) : '—'}×${o.height != null ? q(o.height) : '—'} ${u}`)
      }
      if (o.hidden) parts.push('скрыт')
      const self = o.nodeId === n.id ? 'выделенный элемент' : `узел ${o.nodeId}`
      lines.push(`- ${self}: ${parts.join(', ')}`)
    }
    lines.push('')
    lines.push(
      req.target === 'android'
        ? 'Это живой превью: агент на устройстве подменил `Modifier` работающему LayoutNode, в коде этого нет ' +
            'и после пересборки не останется. Считай замером намерения, а в исходник вноси правку так, как ' +
            'принято в этом проекте: `padding`, `Arrangement.spacedBy`, `Spacer`, порядок элементов, размеры ' +
            'из дизайн-системы — не `Modifier.offset`.'
        : 'Это визуальный превью через inline-стили `translate`/`width` — в коде его нет. ' +
            'Считай замером намерения, а в исходник вноси правку так, как принято в этом проекте: ' +
            'padding, margin, gap, порядок элементов, размеры токенами — не `translate`.',
    )
  }

  lines.push('')
  lines.push('## Задача')
  lines.push(
    'Найди этот элемент в исходниках проекта (якоря выше — классы, текст, data-testid, путь), внеси правку и коротко скажи, что изменил. ' +
      'Если элемент найти не удалось — так и скажи, какие файлы смотрел, не угадывай.',
  )

  return lines.join('\n')
}

export interface AgentEvent {
  kind: 'text' | 'tool' | 'error' | 'done'
  text: string
}

/**
 * Runs one agent turn against the target repo, yielding a flat event stream the
 * UI can render. The SDK's message shapes vary across versions, so extraction is
 * intentionally defensive rather than typed to one release.
 */
export async function* runAgent(req: EditRequest, projectDir: string): AsyncGenerator<AgentEvent> {
  const prompt = buildPrompt(req)
  try {
    const q = query({
      prompt,
      options: {
        cwd: projectDir,
        allowedTools: ALLOWED_TOOLS,
        disallowedTools: DISALLOWED_TOOLS,
        maxTurns: 24,
      },
    })

    for await (const message of q) {
      for (const event of extract(message)) yield event
    }
    yield { kind: 'done', text: '' }
  } catch (err) {
    yield { kind: 'error', text: err instanceof Error ? err.message : String(err) }
  }
}

function extract(message: unknown): AgentEvent[] {
  const m = message as Record<string, any>
  if (!m || typeof m !== 'object') return []

  // Streaming assistant turn: { type: 'assistant', message: { content: [...] } }
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
    return out
  }

  if (m.type === 'text' && typeof m.content === 'string') return [{ kind: 'text', text: m.content }]
  if (m.type === 'result' && typeof m.result === 'string' && m.result.trim()) {
    return [{ kind: 'text', text: m.result }]
  }
  if (m.type === 'result' && m.is_error) {
    return [{ kind: 'error', text: String(m.result ?? 'агент завершился с ошибкой') }]
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
