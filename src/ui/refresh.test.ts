import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { EditRequest, LayoutNode, Snapshot } from '../shared/protocol.ts'
import { decideRefresh, overridesHandedOver, reapplyPlan, snapshotFingerprint } from './refresh.ts'

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
