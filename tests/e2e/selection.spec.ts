import {
  altClick,
  CANVAS_NAME,
  centerOf,
  chatDialog,
  clearQueue,
  expect,
  expectSameBox,
  FIXTURES,
  frameOf,
  hoverBox,
  openWindow,
  palette,
  pipetteButton,
  selectedBox,
  selectInFrame,
  serveDir,
  test,
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

test('2e the Talk cursor bubble follows the arrow while Alt is held, flips at the right edge, and steps aside', async ({ page }) => {
  await openWindow(page)
  const tc = page.getByTestId('talk-cursor')
  const at = async () => {
    const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec((await tc.getAttribute('style')) ?? '')
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null
  }
  const overlayCursor = () => page.locator('.overlay').evaluate((el) => getComputedStyle(el).cursor)
  const cta = frameOf(page).getByTestId('cta-continue')
  const c = await centerOf(cta)

  await expect(tc).toHaveClass(/tc--off/)
  // The pointer rests on the live page; Alt alone (no move) draws the tip right there:
  // the inspector reports where the pointer is.
  // Arrives with a few moves, as a hand does: a single synthetic jump right after load is
  // occasionally not seen by the page at all, and then there is no resting point to report.
  await page.mouse.move(c.x - 20, c.y)
  await page.mouse.move(c.x, c.y, { steps: 5 })
  await page.keyboard.down('Alt')
  await expect(tc).not.toHaveClass(/tc--off/)
  const near = (x: number, y: number) => async () => {
    const p = await at()
    return Boolean(p && Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1)
  }
  await expect.poll(near(c.x, c.y), { message: 'tip on the resting pointer' }).toBe(true)
  await expect(tc).not.toHaveClass(/tc--quiet/)
  await expect(tc).toContainText('Select to chat')
  // The standard arrow stays; the bubble only rides under it.
  expect(await overlayCursor(), 'the system arrow over the frame').toBe('default')

  // It follows the pointer.
  await page.mouse.move(c.x - 80, c.y - 40)
  await expect.poll(near(c.x - 80, c.y - 40)).toBe(true)

  // At the stage's right edge the bubble goes to the left of the tip.
  const canvas = (await page.getByRole('main', { name: CANVAS_NAME }).boundingBox())!
  await page.mouse.move(canvas.x + canvas.width - 20, c.y)
  await expect(tc).toHaveClass(/tc--flip-x/)
  await page.mouse.move(c.x, c.y)
  await expect(tc).not.toHaveClass(/tc--flip-x/)

  // Alt+click picks: the bubble rests, the tip stays.
  await page.mouse.down()
  await page.mouse.up()
  await expect(palette(page)).toBeVisible()
  await expect(tc).toHaveClass(/tc--quiet/)
  await expect(tc).not.toHaveClass(/tc--off/)

  // Over the palette: the system cursor, no follower.
  const pal = (await palette(page).boundingBox())!
  await page.mouse.move(pal.x + 40, pal.y + pal.height - 30, { steps: 4 })
  await expect(tc).toHaveClass(/tc--off/)

  // Alt released: gone, and the overlay lets the page's own cursor through again.
  await page.mouse.move(c.x, c.y, { steps: 4 })
  await expect(tc).not.toHaveClass(/tc--off/)
  await page.keyboard.up('Alt')
  await expect(tc).toHaveClass(/tc--off/)
  await expect(page.locator('.overlay--picking')).toHaveCount(0)

  // Dragging the selected element: no follower, even with Alt pressed in the middle.
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x + 20, c.y + 10, { steps: 4 })
  await page.keyboard.down('Alt')
  await page.mouse.move(c.x + 40, c.y + 20, { steps: 4 })
  await expect(tc).toHaveClass(/tc--off/)
  await page.mouse.up()
  await page.keyboard.up('Alt')
})

