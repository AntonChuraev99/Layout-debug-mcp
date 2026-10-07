import {
  addressField,
  CANVAS_NAME,
  centerOf,
  clearQueue,
  DEMO_URL,
  expect,
  FIXTURES,
  frameOf,
  INSPECTOR_TAG,
  openWindow,
  palette,
  pipetteButton,
  selectInFrame,
  serveDir,
  test,
  UI_URL,
  waitForServerSnapshot,
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

test('1 empty state: no target → open a URL typed without a scheme', async ({ page }) => {
  // The server config always carries a target (the demo by default), so the empty state
  // only shows when `ready` arrives without one: the test rewrites that single field.
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer()
    server.onMessage((raw) => {
      if (typeof raw === 'string') {
        const msg = JSON.parse(raw) as { t: string; targetUrl?: string }
        if (msg.t === 'ready') {
          ws.send(JSON.stringify({ ...msg, targetUrl: '' }))
          return
        }
      }
      ws.send(raw)
    })
  })

  const since = Date.now()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Open the page you want to edit' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'http://localhost:5173' })).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
  // Nothing to inspect yet: the pipette says why instead of doing nothing.
  await expect(pipetteButton(page)).toHaveAttribute('aria-disabled', 'true')

  const typed = DEMO_URL.replace(/^http:\/\//, '')
  await addressField(page).fill(typed)
  await page.getByRole('button', { name: 'Open', exact: true }).click()

  await expect(addressField(page)).toHaveValue(DEMO_URL)
  await expect(page.locator('iframe[title="Page being edited"]')).toHaveAttribute('src', DEMO_URL)
  await expect(frameOf(page).getByRole('heading', { name: 'Годовая подписка' })).toBeVisible()
  await waitForServerSnapshot(since, (n) => n.anchors.testId === 'cta-continue')
  await expect(page.getByText(/^\d+ layers$/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Open the page you want to edit' })).toHaveCount(0)
  await expect(pipetteButton(page)).not.toHaveAttribute('aria-disabled', 'true')
})

test('13 language switch EN → RU survives a reload', async ({ page }) => {
  await openWindow(page)
  const lang = page.getByRole('radiogroup', { name: 'Language' })
  await expect(lang.getByRole('radio', { name: 'English' })).toHaveAttribute('aria-checked', 'true')

  await lang.getByRole('radio', { name: 'Русский' }).click()
  await expect(page.getByRole('button', { name: 'Открыть', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Выбрать слой — или зажми Alt' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')

  await page.reload()
  await expect(page.getByRole('radiogroup', { name: 'Язык' }).getByRole('radio', { name: 'Русский' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('button', { name: 'Открыть', exact: true })).toBeVisible()
  await expect(page.getByRole('main', { name: 'Кадр. Зажми Alt и кликни, чтобы выделить слой' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
})

test('13b the first-run hint shows once: Got it, the first pick or Escape closes it for good', async ({ page }) => {
  await openWindow(page, { coach: true })
  const coach = page.getByRole('dialog', { name: 'The page works as usual' })
  await expect(coach).toBeVisible()
  await expect(coach).toContainText('hold Alt and click it')
  // The first pick closes it too.
  await selectInFrame(page, frameOf(page).getByTestId('cta-continue'))
  await expect(coach).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.overlay')).toBeAttached({ timeout: 20_000 })
  await expect(page.getByText(/^\d+ layers$/)).toBeVisible()
  await expect(coach).toHaveCount(0)
})

test('13c the hint folds to its key cap below 1200 px and keeps the full text in the tooltip', async ({ page }) => {
  await page.setViewportSize({ width: 1199, height: 800 })
  await openWindow(page)
  await expect(page.locator('.pick__stack')).toBeHidden()
  await expect(page.locator('.pick__kap')).toBeVisible()
  await expect(page.locator('.pick__tip')).toHaveText('Hold Alt: hover to inspect, click to select, scroll for the parent layer')
  await page.setViewportSize({ width: 1200, height: 800 })
  await expect(page.locator('.pick__stack')).toBeVisible()
  await expect(page.locator('.pick__stack')).toContainText('hover to inspect · click to select')
})

test('15 page without the inspector script → banner names the real server port', async ({ page }) => {
  await page.goto('/')
  await expect(addressField(page)).not.toHaveValue('')
  await addressField(page).fill(`${site.url}/no-inspector.html`)
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(frameOf(page).getByTestId('plain-title')).toBeVisible()

  const banner = page.getByRole('status').filter({ hasText: "The inspector didn't respond" })
  await expect(banner).toBeVisible({ timeout: 15_000 })
  // The snippet must point at the server this window talks to (SERVER_PORT), not the default 5175.
  await expect(banner.locator('code')).toHaveText(INSPECTOR_TAG)
  await expect(banner).not.toContainText(':5175/')
  const pill = page.getByRole('button', { name: 'Inspector not responding' })
  await expect(pill).toBeVisible()

  // Closing the banner keeps a way back to it.
  await banner.getByRole('button', { name: 'Close' }).click()
  await expect(banner).toHaveCount(0)
  await pill.click()
  await expect(page.getByRole('status').filter({ hasText: "The inspector didn't respond" })).toBeVisible()
})

test('16 data-source-loc becomes the anchor: palette, details and copy show file:line', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: UI_URL })
  await openWindow(page, { target: `${site.url}/source-loc.html`, probe: (n) => n.anchors.testId === 'pay' })
  await selectInFrame(page, frameOf(page).getByTestId('pay'))

  const p = palette(page)
  await expect(p.getByText('src/components/PayButton.tsx:42', { exact: true })).toBeVisible()

  await p.getByRole('menuitem', { name: 'Details' }).click()
  await expect(p.getByRole('menuitem', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true')
  const source = p.locator('dl dt', { hasText: 'Source' })
  await expect(source).toBeVisible()
  await expect(source.locator('xpath=following-sibling::dd[1]')).toHaveText('src/components/PayButton.tsx:42')

  await p.getByRole('menuitem', { name: 'Copy anchor' }).click()
  await expect(p.getByRole('menuitem', { name: 'Copied' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('src/components/PayButton.tsx:42')
})

test('17 at 1024 px the palette goes left of a right-edge element and below a full-width one', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await openWindow(page, { target: `${site.url}/edges.html`, probe: (n) => n.anchors.testId === 'edge' })
  const canvas = (await page.getByRole('main', { name: CANVAS_NAME }).boundingBox())!

  const inside = (b: { x: number; y: number; width: number; height: number }) => {
    expect(b.x).toBeGreaterThanOrEqual(canvas.x)
    expect(b.y).toBeGreaterThanOrEqual(canvas.y)
    expect(b.x + b.width).toBeLessThanOrEqual(canvas.x + canvas.width)
    expect(b.y + b.height).toBeLessThanOrEqual(canvas.y + canvas.height)
  }

  // Right edge: no room on the right, so left of the element, not over it.
  const edge = frameOf(page).getByTestId('edge')
  await selectInFrame(page, edge)
  const edgeBox = (await centerOf(edge)).box
  await expect(async () => {
    const b = (await palette(page).boundingBox())!
    expect(b.x + b.width, 'palette right edge vs element left edge').toBeLessThanOrEqual(edgeBox.x)
    inside(b)
  }).toPass({ timeout: 5_000 })

  // Full width: no room on either side, so below it.
  await page.keyboard.press('Escape')
  const bar = frameOf(page).getByTestId('bar')
  await selectInFrame(page, bar)
  const barBox = (await centerOf(bar)).box
  await expect(async () => {
    const b = (await palette(page).boundingBox())!
    expect(b.y, 'palette top vs element bottom').toBeGreaterThanOrEqual(barBox.y + barBox.height)
    inside(b)
  }).toPass({ timeout: 5_000 })
})
