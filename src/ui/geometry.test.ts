import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { placeHeldPopover, placePopover, streamPlacement } from './geometry.ts'

describe('streamPlacement: the live video over the tree', () => {
  const viewport = { w: 1080, h: 2424 }

  test('a downscaled video of the same screen (scrcpy 854×1920 for 1080×2424) covers the viewport exactly', () => {
    assert.deepEqual(streamPlacement({ w: 854, h: 1920 }, viewport), { rect: { x: 0, y: 0, w: 1080, h: 2424 }, fit: 'aligned' })
    assert.equal(streamPlacement({ w: 1080, h: 2424 }, viewport)?.fit, 'aligned')
  })

  test('the device turned: the video is drawn whole and centred, and said to be rotated', () => {
    const p = streamPlacement({ w: 1920, h: 854 }, viewport)!
    assert.equal(p.fit, 'rotated')
    assert.equal(p.rect.w, 1080)
    assert.ok(Math.abs(p.rect.h - (1080 * 854) / 1920) < 1e-9)
    assert.ok(Math.abs(p.rect.y - (2424 - p.rect.h) / 2) < 1e-9)
    assert.equal(p.rect.x, 0)
  })

  test('another shape (app in split screen): centred, a mismatch', () => {
    const p = streamPlacement({ w: 1080, h: 1080 }, viewport)!
    assert.equal(p.fit, 'mismatch')
    assert.deepEqual(p.rect, { x: 0, y: (2424 - 1080) / 2, w: 1080, h: 1080 })
  })

  test('empty sizes: nothing to place', () => {
    assert.equal(streamPlacement({ w: 0, h: 1920 }, viewport), null)
    assert.equal(streamPlacement({ w: 854, h: 1920 }, { w: 0, h: 0 }), null)
  })
})

// The release recording: 1280×720 window, a 520 px card low in the frame. Neither side has
// room for the 360 px chat, below is too short, so it opens above — and used to jump to the
// top-right corner the moment a new line made it taller than the room above.
describe('placeHeldPopover (M = 12, G = 12)', () => {
  const canvas = { w: 1280, h: 672 }
  const low = { x: 380, y: 404, w: 521, h: 120 } // card box joined with its label
  const chat = (h: number) => ({ w: 360, h })

  test('opens where placePopover puts it, with the room of that side as the cap', () => {
    const p = placeHeldPopover(low, chat(300), canvas, null)
    const plain = placePopover(low, chat(300), canvas)
    assert.deepEqual({ x: p.x, y: p.y, side: p.side }, plain)
    assert.equal(p.side, 'top')
    assert.equal(p.maxH, 404 - 12 - 12)
  })

  test('a held top side survives growth: the card stays above the element and is capped to the room', () => {
    const opened = placeHeldPopover(low, chat(300), canvas, null)
    const grown = placeHeldPopover(low, chat(470), canvas, opened.side)
    assert.equal(grown.side, 'top')
    assert.equal(grown.x, opened.x)
    assert.equal(grown.maxH, 380)
    assert.equal(grown.y, 12)
    assert.ok(grown.y + Math.min(470, grown.maxH) <= low.y - 12, 'the card ends above the element')
  })

  test('a held bottom side survives growth and is capped to the room below', () => {
    const high = { x: 380, y: 60, w: 521, h: 100 }
    const opened = placeHeldPopover(high, chat(300), canvas, null)
    assert.equal(opened.side, 'bottom')
    const grown = placeHeldPopover(high, chat(560), canvas, 'bottom')
    assert.equal(grown.side, 'bottom')
    assert.equal(grown.y, 172)
    assert.equal(grown.maxH, 672 - 12 - 172)
  })

  test('a held right side survives growth: still right, lifted to fit', () => {
    const small = { x: 100, y: 500, w: 100, h: 40 }
    const opened = placeHeldPopover(small, chat(150), canvas, null)
    assert.equal(opened.side, 'right')
    assert.equal(opened.y, 500)
    const grown = placeHeldPopover(small, chat(450), canvas, 'right')
    assert.deepEqual({ x: grown.x, y: grown.y, side: grown.side }, { x: 212, y: 672 - 450 - 12, side: 'right' })
  })

  test('a held side that has no room any more is dropped for a fresh placement', () => {
    // The window got narrower: the right side no longer fits the card at all.
    const small = { x: 100, y: 100, w: 100, h: 40 }
    const p = placeHeldPopover(small, chat(200), { w: 500, h: 672 }, 'right')
    assert.deepEqual({ x: p.x, y: p.y, side: p.side }, placePopover(small, chat(200), { w: 500, h: 672 }))
    // The element moved down to the bottom edge: above is the only room left, below is gone.
    const atEdge = { x: 380, y: 620, w: 521, h: 40 }
    const q = placeHeldPopover(atEdge, chat(200), canvas, 'bottom')
    assert.equal(q.side, 'top')
  })

  test('a held top side with less than a usable strip of room is dropped too', () => {
    const nearTop = { x: 380, y: 120, w: 521, h: 400 }
    const p = placeHeldPopover(nearTop, chat(300), canvas, 'top')
    assert.notEqual(p.side, 'top')
  })
})
