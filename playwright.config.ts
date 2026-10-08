import { defineConfig, devices } from '@playwright/test'

/**
 * E2E for the web target. The suite starts its own copy of the tool on 5284 (UI) /
 * 5285 (server), so a dev instance on the default or any other port is never touched.
 * Tests share one server session, so they run one at a time.
 *
 * Two suites at once (two worktrees, two agents) must not share that instance either:
 * `reuseExistingServer` would attach the second run to the first one's server, and the
 * windows of one run overwrite the snapshot the other is waiting for. Give the second
 * run its own pair: `LD_E2E_UI_PORT=5484 LD_E2E_SERVER_PORT=5485 npm run test:e2e`
 * (tests/e2e/helpers.ts reads the same variables).
 */
const UI_PORT = Number(process.env.LD_E2E_UI_PORT || 5284)
const SERVER_PORT = Number(process.env.LD_E2E_SERVER_PORT || 5285)

/**
 * The window is reached by an IPv4 literal, never by `localhost`. Vite listens on whatever
 * `localhost` resolves to first in Node — `::1` on Windows — and on that address only, while
 * Chrome is free to open a given connection to `localhost` via 127.0.0.1. When that happens
 * to one module of the window (seen: react-dom_client.js → ERR_CONNECTION_REFUSED), React
 * never mounts and the page stays white. `--dns-result-order=ipv4first` makes Vite bind
 * 127.0.0.1, and the literal URL takes the browser's address choice out of the picture.
 * The server already binds 127.0.0.1 and accepts both origins (WINDOW_ORIGINS).
 */
const UI_URL = `http://127.0.0.1:${UI_PORT}`

/**
 * The suite never sends telemetry. Set on this process too, so the workers (forked from
 * it) and everything they spawn — the MCP server in helpers.ts, the servers in
 * offline.spec.ts — inherit it, not only the webServer below.
 */
process.env.LD_TELEMETRY = '0'
process.env.LD_TELEMETRY_DEBUG = ''
const IPV4_FIRST = [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first'].filter(Boolean).join(' ')

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  outputDir: 'test-results/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: UI_URL,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'node scripts/dev.mjs',
    url: UI_URL,
    // Blank LD_* reads as "not set" (src/server/config.ts): a developer's own project dir
    // or target in the shell must not leak into the suite, nor move the default demo target.
    env: {
      LD_UI_PORT: String(UI_PORT),
      LD_SERVER_PORT: String(SERVER_PORT),
      LD_PROJECT_DIR: '',
      LD_TARGET: '',
      LD_TARGET_URL: '',
      NODE_OPTIONS: IPV4_FIRST,
      LD_TELEMETRY: '0',
      LD_TELEMETRY_DEBUG: '',
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
