import {
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

test('2 hover highlights the element under the cursor, click selects it, breadcrumbs go up', async ({ page }) => {
  await openWindow(page)
  const frame = frameOf(page)
  const cta = frame.getByTestId('cta-continue')
  const c = await centerOf(cta)

  await page.mouse.move(c.x, c.y)
  await expect(hoverBox(page)).toBeVisible()
  expectSameBox(await hoverBox(page).boundingBox(), c.box)
  await expect(hoverBox(page)).toContainText('button')

  // The highlight follows the cursor to the next element.
  const title = await centerOf(frame.getByRole('heading', { name: 'Годовая подписка' }))
  await page.mouse.move(title.x, title.y)
  await expect(async () => expectSameBox(await hoverBox(page).boundingBox(), title.box)).toPass({ timeout: 3_000 })
  await expect(hoverBox(page)).toContainText('h1')

  await page.mouse.click(c.x, c.y)
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

test('3 tools V / M / H by click and by key; Hand lets clicks through to the page', async ({ page }) => {
  await openWindow(page, { target: `${site.url}/counter.html`, probe: (n) => n.anchors.testId === 'counter' })
  const tool = (name: string) => page.getByRole('button', { name })
  const pressed = async (name: string) => {
    for (const n of ['Select (V)', 'Move (M)', 'Hand (H)']) {
      await expect(tool(n)).toHaveAttribute('aria-pressed', String(n === name))
    }
  }
  await pressed('Select (V)')

  await tool('Move (M)').click()
  await pressed('Move (M)')
  await tool('Hand (H)').click()
  await pressed('Hand (H)')
  await tool('Select (V)').click()
  await pressed('Select (V)')

  await page.keyboard.press('m')
  await pressed('Move (M)')
  await page.keyboard.press('h')
  await pressed('Hand (H)')
  await page.keyboard.press('v')
  await pressed('Select (V)')

  // Select: the overlay takes the click, the page never sees it.
  const counter = frameOf(page).getByTestId('counter')
  await selectInFrame(page, counter)
  await expect(counter).toHaveText('Click me')

  // Hand: no selection chrome, and the click reaches the page itself.
  await page.keyboard.press('h')
  await pressed('Hand (H)')
  await expect(palette(page)).toHaveCount(0)
  await expect(selectedBox(page)).toHaveCount(0)
  const { x, y } = await centerOf(counter)
  await page.mouse.click(x, y)
  await expect(counter).toHaveText('Clicked 1')
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

  await page.keyboard.press('c')
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
