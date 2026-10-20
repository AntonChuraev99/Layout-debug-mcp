/**
 * The live edit list that outlives a page reload. The window keeps it in step with the
 * edits on the page, the server holds a copy (so it also outlives a window reload), and
 * after any reload of the target the window finds every edit's element again by its
 * anchors and puts the edit back. An edit whose element is not found stays in the list,
 * marked unresolved, until the user discards it.
 *
 * Pure: resolution, list sync, restore and export are unit-tested.
 */
import { CAPS, cap, quote, untrusted, UNTRUSTED_HEADER } from '../mcp/format.ts'
import type { Anchors, EditRequest, LayoutNode, LiveEdit, NodeId, Override, Snapshot } from './protocol.ts'

export type { LiveEdit }

/** Far above any real session; a longer list is a bug or an abuse. */
export const MAX_LIVE_EDITS = 200

/** Path and source location: what a reload keeps of an element. */
const anchorKey = (a: Anchors) => `${a.path}\u0000${a.sourceLoc ?? ''}`

/**
 * Which of the elements with the same path and source location this one is, in snapshot
 * order. 0 on web (DOM paths carry `:nth-of-type`); on Android a path is only the chain
 * of composable kinds, so every item of a LazyColumn shares it and only the order tells them apart.
 */
export function occurrenceOf(snapshot: Snapshot, node: LayoutNode): number {
  const key = anchorKey(node.anchors)
  let i = 0
  for (const n of Object.values(snapshot.nodes)) {
    if (n.id === node.id) return i
    if (anchorKey(n.anchors) === key) i++
  }
  return 0
}

/** One entry per element and page. */
export function editKey(e: Pick<LiveEdit, 'page' | 'anchors' | 'occurrence'>): string {
  return `${e.page}\u0000${anchorKey(e.anchors)}\u0000${e.occurrence}`
}

/** `node` of `snapshot` is the element this entry is about. */
export function editIsNode(e: Pick<LiveEdit, 'anchors' | 'occurrence'>, snapshot: Snapshot, node: LayoutNode): boolean {
  return anchorKey(e.anchors) === anchorKey(node.anchors) && occurrenceOf(snapshot, node) === e.occurrence
}

function unique(nodes: LayoutNode[], test: (n: LayoutNode) => boolean): LayoutNode | undefined {
  let found: LayoutNode | undefined
  for (const n of nodes) {
    if (!test(n)) continue
    if (found) return undefined
    found = n
  }
  return found
}

/**
 * The element an edit belongs to in `snapshot`. Names the page gave the element come first:
 * the only element of its kind with its `data-testid`, then with its DOM id — a sibling
 * removed before it or a wrapper added around it changes its path (`:nth-of-type`), not
 * those. Then the `occurrence`-th element with its path and source location; when there are
 * such elements but not that many, the edit is unresolved — never the first one, which is
 * another item. An ambiguous test id or DOM id falls through to the path.
 */
export function resolveEdit(snapshot: Snapshot, edit: Pick<LiveEdit, 'anchors' | 'occurrence' | 'kind'>): LayoutNode | undefined {
  const nodes = Object.values(snapshot.nodes)
  const { testId, domId } = edit.anchors
  if (testId) {
    const n = unique(nodes, (x) => x.anchors.testId === testId && x.kind === edit.kind)
    if (n) return n
  }
  if (domId) {
    const n = unique(nodes, (x) => x.anchors.domId === domId && x.kind === edit.kind)
    if (n) return n
  }
  const key = anchorKey(edit.anchors)
  let seen = 0
  for (const n of nodes) {
    if (anchorKey(n.anchors) !== key) continue
    if (seen === edit.occurrence) return n
    seen++
  }
  return undefined
}

/**
 * The list after the user changed edits on the live page. `overrides` is everything the
 * page shows now; `skip` are elements whose edit was handed to an agent and is on its way
 * into the code (they must not come back after a reload).
 *
 * - an override on an element of `snapshot` becomes (or updates) its entry;
 * - an override whose element is not in the snapshot keeps its old entry, with the new values;
 * - an entry of this page that is no longer an override was reset by the user: it goes;
 * - unresolved entries and entries of other pages stay, unless an applied edit took their place.
 */
