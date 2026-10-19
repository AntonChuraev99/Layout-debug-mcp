import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ChatMessage, EditRequest } from '../shared/protocol.ts'
import { placeLabel, placePopover } from './geometry.ts'
import {
  analyzeChat,
  applyStatusEvent,
  seedStatuses,
  type ServerStatus,
  type StatusMap,
  bestAnchor,
  displayLabel,
  ellipsize,
  fmt,
  fmtSigned,
  finishedBetween,
  requestStatus,
  shortenPaths,
  sameElement,
  threadFor,
  unownedMessages,
  type RequestStatus,
  type StatusContext,
} from './thread.ts'

const anchors = (path: string, sourceLoc?: string) => ({ path, sourceLoc })

function req(id: string, path: string, extra: Partial<EditRequest> = {}): EditRequest {
  return {
    id,
    createdAt: 1000,
    target: 'web',
    comment: id,
    node: { id: `n-${path}`, kind: 'div', label: path, bounds: { x: 0, y: 0, w: 1, h: 1 }, anchors: anchors(path), styles: {} },
    ancestors: [],
    siblings: [],
    parentBounds: null,
    overrides: [],
    unit: 'css-px',
    pxPerUnit: 1,
    consumed: false,
    ...extra,
  }
}
const msg = (id: string, role: ChatMessage['role'], pending?: boolean): ChatMessage => ({ id, role, text: id, pending })

describe('sameElement', () => {
  test('matches by path, the id does not matter', () => {
    assert.equal(sameElement({ id: 'a', anchors: anchors('main > h2') }, { id: 'b', anchors: anchors('main > h2') }), true)
  })
  test('same id, another path — another element', () => {
    assert.equal(sameElement({ id: 'a', anchors: anchors('main > h2') }, { id: 'a', anchors: anchors('main > p') }), false)
  })
  test('the source, when both have one, must match', () => {
    assert.equal(sameElement({ id: 'a', anchors: anchors('p', 'A.tsx:1') }, { id: 'a', anchors: anchors('p', 'B.tsx:1') }), false)
    assert.equal(sameElement({ id: 'a', anchors: anchors('p', 'A.tsx:1') }, { id: 'a', anchors: anchors('p') }), true)
  })
})

describe('analyzeChat', () => {
  test('built-in agent: a non-pending reply closes the request, service lines belong to it', () => {
    const requests = [req('r1', 'h2')]
    const chat = [msg('r1', 'user'), msg('r1-reply-Edit', 'system'), msg('r1-reply', 'assistant', true)]
    const a = analyzeChat(chat, requests)
    assert.deepEqual(a.owners.get('r1-reply-Edit'), ['r1'])
    assert.equal(a.done.has('r1'), false)
    const finished = analyzeChat([...chat.slice(0, 2), msg('r1-reply', 'assistant', false)], requests)
    assert.equal(finished.done.has('r1'), true)
  })

  test('no agent: the queued line does not close, an MCP reply closes only requests taken from the queue', () => {
    const requests = [req('r1', 'h2', { consumed: true }), req('r2', 'p')]
    const chat = [msg('r1', 'user'), msg('r1-queued', 'system'), msg('r2', 'user'), msg('mcp-x', 'assistant')]
    const a = analyzeChat(chat, requests)
    assert.deepEqual(a.owners.get('mcp-x'), ['r1'])
    assert.deepEqual([...a.done], ['r1'])
  })

  test('an MCP reply sent before the edit does not belong to it', () => {
    const requests = [req('r1', 'h2', { consumed: true })]
    const a = analyzeChat([msg('mcp-old', 'assistant'), msg('r1', 'user')], requests)
    assert.equal(a.owners.has('mcp-old'), false)
    assert.equal(a.done.has('r1'), false)
  })

  test('an MCP system note is attached but does not finish the work', () => {
    const requests = [req('r1', 'h2', { consumed: true })]
    const a = analyzeChat([msg('r1', 'user'), msg('mcp-note', 'system')], requests)
    assert.deepEqual(a.owners.get('mcp-note'), ['r1'])
    assert.equal(a.done.has('r1'), false)
  })

  test('id prefix: r1-2 is not mistaken for r1', () => {
    const requests = [req('r1', 'a'), req('r1-2', 'b')]
    const a = analyzeChat([msg('r1-2-reply', 'assistant', false)], requests)
    assert.deepEqual(a.owners.get('r1-2-reply'), ['r1-2'])
  })
})

describe('threadFor', () => {
  test('a node thread holds only its messages, in order', () => {
    const requests = [req('r1', 'h2'), req('r2', 'p')]
    const chat = [msg('r1', 'user'), msg('r2', 'user'), msg('r1-reply', 'assistant', false)]
    const a = analyzeChat(chat, requests)
    assert.deepEqual(threadFor(chat, a, ['r1']).map((m) => m.id), ['r1', 'r1-reply'])
  })
})

