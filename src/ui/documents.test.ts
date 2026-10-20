import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { frameLoaded, NO_DOCS, snapshotDoc, type FrameDocs } from './documents.ts'

function run(events: Array<string | 'load'>): Array<string> {
  let docs: FrameDocs = NO_DOCS
  const out: string[] = []
  for (const e of events) {
    if (e === 'load') {
      const r = frameLoaded(docs)
      docs = r.docs
      out.push(r.reset ? 'load:reset' : 'load:keep')
    } else {
      const r = snapshotDoc(docs, e)
      docs = r.docs
      out.push(`${e}:${r.verdict}`)
    }
  }
  return out
}

describe('which document a snapshot belongs to', () => {
  test('load first, then the new document reports: reset at load, the new one is new', () => {
    assert.deepEqual(run(['A', 'load', 'B']), ['A:same', 'load:keep', 'B:new'])
    assert.deepEqual(run(['load', 'A', 'load', 'B']), ['load:reset', 'A:same', 'load:reset', 'B:new'])
  })
  test('the new document reports before its load: it is a new page at once, and its load resets nothing', () => {
    assert.deepEqual(run(['load', 'A', 'B', 'load', 'B']), ['load:reset', 'A:same', 'B:new', 'load:keep', 'B:same'])
  })
  test('a late snapshot of the replaced document is dropped', () => {
    assert.deepEqual(run(['load', 'A', 'load', 'A', 'B']), ['load:reset', 'A:same', 'load:reset', 'A:stale', 'B:new'])
  })
  test('orders mixed over several reloads', () => {
    assert.deepEqual(run(['A', 'load', 'load', 'B', 'C', 'load']), ['A:same', 'load:keep', 'load:reset', 'B:new', 'C:new', 'load:keep'])
  })
  test('an inspector without docId: every snapshot is the same document', () => {
    let docs = NO_DOCS
    const r = snapshotDoc(docs, undefined)
    docs = r.docs
    assert.equal(r.verdict, 'same')
    assert.equal(frameLoaded(docs).reset, true)
  })
})
