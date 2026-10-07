import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ghostInset } from './ghost.ts'

const open = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity }
const box = { x: 100, y: 200, w: 80, h: 40 }

describe('ghostInset', () => {
  it('cuts nothing when no container clips', () => {
    assert.deepEqual(ghostInset(box, open), { top: 0, right: 0, bottom: 0, left: 0 })
  })
  it('cuts the part outside the container, per side', () => {
    // Container shows y 220..400 and x 0..150: the top 20 px and the right 30 px go.
    assert.deepEqual(ghostInset(box, { left: 0, top: 220, right: 150, bottom: 400 }), { top: 20, right: 30, bottom: 0, left: 0 })
    assert.deepEqual(ghostInset(box, { left: 120, top: -Infinity, right: Infinity, bottom: 230 }), { top: 0, right: 0, bottom: 10, left: 20 })
  })
  it('hides the ghost once its place is scrolled out of the container', () => {
    assert.equal(ghostInset(box, { left: 0, top: 300, right: 1000, bottom: 600 }), null)
    assert.equal(ghostInset(box, { left: 0, top: 0, right: 1000, bottom: 200 }), null)
    assert.equal(ghostInset(box, { left: 180, top: 0, right: 1000, bottom: 1000 }), null)
  })
  it('hides a box with no size', () => {
    assert.equal(ghostInset({ x: 0, y: 0, w: 0, h: 10 }, open), null)
  })
})