describe('requestStatus', () => {
  const ctx = (extra: Partial<StatusContext> = {}): StatusContext => ({
    since: 500,
    dismissed: new Set(),
    server: new Map(),
    ...extra,
  })
  const statusOf = (r: EditRequest, chat: ChatMessage[], c = ctx()) => requestStatus(r, analyzeChat(chat, [r]), c)

  test('MCP path: queued → taken → reply', () => {
    const r = req('r1', 'h2')
    const chat = [msg('r1', 'user'), msg('r1-queued', 'system')]
    assert.equal(statusOf(r, chat), 'queued')
    const taken = { ...r, consumed: true }
    assert.equal(statusOf(taken, chat), 'work')
    assert.equal(statusOf(taken, [...chat, msg('mcp-a', 'assistant')]), 'done')
  })

  // Error attribution moved to the server: a failed run arrives as status `error`
  // (formerly inferred from "exactly one running request" + error text, removed).
  test('built-in agent: working at once, a non-pending reply — done, a server error — error', () => {
    const r = req('r1', 'h2')
    assert.equal(statusOf(r, [msg('r1', 'user'), msg('r1-reply-Edit a', 'system')]), 'work')
    const finished = [msg('r1', 'user'), msg('r1-reply', 'assistant', false)]
    assert.equal(statusOf(r, finished), 'done')
    const failed = ctx({ server: new Map([['r1', { status: 'error', code: 'agent_failed', message: 'boom' }]]) })
    assert.equal(statusOf(r, finished, failed), 'error')
  })

  test('an old request with no traces is not "working"; a built-in agent with a thread is "working" even when old', () => {
    const old = req('r1', 'h2', { createdAt: 10, consumed: true })
    assert.equal(statusOf(old, [msg('r1', 'user'), msg('r1-queued', 'system')]), 'stale')
    assert.equal(statusOf(old, []), 'stale')
    assert.equal(statusOf({ ...old, consumed: false }, [msg('r1', 'user'), msg('r1-reply-Read a', 'system')]), 'work')
    assert.equal(statusOf(old, [msg('r1', 'user'), msg('r1-reply', 'assistant', true)]), 'work')
    const oldQueued = { ...old, consumed: false }
    assert.equal(statusOf(oldQueued, [msg('r1', 'user'), msg('r1-queued', 'system')]), 'queued')
  })

  test('"Stop waiting for the agent" beats everything', () => {
    const r = req('r1', 'h2')
    assert.equal(statusOf(r, [msg('r1', 'user')], ctx({ dismissed: new Set(['r1']) })), 'dismissed')
  })
})

describe('server-reported status', () => {
  const ctx = (server: StatusMap, extra: Partial<StatusContext> = {}): StatusContext => ({
    since: 500,
    dismissed: new Set(),
    server,
    ...extra,
  })
  const at = (id: string, status: ServerStatus['status'], code?: ServerStatus['code']) =>
    new Map<string, ServerStatus>([[id, { status, code }]])

  test('the server is the source of truth: the chat does not override it', () => {
    const r = req('r1', 'h2', { status: 'working' })
    // A non-pending final reply would mean "done" to the legacy inference.
    const chat = [msg('r1', 'user'), msg('r1-reply', 'assistant', false)]
    assert.equal(requestStatus(r, analyzeChat(chat, [r]), ctx(at('r1', 'working'))), 'work')
    assert.equal(requestStatus(r, analyzeChat([], [r]), ctx(at('r1', 'done'))), 'done')
    assert.equal(requestStatus(r, analyzeChat([], [r]), ctx(at('r1', 'queued'))), 'queued')
    assert.equal(requestStatus(r, analyzeChat([], [r]), ctx(at('r1', 'error', 'agent_failed'))), 'error')
  })

  test('working from the MCP queue before the window opened — stale; built-in agent — work', () => {
    const old = req('r1', 'h2', { createdAt: 10, consumed: true, status: 'working' })
    const queuedChat = [msg('r1', 'user'), msg('r1-queued', 'system')]
    assert.equal(requestStatus(old, analyzeChat(queuedChat, [old]), ctx(at('r1', 'working'))), 'stale')
    assert.equal(requestStatus(old, analyzeChat([msg('r1', 'user')], [old]), ctx(at('r1', 'working'))), 'work')
  })

  test('an MCP reply without requestId, with a server that reports statuses, closes nothing and has no owner', () => {
    const r = req('r1', 'h2', { consumed: true, status: 'working' })
    const chat = [msg('r1', 'user'), msg('mcp-x', 'assistant')]
    const a = analyzeChat(chat, [r])
    assert.equal(a.owners.has('mcp-x'), false)
    assert.equal(a.done.has('r1'), false)
    assert.deepEqual(unownedMessages(chat, a).map((m) => m.id), ['mcp-x'])
  })

  test('a message with requestId belongs to its request, not to every open one', () => {
    const r1 = req('r1', 'h2', { consumed: true, status: 'working' })
    const r2 = req('r2', 'p', { consumed: true, status: 'working' })
    const reply: ChatMessage = { id: 'mcp-y', role: 'assistant', text: 'ok', requestId: 'r2' }
    const chat = [msg('r1', 'user'), msg('r2', 'user'), reply]
    const a = analyzeChat(chat, [r1, r2])
    assert.deepEqual(a.owners.get('mcp-y'), ['r2'])
    assert.deepEqual(threadFor(chat, a, ['r1']).map((m) => m.id), ['r1'])
    assert.deepEqual(threadFor(chat, a, ['r2']).map((m) => m.id), ['r2', 'mcp-y'])
  })

  test('a requestId of an unknown request — the message stays unowned', () => {
    const r = req('r1', 'h2', { status: 'working' })
    const stray: ChatMessage = { id: 'mcp-z', role: 'assistant', text: 'x', requestId: 'gone' }
    assert.equal(analyzeChat([stray], [r]).owners.has('mcp-z'), false)
  })
})

