import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  callText,
  centerOf,
  chatDialog,
  clearQueue,
  clearSelection,
  expect,
  frameOf,
  inboxCard,
  markOver,
  openInbox,
  openWindow,
  paletteField,
  ROOT,
  selectedBox,
  selectInFrame,
  sendFromPalette,
  serveDir,
  serverRequests,
  startMcp,
  test,
} from './helpers'
import type { BrowserContext, Locator, Page } from '@playwright/test'

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

/** Every picture the compositor produces until the returned stop() (screencast sends one per new frame). */
async function screencast(context: BrowserContext, page: Page): Promise<() => Promise<string[]>> {
  const cdp = await context.newCDPSession(page)
  const frames: string[] = []
  cdp.on('Page.screencastFrame', (f) => {
    frames.push(f.data)
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  return async () => {
    await cdp.send('Page.stopScreencast')
    return frames
  }
}

/** With LD_E2E_FRAMES_DIR set, the captured pictures and the per-frame log go there for a human to look at. */
async function saveFrames(prefix: string, frames: string[], log: unknown): Promise<void> {
  const dir = process.env.LD_E2E_FRAMES_DIR
  if (!dir) return
  await mkdir(dir, { recursive: true })
  await Promise.all(frames.map((f, i) => writeFile(join(dir, `${prefix}-${String(i).padStart(3, '0')}.png`), Buffer.from(f, 'base64'))))
  await writeFile(join(dir, `${prefix}-log.json`), JSON.stringify(log, null, 1))
}

const hasMark = async (page: Page, kind: 'work' | 'refresh' | 'queued', el: Locator) => Boolean(await markOver(page, kind, el))
const blurred = async (page: Page, el: Locator) => (await hasMark(page, 'work', el)) || (await hasMark(page, 'refresh', el))

async function requestAsk(page: Page, element: Locator, comment: string) {
  await selectInFrame(page, element)
  await page.keyboard.press('c')
  await expect(paletteField(page)).toBeFocused()
  await sendFromPalette(page, comment)
  await expect.poll(() => hasMark(page, 'queued', element), { message: `queued mark for "${comment}"` }).toBe(true)
}

/**
 * A copy of the demo served from the test's own output dir: the "agent" edits that copy,
 * demo/index.html is never touched.
 */
async function demoCopy(delayMs = 0): Promise<{ url: string; edit: () => Promise<void>; close: () => Promise<void> }> {
  const dir = test.info().outputPath('site')
  await mkdir(dir, { recursive: true })
  const demo = await readFile(join(ROOT, 'demo/index.html'), 'utf8')
  const original = demo.replace('<script src="/inspector.js"></script>', '__INSPECTOR__')
  expect(original, 'demo copy gets the absolute inspector tag').not.toBe(demo)
  const index = join(dir, 'index.html')
  await writeFile(index, original)
  const site = await serveDir(dir, { delayMs })
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

test('11c the frame reload after "done" is seamless: no white frame, no "Connecting inspector…"', async ({ page, context }) => {
  // Release recording: while the window reloaded the page after the agent's reply, the page
  // area went white for a frame or two and the header flashed "Connecting inspector…".
  // A dev server answers in tens of milliseconds; a slower one makes the gap visible to the screencast.
  const site = await demoCopy(250)
  try {
    const openedAt = Date.now()
    await openWindow(page, { target: site.url })
    const cta = frameOf(page).getByTestId('cta-continue')
    const comment = `e2e-11c seamless reload ${Date.now()}`
    await requestAsk(page, cta, comment)
    const id = idFor(await callText(mcp, 'pending_requests'), comment)
    await expect.poll(() => hasMark(page, 'work', cta)).toBe(true)
    const thinking = openedAt + AGENT_THINK_MS - Date.now()
    if (thinking > 0) await page.waitForTimeout(thinking)
    await site.edit()

    // A point of the page's own background (#f4f5f7), left of its centred column: white
    // there means the frame shows no page at all.
    const frameBox = (await page.locator('.canvas iframe[title]').boundingBox())!
    const probe = { x: frameBox.x + 12, y: frameBox.y + frameBox.height / 2 }

    // Every frame the window paints: what the header says, and how many frames are in the canvas.
    await page.evaluate(() => {
      const log: Array<{ status: string; progress: boolean; frames: number }> = []
      ;(window as unknown as { __frameLog: typeof log }).__frameLog = log
      const tick = () => {
        log.push({
          status: document.querySelector('.tb .status')?.textContent ?? '',
          progress: Boolean(document.querySelector('.tb__progress')),
          frames: document.querySelectorAll('.canvas iframe').length,
        })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const stopScreencast = await screencast(context, page)

    expect(await callText(mcp, 'reply_in_window', { text: `Renamed (${Date.now()})`, requestId: id })).toContain('Sent to the window')
    await expect(cta).toHaveText('Оплатить', { timeout: 15_000 })
    await expect.poll(() => blurred(page, cta), { message: 'blur gone after the refresh', timeout: 15_000 }).toBe(false)
    await page.waitForTimeout(300)
    const frames = await stopScreencast()

    const log = await page.evaluate(() => (window as unknown as { __frameLog: Array<{ status: string; progress: boolean; frames: number }> }).__frameLog)

    // Decode the probe pixel of every captured picture in a scratch page.
    const decoder = await context.newPage()
    const pixels = await decoder.evaluate(
      async ({ list, at }) => {
        const out: number[][] = []
        for (const b64 of list) {
          const img = new Image()
          img.src = `data:image/png;base64,${b64}`
          await img.decode()
          const c = document.createElement('canvas')
          c.width = img.naturalWidth
          c.height = img.naturalHeight
          const ctx = c.getContext('2d')!
          ctx.drawImage(img, 0, 0)
          out.push([...ctx.getImageData(Math.round(at.x), Math.round(at.y), 1, 1).data.slice(0, 3)])
        }
        return out
      },
      { list: frames, at: probe },
    )
    await decoder.close()
    await saveFrames('reload', frames, { probe, pixels, log })
    expect(log.length, 'the window painted frames during the refresh').toBeGreaterThan(20)
    expect(log.filter((l) => /Connecting inspector/.test(l.status)), 'no "Connecting inspector…" during a planned refresh').toEqual([])
    expect(log.filter((l) => l.progress), 'no loading bar during a planned refresh').toEqual([])
    expect(frames.length, 'screencast captured the refresh').toBeGreaterThan(3)
    const white = pixels.map((p, i) => ({ i, p })).filter(({ p }) => p.every((c) => c >= 252))
    expect(white, 'no captured frame shows a blank (white) page area').toEqual([])
  } finally {
    await site.close()
  }
})

type Rect = { x: number; y: number; width: number; height: number }
const near = (a: Rect | null, b: Rect, tol = 2) =>
  Boolean(a) && (['x', 'y', 'width', 'height'] as const).every((k) => Math.abs(a![k] - b[k]) <= tol)

test('11d a live-moved element: during the frame swap the selection box and the blur stay on what is visible', async ({ page, context }) => {
  // Release recording: the element was dragged down before the request. While the window
  // swapped the old page for the reloaded one, the box and the blur jumped back to the
  // element's place before the drag for one frame — the old page on screen still showed it moved.
  const site = await demoCopy()
  try {
    const openedAt = Date.now()
    await openWindow(page, { target: site.url })
    const cta = frameOf(page).getByTestId('cta-continue')
    await selectInFrame(page, cta)
    const c = await centerOf(cta)
    await page.mouse.move(c.x, c.y)
    await page.mouse.down()
    await page.mouse.move(c.x + 60, c.y + 140, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => cta.evaluate((el) => (el as HTMLElement).style.translate)).toBe('60px 140px')
    const moved = { ...c.box, x: c.box.x + 60, y: c.box.y + 140 }
    await expect(async () => expect(near(await selectedBox(page).boundingBox(), moved)).toBe(true)).toPass({ timeout: 3_000 })

    const comment = `e2e-11d move it into code ${Date.now()}`
    await page.keyboard.press('c')
    await expect(paletteField(page)).toBeFocused()
    await sendFromPalette(page, comment)
    const id = idFor(await callText(mcp, 'pending_requests'), comment)
    await expect.poll(() => hasMark(page, 'work', cta)).toBe(true)
    const thinking = openedAt + AGENT_THINK_MS - Date.now()
    if (thinking > 0) await page.waitForTimeout(thinking)
    await site.edit()

    // Every frame the window paints: where the selection box and the blur are, and whether the old page is held.
    await page.evaluate(() => {
      const rect = (sel: string) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      const log: unknown[] = []
      ;(window as unknown as { __boxLog: unknown[] }).__boxLog = log
      const tick = () => {
        log.push({
          box: rect('.overlay .box--selected'),
          mark: rect('.overlay .mark--work, .overlay .mark--refresh'),
          held: document.querySelectorAll('.canvas iframe.frame--held').length,
        })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const stopScreencast = await screencast(context, page)

    expect(await callText(mcp, 'reply_in_window', { text: `Moved into code (${Date.now()})`, requestId: id })).toContain('Sent to the window')
    await expect(cta).toHaveText('Оплатить', { timeout: 15_000 })
    await expect.poll(() => blurred(page, cta), { message: 'blur gone after the refresh', timeout: 15_000 }).toBe(false)
    await page.waitForTimeout(300)
    const frames = await stopScreencast()
    // The agent took the move into code: the reloaded page has no live offset, the element is where the code puts it.
    const final = (await cta.boundingBox())!
    expect(near(final, c.box), 'the reloaded page shows the element without the live move').toBe(true)

    type Entry = { box: Rect | null; mark: Rect | null; held: number }
    const log = await page.evaluate(() => (window as unknown as { __boxLog: unknown[] }).__boxLog as Entry[])
    await saveFrames('swap', frames, { moved, final, log })
    const h0 = log.findIndex((l) => l.held > 0)
    const h1 = log.findIndex((l, i) => i > h0 && l.held === 0)
    expect(h0, 'the old page was held during the reload').toBeGreaterThanOrEqual(0)
    expect(h1, 'and was let go').toBeGreaterThan(h0)
    const wrong = log
      .map((l, i) => ({ i, ...l, want: i < h1 ? 'moved' : 'final' }))
      .filter((l) => !near(l.box, l.want === 'moved' ? moved : final) || (l.mark !== null && !near(l.mark, l.box!)))
    expect(wrong, `frames ${h0}..${h1 - 1} hold the old page: the box stays on the moved element until the swap, then sits on the reloaded one`).toEqual([])
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
