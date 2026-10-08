import {
  altClick,
  CANVAS_NAME,
  chatDialog,
  clearQueue,
  expect,
  expectSameBox,
  FIXTURES,
  frameOf,
  inboxCard,
  markOver,
  NO_AGENT_CHAT,
  NO_AGENT_INBOX,
  noAgentListening,
  openInbox,
  openWindow,
  palette,
  paletteField,
  selectedBox,
  selectInFrame,
  sendFromChat,
  sendFromPalette,
  serveDir,
  serverRequests,
  test,
  waitForServerSnapshot,
  waitUntilNotListening,
  WAITING_LINE,
} from './helpers'

test.beforeEach(async () => {
  await clearQueue()
  // These tests send with nobody listening; an agent of an earlier test may still be in its grace period.
  await waitUntilNotListening()
})

test('10 chat: Enter sends → queued mark and inbox card; empty Enter only hints', async ({ page }) => {
  await openWindow(page)
  const cta = frameOf(page).getByTestId('cta-continue')
  await selectInFrame(page, cta)
  await palette(page).getByRole('button', { name: /^Chat with AI/ }).click()

  const chat = chatDialog(page)
  const input = chat.getByRole('textbox', { name: 'Message to the agent' })
  await expect(input).toBeFocused()
  // Nobody calls wait_for_message: the window says messages wait in the Inbox.
  await expect(noAgentListening(page)).toBeVisible()
  await expect(chat.getByText(NO_AGENT_CHAT)).toBeVisible()

  await input.press('Enter')
  await expect(chat.getByText('Describe the edit first')).toBeVisible()
  expect(await serverRequests(), 'an empty Enter must not create a request').toHaveLength(0)

  const comment = `e2e-10 make the button wider ${Date.now()}`
  await sendFromChat(page, comment)
  await expect(input).toHaveValue('')
  await expect(chat.getByRole('log')).toContainText(WAITING_LINE)
  await expect.poll(async () => (await serverRequests()).map((r) => r.comment)).toEqual([comment])

  await expect.poll(async () => Boolean(await markOver(page, 'queued', cta)), { message: 'queued mark over the button' }).toBe(true)
  await expect(page.getByRole('button', { name: /^Inbox: 1 open/ })).toBeVisible()
  const inbox = await openInbox(page)
  await expect(inboxCard(inbox, comment)).toContainText('Waiting for agent')
  await expect(inbox.getByText(NO_AGENT_INBOX)).toBeVisible()
})

test('10b the palette field: C focuses it, Enter sends and opens the chat; empty Enter and Escape keep things as they are', async ({ page }) => {
  await openWindow(page)
  const cta = frameOf(page).getByTestId('cta-continue')
  await selectInFrame(page, cta)
  const field = paletteField(page)
  await expect(field).toBeVisible()
  // Selecting does not take the focus off the frame: its keys walk the tree.
  await expect(field).not.toBeFocused()

  await page.keyboard.press('c')
  await expect(field).toBeFocused()
  await expect(field, 'the C that focused the field is not typed into it').toHaveValue('')

  await field.press('Enter')
  await expect(palette(page).getByText('Describe the edit first')).toBeVisible()
  await expect(chatDialog(page)).toHaveCount(0)
  expect(await serverRequests(), 'an empty Enter must not create a request').toHaveLength(0)

  // Escape with a draft only leaves the field: the selection and the text stay.
  await field.fill('draft to keep')
  await field.press('Escape')
  await expect(field).not.toBeFocused()
  await expect(selectedBox(page)).toHaveCount(1)
  await page.keyboard.press('c')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('draft to keep')

  const comment = `e2e-10b from the palette ${Date.now()}`
  await field.fill(comment)
  await field.press('Enter')
  const chat = chatDialog(page)
  await expect(chat).toBeVisible()
  await expect(chat.getByRole('log')).toContainText(comment)
  await expect.poll(async () => (await serverRequests()).map((r) => r.comment)).toEqual([comment])

  // Back from the chat: the field has the caret, empty, and the thread is one click away.
  await page.keyboard.press('Escape')
  await expect(chatDialog(page)).toHaveCount(0)
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('')
  await palette(page).getByRole('button', { name: 'Chat with AI, 1 edit' }).click()
  await expect(chatDialog(page).getByRole('log')).toContainText(comment)
})

test('10c the palette field draft belongs to its element', async ({ page }) => {
  await openWindow(page)
  await selectInFrame(page, frameOf(page).getByTestId('cta-continue'))
  await paletteField(page).fill('only for the button')
  // The palette sits next to the button and may cover its neighbour: pick the title instead.
  await selectInFrame(page, frameOf(page).getByRole('heading', { name: 'Годовая подписка' }))
  await expect(palette(page)).toHaveAccessibleName(/Годовая подписка/)
  await expect(paletteField(page)).toHaveValue('')
})

