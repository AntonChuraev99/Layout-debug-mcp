import { chatDialog, expect, palette, selectedBox, test } from './helpers'
import { clickCard, openAndroidWindow } from './fakeDevice'

test('android: live video switch with no scrcpy falls back to snapshots and says why', async ({ page }) => {
  const device = await openAndroidWindow(page)
  const toggle = page.getByRole('button', { name: 'Live video', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  const pill = page.getByRole('button', { name: 'Live video off', exact: true })
  await expect(pill).toBeVisible()
  expect(device.streams()).toBe(1)
  await pill.click()
  const pop = page.getByRole('dialog', { name: 'Live video off' })
  await expect(pop).toContainText('scrcpy was not found')
  await expect(pop).toContainText('LD_SCRCPY_SERVER is not set')
  await page.screenshot({ path: `${process.env.LD_E2E_SHOTS_DIR ?? test.info().outputPath('shots')}/android-video-fallback.png` })

  // Still the snapshot loop: frames keep landing, each asking for the picture too.
  await expect(page.locator('img.device')).toBeVisible()
  const from = device.frames()
  await expect.poll(device.frames, { timeout: 10_000 }).toBeGreaterThanOrEqual(from + 2)
  expect(device.pictureFlags().every((p) => p !== false)).toBe(true)

  await pop.getByRole('button', { name: 'Turn live video off' }).click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(pill).toBeHidden()
})

test('android: live video outside a browser with WebCodecs stays on snapshots and says so', async ({ page }) => {
  await page.addInitScript(() => {
    // A browser without WebCodecs, as the window sees it.
    delete (window as { VideoDecoder?: unknown }).VideoDecoder
  })
  const device = await openAndroidWindow(page)
  await page.getByRole('button', { name: 'Live video', exact: true }).click()
  const pill = page.getByRole('button', { name: 'Live video off', exact: true })
  await pill.click()
  await expect(page.getByRole('dialog', { name: 'Live video off' })).toContainText('no WebCodecs video decoder')
  // Nothing was asked of the server, and the frame is the snapshot.
  expect(device.streams()).toBe(0)
  await expect(page.locator('img.device')).toBeVisible()
})

test('android: the open chat survives a drag of its element (text, same card)', async ({ page }) => {
  const device = await openAndroidWindow(page)
  await clickCard(page)
  await palette(page).getByRole('button', { name: /^Chat with AI/ }).click()
  const chat = chatDialog(page)
  await expect(chat).toBeVisible()
  const field = chat.getByRole('textbox', { name: 'Message to the agent' })
  await field.fill('half a thought about this card')
  await chat.evaluate((el) => el.setAttribute('data-e2e-mark', '1'))

  // Several recaptures with the chat open: the card follows its element by anchors.
  const from = device.frames()
  await expect.poll(device.frames, { timeout: 10_000 }).toBeGreaterThanOrEqual(from + 2)
  await expect(chat).toHaveAttribute('data-e2e-mark', '1')

  const box = (await selectedBox(page).boundingBox())!
  const start = { x: box.x + box.width * 0.75, y: box.y + box.height * 0.75 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 20, start.y + 10, { steps: 4 })
  // While dragging the card stands aside...
  await expect(chat).toBeHidden()
  await page.mouse.move(start.x + 40, start.y + 30, { steps: 4 })
  await page.mouse.up()

  // ...and comes back as the same card, with what the user typed.
  await expect(chat).toBeVisible()
  await expect(chat, 'the same chat: it was not mounted anew').toHaveAttribute('data-e2e-mark', '1')
  await expect(field).toHaveValue('half a thought about this card')
  await page.screenshot({ path: `${process.env.LD_E2E_SHOTS_DIR ?? test.info().outputPath('shots')}/android-chat-after-drag.png` })
})
