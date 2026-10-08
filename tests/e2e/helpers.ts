import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test as base, type Locator, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { EditRequest, LayoutNode, Snapshot } from '../../src/shared/protocol.ts'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const FIXTURES = join(ROOT, 'tests/e2e/fixtures')
/** Same defaults and overrides as playwright.config.ts (a second suite runs on its own pair). */
export const UI_PORT = Number(process.env.LD_E2E_UI_PORT || 5284)
export const SERVER_PORT = Number(process.env.LD_E2E_SERVER_PORT || 5285)
/** IPv4 literal, not `localhost`: Vite binds one loopback family (see playwright.config.ts). */
export const UI_URL = `http://127.0.0.1:${UI_PORT}`
/** Node flag that makes a Vite started by a test bind 127.0.0.1 instead of `::1`. */
export const IPV4_FIRST = [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first'].filter(Boolean).join(' ')
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`
/** The bundled demo, the server's default target (src/server/config.ts). */
export const DEMO_URL = `${SERVER_URL}/demo/`
export const INSPECTOR_TAG = `<script src="${SERVER_URL}/inspector.js"></script>`
/** Fixture pages say where the inspector goes; the static server fills in the real port. */
const INSPECTOR_PLACEHOLDER = '__INSPECTOR__'

// --- server session ----------------------------------------------------------

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, init)
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

export async function serverRequests(): Promise<EditRequest[]> {
  return (await api<{ requests: EditRequest[] }>('/api/requests')).requests
}

/**
 * Every test starts from an empty queue. Chat history stays on the server (there is
 * no endpoint to clear it), so assertions name their own unique comment text.
 */
export async function clearQueue(): Promise<void> {
  await api('/api/requests', { method: 'DELETE' })
}

export interface Health {
  ok: boolean
  name: string
  version: string
  pid: number
  windows: number
  listening: boolean
  windowUrl: string
}

export const health = () => api<Health>('/api/health')

/**
 * An agent counts as listening for 10 s after its last wait_for_message ended
 * (src/server/waiters.ts LISTEN_GRACE_MS). Tests that check the "no agent" copy start
 * once the shared server says nobody listens; call after clearQueue(), which closes
 * requests a previous test's agent left in work.
 */
export async function waitUntilNotListening(): Promise<void> {
  await expect
    .poll(async () => (await health()).listening, { timeout: 20_000, message: 'an agent still counts as listening' })
    .toBe(false)
}

/**
 * The window mirrors the page snapshot to the server ~1 s after it changes. A snapshot
 * that is newer than `since` and contains the node proves the window sees that page.
 */
export async function waitForServerSnapshot(since: number, has: (n: LayoutNode) => boolean): Promise<Snapshot> {
  let found: Snapshot | null = null
  await expect
    .poll(
      async () => {
        const { snapshot } = await api<{ snapshot: Snapshot | null }>('/api/snapshot')
        found = snapshot && snapshot.createdAt >= since && Object.values(snapshot.nodes).some(has) ? snapshot : null
        return Boolean(found)
      },
      { timeout: 20_000, message: 'the window never mirrored a fresh snapshot of the page to the server' },
    )
    .toBe(true)
  return found!
}

/** Shared test: waits once per worker until the server behind the UI answers. */
export const test = base.extend<object, { serverReady: void }>({
  serverReady: [
    async ({}, use) => {
      await expect
        .poll(async () => fetch(`${SERVER_URL}/api/health`).then((r) => r.ok).catch(() => false), {
          timeout: 60_000,
          message: `layout-debug server on ${SERVER_URL} did not come up`,
        })
        .toBe(true)
      await use()
    },
    { scope: 'worker', auto: true },
  ],
})
export { expect }

// --- static pages ------------------------------------------------------------

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }

export interface StaticSite {
  url: string
  close: () => Promise<void>
}

/**
 * Serves `dir` on a free loopback port, never cached, with the inspector tag filled in.
 * `delayMs` holds every response that long: a dev server that takes a moment to answer,
 * so the gap between leaving a page and painting the next one is long enough to see.
 */
export async function serveDir(dir: string, opts: { delayMs?: number } = {}): Promise<StaticSite> {
  const server: Server = createServer(async (req, res) => {
    if (opts.delayMs) await new Promise((ok) => setTimeout(ok, opts.delayMs))
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const rel = normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^([/\\])+/, '')
    const file = join(dir, rel)
    if (!file.startsWith(dir)) {
      res.writeHead(403).end('outside the fixture dir')
      return
    }
    try {
      let body = await readFile(file, 'utf8')
      if (file.endsWith('.html')) body = body.replaceAll(INSPECTOR_PLACEHOLDER, INSPECTOR_TAG)
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end(`fixture not found: ${rel}`)
    }
  })
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => ok())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('static server has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  }
}

// --- the window ----------------------------------------------------------------

export const frameOf = (page: Page) => page.frameLocator('iframe[title="Page being edited"]')
/** The card next to the selected element: a dialog with the chat field and the menu of rows. */
export const palette = (page: Page) => page.getByRole('dialog', { name: /^Actions:/ })
/** The always-open chat field of the palette. */
export const paletteField = (page: Page) => palette(page).getByRole('textbox', { name: 'Message to the agent' })
export const chatDialog = (page: Page) => page.getByRole('dialog', { name: /^Chat:/ })
export const addressField = (page: Page) => page.getByRole('textbox', { name: 'Page address' })
export const selectedBox = (page: Page) => page.locator('.overlay .box--selected')
export const hoverBox = (page: Page) => page.locator('.overlay .box--hover')
/** Accessible name of the web frame (the window's `main`). */
export const CANVAS_NAME = 'Frame. Hold Alt and click to select a layer'
export const pipetteButton = (page: Page) => page.getByRole('button', { name: 'Pick a layer — or hold Alt' })
/** The header indicator of listen mode (src/ui/i18n.ts agent.listening / agent.none). */
export const agentListening = (page: Page) => page.getByRole('button', { name: 'Agent listening', exact: true })
export const noAgentListening = (page: Page) => page.getByRole('button', { name: 'No agent listening', exact: true })
/** Window copy for an edit sent with nobody listening (src/ui/i18n.ts). */
export const NO_AGENT_CHAT = 'No agent is listening. Messages wait in the Inbox until one connects.'
export const WAITING_LINE = 'Waiting for an agent. It gets this edit as soon as one listens.'
export const NO_AGENT_INBOX = 'No agent is listening. Queued edits go out when one connects.'

/**
 * Opens the window and waits until it shows `target` (default: the server's own
 * target, the demo) with a live inspector. `probe` is a node the page must contain.
 */
export async function openWindow(
  page: Page,
  opts: { target?: string; probe?: (n: LayoutNode) => boolean; coach?: boolean } = {},
): Promise<void> {
  const since = Date.now()
  // The first-run hint covers the top-left of the page; tests that are not about it start
  // as a returning user (window.spec.ts covers the hint itself).
  if (!opts.coach) {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('layout-debug.coachSeen', '1')
      } catch {
        // No storage: the hint shows, and a test that needs the corner will say so.
      }
    })
  }
  await page.goto('/')
  await expect(page.getByRole('main', { name: CANVAS_NAME })).toBeVisible()
  if (opts.target) {
    // The first `ready` seeds the field with the server's target; typing before that gets overwritten.
    await expect(addressField(page)).not.toHaveValue('')
    await addressField(page).fill(opts.target)
    await page.getByRole('button', { name: 'Open', exact: true }).click()
  }
  await waitForServerSnapshot(since, opts.probe ?? ((n) => n.anchors.testId === 'cta-continue'))
  await expect(page.locator('.overlay')).toBeAttached()
}

export async function centerOf(loc: Locator): Promise<{ x: number; y: number; box: { x: number; y: number; width: number; height: number } }> {
  await expect(loc).toBeVisible()
  const box = await loc.boundingBox()
  if (!box) throw new Error(`no bounding box for ${loc}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }
}