test('2f Alt with the pointer on the palette: no bubble, no hover from the page point it left', async ({ page }) => {
  await openWindow(page)
  const tc = page.getByTestId('talk-cursor')
  const cta = frameOf(page).getByTestId('cta-continue')
  await selectInFrame(page, cta)
  const c = await centerOf(cta)
  const pal = (await palette(page).boundingBox())!

  // Over the page first (the page remembers this point), then onto the palette.
  await page.mouse.move(c.x - 20, c.y)
  await page.mouse.move(c.x, c.y, { steps: 5 })
  await page.mouse.move(pal.x + 40, pal.y + pal.height - 30, { steps: 10 })
  await page.keyboard.down('Alt')
  await expect(page.locator('.overlay--picking')).toHaveCount(1)
  // Give the page's stale answer time to arrive, then: nothing from it.
  await page.waitForTimeout(500)
  await expect(tc).toHaveClass(/tc--off/)
  await expect(hoverBox(page)).toHaveCount(0)

  // Back onto the page: the bubble is at the pointer.
  const back = { x: c.x - 100, y: c.y - 120 }
  await page.mouse.move(back.x, back.y, { steps: 10 })
  await expect(tc).not.toHaveClass(/tc--off/)
  const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec((await tc.getAttribute('style')) ?? '')
  expect(m && Math.abs(Number(m[1]) - back.x) <= 1 && Math.abs(Number(m[2]) - back.y) <= 1, `bubble at the pointer: ${m?.[0]}`).toBe(true)
  await page.keyboard.up('Alt')
})

test('2 with Alt, hover highlights the element under the cursor, Alt+click selects it, breadcrumbs go up', async ({ page }) => {
  await openWindow(page)
  const frame = frameOf(page)
  const cta = frame.getByTestId('cta-continue')
  const c = await centerOf(cta)

  // Without Alt the page is live: hovering highlights nothing.
  await page.mouse.move(c.x, c.y)
  await expect(hoverBox(page)).toHaveCount(0)

  await page.keyboard.down('Alt')
  await page.mouse.move(c.x + 1, c.y)
  await expect(hoverBox(page)).toBeVisible()
  expectSameBox(await hoverBox(page).boundingBox(), c.box)
  await expect(hoverBox(page)).toContainText('button')

  // The highlight follows the cursor to the next element.
  const title = await centerOf(frame.getByRole('heading', { name: 'Годовая подписка' }))
  await page.mouse.move(title.x, title.y)
  await expect(async () => expectSameBox(await hoverBox(page).boundingBox(), title.box)).toPass({ timeout: 3_000 })
  await expect(hoverBox(page)).toContainText('h1')

  await page.mouse.click(c.x, c.y)
  await page.keyboard.up('Alt')
  await expect(palette(page)).toHaveAccessibleName(/^Actions: button/)
  expectSameBox(await selectedBox(page).boundingBox(), c.box)

  // Up one level: the actions row that holds the button.
  const parents = () => palette(page).getByRole('navigation', { name: 'Parents' })
  await parents().getByRole('button').last().click()
  await expect(palette(page)).toHaveAccessibleName('Actions: div div.actions')
  expectSameBox(await selectedBox(page).boundingBox(), (await centerOf(frame.locator('.actions'))).box)

  // And again: the whole card.
  await parents().getByRole('button').last().click()
  await expect(palette(page)).toHaveAccessibleName('Actions: section section.card')
  expectSameBox(await selectedBox(page).boundingBox(), (await centerOf(frame.getByTestId('subscription-card'))).box)
})

test('3 a plain click reaches the page; Alt+click selects and the page never sees it; the selected body holds the mouse', async ({ page }) => {
  await openWindow(page, { target: `${site.url}/counter.html`, probe: (n) => n.anchors.testId === 'counter' })
  const counter = frameOf(page).getByTestId('counter')
  const { x, y } = await centerOf(counter)

  // Nothing selected: the page is live, the click is the page's.
  await page.mouse.click(x, y)
  await expect(counter).toHaveText('Clicked 1')

  // Alt+click: the overlay takes it, the page never sees it.
  await selectInFrame(page, counter)
  await expect(counter).toHaveText('Clicked 1')
  // The new label widened the button; the box follows once the page is recaptured.
  await expect(async () => expectSameBox(await selectedBox(page).boundingBox(), (await centerOf(counter)).box)).toPass({ timeout: 3_000 })

  // A plain click on the selected body is a grab (drag), not a click for the page.
  await page.mouse.click(x, y)
  await expect(counter).toHaveText('Clicked 1')
  await expect(palette(page)).toBeVisible()

  // Escape lets the element go, and the page gets its clicks back.
  await page.keyboard.press('Escape')
  await expect(selectedBox(page)).toHaveCount(0)
  await page.mouse.click(x, y)
  await expect(counter).toHaveText('Clicked 2')
})

