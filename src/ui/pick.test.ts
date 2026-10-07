import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  accumulateWheel,
  chainOf,
  cornersFor,
  decidePick,
  escapeStep,
  handleOrigin,
  inheritedShifts,
  isLargeLayer,
  isOffscreen,
  nudgeOverride,
  resizeFromCorner,
  wheelStep,
  WHEEL_IDLE_MS,
} from './pick.ts'
import { frameCropRect, placeLabel } from './geometry.ts'

// root > card > row > button
const parents: Record<string, string | null> = { root: null, card: 'root', row: 'card', button: 'row' }
const parentOf = (id: string) => parents[id] ?? null
const chain = ['button', 'row', 'card', 'root']

describe('chainOf', () => {
  it('walks from the node to the root', () => {
    assert.deepEqual(chainOf('button', parentOf), chain)
    assert.deepEqual(chainOf('root', parentOf), ['root'])
  })
  it('stops on a cycle instead of hanging', () => {
    const loop: Record<string, string> = { a: 'b', b: 'a' }
    assert.deepEqual(chainOf('a', (id) => loop[id]), ['a', 'b'])
  })
})

describe('decidePick', () => {
  const base = { point: { x: 100, y: 100 }, chain, level: 0, parentOf }

  it('selects the tightest layer on a first pick', () => {
    assert.deepEqual(decidePick({ ...base, prev: null, selectedId: null }), { kind: 'select', id: 'button' })
  })

  it('selects the layer the wheel raised the hover to', () => {
    assert.deepEqual(decidePick({ ...base, prev: null, selectedId: null, level: 2 }), { kind: 'select', id: 'card' })
    assert.deepEqual(decidePick({ ...base, prev: null, selectedId: null, level: 99 }), { kind: 'select', id: 'root' })
  })

  it('climbs to the parent of the selection on a repeat within 4 px', () => {
    const r = decidePick({ ...base, point: { x: 103, y: 100 }, prev: { x: 100, y: 100 }, selectedId: 'button' })
    assert.deepEqual(r, { kind: 'select', id: 'row' })
    // Exactly 4 px still counts; the diagonal is measured as a distance.
    assert.deepEqual(decidePick({ ...base, point: { x: 104, y: 100 }, prev: { x: 100, y: 100 }, selectedId: 'row' }), { kind: 'select', id: 'card' })
  })

  it('does not climb when the pick moved further than 4 px', () => {
    const r = decidePick({ ...base, point: { x: 103, y: 103 }, prev: { x: 100, y: 100 }, selectedId: 'row' })
    assert.deepEqual(r, { kind: 'select', id: 'button' })
  })

  it('reports the top instead of a silent no-op on the root', () => {
    assert.deepEqual(decidePick({ ...base, prev: { x: 100, y: 100 }, selectedId: 'root' }), { kind: 'top' })
  })

  it('needs a selection to climb, and a layer under the cursor otherwise', () => {
    assert.deepEqual(decidePick({ ...base, prev: { x: 100, y: 100 }, selectedId: null }), { kind: 'select', id: 'button' })
    assert.equal(decidePick({ ...base, chain: [], prev: null, selectedId: null }), null)
  })
})

describe('wheelStep', () => {
  it('moves the selection itself when it lies under the cursor', () => {
    assert.deepEqual(wheelStep({ chain, level: 0, selectedId: 'row', dir: 1 }), { level: 2, select: 'card', top: false })
    assert.deepEqual(wheelStep({ chain, level: 2, selectedId: 'card', dir: -1 }), { level: 1, select: 'row', top: false })
  })

  it('moves only the hover when the selection is elsewhere', () => {
    assert.deepEqual(wheelStep({ chain, level: 0, selectedId: 'other', dir: 1 }), { level: 1, top: false })
    assert.deepEqual(wheelStep({ chain, level: 1, selectedId: null, dir: -1 }), { level: 0, top: false })
  })

  it('stops at the tightest layer going down', () => {
    assert.deepEqual(wheelStep({ chain, level: 0, selectedId: null, dir: -1 }), { level: 0, top: false })
    assert.deepEqual(wheelStep({ chain, level: 0, selectedId: 'button', dir: -1 }), { level: 0, top: false })
  })

  it('reports the top going up from the root', () => {
    assert.deepEqual(wheelStep({ chain, level: 3, selectedId: null, dir: 1 }), { level: 3, top: true })
    assert.deepEqual(wheelStep({ chain, level: 0, selectedId: 'root', dir: 1 }), { level: 3, top: true })
  })
})

