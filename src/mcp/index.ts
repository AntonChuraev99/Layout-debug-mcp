/**
 * MCP entry point. Runs as its own stdio process (Claude Code spawns it), so it
 * cannot share memory with the layout-debug server — it reads the live session
 * over the server's local HTTP API instead.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { SERVER_PORT } from '../shared/ports.ts'
import type { EditRequest, LayoutNode, Snapshot } from '../shared/protocol.ts'

const BASE = process.env.LD_SERVER_URL ?? `http://127.0.0.1:${SERVER_PORT}`

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return text(
    `Сервер layout-debug недоступен (${BASE}): ${message}\n` +
      'Запусти его: npm run dev в каталоге layout-debug-mcp.',
  )
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
    `Выделен: ${node.label}`,
    `Тип: ${node.kind}`,
    `Бокс: ${q(node.bounds.w)}×${q(node.bounds.h)} ${unit} @ ${q(node.bounds.x)},${q(node.bounds.y)}`,
  ]
  if (a.sourceLoc) lines.push(`Источник: ${a.sourceLoc}`)
  if (a.testId) lines.push(`data-testid: ${a.testId}`)
  if (a.domId) lines.push(`id: ${a.domId}`)
  if (a.className) lines.push(`Классы: ${a.className}`)
  if (a.text) lines.push(`Текст: ${JSON.stringify(a.text)}`)
  lines.push(`Путь: ${a.path}`)
  const styles = Object.entries(node.styles)
  if (styles.length) lines.push(`Свойства: ${styles.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  if (ancestors.length) {
    lines.push(`Родители: ${ancestors.map((x) => x.kind).join(' > ')}`)
  }
  return lines.join('\n')
}

function describeRequest(req: EditRequest): string {
  const lines = [
    `[${req.consumed ? 'прочитано' : 'НОВОЕ'}] ${new Date(req.createdAt).toISOString()} — ${req.id}`,
    `Комментарий: ${req.comment}`,
    `Элемент: ${req.node.label} (${req.node.kind})`,
  ]
  if (req.node.anchors.sourceLoc) lines.push(`Источник: ${req.node.anchors.sourceLoc}`)
  if (req.node.anchors.className) lines.push(`Классы: ${req.node.anchors.className}`)
  lines.push(`Путь: ${req.node.anchors.path}`)
  const q = (px: number) => Math.round((px / (req.pxPerUnit || 1)) * 10) / 10
  for (const o of req.overrides) {
    const parts: string[] = []
    if (o.dx || o.dy) parts.push(`сдвиг ${q(o.dx)}, ${q(o.dy)} ${req.unit}`)
    if (o.width != null || o.height != null) {
      parts.push(`размер ${o.width != null ? q(o.width) : '—'}×${o.height != null ? q(o.height) : '—'} ${req.unit}`)
    }
    if (o.hidden) parts.push('скрыт')
    if (parts.length) lines.push(`Живая правка (${o.nodeId}): ${parts.join(', ')}`)
  }
  return lines.join('\n')
}

const server = new McpServer({ name: 'layout-debug', version: '0.1.0' })

server.registerTool(
  'layout_snapshot',
  {
    title: 'Дерево layout',
    description:
      'Дерево последнего снимка живого UI: узлы, размеры, якоря для поиска в коде. Сжато по глубине.',
    inputSchema: { maxDepth: z.number().int().min(1).max(30).default(8).describe('Глубина дерева') },
  },
  async ({ maxDepth }) => {
    try {
      const { snapshot } = await api<{ snapshot: Snapshot | null }>('/api/snapshot')
      if (!snapshot) return text('Снимка ещё нет: открой страницу в окне layout-debug.')
      return text(
        `Цель: ${snapshot.target}, единицы: ${snapshot.unit}, ` +
          `вьюпорт ${snapshot.viewport.w}×${snapshot.viewport.h}, узлов: ${Object.keys(snapshot.nodes).length}\n\n` +
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
    title: 'Выделенный элемент',
    description:
      'Что пользователь прямо сейчас выделил в окне layout-debug: бокс, якоря для поиска в коде, цепочка родителей, живые правки.',
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
      if (!data.node) return text('Ничего не выделено.')
      const scale = data.pxPerUnit || 1
      const q = (px: number) => Math.round((px / scale) * 10) / 10
      const body = describeNode(data.node, data.ancestors, data.unit ?? 'px', scale)
      if (!data.overrides.length) return text(body)
      const tweaks = data.overrides
        .map(
          (o) =>
            `- ${o.nodeId}: сдвиг ${q(o.dx)}, ${q(o.dy)}` +
            (o.width != null ? `, размер ${q(o.width)}×${q(o.height ?? 0)}` : ''),
        )
        .join('\n')
      return text(`${body}\n\nЖивые правки (только превью, в коде их нет):\n${tweaks}`)
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'pending_requests',
  {
    title: 'Очередь правок',
    description:
      'Правки, которые пользователь отправил из окна layout-debug: комментарий + артефакты элемента + замеры перетаскивания. ' +
      'Разобрал правку — отпишись через reply_in_window: пользователь смотрит в окно, а не в терминал.',
    inputSchema: {
      includeConsumed: z.boolean().default(false).describe('Показать и уже прочитанные'),
      markConsumed: z.boolean().default(true).describe('Пометить выданные как прочитанные'),
    },
  },
  async ({ includeConsumed, markConsumed }) => {
    try {
      const { requests } = await api<{ requests: EditRequest[] }>('/api/requests')
      const list = includeConsumed ? requests : requests.filter((r) => !r.consumed)
      if (!list.length) return text('Очередь пуста.')
      const body = list.map(describeRequest).join('\n\n---\n\n')
      if (markConsumed) await api('/api/requests/consume', { method: 'GET' })
      return text(body)
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'reply_in_window',
  {
    title: 'Ответить в окно layout-debug',
    description:
      'Написать в чат окна layout-debug. Вызывай после того, как разобрал правку из pending_requests: ' +
      'пользователь смотрит на окно, а не в терминал, и без этого он не узнает, что ты сделал. ' +
      'Коротко: что изменил, в каких файлах, что осталось. Если правку выполнить не удалось — скажи здесь же, почему.',
    inputSchema: {
      text: z.string().min(1).describe('Текст для чата окна'),
      role: z
        .enum(['assistant', 'system'])
        .default('assistant')
        .describe('assistant — ответ пользователю, system — служебная пометка'),
    },
  },
  // `text` is also the name of the response helper, so the argument is renamed.
  async ({ text: content, role }) => {
    try {
      const body = await api<{ ok?: boolean; delivered?: number; error?: string }>('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: content, role }),
      })
      if (body.error) return text(`Не отправилось: ${body.error}`)
      if (!body.delivered) {
        return text('Отправлено, но окно layout-debug сейчас закрыто — сообщение появится, когда его откроют.')
      }
      return text(`Отправлено в окно (${body.delivered}).`)
    } catch (err) {
      return fail(err)
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