test('3b with a layer selected, a plain click elsewhere goes to the page and keeps the selection', async ({ page }) => {
  await openWindow(page)
  const frame = frameOf(page)
  // The second card's title: its palette opens to the right, clear of the CTA.
  await selectInFrame(page, frame.getByRole('heading', { name: 'Вторая карточка' }))
  const before = await selectedBox(page).boundingBox()

  const cta = frame.getByTestId('cta-continue')
  const c = await centerOf(cta)
  await page.mouse.click(c.x, c.y)
  // The page got the click (the button took focus), the window did not deselect.
  await expect(cta).toBeFocused()
  await expect(palette(page)).toHaveAccessibleName(/^Actions: h2/)
  expectSameBox(await selectedBox(page).boundingBox(), before!)
  await expect(page.locator('.overlay .handle')).toHaveCount(4)
})

test('3c a repeated Alt+click on the same spot climbs to the parent; the root says so instead of doing nothing', async ({ page }) => {
  await openWindow(page)
  const c = await centerOf(frameOf(page).getByTestId('cta-continue'))
  await altClick(page, c.x, c.y)
  await expect(palette(page)).toHaveAccessibleName(/^Actions: button/)
  await altClick(page, c.x + 2, c.y)
  await expect(palette(page)).toHaveAccessibleName('Actions: div div.actions')
  await altClick(page, c.x + 2, c.y + 2)
  await expect(palette(page)).toHaveAccessibleName('Actions: section section.card')

  // Far enough from the last pick: the tightest layer again, not one more parent.
  await altClick(page, c.x + 30, c.y)
  await expect(palette(page)).toHaveAccessibleName(/^Actions: button/)

  // Up to the root, then once more: the label reports the top.
  for (let i = 0; i < 10 && !(await page.locator('.chip--selected').textContent())?.includes('Top layer'); i++) {
    await altClick(page, c.x + 30, c.y)
  }
  await expect(page.locator('.chip--selected')).toContainText('Top layer')
})

test('3d Alt+wheel raises the hover to the parent, and Alt+click picks what it shows', async ({ page }) => {
  await openWindow(page)
  const c = await centerOf(frameOf(page).getByTestId('cta-continue'))
  await page.keyboard.down('Alt')
  await page.mouse.move(c.x, c.y)
  await expect(hoverBox(page)).toContainText('button')
  await page.mouse.wheel(0, -100)
  await expect(hoverBox(page)).toContainText('div')
  await expect(hoverBox(page).locator('.chip__lvl')).toBeVisible()
  await page.mouse.wheel(0, 100)
  await expect(hoverBox(page)).toContainText('button')
  await page.mouse.wheel(0, -100)
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await expect(palette(page)).toHaveAccessibleName('Actions: div div.actions')
})

test('3d2 Alt pressed with the cursor resting on the page highlights at once, without a move', async ({ page }) => {
  await openWindow(page)
  const c = await centerOf(frameOf(page).getByTestId('cta-continue'))
  // The cursor rests over the live page (the page, not the window, saw this move).
  await page.mouse.move(c.x, c.y)
  await expect(hoverBox(page)).toHaveCount(0)
  await page.keyboard.down('Alt')
  await expect(hoverBox(page)).toBeVisible()
  await expect(hoverBox(page)).toContainText('button')
  expectSameBox(await hoverBox(page).boundingBox(), c.box)
  await page.keyboard.up('Alt')
  await expect(hoverBox(page)).toHaveCount(0)
})