describe('accumulateWheel', () => {
  const zero = { acc: 0, at: 0 }

  it('makes one step per mouse notch, never two', () => {
    assert.equal(accumulateWheel(zero, -100, 10).steps, 1)
    assert.equal(accumulateWheel(zero, -300, 10).steps, 1)
    assert.equal(accumulateWheel(zero, 100, 10).steps, -1)
  })

  it('adds small trackpad deltas up to one step', () => {
    let s = zero
    const steps: number[] = []
    for (let i = 0; i < 6; i++) {
      const r = accumulateWheel(s, -10, 10 + i)
      s = r.state
      steps.push(r.steps)
    }
    assert.deepEqual(steps, [0, 0, 0, 0, 1, 0])
  })

  it('drops leftover distance after a pause', () => {
    const half = accumulateWheel(zero, -40, 10).state
    assert.equal(accumulateWheel(half, -40, 10 + WHEEL_IDLE_MS + 1).steps, 0)
    assert.equal(accumulateWheel(half, -40, 20).steps, 1)
  })
})

describe('isLargeLayer', () => {
  const frame = { w: 1000, h: 800 }
  it('is large from 60% of the visible frame', () => {
    assert.equal(isLargeLayer({ x: 0, y: 0, w: 1000, h: 480 }, frame), true)
    assert.equal(isLargeLayer({ x: 0, y: 0, w: 1000, h: 479 }, frame), false)
  })
  it('counts only the visible part: a tall body scrolled half away', () => {
    assert.equal(isLargeLayer({ x: 0, y: -2000, w: 1000, h: 2300 }, frame), false)
    assert.equal(isLargeLayer({ x: 0, y: -200, w: 1000, h: 5000 }, frame), true)
  })
  it('a card of ~19% is not large: it takes the mouse by its body', () => {
    assert.equal(isLargeLayer({ x: 460, y: 80, w: 520, h: 449 }, { w: 1440, h: 852 }), false)
  })
})

describe('isOffscreen', () => {
  it('is true only when nothing of the box is in the frame', () => {
    const frame = { w: 100, h: 100 }
    assert.equal(isOffscreen({ x: 0, y: -50, w: 10, h: 40 }, frame), true)
    assert.equal(isOffscreen({ x: 0, y: -50, w: 10, h: 60 }, frame), false)
    assert.equal(isOffscreen({ x: 0, y: 0, w: 0, h: 10 }, frame), false)
  })
})

describe('corner handles', () => {
  const frame = { w: 400, h: 300 }
  it('a box under 24 on any side gets the bottom-right handle only', () => {
    assert.deepEqual(cornersFor({ w: 8, h: 8 }), ['br'])
    assert.deepEqual(cornersFor({ w: 200, h: 20 }), ['br'])
    assert.deepEqual(cornersFor({ w: 24, h: 24 }), ['tl', 'tr', 'bl', 'br'])
  })
  it('centres a handle on its corner', () => {
    assert.deepEqual(handleOrigin('tl', { x: 100, y: 100, w: 50, h: 40 }, frame, false), { x: 88, y: 88 })
    assert.deepEqual(handleOrigin('br', { x: 100, y: 100, w: 50, h: 40 }, frame, false), { x: 138, y: 128 })
  })
  it('keeps a large layer handles inside the box and every handle inside the frame', () => {
    assert.deepEqual(handleOrigin('br', { x: 0, y: 0, w: 400, h: 300 }, frame, true), { x: 376, y: 276 })
    assert.deepEqual(handleOrigin('tl', { x: 0, y: 0, w: 400, h: 300 }, frame, true), { x: 0, y: 0 })
    // A corner right on the frame edge is pulled in; one past it gets no handle.
    assert.deepEqual(handleOrigin('br', { x: 240, y: 240, w: 160, h: 60 }, frame, false), { x: 376, y: 276 })
    assert.equal(handleOrigin('tr', { x: 390, y: -5, w: 50, h: 40 }, frame, false), null)
  })
  it('a layer scrolled out of the frame leaves no stray handle on its edge', () => {
    for (const c of ['tl', 'tr', 'bl', 'br'] as const) assert.equal(handleOrigin(c, { x: 100, y: -200, w: 80, h: 20 }, frame, false), null, c)
  })
})