test('10d the chat of a low element keeps its side while its thread grows (1280×720)', async ({ page }) => {
  // Release recording: the chat opened above a low card, then jumped to the top-right corner
  // as soon as a new line no longer fit above it.
  const site = await serveDir(FIXTURES)
  try {
    await page.setViewportSize({ width: 1280, height: 720 })
    await openWindow(page, { target: `${site.url}/cards.html`, probe: (n) => n.anchors.testId === 'weekly-summary' })
    const card = frameOf(page).getByTestId('weekly-summary')
    const cardBox = (await card.boundingBox())!
    // The padding of the card, not its text: the pick takes the tightest box under the point.
    await altClick(page, cardBox.x + 8, cardBox.y + 8)
    await expect(palette(page)).toBeVisible()
    const anchor = (await selectedBox(page).boundingBox())!
    expectSameBox(anchor, cardBox)
    const canvas = (await page.getByRole('main', { name: CANVAS_NAME }).boundingBox())!

    const chatCard = page.locator('.float:not([aria-hidden]) .float__card--chat')
    const shots = process.env.LD_E2E_SHOTS_DIR ?? test.info().outputPath('shots')
    const seen: Array<{ side: string; box: { x: number; y: number; width: number; height: number } }> = []
    const record = async (step: number) => {
      // Placement runs in a layout effect after the card measured itself: wait until it holds still.
      let last = ''
      await expect
        .poll(async () => {
          const b = await chatCard.boundingBox()
          const now = JSON.stringify(b)
          const settled = now === last
          last = now
          return settled
        }, { intervals: [100] })
        .toBe(true)
      const side = /side-(\w+)/.exec((await chatCard.getAttribute('class')) ?? '')?.[1] ?? '?'
      seen.push({ side, box: (await chatCard.boundingBox())! })
      await page.screenshot({ path: `${shots}/chat-grow-${step}.png` })
    }

    const stamp = Date.now()
    await sendFromPalette(page, `e2e-10d first line ${stamp}`)
    await record(1)
    for (let i = 2; i <= 6; i++) {
      await sendFromChat(page, `e2e-10d line ${i}: make the summary card more compact and move the totals to the right ${stamp}`)
      await record(i)
    }

    const first = seen[0]!
    expect(seen[seen.length - 1]!.box.height, 'the thread grew the chat').toBeGreaterThan(first.box.height + 40)
    for (const [i, s] of seen.entries()) {
      expect(s.side, `step ${i + 1}: the chat stays on the side it opened on`).toBe(first.side)
      expect(s.box.y, `step ${i + 1}: inside the canvas (top)`).toBeGreaterThanOrEqual(canvas.y)
      expect(s.box.y + s.box.height, `step ${i + 1}: inside the canvas (bottom)`).toBeLessThanOrEqual(canvas.y + canvas.height + 0.5)
      const overlaps =
        s.box.x < anchor.x + anchor.width && anchor.x < s.box.x + s.box.width && s.box.y < anchor.y + anchor.height && anchor.y < s.box.y + s.box.height
      expect(overlaps, `step ${i + 1}: the chat does not cover the element it talks about`).toBe(false)
    }
  } finally {
    await site.close()
  }
})

test('18 two windows see the same queue', async ({ page, context }) => {
  const other = await context.newPage()
  await openWindow(page)
  await openWindow(other)

  const comment = `e2e-18 from the first window ${Date.now()}`
  await selectInFrame(page, frameOf(page).getByTestId('cta-continue'))
  await page.keyboard.press('c')
  await expect(paletteField(page)).toBeFocused()
  await sendFromPalette(page, comment)

  // The second window learns about it without a reload.
  await expect(other.getByRole('button', { name: /^Inbox: 1 open/ })).toBeVisible()
  const inbox = await openInbox(other)
  await expect(inboxCard(inbox, comment)).toContainText('Waiting for agent')
  const otherCta = frameOf(other).getByTestId('cta-continue')
  await expect.poll(async () => Boolean(await markOver(other, 'queued', otherCta))).toBe(true)

  // Opening the card there shows the same thread.
  await inboxCard(inbox, comment).click()
  await expect(chatDialog(other).getByRole('log')).toContainText(comment)
})

test('18b a snapshot lost with a dropped socket is sent again after the reconnect', async ({ page }) => {
  // The window sent the page snapshot only when the snapshot changed. If the socket died
  // with it in flight (server restart, proxy hiccup), a static page never produced another
  // one, and MCP saw no page until the user touched it.
  let lost = false
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => {
      if (!lost && typeof m === 'string' && m.includes('"t":"snapshot"')) {
        lost = true
        ws.close() // the snapshot goes down with the socket
        return
      }
      server.send(m)
    })
  })
  const since = Date.now()
  await page.goto('/')
  await expect(frameOf(page).getByTestId('cta-continue')).toBeVisible()
  await expect.poll(() => lost, { message: 'the window never tried to send its snapshot' }).toBe(true)
  await waitForServerSnapshot(since, (n) => n.anchors.testId === 'cta-continue')
})
