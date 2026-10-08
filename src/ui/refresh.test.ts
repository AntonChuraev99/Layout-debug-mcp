import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { EditRequest, LayoutNode, Snapshot } from '../shared/protocol.ts'
import { decideRefresh, frameStack, overlaySource, overridesHandedOver, reapplyPlan, showsConnecting, snapshotFingerprint } from './refresh.ts'

describe('frameStack', () => {
  test('one frame when nothing is held', () => {
    assert.deepEqual(frameStack(3, null), [{ key: 3, held: false }])
  })
  test('the new frame first, the old page held after it (it covers the new one without a z-index)', () => {
    assert.deepEqual(frameStack(4, 3), [
      { key: 4, held: false },
      { key: 3, held: true },
    ])
  })
  test('the same key is never rendered twice', () => {
    assert.deepEqual(frameStack(4, 4), [{ key: 4, held: false }])
  })
})

describe('overlaySource: what the overlay draws while the old page is held over the reloaded one', () => {
  const oldSnap = { id: 'old', createdAt: 1000 }
  const newSnap = { id: 'new', createdAt: 2600 }
  const dragged: Record<string, { nodeId: string; dx: number; dy: number }> = { n1: { nodeId: 'n1', dx: 0, dy: 140 } }
  const held = (loadedAt: number | null) => ({ snapshot: oldSnap, overrides: dragged, loadedAt })

  test('nothing held: the live snapshot and live edits', () => {
    assert.deepEqual(overlaySource(null, { snapshot: newSnap, overrides: {} }), { snapshot: newSnap, overrides: {}, holding: false })
  })
  test('new frame still loading: the old page with its live edits, although the live state still has the old snapshot', () => {
    assert.deepEqual(overlaySource(held(null), { snapshot: oldSnap, overrides: dragged }), { snapshot: oldSnap, overrides: dragged, holding: true })
  })
  test('new frame loaded, its snapshot not in yet: still the old page WITH the drag (the reload cleared the live edits)', () => {
    const v = overlaySource(held(2500), { snapshot: null, overrides: {} })
    assert.equal(v.holding, true)
    assert.equal(v.snapshot, oldSnap)
    assert.deepEqual(v.overrides, dragged)
  })
  test('a snapshot older than the load is the page that went away: still held', () => {
    const v = overlaySource(held(2500), { snapshot: oldSnap, overrides: {} })
    assert.equal(v.holding, true)
    assert.deepEqual(v.overrides, dragged)
  })
  test('the new page reported in: its boxes and the end of the hold come together', () => {
    assert.deepEqual(overlaySource(held(2500), { snapshot: newSnap, overrides: {} }), { snapshot: newSnap, overrides: {}, holding: false })
  })
})

describe('showsConnecting', () => {
  const base = { url: 'http://localhost:5173', connected: false, silent: false, swapping: false }
  test('a page without a live inspector yet: connecting', () => {
    assert.equal(showsConnecting(base), true)
  })
  test('a refresh the window started itself: the old page is on screen, nothing to announce', () => {
    assert.equal(showsConnecting({ ...base, swapping: true }), false)
  })
  test('connected, silent, or no page at all: not connecting', () => {
    assert.equal(showsConnecting({ ...base, connected: true }), false)
    assert.equal(showsConnecting({ ...base, silent: true }), false)
    assert.equal(showsConnecting({ ...base, url: '' }), false)
  })
})

function n(id: string, path: string, extra: Partial<LayoutNode> = {}): LayoutNode {
  return {
    id,
    parentId: id === 'root' ? null : 'root',
    childIds: [],
    depth: id === 'root' ? 0 : 1,
    kind: 'div',
    label: path,
    bounds: { x: 0, y: 0, w: 10, h: 10 },
    anchors: { path },
    styles: { backgroundColor: 'rgb(34, 197, 94)' },
    ...extra,
  }
}

