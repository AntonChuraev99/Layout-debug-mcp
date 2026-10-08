import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Snapshot } from '../shared/protocol.ts'
import { Session } from './session.ts'

function sessionWithSelection(): Session {
  const snapshot: Snapshot = {
    id: 's1',
    target: 'web',
    createdAt: 0,
    unit: 'css-px',
    pxPerUnit: 1,
    viewport: { w: 100, h: 100 },
    rootId: 'root',
    nodes: {
      root: {
        id: 'root',
        parentId: null,
        childIds: ['btn'],
        depth: 0,
        kind: 'div',
        label: 'div',
        bounds: { x: 0, y: 0, w: 100, h: 100 },
        anchors: { path: 'div' },
        styles: {},
      },
      btn: {
        id: 'btn',
        parentId: 'root',
        childIds: [],
        depth: 1,
        kind: 'button',
        label: 'Buy',
        bounds: { x: 10, y: 10, w: 40, h: 20 },
        anchors: { path: 'div > button' },
        styles: {},
      },
    },
  }
  const s = new Session()
  s.setSnapshot(snapshot)
  s.selectedId = 'btn'
  return s
}

describe('Session request status', () => {
  test('a new request starts queued', () => {
    const s = sessionWithSelection()
    assert.equal(s.buildRequest('wider')!.status, 'queued')
  })

  test('done is final, error resolves only to done', () => {
    const s = sessionWithSelection()
    const a = s.buildRequest('a')!
    assert.equal(s.setStatus(a.id, 'working'), true)
    assert.equal(s.setStatus(a.id, 'error', 'agent_failed', 'no key'), true)
    assert.equal(a.errorCode, 'agent_failed')
    assert.equal(s.setStatus(a.id, 'working'), false)
    assert.equal(a.status, 'error')
    assert.equal(s.setStatus(a.id, 'done'), true)
    assert.equal(a.errorCode, undefined)
    assert.equal(s.setStatus(a.id, 'error'), false)
    assert.equal(s.setStatus('nope', 'done'), false)
  })
})

describe('Session.markConsumed', () => {
  test('marks only the given ids and returns what flipped', () => {
    const s = sessionWithSelection()
    const a = s.buildRequest('a')!
    const b = s.buildRequest('b')!
    assert.deepEqual(s.markConsumed([a.id]), [a.id])
    assert.equal(a.consumed, true)
    assert.equal(a.status, 'working')
    assert.equal(b.consumed, false)
    assert.equal(b.status, 'queued')
    // Already consumed: nothing flips again.
    assert.deepEqual(s.markConsumed([a.id]), [])
  })

  test('no ids keeps the legacy meaning: every unconsumed request', () => {
    const s = sessionWithSelection()
    const a = s.buildRequest('a')!
    const b = s.buildRequest('b')!
    s.markConsumed([a.id])
    assert.deepEqual(s.markConsumed(), [b.id])
  })

  test('a finished request is consumed but not demoted to working', () => {
    const s = sessionWithSelection()
    const a = s.buildRequest('a')!
    s.setStatus(a.id, 'error', 'agent_failed', 'boom')
    assert.deepEqual(s.markConsumed([a.id]), [a.id])
    assert.equal(a.status, 'error')
  })
})

describe('Session.addReply (MCP reply_in_window)', () => {
  test('a known requestId ties the message and marks only that request done', () => {
    const s = sessionWithSelection()
    const a = s.buildRequest('a')!
    const b = s.buildRequest('b')!
    s.markConsumed()
    const { message, matched } = s.addReply('Made it wider', 'assistant', a.id)
    assert.equal(matched, true)
    assert.equal(message.requestId, a.id)
    assert.equal(a.status, 'done')
    assert.equal(b.status, 'working')
    assert.equal(s.chat.at(-1), message)
  })

  test('a reply to a request that was never consumed marks it consumed, so it is not NEW again', () => {
    const s = sessionWithSelection()
    const a = s.buildRequest('a')!
    const b = s.buildRequest('b')!
    // Peeked with markConsumed:false — nothing consumed yet.
    s.addReply('Done', 'assistant', a.id)
    assert.equal(a.status, 'done')
    assert.equal(a.consumed, true)
    assert.equal(b.consumed, false)
    // The default pending_requests filter (!consumed) no longer lists it.
    assert.deepEqual(
      s.requests.filter((r) => !r.consumed).map((r) => r.id),
      [b.id],
    )
  })

  test('an unknown requestId still delivers the message, untied, with no status change', () => {
    const s = sessionWithSelection()
    const a = s.buildRequest('a')!
    const { message, matched } = s.addReply('hi', 'assistant', 'missing')
    assert.equal(matched, false)
    assert.equal(message.requestId, undefined)
    assert.equal(a.status, 'queued')
    assert.equal(s.chat.length, 1)
  })

  test('no requestId changes no status', () => {
    const s = sessionWithSelection()
    const a = s.buildRequest('a')!
    s.markConsumed()
    s.addReply('general note', 'system')
    assert.equal(a.status, 'working')
  })

  test('status "error" closes the request as failed, with the reply as the reason', () => {
    const s = sessionWithSelection()
    const a = s.buildRequest('a')!
    s.markConsumed([a.id])
    const { matched } = s.addReply('Could not find the component', 'assistant', a.id, 'error')
    assert.equal(matched, true)
    assert.equal(a.status, 'error')
    assert.equal(a.errorCode, 'agent_failed')
    assert.equal(a.errorMessage, 'Could not find the component')
  })

  test('the error reason is capped, the chat keeps the full reply', () => {
    const s = sessionWithSelection()
    const a = s.buildRequest('a')!
    const long = 'x'.repeat(2000)
    const { message } = s.addReply(long, 'assistant', a.id, 'error')
    assert.equal(message.text, long)
    assert.equal(a.errorMessage!.length, 500)
    assert.ok(a.errorMessage!.endsWith('…'))
  })
})

describe('Session.undelivered (what wait_for_message hands out)', () => {
  test('oldest first; consumed and finished requests are left out', () => {
    const s = sessionWithSelection()
    const a = s.buildRequest('a')!
    const b = s.buildRequest('b')!
    const c = s.buildRequest('c')!
    assert.deepEqual(s.undelivered().map((r) => r.id), [a.id, b.id, c.id])
    s.markConsumed([b.id])
    s.addReply('no', 'assistant', c.id, 'error')
    assert.deepEqual(s.undelivered().map((r) => r.id), [a.id])
  })
})
