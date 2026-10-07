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
