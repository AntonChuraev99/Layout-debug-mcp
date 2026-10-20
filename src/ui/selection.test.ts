import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { LayoutNode, Snapshot } from '../shared/protocol.ts'
import { findNode } from './thread.ts'
import { elementKey, findIndexed, indexByPath, resolveSelected } from './selection.ts'

describe('elementKey', () => {
  test('the same element under a new id keeps its key; another element gets another one', () => {
    assert.equal(elementKey(node('n1', 'root > b')), elementKey(node('n8', 'root > b')))
    assert.notEqual(elementKey(node('n1', 'root > a')), elementKey(node('n1', 'root > b')))
    const at = (loc: string) => ({ anchors: { path: 'root > b', sourceLoc: loc } })
    assert.notEqual(elementKey(at('A.kt:1')), elementKey(at('A.kt:2')))
  })
})

const node = (id: string, path: string): LayoutNode => ({
  id,
  parentId: null,
  childIds: [],
  depth: 0,
  kind: 'Button',
  label: path,
  bounds: { x: 0, y: 0, w: 10, h: 10 },
  anchors: { path },
  styles: {},
})

const snap = (...nodes: LayoutNode[]): Snapshot => ({
  id: 'snap',
  target: 'android',
  createdAt: 0,
  unit: 'dp',
  pxPerUnit: 1,
  viewport: { w: 100, h: 100 },
  rootId: nodes[0]!.id,
  nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
})

describe('resolveSelected', () => {
  test('a fresh pick is read by id', () => {
    const s = snap(node('a', 'root > a'), node('b', 'root > b'))
    assert.equal(resolveSelected(s, 'b', { id: 'a', anchors: { path: 'root > a' } })?.id, 'b')
    assert.equal(resolveSelected(s, 'b', null)?.id, 'b')
  })

  test('a recapture renamed every id: the selection follows its anchors in the same render', () => {
    // Android: the device sends a new tree every ~0.8 s and the ids change with it.
    const next = snap(node('n7', 'root > a'), node('n8', 'root > b'))
    assert.equal(resolveSelected(next, 'n2', { id: 'n2', anchors: { path: 'root > b' } })?.id, 'n8')
  })

  test('an old id reused by another element does not keep the selection on it', () => {
    const next = snap(node('n2', 'root > a'), node('n9', 'root > b'))
    assert.equal(resolveSelected(next, 'n2', { id: 'n2', anchors: { path: 'root > b' } })?.id, 'n9')
  })

  test('with an index of the snapshot it gives the same answers', () => {
    const next = snap(node('n2', 'root > a'), node('n9', 'root > b'))
    const index = indexByPath(next)
    assert.equal(resolveSelected(next, 'n2', { id: 'n2', anchors: { path: 'root > b' } }, index)?.id, 'n9')
    assert.equal(resolveSelected(next, 'n2', { id: 'n2', anchors: { path: 'root > c' } }, index), undefined)
  })

  test('an element that is gone resolves to nothing', () => {
    const next = snap(node('n1', 'root > a'))
    assert.equal(resolveSelected(next, 'n2', { id: 'n2', anchors: { path: 'root > b' } }), undefined)
    assert.equal(resolveSelected(null, 'n2', null), undefined)
    assert.equal(resolveSelected(next, null, null), undefined)
  })
})

describe('findIndexed', () => {
  const at = (id: string, path: string, sourceLoc?: string): LayoutNode => ({ ...node(id, path), anchors: { path, sourceLoc } })
  const s = snap(at('r', 'root'), at('a1', 'root > a', 'A.kt:1'), at('a2', 'root > a', 'A.kt:2'), at('a3', 'root > a'), at('b', 'root > b'))
  const index = indexByPath(s)
  const cases: Array<[string, { id: string; anchors: LayoutNode['anchors'] }]> = [
    ['by id', { id: 'b', anchors: { path: 'root > b' } }],
    ['id reused by another element', { id: 'b', anchors: { path: 'root > a', sourceLoc: 'A.kt:2' } }],
    ['source location picks among same paths', { id: 'x', anchors: { path: 'root > a', sourceLoc: 'A.kt:2' } }],
    ['no source location: first of the path, as findNode', { id: 'x', anchors: { path: 'root > a' } }],
    ['unknown source location falls to the node without one', { id: 'x', anchors: { path: 'root > a', sourceLoc: 'A.kt:9' } }],
    ['gone', { id: 'x', anchors: { path: 'root > z' } }],
  ]
  for (const [name, target] of cases) {
    test(`same node as findNode: ${name}`, () => {
      assert.equal(findIndexed(index, target)?.id, findNode(s, target)?.id)
    })
  }
})