export function syncEdits(
  prev: readonly LiveEdit[],
  overrides: Readonly<Record<NodeId, Override>>,
  snapshot: Snapshot,
  page: string,
  skip: ReadonlySet<NodeId> = new Set(),
): LiveEdit[] {
  const fresh = new Map<string, LiveEdit>()
  for (const o of Object.values(overrides)) {
    if (skip.has(o.nodeId)) continue
    const node = snapshot.nodes[o.nodeId]
    if (node) {
      const e: LiveEdit = {
        page,
        target: snapshot.target,
        kind: node.kind,
        label: node.label,
        anchors: node.anchors,
        occurrence: occurrenceOf(snapshot, node),
        override: o,
        unit: snapshot.unit,
        pxPerUnit: snapshot.pxPerUnit,
        resolved: true,
      }
      fresh.set(editKey(e), e)
      continue
    }
    const old = prev.find((e) => e.page === page && e.resolved && e.override.nodeId === o.nodeId)
    if (old) fresh.set(editKey(old), { ...old, override: o })
  }
  const out: LiveEdit[] = []
  for (const e of prev) {
    const key = editKey(e)
    const now = fresh.get(key)
    if (now) {
      out.push(now)
      fresh.delete(key)
    } else if (e.page !== page || !e.resolved) {
      out.push(e)
    }
  }
  out.push(...fresh.values())
  return out.slice(-MAX_LIVE_EDITS)
}

/**
 * What to put back on a page that has just come in. Only entries of `page` take part:
 * each one is found by its anchors and re-addressed to its new node id, or marked
 * unresolved. An element that already carries an edit (`current`) keeps it.
 * `lost` counts entries that resolved before and do not now.
 */
export function restorePlan(
  list: readonly LiveEdit[],
  snapshot: Snapshot,
  page: string,
  current: Readonly<Record<NodeId, Override>> = {},
): { apply: Override[]; edits: LiveEdit[]; lost: number } {
  const apply: Override[] = []
  let lost = 0
  const edits = list.map((e) => {
    if (e.page !== page) return e
    const node = resolveEdit(snapshot, e)
    if (!node) {
      if (e.resolved) lost++
      return e.resolved ? { ...e, resolved: false } : e
    }
    const override = { ...e.override, nodeId: node.id }
    if (!current[node.id]) apply.push(override)
    return {
      ...e,
      override,
      anchors: node.anchors,
      occurrence: occurrenceOf(snapshot, node),
      kind: node.kind,
      label: node.label,
      resolved: true,
    }
  })
  return { apply, edits, lost }
}

/**
 * The entries a finished request took into the code: the element's own edit, when the
 * request carried one, on the page it was sent from. Its other live edits stay with the
 * user, and so does the same element's edit on another page (a shared header moved
 * differently on `/a` and `/b`). A request without `page` (sent by an older window) matches any page.
 */
export function dropHandedOver(list: readonly LiveEdit[], requests: readonly EditRequest[]): LiveEdit[] {
  const handed = requests.filter((r) => r.overrides.some((o) => o.nodeId === r.node.id))
  if (!handed.length) return [...list]
  return list.filter(
    (e) =>
      !handed.some(
        (r) =>
          r.target === e.target &&
          (r.page === undefined || r.page === e.page) &&
          anchorKey(r.node.anchors) === anchorKey(e.anchors) &&
          (r.occurrence ?? 0) === e.occurrence,
      ),
  )
}

const sameValues = (a: Override, b: Override) =>
  a.dx === b.dx && a.dy === b.dy && a.width === b.width && a.height === b.height && Boolean(a.hidden) === Boolean(b.hidden)

/**
 * Another window changed the list (or `DELETE /api/live-edits` did). This window's page
 * follows it both ways: an edit that left the list is taken off (`clear`), and an entry of
 * this page that resolves here but is not on the page with these values is put on (`apply`)
 * — otherwise this window's next sync would read it as reset and drop it for everyone.
 */
export function externalListPlan(
  list: readonly LiveEdit[],
  snapshot: Snapshot,
  page: string,
  current: Readonly<Record<NodeId, Override>>,
): { apply: Override[]; clear: NodeId[] } {
  const mine = list.filter((e) => e.page === page && e.resolved)
  const clear: NodeId[] = []
  for (const o of Object.values(current)) {
    const node = snapshot.nodes[o.nodeId]
    if (node && !mine.some((e) => editIsNode(e, snapshot, node))) clear.push(o.nodeId)
  }
  const apply: Override[] = []
  for (const e of mine) {
    const node = resolveEdit(snapshot, e)
    if (!node) continue
    const now = current[node.id]
    if (!now || !sameValues(now, e.override)) apply.push({ ...e.override, nodeId: node.id })
  }
  return { apply, clear }
}

/**
 * Two lists hold the same edits. Node ids do not count: each window and each document
 * numbers its nodes its own way, and an id-only difference sent around would bounce
 * between two windows forever.
 */
export function sameEdits(a: readonly LiveEdit[], b: readonly LiveEdit[]): boolean {
  if (a.length !== b.length) return false
  const plain = (l: readonly LiveEdit[]) => JSON.stringify(l.map((e) => ({ ...e, override: { ...e.override, nodeId: '' } })))
  return plain(a) === plain(b)
}