test('3d3 Alt over a selected layer leaves it an outline only; past the root the hover says Top layer', async ({ page }) => {
  await openWindow(page)
  const frame = frameOf(page)
  await selectInFrame(page, frame.getByRole('heading', { name: 'Вторая карточка' }))
  await expect(page.locator('.chip--selected')).toBeVisible()

  // Alt over the selection itself: one label (the hover's), the selection keeps only its outline.
  const h = await centerOf(frame.getByRole('heading', { name: 'Вторая карточка' }))
  await page.keyboard.down('Alt')
  await page.mouse.move(h.x, h.y)
  await expect(page.locator('.chip--selected')).toHaveCount(0)
  await expect(page.locator('.overlay .handle')).toHaveCount(0)
  await expect(hoverBox(page)).toContainText('h2')
  await expect(page.locator('.overlay .chip')).toHaveCount(1)

  // Another branch: the wheel walks the hover up to the root and once more.
  const c = await centerOf(frame.getByTestId('cta-continue'))
  await page.mouse.move(c.x, c.y)
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100)
  await expect(hoverBox(page)).toContainText('Top layer')
  await page.keyboard.up('Alt')
})

test('3d4 a scrolling ticker elsewhere on the page does not hide the palette', async ({ page }) => {
  await openWindow(page, { target: `${site.url}/link.html`, probe: (n) => n.anchors.testId === 'dl' })
  await selectInFrame(page, frameOf(page).getByTestId('dl'))
  // Any moment of hiding counts, not just the state at the end.
  await page.evaluate(() => {
    const w = window as unknown as { staleSeen: boolean }
    w.staleSeen = false
    new MutationObserver(() => {
      if (document.querySelector('.float--stale, .overlay--stale')) w.staleSeen = true
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] })
  })
  const ticker = frameOf(page).getByTestId('ticker')
  await ticker.evaluate(
    (el) =>
      new Promise<void>((done) => {
        let n = 0
        const t = setInterval(() => {
          el.scrollLeft += 4
          if (++n === 30) {
            clearInterval(t)
            done()
          }
        }, 30)
      }),
  )
  expect(await page.evaluate(() => (window as unknown as { staleSeen: boolean }).staleSeen), 'palette hid during an unrelated scroll').toBe(false)
  await expect(palette(page)).toBeVisible()

  // A scroll of the document itself does move the selection: then the boxes step aside.
  await frameOf(page).locator('body').evaluate((b) => {
    b.style.height = '3000px'
  })
  await frameOf(page).locator('html').evaluate(() => window.scrollBy(0, 40))
  await expect.poll(() => page.evaluate(() => (window as unknown as { staleSeen: boolean }).staleSeen)).toBe(true)
})

test('3e the pipette selects one layer and switches itself off; Escape cancels it', async ({ page }) => {
  await openWindow(page)
  const counterPage = frameOf(page)
  const pipette = pipetteButton(page)
  await pipette.click()
  await expect(pipette).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(pipette).toHaveAttribute('aria-pressed', 'false')

  await pipette.click()
  const c = await centerOf(counterPage.getByTestId('cta-continue'))
  await page.mouse.click(c.x, c.y)
  await expect(palette(page)).toHaveAccessibleName(/^Actions: button/)
  await expect(pipette).toHaveAttribute('aria-pressed', 'false')
  // Back to the live page: the next plain click is the page's (no hover, no new pick).
  const title = await centerOf(counterPage.getByRole('heading', { name: 'Годовая подписка' }))
  await page.mouse.move(title.x, title.y)
  await expect(hoverBox(page)).toHaveCount(0)
})

test('3f Alt+click on a link inside the focused page selects it and downloads nothing', async ({ page }) => {
  await openWindow(page, { target: `${site.url}/link.html`, probe: (n) => n.anchors.testId === 'dl' })
  const downloads: string[] = []
  page.on('download', (d) => downloads.push(d.suggestedFilename()))
  const frame = frameOf(page)
  // Focus inside the page: the window hears about Alt only through the inspector.
  await frame.getByTestId('field').click()
  const link = frame.getByTestId('dl')
  await selectInFrame(page, link)
  await expect(palette(page)).toHaveAccessibleName(/^Actions: a/)

  // The inspector's own guard: an Alt+click that reaches the page is swallowed.
  await link.dispatchEvent('click', { altKey: true, bubbles: true, cancelable: true })
  await page.waitForTimeout(1_000)
  expect(downloads, 'Alt+click must never download the link').toEqual([])
})

