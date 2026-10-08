import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { EditRequest, Snapshot } from '../shared/protocol.ts'
import { Session } from './session.ts'
import { WaitHub, type WaitSink } from './waiters.ts'

function session(): Session {
  const snapshot: Snapshot = {
    id: 's1',
    target: 'web',
    createdAt: 0,
    unit: 'css-px',
    pxPerUnit: 1,
    viewport: { w: 100, h: 100 },
    rootId: 'btn',
    nodes: {
      btn: {
        id: 'btn',
        parentId: null,
        childIds: [],
        depth: 0,
        kind: 'button',
        label: 'Buy',
        bounds: { x: 0, y: 0, w: 40, h: 20 },
        anchors: { path: 'button' },
        styles: {},
      },
    },
  }
  const s = new Session()
  s.setSnapshot(snapshot)
  s.selectedId = 'btn'
  return s
}

/** A test sink: records what it got; `mode` decides how the "write" ends. */
function sink(mode: 'written' | 'gone' | 'manual' = 'written') {
  const got: EditRequest[] = []
  let timeouts = 0
  let finish: ((ok: boolean) => void) | null = null
  const s: WaitSink = {
    deliver(request, written) {
      got.push(request)
      if (mode === 'written') written(true)
      else if (mode === 'gone') written(false)
      else finish = written
    },
    timeout() {
      timeouts++
    },
  }
  return {
    sink: s,
    got,
    get timeouts() {
      return timeouts
    },
    finish: (ok: boolean) => finish?.(ok),
  }
}