// --- export -------------------------------------------------------------------

const round = (n: number) => Math.round(n * 10) / 10
const signed = (n: number) => (round(n) > 0 ? `+${round(n)}` : String(round(n)))

/** The change in the unit that belongs in code: `offset +40, +20 css-px; size 120×40 css-px; hidden`. */
export function describeChange(e: Pick<LiveEdit, 'override' | 'unit' | 'pxPerUnit'>): string {
  const scale = e.pxPerUnit > 0 ? e.pxPerUnit : 1
  const o = e.override
  const parts: string[] = []
  if (o.dx || o.dy) parts.push(`offset ${signed(o.dx / scale)}, ${signed(o.dy / scale)} ${e.unit}`)
  if (o.width != null || o.height != null) {
    const w = o.width != null ? String(round(o.width / scale)) : '—'
    const h = o.height != null ? String(round(o.height / scale)) : '—'
    parts.push(`size ${w}×${h} ${e.unit}`)
  }
  if (o.hidden) parts.push('hidden')
  return parts.join('; ') || 'no change'
}

function anchorLines(a: Anchors): string[] {
  const lines: string[] = []
  if (a.sourceLoc) lines.push(`source: ${quote(a.sourceLoc, CAPS.sourceLoc)}`)
  if (a.testId) lines.push(`data-testid: ${quote(a.testId, CAPS.testId)}`)
  if (a.domId) lines.push(`id: ${quote(a.domId, CAPS.domId)}`)
  if (a.className) lines.push(`classes: ${quote(a.className, CAPS.className)}`)
  if (a.text) lines.push(`text: ${quote(a.text, CAPS.text)}`)
  lines.push(`path: ${quote(a.path, CAPS.path)}`)
  return lines
}

const PAGE_CAP = 300

/**
 * "Copy all edits" as Markdown, for pasting into any agent. The numbers are the tool's
 * own; everything that came from the page (labels, anchors, the address) sits in the
 * marked block, capped and JSON-quoted, like the MCP tools return it.
 */
export function exportMarkdown(list: readonly LiveEdit[]): string {
  const head = [
    '# Live edits from layout-debug',
    '',
    list.length
      ? `${list.length} live edit${list.length === 1 ? '' : 's'} made in the layout-debug window. They are a preview, not in the code yet: ` +
        'find each element by its anchors and make the change in the source.'
      : 'No live edits.',
  ]
  const blocks = list.map((e, i) => {
    const status = e.resolved ? '' : ' (not found on the page after the last reload)'
    return [
      `## ${i + 1}. ${describeChange(e)}${status}`,
      '',
      untrusted([
        `page: ${quote(e.page, PAGE_CAP)}`,
        `element: ${quote(e.label, CAPS.label)} (${quote(e.kind, CAPS.kind)})`,
        ...anchorLines(e.anchors),
      ]),
    ].join('\n')
  })
  return [...head, ...blocks.flatMap((b) => ['', b])].join('\n') + '\n'
}

/** The same list as JSON: numbers in the code unit, page data capped and labelled untrusted. */
export function exportJson(list: readonly LiveEdit[]): string {
  const capAnchors = (a: Anchors) => {
    const out: Record<string, string> = { path: cap(a.path, CAPS.path) }
    if (a.sourceLoc) out.sourceLoc = cap(a.sourceLoc, CAPS.sourceLoc)
    if (a.testId) out.testId = cap(a.testId, CAPS.testId)
    if (a.domId) out.domId = cap(a.domId, CAPS.domId)
    if (a.className) out.className = cap(a.className, CAPS.className)
    if (a.text) out.text = cap(a.text, CAPS.text)
    return out
  }
  const body = {
    tool: 'layout-debug-mcp',
    note: `Live edits: a preview, not in the code yet. ${UNTRUSTED_HEADER} page, element and anchors.`,
    edits: list.map((e) => {
      const scale = e.pxPerUnit > 0 ? e.pxPerUnit : 1
      const o = e.override
      const change: Record<string, unknown> = { unit: e.unit }
      if (o.dx || o.dy) change.offset = { dx: round(o.dx / scale), dy: round(o.dy / scale) }
      if (o.width != null) change.width = round(o.width / scale)
      if (o.height != null) change.height = round(o.height / scale)
      if (o.hidden) change.hidden = true
      return {
        target: e.target,
        resolved: e.resolved,
        change,
        page: cap(e.page, PAGE_CAP),
        element: { kind: cap(e.kind, CAPS.kind), label: cap(e.label, CAPS.label) },
        anchors: capAnchors(e.anchors),
      }
    }),
  }
  return JSON.stringify(body, null, 2)
}
