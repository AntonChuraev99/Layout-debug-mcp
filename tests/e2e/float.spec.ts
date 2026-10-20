import type { Locator, Page } from '@playwright/test'
import {
  altClick,
  CANVAS_NAME,
  chatDialog,
  clearQueue,
  expect,
  FIXTURES,
  frameOf,
  openWindow,
  palette,
  selectedBox,
  selectInFrame,
  sendFromChat,
  sendFromPalette,
  serveDir,
  test,
  waitUntilNotListening,
  type StaticSite,
} from './helpers'

let site: StaticSite
test.beforeAll(async () => {
  site = await serveDir(FIXTURES)
})
test.afterAll(async () => {
  await site?.close()
})
test.beforeEach(async () => {
  await clearQueue()
})

type Box = { x: number; y: number; width: number; height: number }

const floatCard = (page: Page) => page.locator('.float:not([aria-hidden]) .float__card')

/** Side class of the card and its box, once placement holds still (it runs after the card measured itself). */
async function settledCard(page: Page): Promise<{ side: string; box: Box }> {
  let last = ''
  await expect
    .poll(
      async () => {
        const now = JSON.stringify([await floatCard(page).getAttribute('class'), await floatCard(page).boundingBox()])
        const settled = now === last
        last = now
        return settled
      },
      { intervals: [120] },
    )
    .toBe(true)
  const side = /side-(\w+)/.exec((await floatCard(page).getAttribute('class')) ?? '')?.[1] ?? '?'
  return { side, box: (await floatCard(page).boundingBox())! }
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

async function expectInside(page: Page, b: Box) {
  const canvas = (await page.getByRole('main', { name: CANVAS_NAME }).boundingBox())!
  expect(b.y, 'card top inside the canvas').toBeGreaterThanOrEqual(canvas.y)
  expect(b.y + b.height, 'card bottom inside the canvas').toBeLessThanOrEqual(canvas.y + canvas.height + 0.5)
  expect(b.x, 'card left inside the canvas').toBeGreaterThanOrEqual(canvas.x)
  expect(b.x + b.width, 'card right inside the canvas').toBeLessThanOrEqual(canvas.x + canvas.width + 0.5)
}

// #33: the palette was re-placed from its new size on every change, so "Details" (taller and
// wider) threw it to another side of the element, often to the top-right corner of the frame.
test('33 the palette keeps its side when Details opens, and grows in place', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await openWindow(page, { target: `${site.url}/edges.html`, probe: (n) => n.anchors.testId === 'bar' })
  const shots = process.env.LD_E2E_SHOTS_DIR ?? test.info().outputPath('shots')

  // Full width: no room on either side, the palette opens below the bar.
  const bar = frameOf(page).getByTestId('bar')
  await selectInFrame(page, bar)
  const element = (await selectedBox(page).boundingBox())!
  const opened = await settledCard(page)
  expect(opened.side).toBe('bottom')

  const details = palette(page).getByRole('menuitem', { name: 'Details' })
  await details.click()
  await expect(details).toHaveAttribute('aria-expanded', 'true')
  await expect(palette(page).locator('dl')).toBeVisible()
  const grown = await settledCard(page)
  await page.screenshot({ path: `${shots}/33-details-open.png` })
  expect(grown.side, 'the palette stays below the element').toBe(opened.side)
  expect(grown.box.y, 'and keeps its top edge').toBeCloseTo(opened.box.y, 0)
  expect(grown.box.height, 'Details made it taller').toBeGreaterThan(opened.box.height + 40)
  await expectInside(page, grown.box)
  expect(overlaps(grown.box, element), 'the palette does not cover the element').toBe(false)
  // Capped to the room below: what does not fit scrolls inside the palette, the rows stay reachable.
  await expect(palette(page).getByRole('menuitem', { name: 'Details' })).toBeInViewport()

  // Closing Details shrinks it back in the same place.
  await details.click()
  await expect(details).toHaveAttribute('aria-expanded', 'false')
  const closed = await settledCard(page)
  expect(closed.side).toBe(opened.side)
  expect(closed.box.y).toBeCloseTo(opened.box.y, 0)

  // A different element picks its side afresh: right of the element at the right edge has no room.
  await page.keyboard.press('Escape')
  await selectInFrame(page, frameOf(page).getByTestId('edge'))
  const other = await settledCard(page)
  expect(other.side).toBe('left')
})