function hubFor(s: Session, graceMs = 10_000, workingHoldMs?: number) {
  const listening: boolean[] = []
  const delivered: string[] = []
  const hub = new WaitHub({
    pending: () => s.undelivered(),
    delivered: (id) => {
      delivered.push(id)
      s.markConsumed([id])
    },
    stillWorking: (id) => s.requests.find((r) => r.id === id)?.status === 'working',
    listeningChanged: (l) => listening.push(l),
    graceMs,
    workingHoldMs,
  })
  return { hub, listening, delivered }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('WaitHub: delivery', () => {
  test('a request already queued is handed out at once and marked working', () => {
    const s = session()
    const r = s.buildRequest('wider')!
    const { hub, delivered } = hubFor(s)
    const a = sink()
    hub.wait(a.sink, 10_000)
    assert.deepEqual(a.got.map((x) => x.id), [r.id])
    assert.deepEqual(delivered, [r.id])
    assert.equal(r.status, 'working')
    assert.equal(r.consumed, true)
    assert.equal(hub.openWaits, 0)
    hub.close()
  })

  test('a request that arrives later goes to the open wait', () => {
    const s = session()
    const { hub } = hubFor(s)
    const a = sink()
    hub.wait(a.sink, 10_000)
    assert.equal(a.got.length, 0)
    const r = s.buildRequest('later')!
    hub.dispatch()
    assert.deepEqual(a.got.map((x) => x.id), [r.id])
    hub.close()
  })

  test('one request goes to one waiter only', () => {
    const s = session()
    const { hub } = hubFor(s)
    const a = sink()
    const b = sink()
    hub.wait(a.sink, 10_000)
    hub.wait(b.sink, 10_000)
    s.buildRequest('one')
    hub.dispatch()
    hub.dispatch()
    assert.equal(a.got.length + b.got.length, 1)
    assert.equal(hub.openWaits, 1)
    hub.close()
  })

  test('FIFO: oldest request first, to the oldest wait', () => {
    const s = session()
    const r1 = s.buildRequest('first')!
    const r2 = s.buildRequest('second')!
    const { hub } = hubFor(s)
    const a = sink()
    const b = sink()
    hub.wait(a.sink, 10_000)
    hub.wait(b.sink, 10_000)
    assert.deepEqual(a.got.map((x) => x.id), [r1.id])
    assert.deepEqual(b.got.map((x) => x.id), [r2.id])
    hub.close()
  })

  test('while a response is being written the request is not handed to anyone else', () => {
    const s = session()
    const r = s.buildRequest('x')!
    const { hub, delivered } = hubFor(s)
    const a = sink('manual')
    const b = sink()
    hub.wait(a.sink, 10_000)
    hub.wait(b.sink, 10_000)
    assert.equal(b.got.length, 0)
    assert.equal(r.status, 'queued', 'not working before the write finished')
    a.finish(true)
    assert.deepEqual(delivered, [r.id])
    assert.equal(r.status, 'working')
    assert.equal(b.got.length, 0)
    hub.close()
  })

  test('a write that fails releases the request to the next waiter; nothing is consumed by the dead one', () => {
    const s = session()
    const r = s.buildRequest('x')!
    const { hub, delivered } = hubFor(s)
    const dead = sink('gone')
    hub.wait(dead.sink, 10_000)
    assert.equal(r.consumed, false)
    assert.equal(r.status, 'queued')
    assert.deepEqual(delivered, [])
    const next = sink()
    hub.wait(next.sink, 10_000)
    assert.deepEqual(next.got.map((x) => x.id), [r.id])
    assert.deepEqual(delivered, [r.id])
    hub.close()
  })

  test('a duplicate written() call is ignored', () => {
    const s = session()
    s.buildRequest('x')
    const { hub, delivered } = hubFor(s)
    const a = sink('manual')
    hub.wait(a.sink, 10_000)
    a.finish(true)
    a.finish(false)
    a.finish(true)
    assert.equal(delivered.length, 1)
    hub.close()
  })
})

describe('WaitHub: disconnect and timeout', () => {
  test('cancel (client hung up) removes the wait and consumes nothing', () => {
    const s = session()
    const { hub } = hubFor(s)
    const a = sink()
    const cancel = hub.wait(a.sink, 10_000)
    cancel()
    assert.equal(hub.openWaits, 0)
    const r = s.buildRequest('after')!
    hub.dispatch()
    assert.equal(a.got.length, 0)
    assert.equal(r.status, 'queued')
    assert.equal(r.consumed, false)
    // A second cancel is harmless.
    cancel()
    hub.close()
  })

  test('timeout ends the wait with timeout() and frees it', async () => {
    const s = session()
    const { hub } = hubFor(s)
    const a = sink()
    hub.wait(a.sink, 20)
    await sleep(60)
    assert.equal(a.timeouts, 1)
    assert.equal(hub.openWaits, 0)
    const r = s.buildRequest('late')!
    hub.dispatch()
    assert.equal(a.got.length, 0)
    assert.equal(r.status, 'queued')
    hub.close()
  })

  test('a delivered wait never times out afterwards', async () => {
    const s = session()
    s.buildRequest('x')
    const { hub } = hubFor(s)
    const a = sink()
    hub.wait(a.sink, 20)
    await sleep(60)
    assert.equal(a.got.length, 1)
    assert.equal(a.timeouts, 0)
    hub.close()
  })
})

describe('WaitHub: listening flag', () => {
  test('true while a wait is open, still true within the grace period, false after it', async () => {
    const s = session()
    const { hub, listening } = hubFor(s, 40)
    assert.equal(hub.listening, false)
    const cancel = hub.wait(sink().sink, 10_000)
    assert.equal(hub.listening, true)
    assert.deepEqual(listening, [true])
    cancel()
    assert.equal(hub.listening, true, 'an agent between two calls still counts as listening')
    await sleep(100)
    assert.equal(hub.listening, false)
    assert.deepEqual(listening, [true, false])
    hub.close()
  })

  test('a new wait within the grace period does not flicker the flag', async () => {
    const s = session()
    const { hub, listening } = hubFor(s, 60)
    const c1 = hub.wait(sink().sink, 10_000)
    c1()
    await sleep(10)
    const c2 = hub.wait(sink().sink, 10_000)
    await sleep(80)
    assert.deepEqual(listening, [true])
    c2()
    hub.close()
  })

  test('the agent working on a delivered request counts as listening for the grace period', () => {
    const s = session()
    s.buildRequest('x')
    const { hub } = hubFor(s, 10_000)
    hub.wait(sink().sink, 10_000)
    assert.equal(hub.openWaits, 0)
    assert.equal(hub.listening, true)
    hub.close()
  })
})

describe('WaitHub: an agent working on a handed-out request counts as listening', () => {
  test('past the grace period while the request is working; the reply ends it', async () => {
    const s = session()
    const r = s.buildRequest('x')!
    const { hub, listening } = hubFor(s, 30)
    hub.wait(sink().sink, 10_000)
    await sleep(80)
    assert.equal(r.status, 'working')
    assert.equal(hub.listening, true, 'still busy with the request')
    assert.deepEqual(listening, [true])
    s.addReply('done', 'assistant', r.id)
    hub.refresh()
    // The reply ended work; the grace period of the last wait has long passed.
    assert.equal(hub.listening, false)
    assert.deepEqual(listening, [true, false])
    hub.close()
  })

  test('an error reply ends it too, and so does clearing the queue', () => {
    for (const end of ['error', 'clear'] as const) {
      const s = session()
      const r = s.buildRequest('x')!
      const { hub, listening } = hubFor(s, 0)
      hub.wait(sink().sink, 10_000)
      assert.equal(hub.listening, true)
      if (end === 'error') s.addReply('could not', 'assistant', r.id, 'error')
      else s.clearRequests()
      hub.refresh()
      assert.equal(hub.listening, false, end)
      assert.deepEqual(listening, [true, false], end)
      hub.close()
    }
  })

  test('a long silence does not requeue the request: it stays working, no other wait gets it', async () => {
    const s = session()
    const r = s.buildRequest('x')!
    const { hub } = hubFor(s, 10)
    hub.wait(sink().sink, 10_000)
    await sleep(50)
    const next = sink()
    hub.wait(next.sink, 20)
    await sleep(60)
    assert.equal(next.got.length, 0)
    assert.equal(next.timeouts, 1)
    assert.equal(r.status, 'working')
    assert.equal(hub.listening, true)
    hub.close()
  })

  test('a request read through pending_requests (not via a wait) does not keep the flag on', async () => {
    const s = session()
    const r = s.buildRequest('x')!
    const { hub } = hubFor(s, 10)
    s.markConsumed([r.id])
    const cancel = hub.wait(sink().sink, 10_000)
    cancel()
    await sleep(40)
    assert.equal(r.status, 'working')
    assert.equal(hub.listening, false)
    hub.close()
  })
})

describe('WaitHub: a reply within the grace period', () => {
  test('after the grace period ends, stopped-listening is announced; the next wait announces listening again', async () => {
    const s = session()
    const r = s.buildRequest('x')!
    const { hub, listening } = hubFor(s, 40)
    hub.wait(sink().sink, 10_000)
    assert.deepEqual(listening, [true])
    // The agent answers well inside the grace period of its last wait.
    s.addReply('done', 'assistant', r.id)
    hub.refresh()
    assert.equal(hub.listening, true, 'still within the grace period')
    await sleep(120)
    assert.equal(hub.listening, false)
    assert.deepEqual(listening, [true, false], 'the flip to false is announced, not silent')
    const cancel = hub.wait(sink().sink, 10_000)
    assert.deepEqual(listening, [true, false, true])
    cancel()
    hub.close()
  })
})

describe('WaitHub: the working hold is bounded', () => {
  test('an agent that never replies stops counting as listening after the hold; the request stays working', async () => {
    const s = session()
    const r = s.buildRequest('x')!
    const { hub, listening } = hubFor(s, 10, 60)
    hub.wait(sink().sink, 10_000)
    await sleep(30)
    assert.equal(hub.listening, true, 'past the grace, inside the hold')
    await sleep(80)
    assert.equal(hub.listening, false)
    assert.deepEqual(listening, [true, false], 'the end of the hold is announced')
    assert.equal(r.status, 'working', 'the request is not requeued or closed')
    assert.deepEqual(s.undelivered(), [])
    // A later wait announces listening again and does not get the stale request.
    const next = sink()
    const cancel = hub.wait(next.sink, 10_000)
    assert.deepEqual(listening, [true, false, true])
    assert.equal(next.got.length, 0)
    cancel()
    hub.close()
  })

  test('the hold counts from the hand-out, not from later waits', async () => {
    const s = session()
    s.buildRequest('x')
    const { hub } = hubFor(s, 10, 60)
    hub.wait(sink().sink, 10_000)
    await sleep(40)
    const cancel = hub.wait(sink().sink, 10_000)
    cancel()
    await sleep(50)
    // 90 ms since the hand-out, 50 ms since the last wait: grace over, hold over.
    assert.equal(hub.listening, false)
    hub.close()
  })
})