describe('resizeFromCorner', () => {
  const base = { dx: 0, dy: 0, w: 100, h: 50 }
  it('bottom-right grows with the pointer, the element stays', () => {
    assert.deepEqual(resizeFromCorner('br', base, { x: 30, y: 10 }), { dx: 0, dy: 0, w: 130, h: 60 })
  })
  it('top-left keeps the far edge: the element shifts by what it grows', () => {
    assert.deepEqual(resizeFromCorner('tl', base, { x: -20, y: -10 }), { dx: -20, dy: -10, w: 120, h: 60 })
  })
  it('top-right and bottom-left mix the two', () => {
    assert.deepEqual(resizeFromCorner('tr', base, { x: 10, y: 5 }), { dx: 0, dy: 5, w: 110, h: 45 })
    assert.deepEqual(resizeFromCorner('bl', base, { x: 10, y: 5 }), { dx: 10, dy: 0, w: 90, h: 55 })
  })
  it('never drops below the minimum, and the far edge still holds', () => {
    assert.deepEqual(resizeFromCorner('br', base, { x: -500, y: -500 }), { dx: 0, dy: 0, w: 1, h: 1 })
    assert.deepEqual(resizeFromCorner('tl', base, { x: 500, y: 500 }), { dx: 99, dy: 49, w: 1, h: 1 })
  })
})

describe('nudgeOverride', () => {
  const rect = { w: 100, h: 40 }
  it('moves by one unit, eight with Shift, keeping the rest of the override', () => {
    assert.deepEqual(nudgeOverride('move', 'ArrowRight', false, 'n', undefined, rect, 1), { nodeId: 'n', dx: 1, dy: 0, width: undefined, height: undefined, hidden: undefined })
    const prev = { nodeId: 'n', dx: 3, dy: 4, width: 120, hidden: true }
    assert.deepEqual(nudgeOverride('move', 'ArrowUp', true, 'n', prev, rect, 1), { nodeId: 'n', dx: 3, dy: -4, width: 120, height: undefined, hidden: true })
  })
  it('a unit is dp on Android: frame px times the density', () => {
    assert.equal(nudgeOverride('move', 'ArrowLeft', false, 'n', undefined, rect, 2.75).dx, -3)
    assert.equal(nudgeOverride('move', 'ArrowDown', true, 'n', undefined, rect, 2.75).dy, 22)
  })
  it('resizes: ← narrower, → wider, ↑ shorter, ↓ taller, from the current size', () => {
    assert.equal(nudgeOverride('resize', 'ArrowLeft', false, 'n', undefined, rect, 1).width, 99)
    assert.equal(nudgeOverride('resize', 'ArrowRight', true, 'n', undefined, rect, 1).width, 108)
    assert.equal(nudgeOverride('resize', 'ArrowUp', false, 'n', undefined, rect, 1).height, 39)
    const r = nudgeOverride('resize', 'ArrowDown', false, 'n', { nodeId: 'n', dx: 5, dy: 0, width: 80 }, rect, 1)
    assert.deepEqual([r.dx, r.width, r.height], [5, 80, 41])
  })
  it('never sizes below one unit', () => {
    assert.equal(nudgeOverride('resize', 'ArrowLeft', true, 'n', undefined, { w: 3, h: 3 }, 1).width, 1)
    assert.equal(nudgeOverride('resize', 'ArrowUp', true, 'n', undefined, { w: 3, h: 3 }, 2).height, 2)
  })
})