test('33b a palette above a low element keeps its bottom edge and grows upward', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await openWindow(page, { target: `${site.url}/jump.html`, probe: (n) => n.anchors.testId === 'low' })
  await selectInFrame(page, frameOf(page).getByTestId('low'))
  const element = (await selectedBox(page).boundingBox())!
  const opened = await settledCard(page)
  expect(opened.side).toBe('top')

  await palette(page).getByRole('menuitem', { name: 'Details' }).click()
  await expect(palette(page).locator('dl')).toBeVisible()
  const grown = await settledCard(page)
  expect(grown.side, 'the palette stays above the element').toBe('top')
  // Its bottom edge stays just above the element (and its label): it grew upward, not away.
  const gapBelow = element.y - (grown.box.y + grown.box.height)
  expect(gapBelow, 'bottom edge right above the element').toBeGreaterThanOrEqual(0)
  expect(gapBelow, 'bottom edge right above the element').toBeLessThanOrEqual(48)
  await expectInside(page, grown.box)
  expect(overlaps(grown.box, element), 'the palette does not cover the element').toBe(false)
})

/** Every scroll of an element of the window from now on, except the lists that are meant to scroll. */
async function watchScrolls(page: Page, allowed: string[]): Promise<() => Promise<string[]>> {
  await page.evaluate((allowedSelectors) => {
    const w = window as unknown as { __scrolls: string[] }
    w.__scrolls = []
    document.addEventListener(
      'scroll',
      (e) => {
        const t = e.target
        const el = t instanceof Document ? t.scrollingElement : (t as Element)
        if (!el || allowedSelectors.some((s) => el.matches(s))) return
        w.__scrolls.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className} → ${el.scrollLeft},${el.scrollTop}`)
      },
      true,
    )
  }, allowed)
  return () => page.evaluate(() => (window as unknown as { __scrolls: string[] }).__scrolls)
}

// #3: the window's own layers (the canvas, the palette's collapsing Details) are `overflow:
// hidden`, which the browser still scrolls to bring a focused element into view. A focus that
// lands outside their box moved everything in them: the frame, the overlay, the palette.
test('3 focus moving through the palette never scrolls the frame or a clipped layer', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 560 })
  await openWindow(page, { target: `${site.url}/cards.html`, probe: (n) => n.anchors.testId === 'annual-plan' })
  const canvas = page.getByRole('main', { name: CANVAS_NAME })
  const frame = page.locator('iframe[title="Page being edited"]')
  const frameBox = (await frame.boundingBox())!
  const scrolls = await watchScrolls(page, ['.details', '.chat__log', '.palette__body'])

  // A section with children, so Details lists them as buttons that take the focus.
  const card = (await frameOf(page).getByTestId('annual-plan').boundingBox())!
  await altClick(page, card.x + 6, card.y + 6)
  await expect(palette(page)).toBeVisible()
  await palette(page).getByRole('menuitem', { name: 'Details' }).click()
  await expect(palette(page).locator('.kid').first()).toBeVisible()
  await settledCard(page)
  // Keyboard path through the palette, its Details and back, then the chat and back.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab')
  await page.screenshot({ path: `${process.env.LD_E2E_SHOTS_DIR ?? test.info().outputPath('shots')}/3-details-tabbed.png` })
  await page.keyboard.press('Shift+Tab')
  await palette(page).getByRole('menuitem', { name: 'Details' }).focus()
  await page.keyboard.press('End')
  await page.keyboard.press('Home')
  await palette(page).getByRole('button', { name: /^Chat with AI/ }).click()
  await expect(chatDialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeVisible()

  expect(await scrolls(), 'no window layer outside the scrolling lists moved').toEqual([])
  expect(await canvas.evaluate((el) => [el.scrollLeft, el.scrollTop])).toEqual([0, 0])
  expect(await frame.boundingBox()).toEqual(frameBox)
})

async function scrollState(log: Locator) {
  return log.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }))
}

