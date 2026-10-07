import {
  chatDialog,
  clearQueue,
  expect,
  frameOf,
  inboxCard,
  markOver,
  openInbox,
  openWindow,
  palette,
  selectInFrame,
  sendFromChat,
  serverRequests,
  test,
  waitForServerSnapshot,
} from './helpers'

test.beforeEach(async () => {
  await clearQueue()
})

test('10 chat: Enter sends → queued mark and inbox card; empty Enter only hints', async ({ page }) => {
  await openWindow(page)
  const cta = frameOf(page).getByTestId('cta-continue')
  await selectInFrame(page, cta)
  await palette(page).getByRole('menuitem', { name: /^Chat with AI/ }).click()

  const chat = chatDialog(page)
  const input = chat.getByRole('textbox', { name: 'Message to the agent' })
  await expect(input).toBeFocused()
  // No project configured for the e2e server: the window says edits go to the MCP queue.
  await expect(chat.getByText(/No agent is connected in the window/)).toBeVisible()

  await input.press('Enter')
  await expect(chat.getByText('Describe the edit first')).toBeVisible()
  expect(await serverRequests(), 'an empty Enter must not create a request').toHaveLength(0)

  const comment = `e2e-10 make the button wider ${Date.now()}`
  await sendFromChat(page, comment)
  await expect(input).toHaveValue('')
  await expect(chat.getByRole('log')).toContainText('Added to the queue; the agent picks it up via pending_requests')
  await expect.poll(async () => (await serverRequests()).map((r) => r.comment)).toEqual([comment])

  await expect.poll(async () => Boolean(await markOver(page, 'queued', cta)), { message: 'queued mark over the button' }).toBe(true)
  await expect(page.getByRole('button', { name: /^Inbox: 1 open/ })).toBeVisible()
  const inbox = await openInbox(page)
  await expect(inboxCard(inbox, comment)).toContainText('Queued')
})

test('18 two windows see the same queue', async ({ page, context }) => {
  const other = await context.newPage()
  await openWindow(page)
  await openWindow(other)

  const comment = `e2e-18 from the first window ${Date.now()}`
  await selectInFrame(page, frameOf(page).getByTestId('cta-continue'))
  await page.keyboard.press('c')
  await sendFromChat(page, comment)

  // The second window learns about it without a reload.
  await expect(other.getByRole('button', { name: /^Inbox: 1 open/ })).toBeVisible()
  const inbox = await openInbox(other)
  await expect(inboxCard(inbox, comment)).toContainText('Queued')
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