describe('inheritedShifts', () => {
  // root > card > (row > button, title)
  const nodes = {
    root: { childIds: ['card'] },
    card: { childIds: ['row', 'title'] },
    row: { childIds: ['button'] },
    button: { childIds: [] },
    title: { childIds: [] },
  }
  const ov = (nodeId: string, dx: number, dy: number, extra: { width?: number; hidden?: boolean } = {}) => ({ nodeId, dx, dy, ...extra })

  it('carries every descendant of a moved node, not the node itself', () => {
    const s = inheritedShifts(nodes, { row: ov('row', 120, 30) })
    assert.deepEqual(s.get('button'), { x: 120, y: 30 })
    assert.equal(s.has('row'), false)
    assert.equal(s.has('title'), false)
    assert.equal(s.has('card'), false)
  })
  it('adds nested moves up', () => {
    const s = inheritedShifts(nodes, { card: ov('card', 10, 0), row: ov('row', 5, 7) })
    assert.deepEqual(s.get('row'), { x: 10, y: 0 })
    assert.deepEqual(s.get('button'), { x: 15, y: 7 })
    assert.deepEqual(s.get('title'), { x: 10, y: 0 })
  })
  it('ignores size-only and hide-only edits: they reflow, and the snapshot already shows that', () => {
    assert.equal(inheritedShifts(nodes, { card: ov('card', 0, 0, { width: 300, hidden: true }) }).size, 0)
  })
  it('survives an override for a node missing from the snapshot', () => {
    assert.equal(inheritedShifts(nodes, { gone: ov('gone', 4, 4) }).size, 0)
  })
})

describe('frameCropRect', () => {
  it('maps frame px to picture px when the picture is decoded at another size', () => {
    assert.deepEqual(frameCropRect({ x: 100, y: 200, w: 50, h: 40 }, { w: 540, h: 1200 }, { w: 1080, h: 2400 }), { x: 50, y: 100, w: 25, h: 20 })
    assert.deepEqual(frameCropRect({ x: 10, y: 20, w: 30, h: 40 }, { w: 1080, h: 2400 }, { w: 1080, h: 2400 }), { x: 10, y: 20, w: 30, h: 40 })
  })
  it('clips to the picture and gives up on a rect off it', () => {
    assert.deepEqual(frameCropRect({ x: -10, y: 2390, w: 40, h: 40 }, { w: 1080, h: 2400 }, { w: 1080, h: 2400 }), { x: 0, y: 2390, w: 30, h: 10 })
    assert.equal(frameCropRect({ x: 2000, y: 10, w: 40, h: 40 }, { w: 1080, h: 2400 }, { w: 1080, h: 2400 }), null)
    assert.equal(frameCropRect({ x: 10, y: 10, w: 40, h: 40 }, { w: 0, h: 0 }, { w: 1080, h: 2400 }), null)
  })
})

describe('escapeStep', () => {
  const none = { coach: false, chat: false, details: false, nudge: false, pipette: false, selected: false }
  it('closes chat → details → nudge → pipette → selection, one per press', () => {
    const all = { coach: false, chat: true, details: true, nudge: true, pipette: true, selected: true }
    assert.equal(escapeStep(all), 'chat')
    assert.equal(escapeStep({ ...all, chat: false }), 'details')
    assert.equal(escapeStep({ ...all, chat: false, details: false }), 'nudge')
    assert.equal(escapeStep({ ...all, chat: false, details: false, nudge: false }), 'pipette')
    assert.equal(escapeStep({ ...none, selected: true }), 'selection')
    assert.equal(escapeStep(none), null)
  })
  it('the first-run hint goes first', () => {
    assert.equal(escapeStep({ ...none, coach: true, selected: true }), 'coach')
  })
})

describe('placeLabel', () => {
  it('above the box when there is room, below near the top edge', () => {
    assert.equal(placeLabel({ x: 10, y: 40, w: 100, h: 40 }, 60, 1000).vertical, 'above')
    assert.equal(placeLabel({ x: 10, y: 10, w: 100, h: 40 }, 60, 1000).vertical, 'below')
  })
  it('inside a tall box at the top edge (body, Scaffold): below it would leave the frame', () => {
    assert.equal(placeLabel({ x: 0, y: 0, w: 1000, h: 500 }, 80, 1000, 24).vertical, 'inside')
    // A 24px label needs 30px of room above.
    assert.equal(placeLabel({ x: 0, y: 28, w: 100, h: 500 }, 80, 1000, 24).vertical, 'inside')
    assert.equal(placeLabel({ x: 0, y: 30, w: 100, h: 500 }, 80, 1000, 24).vertical, 'above')
  })
  it('aligns right past the right edge', () => {
    assert.equal(placeLabel({ x: 950, y: 40, w: 40, h: 20 }, 80, 1000).align, 'right')
  })
})