test('3g AltGr (Ctrl+Alt) while typing in the page does not turn selection on', async ({ page }) => {
  await openWindow(page, { target: `${site.url}/link.html`, probe: (n) => n.anchors.testId === 'dl' })
  const field = frameOf(page).getByTestId('field')
  await field.click()
  await page.keyboard.down('Control')
  await page.keyboard.down('Alt')
  const c = await centerOf(frameOf(page).getByTestId('dl'))
  await page.mouse.move(c.x, c.y)
  await expect(page.locator('.canvas--picking')).toHaveCount(0)
  await expect(hoverBox(page)).toHaveCount(0)
  await page.keyboard.up('Alt')
  await page.keyboard.up('Control')
  await page.keyboard.type('ok')
  await expect(field).toHaveValue('ok')
})

test('3h Alt that never got its keyup (Alt+Tab) is dropped when the window loses focus', async ({ page }) => {
  await openWindow(page)
  await page.keyboard.down('Alt')
  await expect(page.locator('.canvas--picking')).toHaveCount(1)
  // Alt+Tab: the window blurs and the keyup goes to another app.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true })
    window.dispatchEvent(new Event('blur'))
  })
  await expect(page.locator('.canvas--picking')).toHaveCount(0)
  await expect(page.locator('.pick.is-alt')).toHaveCount(0)
  await page.evaluate(() => {
    delete (document as unknown as { hasFocus?: unknown }).hasFocus
  })
  await page.keyboard.up('Alt')
})

test('8 details expand with the element facts and collapse again', async ({ page }) => {
  await openWindow(page)
  const cta = frameOf(page).getByTestId('cta-continue')
  await selectInFrame(page, cta)
  const p = palette(page)
  const details = p.getByRole('menuitem', { name: 'Details' })
  await expect(details).toHaveAttribute('aria-expanded', 'false')
  await expect(p.locator('dl')).toHaveCount(0)

  await details.click()
  await expect(details).toHaveAttribute('aria-expanded', 'true')
  const dd = (label: string) => p.locator('dl dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]')
  await expect(dd('testId')).toHaveText('cta-continue')
  await expect(dd('Classes')).toHaveText('btn btn--primary')
  await expect(dd('Path')).toContainText('button')

  // Box row is in css-px and matches the element's real size.
  const box = (await centerOf(cta)).box
  const m = /^([\d.]+) × ([\d.]+) css-px/.exec((await dd('Box').innerText()).trim())
  expect(m, 'Box row reads "W × H css-px"').not.toBeNull()
  expect(Math.abs(Number(m![1]) - box.width)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(Number(m![2]) - box.height)).toBeLessThanOrEqual(0.5)

  await details.click()
  await expect(details).toHaveAttribute('aria-expanded', 'false')
  await expect(p.locator('dl')).toHaveCount(0)
})

test('9 Escape closes chat, then details, then the selection', async ({ page }) => {
  await openWindow(page)
  await selectInFrame(page, frameOf(page).getByTestId('cta-continue'))
  const details = palette(page).getByRole('menuitem', { name: 'Details' })
  await details.click()
  await expect(details).toHaveAttribute('aria-expanded', 'true')

  await palette(page).getByRole('button', { name: /^Chat with AI/ }).click()
  await expect(chatDialog(page)).toBeVisible()
  await expect(chatDialog(page).getByRole('textbox', { name: 'Message to the agent' })).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(chatDialog(page)).toHaveCount(0)
  await expect(palette(page)).toBeVisible()
  await expect(palette(page).getByRole('menuitem', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true')

  await page.keyboard.press('Escape')
  await expect(palette(page).getByRole('menuitem', { name: 'Details' })).toHaveAttribute('aria-expanded', 'false')
  await expect(palette(page)).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(palette(page)).toHaveCount(0)
  await expect(selectedBox(page)).toHaveCount(0)
})