/** A click with Alt held: the selection gesture (the page itself is live without it). */
export async function altClick(page: Page, x: number, y: number): Promise<void> {
  await page.keyboard.down('Alt')
  try {
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.up()
  } finally {
    await page.keyboard.up('Alt')
  }
}

/** Alt+clicks right above an element of the page: the way a user selects it. */
export async function selectInFrame(page: Page, element: Locator): Promise<void> {
  const { x, y } = await centerOf(element)
  await altClick(page, x, y)
  await expect(palette(page)).toBeVisible()
}

/** Closes chat, details and selection: Escape until nothing floats over the page. */
export async function clearSelection(page: Page): Promise<void> {
  for (let i = 0; i < 4 && (await selectedBox(page).count()) > 0; i++) await page.keyboard.press('Escape')
  await expect(selectedBox(page)).toHaveCount(0)
}

/** Two boxes agree within `tol` px on every edge. */
export function expectSameBox(
  actual: { x: number; y: number; width: number; height: number } | null,
  expected: { x: number; y: number; width: number; height: number },
  tol = 2,
): void {
  expect(actual, 'element has no box').not.toBeNull()
  const a = actual!
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(a[k] - expected[k]), `${k}: ${a[k]} vs ${expected[k]}`).toBeLessThanOrEqual(tol)
  }
}

