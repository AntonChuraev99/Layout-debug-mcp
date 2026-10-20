import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import {
  addressField,
  clearQueue,
  expect,
  FIXTURES,
  frameOf,
  IPV4_FIRST,
  palette,
  ROOT,
  selectInFrame,
  serveDir,
  test,
  type StaticSite,
} from './helpers'
import type { Page } from '@playwright/test'

/**
 * Targets that forbid framing (issue #19). The window names the header and the fix instead
 * of "the inspector didn't respond"; with the framing proxy on, the same page renders and
 * its layers can be selected.
 */

const XFO_DENY = { 'x-frame-options': 'DENY' }
const CSP_NONE = { 'content-security-policy': "default-src 'self' 'unsafe-inline' http://127.0.0.1:*; frame-ancestors 'none'" }

const GENERIC = "The inspector didn't respond"
const BLOCKED = "The page can't be shown in a frame"
const blockedBanner = (page: Page) => page.getByRole('status').filter({ hasText: BLOCKED })

async function open(page: Page, url: string): Promise<void> {
  await page.goto('/')
  await expect(addressField(page)).not.toHaveValue('')
  await addressField(page).fill(url)
  await page.getByRole('button', { name: 'Open', exact: true }).click()
}

test.describe('shared instance: detection', () => {
  let xfo: StaticSite
  let csp: StaticSite
  test.beforeAll(async () => {
    xfo = await serveDir(FIXTURES, { headers: XFO_DENY })
    csp = await serveDir(FIXTURES, { headers: CSP_NONE })
  })
  test.afterAll(async () => {
    await xfo?.close()
    await csp?.close()
  })
  test.beforeEach(async () => {
    await clearQueue()
  })

  test('19a X-Frame-Options: DENY → the window names the header and the proxy fix, not the generic timeout', async ({ page }) => {
    const url = `${xfo.url}/framing.html`
    await open(page, url)

    const banner = blockedBanner(page)
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await expect(banner).toContainText('X-Frame-Options: DENY')
    // The form the text asks for: the MCP client's env.
    await expect(banner.locator('.codeblock code')).toHaveText(`"env": { "LD_FRAMING_PROXY": "1", "LD_TARGET_URL": "${url}" }`)
    const pill = page.getByRole('button', { name: 'Page forbids framing' })
    await expect(pill).toBeVisible()

    // Past the inspector timeout (2.5 s) the generic banner and pill still stay away.
    await page.waitForTimeout(3500)
    await expect(page.getByRole('status').filter({ hasText: GENERIC })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Inspector not responding' })).toHaveCount(0)

    await page.screenshot({ path: `${process.env.LD_E2E_SHOTS_DIR ?? test.info().outputPath('shots')}/framing-blocked.png` })

    // Closing the banner keeps a way back to it.
    await banner.getByRole('button', { name: 'Close' }).click()
    await expect(banner).toHaveCount(0)
    await pill.click()
    await expect(blockedBanner(page)).toBeVisible()
  })

  test("19b CSP frame-ancestors 'none' → the directive is named, not the rest of the policy", async ({ page }) => {
    await open(page, `${csp.url}/framing.html`)
    const banner = blockedBanner(page)
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await expect(banner).toContainText("Content-Security-Policy: frame-ancestors 'none'")
    await expect(banner).not.toContainText('default-src')
  })

  test('19c a page that allows framing gets neither banner (no false alarm)', async ({ page }) => {
    const plain = await serveDir(FIXTURES)
    try {
      await open(page, `${plain.url}/framing.html`)
      await expect(frameOf(page).getByTestId('framed-title')).toBeVisible()
      await expect(page.locator('.overlay')).toBeAttached({ timeout: 15_000 })
      await expect(blockedBanner(page)).toHaveCount(0)
    } finally {
      await plain.close()
    }
  })
})

/**
 * Its own copy of the tool with the framing proxy on: the target is fixed at server start,
 * so the shared instance can't be switched to it. Ports 5374 (UI) / 5375 (server) / 5376 (proxy).
 */
test.describe('own instance: framing proxy', () => {
  const UI_PORT = 5374
  const SERVER_PORT = 5375
  const PROXY_PORT = 5376
  const UI = `http://127.0.0.1:${UI_PORT}`
  const SERVER = `http://127.0.0.1:${SERVER_PORT}`
  const logs: string[] = []
  let site: StaticSite
  let server: ChildProcess | null = null
  let ui: ChildProcess | null = null

  function start(name: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (d) => logs.push(`[${name}] ${String(d).trimEnd()}`))
    child.on('exit', (code) => logs.push(`[${name}] exited with ${code}`))
    return child
  }

  async function stop(child: ChildProcess | null): Promise<void> {
    if (!child || child.exitCode !== null) return
    const exited = new Promise((ok) => child.once('exit', ok))
    child.kill()
    await exited
  }

  async function waitUp(url: string): Promise<void> {
    await expect
      .poll(async () => fetch(url).then((r) => r.status < 500).catch(() => false), {
        timeout: 60_000,
        message: `${url} should be up\n${logs.slice(-20).join('\n')}`,
      })
      .toBe(true)
  }

  test.beforeAll(async () => {
    // Both framing headers at once: the proxy must drop both.
    site = await serveDir(FIXTURES, {
      headers: { ...XFO_DENY, 'content-security-policy': "frame-ancestors 'none'; img-src *" },
      inspectorTag: `<script src="${SERVER}/inspector.js"></script>`,
    })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LD_UI_PORT: String(UI_PORT),
      LD_SERVER_PORT: String(SERVER_PORT),
      LD_TARGET_URL: `${site.url}/framing.html`,
      LD_FRAMING_PROXY: '1',
      LD_FRAMING_PROXY_PORT: String(PROXY_PORT),
      NODE_OPTIONS: IPV4_FIRST,
    }
    // A developer's own LD_* settings must not change what this instance serves.
    for (const k of ['LD_PROJECT_DIR', 'LD_TARGET', 'LD_SERVER_URL', 'LD_CONFIG']) delete env[k]
    server = start('server', ['--import', 'tsx', 'src/server/index.ts'], env)
    ui = start('ui', [join(ROOT, 'node_modules/vite/bin/vite.js'), '--logLevel', 'warn'], env)
    await waitUp(`${SERVER}/api/health`)
    await waitUp(UI)
  })
  test.afterAll(async () => {
    await stop(server)
    await stop(ui)
    await site?.close()
  })
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach('instance-logs', { body: logs.join('\n') })
  })

  test('19d with LD_FRAMING_PROXY=1 the page renders through the proxy and selection works', async ({ page }) => {
    test.setTimeout(150_000)
    await page.addInitScript(() => {
      try {
        localStorage.setItem('layout-debug.coachSeen', '1')
      } catch {
        // no storage: the first-run hint shows, which this test does not need
      }
    })
    await page.goto(UI)
    // The address field keeps the target the user knows; the frame loads it through the proxy.
    await expect(addressField(page)).toHaveValue(`${site.url}/framing.html`)
    await expect(page.locator('iframe[title="Page being edited"]')).toHaveAttribute('src', `http://127.0.0.1:${PROXY_PORT}/framing.html`)
    const frame = frameOf(page)
    await expect(frame.getByTestId('framed-title')).toBeVisible({ timeout: 20_000 })

    await expect(page.locator('.overlay')).toBeAttached({ timeout: 15_000 })
    await selectInFrame(page, frame.getByTestId('framed-card'))
    await expect(palette(page)).toBeVisible()
    await expect(blockedBanner(page)).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: GENERIC })).toHaveCount(0)

    // The window mirrored the proxied page to the server: the selection is the real element.
    await expect
      .poll(async () => {
        const body = (await (await fetch(`${SERVER}/api/selected`)).json()) as { node: { anchors: { testId?: string } } | null }
        return body.node?.anchors.testId ?? null
      })
      .toBe('framed-card')
  })
})