function snap(nodes: LayoutNode[], id = 'snap-1'): Snapshot {
  const root = nodes.find((x) => x.id === 'root')!
  root.childIds = nodes.filter((x) => x.id !== 'root').map((x) => x.id)
  return {
    id,
    target: 'web',
    createdAt: Date.now(),
    unit: 'css-px',
    pxPerUnit: 1,
    viewport: { w: 100, h: 100 },
    rootId: 'root',
    nodes: Object.fromEntries(nodes.map((x) => [x.id, x])),
  }
}

const page = (avatarBg = 'rgb(34, 197, 94)', scroll = 0, idPrefix = 'n') =>
  snap(
    [
      n('root', 'body', { bounds: { x: 0, y: -scroll, w: 100, h: 400 } }),
      n(`${idPrefix}1`, 'body > div.avatar', { bounds: { x: 4, y: 4 - scroll, w: 44, h: 44 }, styles: { backgroundColor: avatarBg } }),
    ],
    `snap-${Math.random()}`,
  )

describe('snapshotFingerprint', () => {
  test('a recapture of the same page matches, whatever the ids and snapshot id', () => {
    assert.equal(snapshotFingerprint(page()), snapshotFingerprint(page(undefined, 0, 'x')))
  })
  test('scrolling the document is not a change', () => {
    assert.equal(snapshotFingerprint(page()), snapshotFingerprint(page(undefined, 120)))
  })
  test('a new background color is a change', () => {
    assert.notEqual(snapshotFingerprint(page()), snapshotFingerprint(page('rgb(249, 115, 22)')))
  })
  test('no snapshot has no fingerprint', () => {
    assert.equal(snapshotFingerprint(null), null)
  })
})

describe('decideRefresh', () => {
  const before = snapshotFingerprint(page())
  test('web, the page changed during the grace period (HMR) → keep', () => {
    assert.equal(decideRefresh('web', before, snapshotFingerprint(page('rgb(249, 115, 22)'))), 'keep')
  })
  test('web, nothing changed (static page, no HMR) → reload the frame', () => {
    assert.equal(decideRefresh('web', before, snapshotFingerprint(page(undefined, 0, 'x'))), 'reload-frame')
  })
  test('web, no snapshot on either side → reload the frame', () => {
    assert.equal(decideRefresh('web', null, before), 'reload-frame')
    assert.equal(decideRefresh('web', before, null), 'reload-frame')
  })
  test('android → capture the device, even if the tree changed', () => {
    assert.equal(decideRefresh('android', before, snapshotFingerprint(page('rgb(249, 115, 22)'))), 'capture-device')
    assert.equal(decideRefresh('android', before, before), 'capture-device')
  })
})

describe('overridesHandedOver', () => {
  const live = { n1: { nodeId: 'n1', dx: 8, dy: 0 }, n2: { nodeId: 'n2', dx: 0, dy: 4 } }
  const req = (nodeId: string, sent: string[]) =>
    ({ node: { id: nodeId }, overrides: sent.map((id) => ({ nodeId: id, dx: 1, dy: 1 })) }) as unknown as EditRequest
  test("only the requested element's own edit; other edits of the page stay with the user", () => {
    assert.deepEqual([...overridesHandedOver(live, [req('n1', ['n1', 'n2'])])], ['n1'])
  })
  test('the element had no edit when the request went out → nothing to drop', () => {
    assert.deepEqual([...overridesHandedOver(live, [req('n1', ['n2'])])], [])
  })
  test('the edit is no longer live (reset by the user) → nothing to drop', () => {
    assert.deepEqual([...overridesHandedOver({ n2: live.n2 }, [req('n1', ['n1'])])], [])
  })
})

describe('reapplyPlan', () => {
  test('re-addresses an edit to the reloaded node by anchor; counts the lost one', () => {
    const after = page(undefined, 0, 'fresh')
    const plan = reapplyPlan(
      [
        { override: { nodeId: 'n1', dx: 0, dy: 12 }, anchors: { path: 'body > div.avatar' } },
        { override: { nodeId: 'n7', dx: 3, dy: 0 }, anchors: { path: 'body > div.removed' } },
      ],
      after,
    )
    assert.deepEqual(plan.apply, [{ nodeId: 'fresh1', dx: 0, dy: 12 }])
    assert.equal(plan.lost, 1)
  })
})
