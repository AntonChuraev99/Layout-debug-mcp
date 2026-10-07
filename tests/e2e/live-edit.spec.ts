import {
  centerOf,
  clearQueue,
  expect,
  expectSameBox,
  frameOf,
  openWindow,
  palette,
  selectedBox,
  selectInFrame,
  test,
  UI_URL,
  waitForServerSnapshot,
} from './helpers'
import type { Locator, Page } from '@playwright/test'

test.beforeEach(async () => {
  await clearQueue()
})

test('4 dragging with Move shifts the real element in the page and the label shows Δ', async ({ page }) => {
  await openWindow(page)
  await page.keyboard.press('m')
  await expect(page.getByRole('button', { name: 'Move (M)' })).toHaveAttribute('aria-pressed', 'true')

  const cta = frameOf(page).getByTestId('cta-continue')
  const c = await centerOf(cta)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x + 40, c.y + 20, { steps: 8 })
  await expect(selectedBox(page).locator('.chip--selected')).toContainText('Δ +40, +20 css-px')
  // The palette stands aside while the element is being dragged.
  await expect(palette(page)).toHaveCount(0)
  await page.mouse.up()

  // An inline style in the page itself, not a picture of the element.
  await expect.poll(() => cta.evaluate((el) => (el as HTMLElement).style.translate)).toBe('40px 20px')
  const moved = { ...c.box, x: c.box.x + 40, y: c.box.y + 20 }
  expectSameBox(await cta.boundingBox(), moved)
  await expect(async () => expectSameBox(await selectedBox(page).boundingBox(), moved)).toPass({ timeout: 3_000 })
})

test('4b a moved element keeps its selection box when the page re-renders', async ({ page }) => {
  // The app changes on its own while the user plays (state change, hot reload): the
  // inspector recaptures, and the box must still sit on the moved element, not drift.
  await openWindow(page)
  await page.keyboard.press('m')
  const cta = frameOf(page).getByTestId('cta-continue')
  const c = await centerOf(cta)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x + 40, c.y + 20, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => cta.evaluate((el) => (el as HTMLElement).style.translate)).toBe('40px 20px')
  const moved = (await cta.boundingBox())!

  const since = Date.now()
  await frameOf(page).locator('body').evaluate((b) => b.classList.add('e2e-rerender'))
  // A snapshot taken after the mutation reached the window (it mirrors it to the server).
  await waitForServerSnapshot(since, (n) => n.anchors.testId === 'cta-continue')
  expect(await cta.evaluate((el) => (el as HTMLElement).style.translate), 'the live edit survives the recapture').toBe('40px 20px')
  expectSameBox(await cta.boundingBox(), moved)
  expectSameBox(await selectedBox(page).boundingBox(), moved)
})

async function resizeBy(page: Page, element: Locator, dx: number, dy: number): Promise<{ w: number; h: number }> {
  await selectInFrame(page, element)
  const before = (await centerOf(element)).box

  const resize = palette(page).getByRole('menuitemcheckbox', { name: 'Resize' })
  await expect(resize).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('.overlay [data-handle="resize"]')).toHaveCount(0)
  await resize.click()
  await expect(resize).toHaveAttribute('aria-checked', 'true')

  const handle = await centerOf(page.locator('.overlay [data-handle="resize"]'))
  const w = Math.round(before.width + dx)
  const h = Math.round(before.height + dy)
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.x + dx, handle.y + dy, { steps: 6 })
  await expect(selectedBox(page).locator('.chip--selected')).toContainText(`${w} × ${h} css-px`)
  await page.mouse.up()

  await expect
    .poll(() => element.evaluate((el) => [(el as HTMLElement).style.width, (el as HTMLElement).style.height]))
    .toEqual([`${w}px`, `${h}px`])
  return { w, h }
}

test('5 the resize handle changes the real width and height', async ({ page }) => {
  await openWindow(page)
  // A plain block: resizing it moves nothing around it, so the box must match exactly.
  const title = frameOf(page).getByRole('heading', { name: 'Годовая подписка' })
  const { w, h } = await resizeBy(page, title, 30, 10)
  const after = (await title.boundingBox())!
  expect(Math.abs(after.width - w), 'real width follows the handle').toBeLessThanOrEqual(1)
  expect(Math.abs(after.height - h), 'real height follows the handle').toBeLessThanOrEqual(1)
  expectSameBox(await selectedBox(page).boundingBox(), after)
})

test('5c after a resize that reflows its row, the selection box stays on the real element', async ({ page }) => {
  // "Отмена" sits right of a `flex: 1` button: growing it moves its left edge in the page.
  await openWindow(page)
  const cancel = frameOf(page).getByRole('button', { name: 'Отмена' })
  const { w, h } = await resizeBy(page, cancel, 30, 10)
  const after = (await cancel.boundingBox())!
  expect(Math.abs(after.width - w), 'real width follows the handle').toBeLessThanOrEqual(1)
  expect(Math.abs(after.height - h), 'real height follows the handle').toBeLessThanOrEqual(1)
  await expect(async () => expectSameBox(await selectedBox(page).boundingBox(), after)).toPass({ timeout: 3_000 })
})

test('5b resizing a flex: 1 item changes its real width, not only the overlay box', async ({ page }) => {
  // The demo CTA is `flex: 1`: an inline `width` alone does not size a growing flex item.
  await openWindow(page)
  const cta = frameOf(page).getByTestId('cta-continue')
  const { w, h } = await resizeBy(page, cta, 30, 10)
  const after = (await cta.boundingBox())!
  expect(Math.abs(after.height - h), 'real height follows the handle').toBeLessThanOrEqual(1)
  expect(Math.abs(after.width - w), 'real width follows the handle (overlay shows the new width)').toBeLessThanOrEqual(1)
})

test('6 Hide makes the element invisible in the page, Show brings it back', async ({ page }) => {
  await openWindow(page)
  const cta = frameOf(page).getByTestId('cta-continue')
  await selectInFrame(page, cta)
  const p = palette(page)
  const visibility = () => cta.evaluate((el) => getComputedStyle(el).visibility)

  await p.getByRole('menuitem', { name: 'Hide' }).click()
  await expect.poll(visibility).toBe('hidden')
  await expect(p.getByRole('menuitem', { name: 'Show' })).toBeVisible()
  await expect(p.getByRole('menuitem', { name: 'Reset edits' })).toBeVisible()

  await p.getByRole('menuitem', { name: 'Show' }).click()
  await expect.poll(visibility).toBe('visible')
  await expect(p.getByRole('menuitem', { name: 'Hide' })).toBeVisible()
  // Nothing else was changed, so there is no edit left to reset.
  await expect(p.getByRole('menuitem', { name: 'Reset edits' })).toHaveCount(0)
})

test('7 Copy anchor puts the best anchor on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: UI_URL })
  await openWindow(page)
  await selectInFrame(page, frameOf(page).getByTestId('cta-continue'))
  const p = palette(page)

  await p.getByRole('menuitem', { name: 'Copy anchor' }).click()
  await expect(p.getByRole('menuitem', { name: 'Copied' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('[data-testid="cta-continue"]')
  // The confirmation is temporary.
  await expect(p.getByRole('menuitem', { name: 'Copy anchor' })).toBeVisible({ timeout: 5_000 })
})
