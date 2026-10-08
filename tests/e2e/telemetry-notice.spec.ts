import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, frameOf, IPV4_FIRST, ROOT, test } from './helpers'

/**
 * The suite runs with telemetry off (playwright.config.ts), so the shared server never asks
 * for the notice. This test starts its own copy on 5386 / 5387 with telemetry on in debug
 * mode: LD_TELEMETRY_DEBUG=1 prints events and sends nothing, and LD_TELEMETRY_DIR keeps
 * the state file in a temp dir, away from the developer's real one.
 */
const UI_PORT = 5386
const SERVER_PORT = 5387
const UI = `http://127.0.0.1:${UI_PORT}`
const HEALTH = `http://127.0.0.1:${SERVER_PORT}/api/health`

const logs: string[] = []
let stateDir = ''

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    LD_UI_PORT: String(UI_PORT),
    LD_SERVER_PORT: String(SERVER_PORT),
    NODE_OPTIONS: IPV4_FIRST,
    LD_TELEMETRY_DEBUG: '1',
    LD_TELEMETRY_DIR: stateDir,
  }
  // Same isolation as offline.spec.ts, plus every switch that would turn telemetry off here.
  for (const k of ['LD_PROJECT_DIR', 'LD_TARGET', 'LD_TARGET_URL', 'LD_SERVER_URL', 'LD_TELEMETRY', 'DO_NOT_TRACK', 'CI']) delete e[k]
  return e
}

function start(name: string, args: string[]): ChildProcess {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
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

let server: ChildProcess | null = null
let ui: ChildProcess | null = null

test.afterEach(async ({}, testInfo) => {
  await stop(server)
  await stop(ui)
  if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach('instance-logs', { body: logs.join('\n') })
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

test('28 telemetry notice: shown once, "Got it" hides it, a reload does not bring it back', async ({ page }) => {
  test.setTimeout(150_000)
  stateDir = mkdtempSync(join(tmpdir(), 'ld-telemetry-e2e-'))
  server = start('server', ['--import', 'tsx', 'src/server/index.ts'])
  ui = start('ui', [join(ROOT, 'node_modules/vite/bin/vite.js'), '--logLevel', 'warn'])
  await waitUp(HEALTH)
  await waitUp(UI)

  await page.addInitScript(() => {
    try {
      localStorage.setItem('layout-debug.coachSeen', '1')
    } catch {
      // No storage: the first-run hint shows too; the notice is found by its region anyway.
    }
  })
  await page.goto(UI)
  await expect(frameOf(page).getByRole('heading', { name: 'Годовая подписка' })).toBeVisible({ timeout: 20_000 })

  const notice = page.getByRole('region', { name: 'Usage data' })
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('Never page content or paths.')
  const link = notice.getByRole('link', { name: 'How to turn off' })
  await expect(link).toHaveAttribute('href', 'https://github.com/AntonChuraev99/Layout-debug-mcp#telemetry')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)

  await notice.getByRole('button', { name: 'Got it' }).click()
  await expect(notice).toHaveCount(0)
  // The server keeps the dismissal in its state file.
  await expect
    .poll(() => {
      try {
        return Boolean(JSON.parse(readFileSync(join(stateDir, 'telemetry.json'), 'utf8')).windowNoticeDismissedAt)
      } catch {
        return false
      }
    })
    .toBe(true)

  await page.reload()
  // The frame loads the target that `ready` names, so by now that `ready` has been handled.
  await expect(frameOf(page).getByRole('heading', { name: 'Годовая подписка' })).toBeVisible({ timeout: 20_000 })
  await expect(notice).toHaveCount(0)
  // Debug mode printed the events instead of sending them.
  expect(logs.some((l) => l.includes('[layout-debug telemetry]'))).toBe(true)
})
