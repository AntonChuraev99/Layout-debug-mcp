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
  test('совпадение по пути, id не важен', () => {
    assert.equal(sameElement({ id: 'a', anchors: anchors('main > h2') }, { id: 'b', anchors: anchors('main > h2') }), true)
  })
  test('тот же id, другой путь — другой элемент', () => {
    assert.equal(sameElement({ id: 'a', anchors: anchors('main > h2') }, { id: 'a', anchors: anchors('main > p') }), false)
  })
  test('исходник, если он есть у обоих, обязан совпасть', () => {
    assert.equal(sameElement({ id: 'a', anchors: anchors('p', 'A.tsx:1') }, { id: 'a', anchors: anchors('p', 'B.tsx:1') }), false)
    assert.equal(sameElement({ id: 'a', anchors: anchors('p', 'A.tsx:1') }, { id: 'a', anchors: anchors('p') }), true)
  })
})

describe('analyzeChat', () => {
  test('встроенный агент: ответ без pending закрывает запрос, служебные строки принадлежат ему', () => {
    const requests = [req('r1', 'h2')]
    const chat = [msg('r1', 'user'), msg('r1-reply-Edit', 'system'), msg('r1-reply', 'assistant', true)]
    const a = analyzeChat(chat, requests)
    assert.deepEqual(a.owners.get('r1-reply-Edit'), ['r1'])
    assert.equal(a.done.has('r1'), false)
    const finished = analyzeChat([...chat.slice(0, 2), msg('r1-reply', 'assistant', false)], requests)
    assert.equal(finished.done.has('r1'), true)
  })

  test('без агента: queued-строка не закрывает, ответ MCP закрывает только забранные из очереди', () => {
    const requests = [req('r1', 'h2', { consumed: true }), req('r2', 'p')]
    const chat = [msg('r1', 'user'), msg('r1-queued', 'system'), msg('r2', 'user'), msg('mcp-x', 'assistant')]
    const a = analyzeChat(chat, requests)
    assert.deepEqual(a.owners.get('mcp-x'), ['r1'])
    assert.deepEqual([...a.done], ['r1'])
  })

  test('ответ MCP до отправки правки этой правке не принадлежит', () => {
    const requests = [req('r1', 'h2', { consumed: true })]
    const a = analyzeChat([msg('mcp-old', 'assistant'), msg('r1', 'user')], requests)
    assert.equal(a.owners.has('mcp-old'), false)
    assert.equal(a.done.has('r1'), false)
  })

  test('системная пометка MCP привязывается, но работу не завершает', () => {
    const requests = [req('r1', 'h2', { consumed: true })]
    const a = analyzeChat([msg('r1', 'user'), msg('mcp-note', 'system')], requests)
    assert.deepEqual(a.owners.get('mcp-note'), ['r1'])
    assert.equal(a.done.has('r1'), false)
  })

  test('id-префикс: r1-2 не путается с r1', () => {
    const requests = [req('r1', 'a'), req('r1-2', 'b')]
    const a = analyzeChat([msg('r1-2-reply', 'assistant', false)], requests)
    assert.deepEqual(a.owners.get('r1-2-reply'), ['r1-2'])
  })
})