describe('applyStatusEvent / seedStatuses', () => {
  test('an event writes the status; repeating it returns the same object (no re-render)', () => {
    const empty: StatusMap = new Map()
    const a = applyStatusEvent(empty, { id: 'r1', status: 'working' })
    assert.deepEqual(a.get('r1'), { status: 'working', code: undefined, message: undefined })
    assert.equal(applyStatusEvent(a, { id: 'r1', status: 'working' }), a)
    const b = applyStatusEvent(a, { id: 'r1', status: 'error', code: 'agent_failed', message: 'build broke' })
    assert.deepEqual(b.get('r1'), { status: 'error', code: 'agent_failed', message: 'build broke' })
    assert.equal(a.get('r1')!.status, 'working', 'the previous map is not mutated')
  })

  test('a requests frame replaces the statuses, taking the error from the request fields', () => {
    const prev = applyStatusEvent(new Map(), { id: 'r1', status: 'working' })
    const next = seedStatuses(prev, [
      req('r1', 'h2', { status: 'error', errorCode: 'agent_failed', errorMessage: 'boom' }),
      req('r2', 'p', { status: 'queued' }),
    ])
    assert.deepEqual(next.get('r1'), { status: 'error', code: 'agent_failed', message: 'boom' })
    assert.equal(next.get('r2')?.status, 'queued')
  })

  test('cleared requests go; a request without status (old server) is not added, but an event before the frame is kept', () => {
    const prev = applyStatusEvent(applyStatusEvent(new Map(), { id: 'gone', status: 'done' }), { id: 'r3', status: 'working' })
    const next = seedStatuses(prev, [req('r1', 'h2'), req('r3', 'a')])
    assert.equal(next.has('gone'), false)
    assert.equal(next.has('r1'), false)
    assert.equal(next.get('r3')?.status, 'working')
  })
})

describe('finishedBetween', () => {
  const m = (entries: Record<string, RequestStatus>) => new Map(Object.entries(entries))

  test('open → done/error — finished, from any open state', () => {
    assert.deepEqual(finishedBetween(m({ a: 'work', b: 'queued', c: 'work' }), m({ a: 'done', b: 'error', c: 'work' })), ['a', 'b'])
  })
  test('a request missing from the previous map starts there, it does not finish', () => {
    assert.deepEqual(finishedBetween(m({}), m({ a: 'done' })), [])
  })
  test('dismissed and already final requests do not finish again', () => {
    assert.deepEqual(finishedBetween(m({ b: 'dismissed', c: 'done', d: 'error' }), m({ b: 'done', c: 'done', d: 'error' })), [])
  })
  test('error → done (a Claude Code session completed the edit) — finished: the frame needs a refresh', () => {
    assert.deepEqual(finishedBetween(m({ a: 'error' }), m({ a: 'done' })), ['a'])
  })
  test('stale → done (taken before the window opened, answered by requestId) — finished', () => {
    assert.deepEqual(finishedBetween(m({ a: 'stale' }), m({ a: 'done' })), ['a'])
  })
  test('error is reached only from an open state', () => {
    assert.deepEqual(finishedBetween(m({ a: 'stale', b: 'done', c: 'work' }), m({ a: 'error', b: 'error', c: 'error' })), ['c'])
  })
})