/** Overlay mark of the given kind over `element`'s box, if any. */
export async function markOver(page: Page, kind: 'work' | 'refresh' | 'queued' | 'done', element: Locator): Promise<Locator | null> {
  const target = await element.boundingBox()
  if (!target) return null
  for (const mark of await page.locator(`.overlay .mark--${kind}`).all()) {
    const b = await mark.boundingBox()
    if (b && Math.abs(b.x - target.x) <= 2 && Math.abs(b.y - target.y) <= 2 && Math.abs(b.width - target.width) <= 2) return mark
  }
  return null
}

/** Sends a chat message from the open chat popover of the selected element. */
export async function sendFromChat(page: Page, text: string): Promise<void> {
  const chat = chatDialog(page)
  await expect(chat).toBeVisible()
  const input = chat.getByRole('textbox', { name: 'Message to the agent' })
  await input.fill(text)
  await input.press('Enter')
  await expect(chat.getByRole('log')).toContainText(text)
}

/** Types into the palette's field of the selected element and sends: the chat opens with the message. */
export async function sendFromPalette(page: Page, text: string): Promise<void> {
  const input = paletteField(page)
  await input.fill(text)
  await input.press('Enter')
  await expect(chatDialog(page).getByRole('log')).toContainText(text)
}

export async function openInbox(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: 'Requests' })
  if (!(await dialog.isVisible())) await page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(dialog).toBeVisible()
  return dialog
}

/** An inbox card is a button whose name carries the comment text. */
export const inboxCard = (inbox: Locator, comment: string) => inbox.getByRole('button', { name: new RegExp(escapeRe(comment)) })

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// --- MCP -----------------------------------------------------------------------

/**
 * The real MCP stdio server of the tool, pointed at the e2e server by port.
 * LD_SERVER_URL stays unset on purpose: with it, open_window treats the server as
 * external and never decides whether to start one, which is what the listen tests check.
 * No browser is ever opened, and wait_for_message defaults to a short wait.
 */
export async function startMcp(extraEnv: Record<string, string> = {}): Promise<Client> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'LD_SERVER_URL') env[k] = v
  env.LD_SERVER_PORT = String(SERVER_PORT)
  env.LD_UI_PORT = String(UI_PORT)
  env.LD_NO_BROWSER = '1'
  env.LD_WAIT_SECONDS = '5'
  Object.assign(env, extraEnv)
  // Same loader as `npx tsx`, without a shell in between (Windows-safe, killable).
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp/index.ts'],
    cwd: ROOT,
    env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'layout-debug-e2e', version: '0.0.0' })
  await client.connect(transport)
  return client
}

export async function callText(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await client.callTool({ name, arguments: args })
  const content = (res.content ?? []) as Array<{ type: string; text?: string }>
  return content.map((c) => c.text ?? '').join('\n')
}