describe('threadFor', () => {
  test('лента узла — только его сообщения, по порядку', () => {
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

  test('MCP-путь: в очереди → забран → ответ', () => {
    const r = req('r1', 'h2')
    const chat = [msg('r1', 'user'), msg('r1-queued', 'system')]
    assert.equal(statusOf(r, chat), 'queued')
    const taken = { ...r, consumed: true }
    assert.equal(statusOf(taken, chat), 'work')
    assert.equal(statusOf(taken, [...chat, msg('mcp-a', 'assistant')]), 'done')
  })

  // Error attribution moved to the server: a failed run arrives as status `error`
  // (formerly inferred from "exactly one running request" + error text, removed).
  test('встроенный агент: сразу в работе, ответ без pending — готово, ошибка от сервера — ошибка', () => {
    const r = req('r1', 'h2')
    assert.equal(statusOf(r, [msg('r1', 'user'), msg('r1-reply-Edit a', 'system')]), 'work')
    const finished = [msg('r1', 'user'), msg('r1-reply', 'assistant', false)]
    assert.equal(statusOf(r, finished), 'done')
    const failed = ctx({ server: new Map([['r1', { status: 'error', code: 'agent_failed', message: 'boom' }]]) })
    assert.equal(statusOf(r, finished, failed), 'error')
  })

  test('старый запрос без следов — не «в работе»; встроенный агент с тредом — «в работе» даже старый', () => {
    const old = req('r1', 'h2', { createdAt: 10, consumed: true })
    assert.equal(statusOf(old, [msg('r1', 'user'), msg('r1-queued', 'system')]), 'stale')
    assert.equal(statusOf(old, []), 'stale')
    assert.equal(statusOf({ ...old, consumed: false }, [msg('r1', 'user'), msg('r1-reply-Read a', 'system')]), 'work')
    assert.equal(statusOf(old, [msg('r1', 'user'), msg('r1-reply', 'assistant', true)]), 'work')
    const oldQueued = { ...old, consumed: false }
    assert.equal(statusOf(oldQueued, [msg('r1', 'user'), msg('r1-queued', 'system')]), 'queued')
  })

  test('«Не ждать агента» побеждает всё', () => {
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

  test('сервер — источник правды: чат его не перебивает', () => {
    const r = req('r1', 'h2', { status: 'working' })
    // A non-pending final reply would mean "done" to the legacy inference.
    const chat = [msg('r1', 'user'), msg('r1-reply', 'assistant', false)]
    assert.equal(requestStatus(r, analyzeChat(chat, [r]), ctx(at('r1', 'working'))), 'work')
    assert.equal(requestStatus(r, analyzeChat([], [r]), ctx(at('r1', 'done'))), 'done')
    assert.equal(requestStatus(r, analyzeChat([], [r]), ctx(at('r1', 'queued'))), 'queued')
    assert.equal(requestStatus(r, analyzeChat([], [r]), ctx(at('r1', 'error', 'agent_failed'))), 'error')
  })

  test('working из очереди MCP до открытия окна — stale; встроенный агент — work', () => {
    const old = req('r1', 'h2', { createdAt: 10, consumed: true, status: 'working' })
    const queuedChat = [msg('r1', 'user'), msg('r1-queued', 'system')]
    assert.equal(requestStatus(old, analyzeChat(queuedChat, [old]), ctx(at('r1', 'working'))), 'stale')
    assert.equal(requestStatus(old, analyzeChat([msg('r1', 'user')], [old]), ctx(at('r1', 'working'))), 'work')
  })

  test('ответ MCP без requestId при сервере со статусами ничего не закрывает и ничей', () => {
    const r = req('r1', 'h2', { consumed: true, status: 'working' })
    const chat = [msg('r1', 'user'), msg('mcp-x', 'assistant')]
    const a = analyzeChat(chat, [r])
    assert.equal(a.owners.has('mcp-x'), false)
    assert.equal(a.done.has('r1'), false)
    assert.deepEqual(unownedMessages(chat, a).map((m) => m.id), ['mcp-x'])
  })

  test('сообщение с requestId принадлежит своему запросу, а не всем открытым', () => {
    const r1 = req('r1', 'h2', { consumed: true, status: 'working' })
    const r2 = req('r2', 'p', { consumed: true, status: 'working' })
    const reply: ChatMessage = { id: 'mcp-y', role: 'assistant', text: 'ok', requestId: 'r2' }
    const chat = [msg('r1', 'user'), msg('r2', 'user'), reply]
    const a = analyzeChat(chat, [r1, r2])
    assert.deepEqual(a.owners.get('mcp-y'), ['r2'])
    assert.deepEqual(threadFor(chat, a, ['r1']).map((m) => m.id), ['r1'])
    assert.deepEqual(threadFor(chat, a, ['r2']).map((m) => m.id), ['r2', 'mcp-y'])
  })

  test('requestId с неизвестным запросом — сообщение остаётся ничьим', () => {
    const r = req('r1', 'h2', { status: 'working' })
    const stray: ChatMessage = { id: 'mcp-z', role: 'assistant', text: 'x', requestId: 'gone' }
    assert.equal(analyzeChat([stray], [r]).owners.has('mcp-z'), false)
  })
})

describe('applyStatusEvent / seedStatuses', () => {
  test('событие пишет статус; повтор того же — тот же объект (без ре-рендера)', () => {
    const empty: StatusMap = new Map()
    const a = applyStatusEvent(empty, { id: 'r1', status: 'working' })
    assert.deepEqual(a.get('r1'), { status: 'working', code: undefined, message: undefined })
    assert.equal(applyStatusEvent(a, { id: 'r1', status: 'working' }), a)
    const b = applyStatusEvent(a, { id: 'r1', status: 'error', code: 'agent_failed', message: 'build broke' })
    assert.deepEqual(b.get('r1'), { status: 'error', code: 'agent_failed', message: 'build broke' })
    assert.equal(a.get('r1')!.status, 'working', 'the previous map is not mutated')
  })

  test('кадр requests заменяет статусы, ошибку берёт из полей запроса', () => {
    const prev = applyStatusEvent(new Map(), { id: 'r1', status: 'working' })
    const next = seedStatuses(prev, [
      req('r1', 'h2', { status: 'error', errorCode: 'agent_failed', errorMessage: 'boom' }),
      req('r2', 'p', { status: 'queued' }),
    ])
    assert.deepEqual(next.get('r1'), { status: 'error', code: 'agent_failed', message: 'boom' })
    assert.equal(next.get('r2')?.status, 'queued')
  })

  test('очищенные запросы уходят; запрос без статуса (старый сервер) не попадает, но событие до кадра сохраняется', () => {
    const prev = applyStatusEvent(applyStatusEvent(new Map(), { id: 'gone', status: 'done' }), { id: 'r3', status: 'working' })
    const next = seedStatuses(prev, [req('r1', 'h2'), req('r3', 'a')])
    assert.equal(next.has('gone'), false)
    assert.equal(next.has('r1'), false)
    assert.equal(next.get('r3')?.status, 'working')
  })
})

describe('finishedBetween', () => {
  const m = (entries: Record<string, RequestStatus>) => new Map(Object.entries(entries))

  test('открытый → done/error — завершён, из любого открытого состояния', () => {
    assert.deepEqual(finishedBetween(m({ a: 'work', b: 'queued', c: 'work' }), m({ a: 'done', b: 'error', c: 'work' })), ['a', 'b'])
  })
  test('запрос, которого не было в прошлой карте, там начинается, а не завершается', () => {
    assert.deepEqual(finishedBetween(m({}), m({ a: 'done' })), [])
  })
  test('dismissed и уже финальные повторно не завершаются', () => {
    assert.deepEqual(finishedBetween(m({ b: 'dismissed', c: 'done', d: 'error' }), m({ b: 'done', c: 'done', d: 'error' })), [])
  })
  test('error → done (правку довела сессия Claude Code) — завершён: кадр надо обновить', () => {
    assert.deepEqual(finishedBetween(m({ a: 'error' }), m({ a: 'done' })), ['a'])
  })
  test('stale → done (взят до открытия окна, ответили по requestId) — завершён', () => {
    assert.deepEqual(finishedBetween(m({ a: 'stale' }), m({ a: 'done' })), ['a'])
  })
  test('в error попадают только из открытого состояния', () => {
    assert.deepEqual(finishedBetween(m({ a: 'stale', b: 'done', c: 'work' }), m({ a: 'error', b: 'error', c: 'error' })), ['c'])
  })
})

describe('shortenPaths / unownedMessages', () => {
  test('пути внутри проекта — от его корня, все вхождения; без projectDir текст как есть', () => {
    const reply = 'Edited C:\\proj\\src\\A.tsx and C:/proj/src/B.css; left D:/other/C.ts'
    assert.equal(shortenPaths(reply, 'C:\\proj'), 'Edited src/A.tsx and src/B.css; left D:/other/C.ts')
    assert.equal(shortenPaths(reply, null), reply)
    assert.equal(shortenPaths('Read C:\\proj\\src\\A.tsx', 'C:\\proj'), 'Read src/A.tsx')
  })
  test('без хозяина — не пользовательские сообщения вне запросов', () => {
    const requests = [req('r1', 'h2')]
    const chat = [msg('mcp-early', 'system'), msg('r1', 'user'), msg('r1-reply', 'assistant', false)]
    assert.deepEqual(unownedMessages(chat, analyzeChat(chat, requests)).map((m) => m.id), ['mcp-early'])
  })
})

describe('форматирование', () => {
  // Plurals and relative time moved to i18n.test.ts with the same expectations.
  test('displayLabel', () => {
    assert.equal(displayLabel('h2', 'h2 "Вторая карточка"'), '«Вторая карточка»')
    assert.equal(displayLabel('div', 'div.card'), '.card')
    assert.equal(displayLabel('div', 'div'), '')
    assert.equal(displayLabel('PrimaryButton', 'Продолжить'), '«Продолжить»')
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
  test('порядок: исходник, testId, id, классы, путь', () => {
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
  test('1. справа, если влезает', () => {
    assert.deepEqual(placePopover({ x: 100, y: 100, w: 100, h: 40 }, size, box), { x: 212, y: 100, side: 'right' })
  })
  test('2. у правого края — слева', () => {
    const p = placePopover({ x: 850, y: 100, w: 100, h: 40 }, size, box)
    assert.deepEqual(p, { x: 638, y: 100, side: 'left' })
  })
  test('3. на всю ширину — снизу, по правому краю якоря', () => {
    const p = placePopover({ x: 0, y: 50, w: 1000, h: 100 }, size, box)
    assert.deepEqual(p, { x: 1000 - 200 - 12, y: 162, side: 'bottom' })
  })
  test('3. снизу не влезает — сверху', () => {
    const p = placePopover({ x: 0, y: 600, w: 1000, h: 100 }, size, box)
    assert.deepEqual(p, { x: 788, y: 600 - 12 - 300, side: 'top' })
  })
  test('сбоку у нижнего края — поднят так, чтобы влезть', () => {
    const p = placePopover({ x: 100, y: 700, w: 100, h: 40 }, size, box)
    assert.equal(p.side, 'right')
    assert.equal(p.y, 800 - 300 - 12)
  })
  test('4. весь кадр — правый верхний угол', () => {
    const p = placePopover({ x: 0, y: 0, w: 1000, h: 800 }, size, box)
    assert.deepEqual(p, { x: 788, y: 12, side: 'corner' })
  })
})

describe('placeLabel', () => {
  test('над боксом слева по умолчанию', () => {
    assert.deepEqual(placeLabel({ x: 100, y: 100, w: 50, h: 20 }, 80, 1000), { vertical: 'above', align: 'left' })
  })
  test('у верхней кромки — под боксом', () => {
    assert.equal(placeLabel({ x: 100, y: 20, w: 50, h: 20 }, 80, 1000).vertical, 'below')
    assert.equal(placeLabel({ x: 100, y: 26, w: 50, h: 20 }, 80, 1000).vertical, 'above')
  })
  test('за правой кромкой — по правому краю бокса', () => {
    assert.equal(placeLabel({ x: 940, y: 100, w: 50, h: 20 }, 80, 1000).align, 'right')
  })
})
