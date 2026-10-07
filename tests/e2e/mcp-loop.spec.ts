import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  callText,
  chatDialog,
  clearQueue,
  clearSelection,
  expect,
  frameOf,
  inboxCard,
  markOver,
  openInbox,
  openWindow,
  ROOT,
  selectInFrame,
  sendFromChat,
  serveDir,
  serverRequests,
  startMcp,
  test,
} from './helpers'
import type { Locator, Page } from '@playwright/test'

let mcp: Client
test.beforeEach(async () => {
  await clearQueue()
  mcp = await startMcp()
})
test.afterEach(async () => {
  await mcp?.close()
})

/** The request id `pending_requests` printed for the request with this comment. */
function idFor(pendingText: string, comment: string): string {
  const block = pendingText.split('\n\n---\n\n').find((b) => b.includes(`Comment: ${comment}`))
  expect(block, `pending_requests lists "${comment}"`).toBeDefined()
  // `requestId: <id>` (contract), `[NEW] <date> — <id>` (older output).
  const m = /requestId: ([0-9a-f-]{36})/.exec(block!) ?? /— ([0-9a-f-]{36})/.exec(block!)
  expect(m, 'request id in the pending_requests output').not.toBeNull()
  return m![1]!
}

const hasMark = async (page: Page, kind: 'work' | 'refresh' | 'queued', el: Locator) => Boolean(await markOver(page, kind, el))
const blurred = async (page: Page, el: Locator) => (await hasMark(page, 'work', el)) || (await hasMark(page, 'refresh', el))

async function requestAsk(page: Page, element: Locator, comment: string) {
  await selectInFrame(page, element)
  await page.keyboard.press('c')
  await sendFromChat(page, comment)
  await expect.poll(() => hasMark(page, 'queued', element), { message: `queued mark for "${comment}"` }).toBe(true)
}

/**
 * A copy of the demo served from the test's own output dir: the "agent" edits that copy,
 * demo/index.html is never touched.
 */
async function demoCopy(): Promise<{ url: string; edit: () => Promise<void>; close: () => Promise<void> }> {
  const dir = test.info().outputPath('site')
  await mkdir(dir, { recursive: true })
  const demo = await readFile(join(ROOT, 'demo/index.html'), 'utf8')
  const original = demo.replace('<script src="/inspector.js"></script>', '__INSPECTOR__')
  expect(original, 'demo copy gets the absolute inspector tag').not.toBe(demo)
  const index = join(dir, 'index.html')
  await writeFile(index, original)
  const site = await serveDir(dir)
  return {
    url: `${site.url}/`,
    edit: () => writeFile(index, original.replace('>Продолжить<', '>Оплатить<')),
    close: site.close,
  }
}

/**
 * The window treats status changes in the first 1.5 s after its socket opens as replayed
 * history (App.tsx REPLAY_SETTLE_MS). A real agent needs longer than that to edit code;
 * the test stands in for that time so the main loop is checked on its own (case 11b
 * covers the fast reply separately).
 */
const AGENT_THINK_MS = 2_000

