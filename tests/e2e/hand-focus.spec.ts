import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  centerOf,
  chatDialog,
  clearQueue,
  expect,
  frameOf,
  hoverBox,
  openWindow,
  palette,
  selectedBox,
  selectInFrame,
  serveDir,
  test,
  type StaticSite,
} from './helpers'

/**
 * The page is live, so after a click in it the keyboard focus lives in the page's iframe
 * and key presses reach the page document, not the window. The inspector hands C, Escape
 * and Alt back to the window — except while the user types into a field of the page.
 */
const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>e2e: hand focus</title>
    <style>body { margin: 0; padding: 48px; font: 16px system-ui, sans-serif; } .row { display: flex; gap: 16px; }</style>
  </head>
  <body>
    <main class="row">
      <button type="button" data-testid="counter"
        onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1); this.textContent = 'Clicked ' + this.dataset.clicks">Click me</button>
      <input data-testid="field" aria-label="Field" />
      <div data-testid="editable" contenteditable="true" style="min-width: 120px; border: 1px solid #999">x</div>
    </main>
    __INSPECTOR__
  </body>
</html>`

let dir: string
let site: StaticSite
test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ld-hand-focus-'))
  await writeFile(join(dir, 'hand.html'), PAGE, 'utf8')
  site = await serveDir(dir)
})
test.afterAll(async () => {
  await site?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
})
test.beforeEach(async () => {
  await clearQueue()
})

async function openLive(page: import('@playwright/test').Page) {
  await openWindow(page, { target: `${site.url}/hand.html`, probe: (n) => n.anchors.testId === 'counter' })
}

test('22 after a click inside the page, Alt, C and Escape still reach the window', async ({ page }) => {
  await openLive(page)
  const counter = frameOf(page).getByTestId('counter')
  const { x, y } = await centerOf(counter)
  await page.mouse.click(x, y)
  await expect(counter).toHaveText('Clicked 1')
  // Focus is in the page now: keys land in the iframe's document.
  await expect(counter).toBeFocused()

  // Alt pressed inside the page turns selection on (the inspector reports it).
  await page.keyboard.down('Alt')
  await expect(page.locator('.canvas--picking')).toHaveCount(1)
  await page.mouse.move(x + 1, y)
  await expect(hoverBox(page)).toBeVisible()
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await expect(page.locator('.canvas--picking')).toHaveCount(0)
  await expect(palette(page)).toHaveAccessibleName(/^Actions: button/)
  // The pick was the window's: the page did not count it.
  await expect(counter).toHaveText('Clicked 1')

  // Back into the page by a click outside the selected box (it keeps the selection), then C.
  await page.mouse.click(30, 300)
  await expect(selectedBox(page)).toHaveCount(1)
  // Pressed by physical key code (the non-Latin-layout case itself is covered in src/inspector/keys.test.ts).
  await page.keyboard.press('KeyC')
  await expect(chatDialog(page)).toBeVisible()

  // Escape from the page walks the window's Escape order: chat, then the selection.
  await page.mouse.click(30, 300)
  await page.keyboard.press('Escape')
  await expect(chatDialog(page)).toHaveCount(0)
  await expect(palette(page)).toBeVisible()
  await page.mouse.click(30, 300)
  await page.keyboard.press('Escape')
  await expect(selectedBox(page)).toHaveCount(0)
})

test('23 typing into a field of the page never triggers window keys', async ({ page }) => {
  await openLive(page)
  const counter = frameOf(page).getByTestId('counter')
  await selectInFrame(page, counter)

  // The palette opens over the fields next to the button: focus them the way a Tab would.
  const field = frameOf(page).getByTestId('field')
  await field.focus()
  await page.keyboard.type('vmhc')
  await expect(field).toHaveValue('vmhc')
  await expect(chatDialog(page)).toHaveCount(0)
  // Escape in a field stays the field's: the selection is still there.
  await page.keyboard.press('Escape')
  await expect(selectedBox(page)).toHaveCount(1)

  const editable = frameOf(page).getByTestId('editable')
  await editable.focus()
  await page.keyboard.press('End')
  await page.keyboard.type('cm')
  await expect(editable).toHaveText('xcm')
  await expect(chatDialog(page)).toHaveCount(0)

  // Leaving the field gives the keys back.
  await page.mouse.click(30, 300)
  await page.keyboard.press('c')
  await expect(chatDialog(page)).toBeVisible()
})
