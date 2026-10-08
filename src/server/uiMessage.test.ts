import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseUiMessage } from './uiMessage.ts'

const override = { nodeId: 'n1', dx: 4, dy: -2 }
const snapshot = { id: 's', target: 'web', rootId: 'r', nodes: {}, pxPerUnit: 1, unit: 'css-px' }

describe('parseUiMessage: refuses frames handlers cannot use', () => {
  for (const raw of ['null', '5', '"submit"', '[]', 'true']) {
    test(`non-object JSON ${raw} is refused with a reason instead of throwing`, () => {
      const r = parseUiMessage(raw)
      assert.equal(r.ok, false)
      assert.match(!r.ok ? r.reason : '', /expected an object/)
    })
  }

  test('invalid JSON is refused', () => {
    const r = parseUiMessage('{nope')
    assert.deepEqual(r, { ok: false, reason: 'not valid JSON' })
  })

  test('submit without a string comment is refused, and reports its type', () => {
    const r = parseUiMessage('{"t":"submit"}')
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.t, 'submit')
    assert.match(!r.ok ? r.reason : '', /comment/)
  })

  test('unknown type is refused', () => {
    const r = parseUiMessage('{"t":"explode"}')
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.reason : '', /unknown message type "explode"/)
  })

  test('a frame with no t is refused', () => {
    assert.equal(parseUiMessage('{}').ok, false)
  })

  test('bad shapes for snapshot / select / overrides / androidOverride are refused', () => {
    assert.equal(parseUiMessage(JSON.stringify({ t: 'snapshot', snapshot: null })).ok, false)
    assert.equal(parseUiMessage(JSON.stringify({ t: 'snapshot', snapshot: { ...snapshot, nodes: null } })).ok, false)
    assert.equal(parseUiMessage(JSON.stringify({ t: 'select', nodeId: 5 })).ok, false)
    assert.equal(parseUiMessage(JSON.stringify({ t: 'overrides', overrides: {} })).ok, false)
    assert.equal(parseUiMessage(JSON.stringify({ t: 'overrides', overrides: [{ nodeId: 'n', dx: 'x', dy: 0 }] })).ok, false)
    assert.equal(parseUiMessage(JSON.stringify({ t: 'androidOverride', override: null })).ok, false)
  })
})

describe('parseUiMessage: snapshot nodes are checked deeply (MCP formatting must not throw on them)', () => {
  const good = {
    id: 'n1',
    parentId: null,
    childIds: [],
    depth: 0,
    kind: 'div',
    label: 'div',
    bounds: { x: 0, y: 0, w: 10, h: 10 },
    anchors: { path: 'div', className: 'a b' },
    styles: { display: 'flex' },
  }
  const withNode = (n: unknown) => JSON.stringify({ t: 'snapshot', snapshot: { ...snapshot, rootId: 'n1', nodes: { n1: n } } })

  test('a complete node passes', () => {
    assert.equal(parseUiMessage(withNode(good)).ok, true)
  })
  const broken: Array<[string, unknown, RegExp]> = [
    ['no anchors', { ...good, anchors: undefined }, /anchors is not an object/],
    ['anchors.path missing', { ...good, anchors: {} }, /anchors\.path is not a string/],
    ['className not a string', { ...good, anchors: { path: 'p', className: 5 } }, /anchors\.className is not a string/],
    ['bounds missing w', { ...good, bounds: { x: 0, y: 0, h: 1 } }, /bounds\.w is not a number/],
    ['childIds not strings', { ...good, childIds: [1] }, /childIds is not an array of strings/],
    ['styles with a number', { ...good, styles: { width: 10 } }, /styles is not an object of strings/],
    ['kind missing', { ...good, kind: undefined }, /kind is not a string/],
    ['node is null', null, /is not an object/],
  ]
  for (const [name, n, reason] of broken) {
    test(`${name} is refused with the field named`, () => {
      const r = parseUiMessage(withNode(n))
      assert.equal(r.ok, false)
      assert.match(!r.ok ? r.reason : '', reason)
    })
  }
  test('a bad unit or viewport is refused', () => {
    assert.equal(parseUiMessage(JSON.stringify({ t: 'snapshot', snapshot: { ...snapshot, unit: 'em' } })).ok, false)
    assert.equal(parseUiMessage(JSON.stringify({ t: 'snapshot', snapshot: { ...snapshot, viewport: { w: 'x' } } })).ok, false)
  })
})

describe('parseUiMessage: accepts every valid frame', () => {
  const valid = [
    { t: 'locale', locale: 'ru' },
    { t: 'snapshot', snapshot },
    { t: 'select', nodeId: 'n1' },
    { t: 'select', nodeId: null },
    { t: 'overrides', overrides: [override, { ...override, width: 10, height: 20, hidden: true }] },
    { t: 'submit', comment: 'wider' },
    { t: 'clearRequests' },
    { t: 'androidCapture' },
    { t: 'androidOverride', override },
    { t: 'androidClearOverrides' },
  ]
  for (const msg of valid) {
    test(`${msg.t} ${JSON.stringify(msg).slice(0, 60)}`, () => {
      assert.deepEqual(parseUiMessage(JSON.stringify(msg)), { ok: true, msg })
    })
  }
})
