import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { chatDialog, expect, frameOf, IPV4_FIRST, palette, ROOT, selectInFrame, test } from './helpers'

/**
 * Its own copy of the tool on 5384 / 5385: this test kills and restarts the server,
 * which must never happen to the shared e2e instance or to a developer's dev server.
 */
const UI_PORT = 5384
const SERVER_PORT = 5385
// IPv4 literal + ipv4first Vite, same reason as the shared instance (playwright.config.ts).
const UI = `http://127.0.0.1:${UI_PORT}`
const HEALTH = `http://127.0.0.1:${SERVER_PORT}/api/health`

const logs: string[] = []

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, LD_UI_PORT: String(UI_PORT), LD_SERVER_PORT: String(SERVER_PORT), NODE_OPTIONS: IPV4_FIRST }
  // A developer's own LD_* settings must not leak in (a project dir would switch the real agent on).
  for (const k of ['LD_PROJECT_DIR', 'LD_TARGET', 'LD_TARGET_URL', 'LD_SERVER_URL']) delete e[k]
  return e
}

/** Node directly, no shell in between: `kill()` then really stops it, on Windows too. */
function start(name: string, args: string[]): ChildProcess {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (d) => logs.push(`[${name}] ${String(d).trimEnd()}`))
  child.on('exit', (code) => logs.push(`[${name}] exited with ${code}`))
  return child
}

const startServer = () => start('server', ['--import', 'tsx', 'src/server/index.ts'])
const startUi = () => start('ui', [join(ROOT, 'node_modules/vite/bin/vite.js'), '--logLevel', 'warn'])

async function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((ok) => child.once('exit', ok))
  child.kill()
  await exited
}

async function waitUntil(url: string, up: boolean): Promise<void> {
  await expect
    .poll(async () => fetch(url).then((r) => r.status < 500).catch(() => false), {
      timeout: 60_000,
      message: `${url} should be ${up ? 'up' : 'down'}\n${logs.slice(-20).join('\n')}`,
    })
    .toBe(up)
}

let server: ChildProcess | null = null
let ui: ChildProcess | null = null

test.afterEach(async ({}, testInfo) => {
  await stop(server)
  await stop(ui)
  if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach('instance-logs', { body: logs.join('\n') })
})

test('14 server down → red pill with the fix; it clears once the server is back', async ({ page }) => {
  test.setTimeout(150_000)
  server = startServer()
  ui = startUi()
  await waitUntil(HEALTH, true)
  await waitUntil(UI, true)

  await page.goto(UI)
  await expect(frameOf(page).getByRole('heading', { name: 'Годовая подписка' })).toBeVisible({ timeout: 20_000 })
  const pill = page.getByRole('button', { name: 'Server not responding' })
  await expect(pill).toHaveCount(0)

  await stop(server)
  server = null
  await waitUntil(HEALTH, false)
  await expect(pill).toBeVisible({ timeout: 10_000 })
  await pill.click()
  const pop = page.getByRole('dialog', { name: 'Server not responding' })
  await expect(pop).toContainText("The local server isn't responding")
  await expect(pop.locator('code')).toHaveText('npm run dev')
  await page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)

  // Layers still work offline; sending says why it can't, instead of failing silently.
  await selectInFrame(page, frameOf(page).getByTestId('cta-continue'))
  await palette(page).getByRole('menuitem', { name: /^Chat with AI/ }).click()
  const offlineHint = chatDialog(page).getByText("Server isn't responding, so sending is unavailable")
  await expect(offlineHint).toBeVisible()
  await expect(chatDialog(page).getByRole('button', { name: 'Send' })).toBeDisabled()

  server = startServer()
  await waitUntil(HEALTH, true)
  await expect(pill).toHaveCount(0, { timeout: 15_000 })
  await expect(offlineHint).toHaveCount(0)
})
