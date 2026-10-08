import assert from 'node:assert/strict'
import { test } from 'node:test'
import { staleServerAction } from './launch.ts'

const h = (version: string, windows: number, listening: boolean) => ({ version, windows, listening })

test('staleServerAction: the same version is used as it is', () => {
  assert.equal(staleServerAction(h('0.2.0', 0, false), '0.2.0', false), 'use')
  assert.equal(staleServerAction(h('0.2.0', 3, true), '0.2.0', false), 'use')
})

test('staleServerAction: another version is replaced only when nobody uses it', () => {
  assert.equal(staleServerAction(h('0.1.9', 0, false), '0.2.0', false), 'replace')
})

test('staleServerAction: an agent listening on it keeps it, even with no window (its wait and queue would be lost)', () => {
  assert.equal(staleServerAction(h('0.1.9', 0, true), '0.2.0', false), 'keep')
})

test('staleServerAction: a connected window or an external server keeps it', () => {
  assert.equal(staleServerAction(h('0.1.9', 1, false), '0.2.0', false), 'keep')
  assert.equal(staleServerAction(h('0.1.9', 0, false), '0.2.0', true), 'keep')
})