// #6: the chat followed its log back to the bottom on its own. Each new node id of the
// selected element (Android: every recapture; web: a re-render that replaced it) left one
// render without a selected element, so the chat unmounted and mounted again: scroll reset,
// focus taken back by its field.
test('6 the chat keeps the scroll position the user set while the page renders the element anew', async ({ page }) => {
  await waitUntilNotListening()
  await page.setViewportSize({ width: 1024, height: 600 })
  await openWindow(page, { target: `${site.url}/rerender.html`, probe: (n) => n.anchors.testId === 'live-card' })
  await selectInFrame(page, frameOf(page).getByTestId('live-card'))
  const stamp = Date.now()
  await sendFromPalette(page, `e2e-6 first ${stamp}`)
  for (let i = 2; i <= 6; i++) await sendFromChat(page, `e2e-6 line ${i}: make the card padding smaller and the title bolder ${stamp}`)

  const chat = chatDialog(page)
  const log = chat.getByRole('log')
  await expect.poll(async () => (await scrollState(log)).max, { message: 'the thread is taller than the chat' }).toBeGreaterThan(80)
  // Mark this chat: a remount would bring a new element without the mark.
  await chat.evaluate((el) => el.setAttribute('data-e2e-mark', '1'))
  // The user scrolls up to read, and leaves the field (reading, not typing).
  await log.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  await page.getByRole('main', { name: CANVAS_NAME }).focus()

  const renders = () => frameOf(page).locator('body').evaluate(() => (window as unknown as { __renders: number }).__renders)
  const from = await renders()
  await expect.poll(renders, { timeout: 10_000 }).toBeGreaterThanOrEqual(from + 4)

  await page.screenshot({ path: `${process.env.LD_E2E_SHOTS_DIR ?? test.info().outputPath('shots')}/6-chat-scrolled-up.png` })
  await expect(chat, 'the same chat is on screen: it was not mounted anew').toHaveAttribute('data-e2e-mark', '1')
  expect((await scrollState(log)).top, 'the log stays where the user scrolled it').toBe(0)
  await expect(chat.getByRole('textbox', { name: 'Message to the agent' }), 'the field did not take the focus back').not.toBeFocused()
})

// The card stood aside during a drag by unmounting: the open chat came back as a new one, with
// its log scrolled to the bottom and the text the user had not sent yet gone.
test('drag with the chat open keeps its scroll position and the unsent text', async ({ page }) => {
  await waitUntilNotListening()
  await page.setViewportSize({ width: 1024, height: 600 })
  await openWindow(page, { target: `${site.url}/cards.html`, probe: (n) => n.anchors.testId === 'annual-plan' })
  const card = (await frameOf(page).getByTestId('annual-plan').boundingBox())!
  await altClick(page, card.x + 6, card.y + 6)
  await expect(palette(page)).toBeVisible()
  const stamp = Date.now()
  await sendFromPalette(page, `e2e-drag first ${stamp}`)
  for (let i = 2; i <= 6; i++) await sendFromChat(page, `e2e-drag line ${i}: make the plan card narrower and its price larger ${stamp}`)

  const chat = chatDialog(page)
  const log = chat.getByRole('log')
  await expect.poll(async () => (await scrollState(log)).max, { message: 'the thread is taller than the chat' }).toBeGreaterThan(80)
  await chat.evaluate((el) => el.setAttribute('data-e2e-mark', '1'))
  await log.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  const field = chat.getByRole('textbox', { name: 'Message to the agent' })
  await field.fill('not sent yet')

  const box = (await selectedBox(page).boundingBox())!
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 15, start.y + 10, { steps: 4 })
  await expect(chat, 'the chat stands aside while the element is dragged').toBeHidden()
  await page.mouse.move(start.x + 30, start.y + 20, { steps: 4 })
  await page.mouse.up()

  await expect(chat).toBeVisible()
  await expect(chat, 'the same chat is on screen: it was not mounted anew').toHaveAttribute('data-e2e-mark', '1')
  expect((await scrollState(log)).top, 'the log stays where the user scrolled it').toBe(0)
  await expect(field).toHaveValue('not sent yet')
})

// Same cause in the palette: its body was keyed by the node id, so every new id of the same
// element (Android: every recapture) rebuilt it under the user's caret.
test('6b typing in the palette field survives the page rendering the element anew', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 })
  await openWindow(page, { target: `${site.url}/rerender.html`, probe: (n) => n.anchors.testId === 'live-card' })
  await selectInFrame(page, frameOf(page).getByTestId('live-card'))
  const field = palette(page).getByRole('textbox', { name: 'Message to the agent' })
  await page.keyboard.press('c')
  await expect(field).toBeFocused()
  await page.keyboard.type('half a thought')
  await field.evaluate((el) => el.setAttribute('data-e2e-mark', '1'))

  const renders = () => frameOf(page).locator('body').evaluate(() => (window as unknown as { __renders: number }).__renders)
  const from = await renders()
  await expect.poll(renders, { timeout: 10_000 }).toBeGreaterThanOrEqual(from + 4)

  await expect(field, 'the same field: not rebuilt').toHaveAttribute('data-e2e-mark', '1')
  await expect(field, 'the caret is still in it').toBeFocused()
  await page.keyboard.type(', and the rest')
  await expect(field).toHaveValue('half a thought, and the rest')
})
