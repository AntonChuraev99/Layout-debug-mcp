import { CANVAS_NAME, expect, openWindow, test } from './helpers'

/**
 * No silent white page: when the window's scripts fail to load (seen as one module refused
 * by a single-family loopback listener), index.html shows why and what to do next.
 */
const REACT_DOM = /react-dom_client\.js/

test('24 a script of the window fails to load: an alert says so, with the next step', async ({ page }) => {
  await page.route(REACT_DOM, (r) => r.abort('connectionrefused'))
  await page.goto('/')
  const alert = page.getByRole('alert')
  await expect(alert).toBeVisible({ timeout: 5_000 })
  await expect(alert).toContainText("didn't start")
  await expect(alert).toContainText('a script of the window failed to load')
  await expect(alert).toContainText('npm run dev')
  await expect(alert.getByRole('button', { name: 'Reload page' })).toBeVisible()
})

test('25 the alert follows the stored language (RU)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('layout-debug.locale', 'ru'))
  await page.route(REACT_DOM, (r) => r.abort('connectionrefused'))
  await page.goto('/')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Окно не запустилось', { timeout: 5_000 })
  await expect(alert).toContainText('npm run dev')
  await expect(alert.getByRole('button', { name: 'Обновить страницу' })).toBeVisible()
})

test('26 a healthy boot never shows the fallback, even past its 15 s backstop', async ({ page }) => {
  await page.clock.install()
  await openWindow(page)
  await page.clock.fastForward(20_000)
  await expect(page.locator('#boot-error')).toBeHidden()
  await expect(page.locator('#boot-error')).toBeEmpty()
  await expect(page.getByRole('main', { name: CANVAS_NAME })).toBeVisible()
})

test('26b a slow first render: backstop panel shows, then leaves once the app paints', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  await page.route(/\/src\/ui\/main\.tsx/, async (r) => {
    await gate
    await r.fallback()
  })
  await page.clock.install()
  await page.goto('/', { waitUntil: 'commit' })
  await page.locator('#boot-error').waitFor({ state: 'attached' })
  await page.clock.fastForward(16_000)
  const alert = page.getByRole('alert')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('the app did not render within 15 s')
  release()
  await expect(page.getByRole('main', { name: CANVAS_NAME })).toBeVisible()
  await expect(page.locator('#boot-error')).toBeHidden()
  await expect(page.locator('#boot-error')).toBeEmpty()
})

/** index.html's boot-failure hook; `force` stands for a render crash (src/ui/main.tsx). */
type BootWindow = Window & { __ldBootFailed?: (cause: string, force: boolean) => void }

/** Holds the window's entry module until `release()`, so the 15 s backstop fires first. */
async function slowBoot(page: import('@playwright/test').Page) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  await page.route(/\/src\/ui\/main\.tsx/, async (r) => {
    await gate
    await r.fallback()
  })
  await page.clock.install()
  await page.goto('/', { waitUntil: 'commit' })
  await page.locator('#boot-error').waitFor({ state: 'attached' })
  await page.clock.fastForward(16_000)
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('the app did not render within 15 s')
  return { alert, release }
}

test('26c a render crash replaces the timeout panel that is up with the real error', async ({ page }) => {
  const { alert, release } = await slowBoot(page)
  await page.evaluate(() => (window as BootWindow).__ldBootFailed?.('crash while shown', true))
  await expect(alert).toContainText('crash while shown')
  await expect(alert).not.toContainText('did not render within 15 s')
  await expect(alert.getByRole('button', { name: 'Reload page' })).toHaveCount(1)
  release()
})

test('26d after a slow boot dropped the panel: a soft cause stays out, a render crash shows', async ({ page }) => {
  const { alert, release } = await slowBoot(page)
  release()
  await expect(page.locator('#boot-error')).toBeHidden()
  await page.evaluate(() => (window as BootWindow).__ldBootFailed?.('soft cause', false))
  await expect(page.locator('#boot-error')).toBeHidden()
  await page.evaluate(() => (window as BootWindow).__ldBootFailed?.('crash after drop', true))
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('crash after drop')
  await expect(alert).not.toContainText('did not render within 15 s')
})

test('27 Reload in the fallback reloads into a working window', async ({ page }) => {
  let block = true
  await page.route(REACT_DOM, (r) => (block ? r.abort('connectionrefused') : r.fallback()))
  await page.goto('/')
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 5_000 })
  block = false
  await page.getByRole('button', { name: 'Reload page' }).click()
  await expect(page.getByRole('main', { name: CANVAS_NAME })).toBeVisible()
  await expect(page.locator('#boot-error')).toBeHidden()
})
