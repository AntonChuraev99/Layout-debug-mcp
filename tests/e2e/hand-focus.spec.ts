import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { centerOf, clearQueue, expect, frameOf, openWindow, serveDir, test, type StaticSite } from './helpers'

/**
 * After a Hand-tool click the keyboard focus lives in the page's iframe, so key presses
 * reach the page document, not the window. The inspector hands V / M / H / C back to the
 * window — except while the user types into a field of the page.
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

const TOOLS = ['Select (V)', 'Move (M)', 'Hand (H)'] as const
async function expectTool(page: import('@playwright/test').Page, name: (typeof TOOLS)[number]) {
  for (const n of TOOLS) await expect(page.getByRole('button', { name: n })).toHaveAttribute('aria-pressed', String(n === name))
}

async function openHand(page: import('@playwright/test').Page) {
  await openWindow(page, { target: `${site.url}/hand.html`, probe: (n) => n.anchors.testId === 'counter' })
  await page.keyboard.press('h')
  await expectTool(page, 'Hand (H)')
}

test('22 after a Hand click inside the page, V / M / H still switch tools', async ({ page }) => {
  await openHand(page)
  const counter = frameOf(page).getByTestId('counter')
  const { x, y } = await centerOf(counter)
  await page.mouse.click(x, y)
  await expect(counter).toHaveText('Clicked 1')
  // Focus is in the page now: the shortcut lands in the iframe's document.
  await expect(counter).toBeFocused()

  await page.keyboard.press('v')
  await expectTool(page, 'Select (V)')

  // Back to Hand, click the page again, then M and H from inside the page.
  await page.getByRole('button', { name: 'Hand (H)' }).click()
  await page.mouse.click(x, y)
  await expect(counter).toHaveText('Clicked 2')
  await expect(counter).toBeFocused()
  await page.keyboard.press('m')
  await expectTool(page, 'Move (M)')

  await page.getByRole('button', { name: 'Hand (H)' }).click()
  await page.mouse.click(x, y)
  await expect(counter).toBeFocused()
  // Pressed by physical key code (the non-Latin-layout case itself is covered in src/inspector/keys.test.ts).
  await page.keyboard.press('KeyV')
  await expectTool(page, 'Select (V)')
})

test('23 typing into a field of the page never switches tools', async ({ page }) => {
  await openHand(page)
  const field = frameOf(page).getByTestId('field')
  await field.click()
  await page.keyboard.type('vmhc')
  await expect(field).toHaveValue('vmhc')
  await expectTool(page, 'Hand (H)')

  const editable = frameOf(page).getByTestId('editable')
  await editable.click()
  await page.keyboard.press('End')
  await page.keyboard.type('vm')
  await expect(editable).toHaveText('xvm')
  await expectTool(page, 'Hand (H)')

  // Leaving the field gives the shortcuts back.
  const counter = frameOf(page).getByTestId('counter')
  await counter.click()
  await expect(counter).toBeFocused()
  await page.keyboard.press('v')
  await expectTool(page, 'Select (V)')
})