test('11 full MCP loop: pending_requests → blur → code change → reply_in_window → refreshed frame, reply, done', async ({ page }) => {
  const site = await demoCopy()
  try {
    const openedAt = Date.now()
    await openWindow(page, { target: site.url })
    const cta = frameOf(page).getByTestId('cta-continue')
    const comment = `e2e-11 rename the button to Оплатить ${Date.now()}`
    await requestAsk(page, cta, comment)

    const pending = await callText(mcp, 'pending_requests')
    const id = idFor(pending, comment)
    expect(pending).toContain('[NEW]')

    // Taken from the queue: the element goes under the "agent is working" blur.
    await expect.poll(() => hasMark(page, 'work', cta), { message: 'work mark (blur) over the button' }).toBe(true)
    const mark = (await markOver(page, 'work', cta))!
    expect(await mark.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain('blur')
    expect.soft((await serverRequests()).find((r) => r.id === id)?.status, 'contract: consumed request is `working` on the server').toBe('working')

    // The agent changes the code, then reports back for this very request.
    const thinking = openedAt + AGENT_THINK_MS - Date.now()
    if (thinking > 0) await page.waitForTimeout(thinking)
    await site.edit()
    const reply = `Renamed the button to «Оплатить» (${Date.now()})`
    const sent = await callText(mcp, 'reply_in_window', { text: reply, requestId: id })
    expect(sent).toContain('Sent to the window')

    // No hot reload in a static page: the window reloads the frame itself and the blur goes.
    await expect(cta).toHaveText('Оплатить', { timeout: 15_000 })
    await expect.poll(() => blurred(page, cta), { message: 'blur gone after the refresh', timeout: 15_000 }).toBe(false)
    await expect(chatDialog(page).getByRole('log')).toContainText(reply)

    const inbox = await openInbox(page)
    await inbox.getByRole('radio', { name: 'All' }).click()
    await expect(inboxCard(inbox, comment)).toContainText('Done')
    expect.soft((await serverRequests()).find((r) => r.id === id)?.status, 'contract: replied request is `done` on the server').toBe('done')
  } finally {
    await site.close()
  }
})

test('11b a reply that lands right after the window connected still refreshes the frame', async ({ page }) => {
  // Same loop as 11 without the agent's think time: the reply comes within ~1 s of the
  // window opening (a fast agent, or a window that just reconnected after a server restart).
  const site = await demoCopy()
  try {
    await openWindow(page, { target: site.url })
    const cta = frameOf(page).getByTestId('cta-continue')
    const comment = `e2e-11b quick rename ${Date.now()}`
    await requestAsk(page, cta, comment)
    const id = idFor(await callText(mcp, 'pending_requests'), comment)
    await site.edit()
    expect(await callText(mcp, 'reply_in_window', { text: `Done quickly (${Date.now()})`, requestId: id })).toContain('Sent to the window')

    await expect(cta, 'the window reloads the frame after "done"').toHaveText('Оплатить', { timeout: 15_000 })
  } finally {
    await site.close()
  }
})

test('12 two requests in work, reply to one by requestId → only that one is done', async ({ page }) => {
  await openWindow(page)
  const frame = frameOf(page)
  const cancel = frame.getByRole('button', { name: 'Отмена' })
  const cta = frame.getByTestId('cta-continue')
  const stamp = Date.now()
  const commentB = `e2e-12 B: make Отмена smaller ${stamp}`
  const commentA = `e2e-12 A: make Продолжить bolder ${stamp}`

  await requestAsk(page, cancel, commentB)
  await clearSelection(page)
  await requestAsk(page, cta, commentA)

  const pending = await callText(mcp, 'pending_requests')
  const idA = idFor(pending, commentA)
  const idB = idFor(pending, commentB)
  await expect.poll(() => hasMark(page, 'work', cta)).toBe(true)
  await expect.poll(() => hasMark(page, 'work', cancel)).toBe(true)

  const sent = await callText(mcp, 'reply_in_window', { text: `A handled (${stamp})`, requestId: idA })
  expect(sent).toContain('Sent to the window')

  await expect.poll(() => blurred(page, cta), { message: 'A leaves work', timeout: 15_000 }).toBe(false)
  const inbox = await openInbox(page)
  await inbox.getByRole('radio', { name: 'All' }).click()
  await expect(inboxCard(inbox, commentA)).toContainText('Done')
  // B was not answered: it stays in work, in the inbox and over its element.
  await expect(inboxCard(inbox, commentB)).toContainText('Agent editing')
  await expect(inboxCard(inbox, commentB)).not.toContainText('Done')
  expect(await hasMark(page, 'work', cancel), 'B keeps its work mark').toBe(true)

  const statuses = Object.fromEntries((await serverRequests()).map((r) => [r.id, r.status]))
  expect.soft(statuses[idA], 'contract: A is `done` on the server').toBe('done')
  expect.soft(statuses[idB], 'contract: B stays `working` on the server').toBe('working')
})