describe('shortenPaths / unownedMessages', () => {
  test('paths inside the project become root-relative, every occurrence; without projectDir the text stays as is', () => {
    const reply = 'Edited C:\\proj\\src\\A.tsx and C:/proj/src/B.css; left D:/other/C.ts'
    assert.equal(shortenPaths(reply, 'C:\\proj'), 'Edited src/A.tsx and src/B.css; left D:/other/C.ts')
    assert.equal(shortenPaths(reply, null), reply)
    assert.equal(shortenPaths('Read C:\\proj\\src\\A.tsx', 'C:\\proj'), 'Read src/A.tsx')
  })
  test('unowned — non-user messages outside requests', () => {
    const requests = [req('r1', 'h2')]
    const chat = [msg('mcp-early', 'system'), msg('r1', 'user'), msg('r1-reply', 'assistant', false)]
    assert.deepEqual(unownedMessages(chat, analyzeChat(chat, requests)).map((m) => m.id), ['mcp-early'])
  })
})

describe('formatting', () => {
  // Plurals and relative time moved to i18n.test.ts with the same expectations.
  test('displayLabel', () => {
    assert.equal(displayLabel('h2', 'h2 "Second card"'), '«Second card»')
    assert.equal(displayLabel('div', 'div.card'), '.card')
    assert.equal(displayLabel('div', 'div'), '')
    assert.equal(displayLabel('PrimaryButton', 'Continue'), '«Continue»')
    assert.equal(displayLabel('Row', 'Row'), '')
  })
  test('fmt / fmtSigned / ellipsize', () => {
    assert.equal(fmt(-8), '−8')
    assert.equal(fmt(25.54), '25.5')
    assert.equal(fmtSigned(16), '+16')
    assert.equal(fmtSigned(-8), '−8')
    assert.equal(fmtSigned(0), '0')
    assert.equal(ellipsize('abcdef', 4), 'abc…')
    assert.equal(ellipsize('abc', 4), 'abc')
  })
})

describe('bestAnchor', () => {
  test('order: source, testId, id, classes, path', () => {
    assert.equal(bestAnchor({ path: 'p', sourceLoc: 'A.tsx:3', testId: 't' }), 'A.tsx:3')
    assert.equal(bestAnchor({ path: 'p', testId: 't', domId: 'd' }), '[data-testid="t"]')
    assert.equal(bestAnchor({ path: 'p', domId: 'd', className: 'c' }), '#d')
    assert.equal(bestAnchor({ path: 'p', className: 'flex gap-2' }), 'flex gap-2')
    assert.equal(bestAnchor({ path: 'main > p' }), 'main > p')
  })
})

describe('placePopover (M = 12, G = 12)', () => {
  const box = { w: 1000, h: 800 }
  const size = { w: 200, h: 300 }
  test('1. on the right when it fits', () => {
    assert.deepEqual(placePopover({ x: 100, y: 100, w: 100, h: 40 }, size, box), { x: 212, y: 100, side: 'right' })
  })
  test('2. near the right edge — on the left', () => {
    const p = placePopover({ x: 850, y: 100, w: 100, h: 40 }, size, box)
    assert.deepEqual(p, { x: 638, y: 100, side: 'left' })
  })
  test('3. full width — below, aligned to the anchor right edge', () => {
    const p = placePopover({ x: 0, y: 50, w: 1000, h: 100 }, size, box)
    assert.deepEqual(p, { x: 1000 - 200 - 12, y: 162, side: 'bottom' })
  })
  test('3. no room below — above', () => {
    const p = placePopover({ x: 0, y: 600, w: 1000, h: 100 }, size, box)
    assert.deepEqual(p, { x: 788, y: 600 - 12 - 300, side: 'top' })
  })
  test('on the side near the bottom edge — raised to fit', () => {
    const p = placePopover({ x: 100, y: 700, w: 100, h: 40 }, size, box)
    assert.equal(p.side, 'right')
    assert.equal(p.y, 800 - 300 - 12)
  })
  test('4. the whole frame — top right corner', () => {
    const p = placePopover({ x: 0, y: 0, w: 1000, h: 800 }, size, box)
    assert.deepEqual(p, { x: 788, y: 12, side: 'corner' })
  })
})

describe('placeLabel', () => {
  test('above the box, on the left by default', () => {
    assert.deepEqual(placeLabel({ x: 100, y: 100, w: 50, h: 20 }, 80, 1000), { vertical: 'above', align: 'left' })
  })
  test('near the top edge — below the box', () => {
    assert.equal(placeLabel({ x: 100, y: 20, w: 50, h: 20 }, 80, 1000).vertical, 'below')
    assert.equal(placeLabel({ x: 100, y: 26, w: 50, h: 20 }, 80, 1000).vertical, 'above')
  })
  test('past the right edge — aligned to the box right edge', () => {
    assert.equal(placeLabel({ x: 940, y: 100, w: 50, h: 20 }, 80, 1000).align, 'right')
  })
})
