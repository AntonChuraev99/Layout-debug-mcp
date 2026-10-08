/**
 * `open_window`: make sure a layout-debug server answers, starting one if needed,
 * and open the window. The server runs as its own detached process (it outlives
 * this MCP process and serves the window); its output goes to a log file in the
 * temp directory, never to this process's stdout, which carries only MCP frames.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openBrowser } from '../shared/browser.ts'
import { PACKAGE_NAME, PACKAGE_ROOT, PACKAGE_VERSION, RUNNING_FROM_SOURCE } from '../shared/paths.ts'
import type { HealthResponse } from '../shared/protocol.ts'
import type { BrowserOutcome, ServerOutcome } from '../shared/telemetry.ts'

const START_TIMEOUT_MS = 5_000
const STOP_TIMEOUT_MS = 3_000
const POLL_MS = 150
/** The server spawned here exits on its own after this long with no window and no agent. */
const IDLE_EXIT_MINUTES = '30'

type Env = Record<string, string | undefined>

export type Probe =
  | { kind: 'ours'; health: HealthResponse }
  | { kind: 'foreign'; status: number }
  | { kind: 'down'; reason: string }

export async function probe(base: string, timeoutMs = 1_000): Promise<Probe> {
  let res: Response
  try {
    res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
    return { kind: 'down', reason: `${(err as Error).message}${cause}` }
  }
  try {
    const body = (await res.json()) as Partial<HealthResponse>
    if (res.ok && body.name === PACKAGE_NAME) return { kind: 'ours', health: body as HealthResponse }
  } catch {
    // not JSON: some other program on the port
  }
  return { kind: 'foreign', status: res.status }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function serverLogPath(port: number): string {
  return join(tmpdir(), `layout-debug-mcp-${port}.log`)
}

function logTail(path: string, lines = 15): string {
  try {
    const all = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/)
    return all.slice(-lines).join('\n')
  } catch {
    return '(the log file could not be read)'
  }
}

/** The command that runs the server: the built bundle in the package, tsx + source in a checkout. */
export function serverCommand(): { args: string[]; missing?: string } {
  if (RUNNING_FROM_SOURCE) {
    const loader = join(PACKAGE_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')
    const entry = join(PACKAGE_ROOT, 'src', 'server', 'index.ts')
    if (!existsSync(loader)) return { args: [], missing: `${loader} (run npm install in ${PACKAGE_ROOT})` }
    return { args: ['--import', pathToFileURL(loader).href, entry] }
  }
  const entry = join(PACKAGE_ROOT, 'dist', 'server', 'index.js')
  if (!existsSync(entry)) return { args: [], missing: `${entry} (the package is incomplete; reinstall it)` }
  return { args: [entry] }
}

type StartFailure = { outcome: 'spawn_failed' | 'exited_at_start' | 'start_timeout'; text: string }

/** Starts the server detached and waits until it answers. Returns its health or why it did not start. */
async function startServer(
  base: string,
  port: number,
  env: Env,
  telemetryClient: string | null,
): Promise<HealthResponse | StartFailure> {
  const command = serverCommand()
  if (command.missing) return { outcome: 'spawn_failed', text: `The server entry is missing: ${command.missing}` }
  const logPath = serverLogPath(port)
  let logFd: number | null = null
  try {
    logFd = openSync(logPath, 'w')
  } catch {
    logFd = null
  }
  let exited: { code: number | null; signal: string | null } | null = null
  let spawnError: string | null = null
  try {
    const child = spawn(process.execPath, command.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // The project the agent works on: where the MCP client started us.
        LD_PROJECT_DIR: env.LD_PROJECT_DIR?.trim() || process.cwd(),
        LD_IDLE_EXIT_MINUTES: env.LD_IDLE_EXIT_MINUTES?.trim() || IDLE_EXIT_MINUTES,
        // The spawned server always serves the window itself.
        LD_DEV: '',
        // Telemetry of the server names the MCP client that started it (name@version, capped).
        LD_LAUNCHED_BY: 'mcp',
        LD_TELEMETRY_CLIENT: telemetryClient ?? '',
      },
      detached: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      windowsHide: true,
    })
    child.once('error', (err) => {
      spawnError = err.message
    })
    child.once('exit', (code, signal) => {
      exited = { code, signal }
    })
    child.unref()
  } catch (err) {
    spawnError = (err as Error).message
  } finally {
    if (logFd !== null) closeSync(logFd)
  }

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const p = await probe(base, 500)
    if (p.kind === 'ours') return p.health
    if (spawnError) return { outcome: 'spawn_failed', text: `Could not start the server process: ${spawnError}` }
    if (exited) {
      // Exit 0 can mean another copy won the race for the port; it answers then.
      const again = await probe(base, 500)
      if (again.kind === 'ours') return again.health
      const { code, signal } = exited as { code: number | null; signal: string | null }
      return {
        outcome: 'exited_at_start',
        text: `The server exited at start (${signal ?? `code ${code}`}). Log ${logPath}:\n` + logTail(logPath),
      }
    }
    await sleep(POLL_MS)
  }
  return {
    outcome: 'start_timeout',
    text:
      `The server did not answer at ${base} within ${START_TIMEOUT_MS / 1000} s. ` +
      (logFd !== null ? `Log ${logPath}:\n${logTail(logPath)}` : 'Its log could not be written.'),
  }
}

async function stopServer(base: string): Promise<boolean> {
  try {
    await fetch(`${base}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1_000) })
  } catch {
    // It may drop the connection while exiting; the probe below decides.
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await probe(base, 300)).kind === 'down') return true
    await sleep(POLL_MS)
  }
  return false
}

export const LISTEN_INSTRUCTIONS =
  'Now listen: call wait_for_message. It returns as soon as the user sends a message or an edit from the window. ' +
  'Handle it (edit the code), answer with reply_in_window(requestId, text, status), then call wait_for_message ' +
  'again. A timeout result is normal: call wait_for_message again at once. Keep this loop until the user says to stop.'

/**
 * What to do with a running server of another version: replace it only when nobody
 * uses it — no window connected and no agent listening (replacing would drop that
 * agent's open wait and the in-memory queue) — and only when this process may start one.
 */
export function staleServerAction(
  health: Pick<HealthResponse, 'version' | 'windows' | 'listening'>,
  ourVersion: string,
  external: boolean,
): 'use' | 'replace' | 'keep' {
  if (health.version === ourVersion) return 'use'
  return health.windows === 0 && !health.listening && !external ? 'replace' : 'keep'
}

export interface OpenWindowOptions {
  base: string
  port: number
  env: Env
  /** LD_SERVER_URL is set: the server lives elsewhere, this process must not start one. */
  external: boolean
  /** `name@version` of the MCP client, handed to a server this call starts (its telemetry). */
  telemetryClient?: string | null
}

/** The text open_window returns, plus what happened, as enums for telemetry. */
export interface OpenWindowResult {
  text: string
  server: ServerOutcome
  browser: BrowserOutcome
}

/** open_window, success or not. */
export async function openWindow({ base, port, env, external, telemetryClient = null }: OpenWindowOptions): Promise<OpenWindowResult> {
  const notes: string[] = []
  let state = await probe(base)
  let server: ServerOutcome = 'reused'

  if (state.kind === 'foreign') {
    return {
      text:
        `Port ${port} is taken by another program (it answered HTTP ${state.status} on /api/health, ` +
        `not as ${PACKAGE_NAME}). Set LD_SERVER_PORT to a free port in the env of this MCP server ` +
        'in the client config, restart the client session, and call open_window again.',
      server: 'port_busy',
      browser: 'skipped',
    }
  }

  const action = state.kind === 'ours' ? staleServerAction(state.health, PACKAGE_VERSION, external) : 'use'
  if (state.kind === 'ours' && action !== 'use') {
    if (action === 'replace') {
      if (!(await stopServer(base))) {
        return {
          text:
            `A ${PACKAGE_NAME} ${state.health.version} server (pid ${state.health.pid}) runs at ${base} and did not ` +
            `stop when asked. Stop that process, then call open_window again.`,
          server: 'stop_failed',
          browser: 'skipped',
        }
      }
      notes.push(`Replaced an older ${PACKAGE_NAME} ${state.health.version} server.`)
      state = { kind: 'down', reason: 'stopped' }
      server = 'replaced_stale'
    } else {
      server = 'kept_stale'
      notes.push(
        `Note: the running server is ${PACKAGE_NAME} ${state.health.version}, this MCP server is ${PACKAGE_VERSION}; ` +
          `it is kept because ${
            external
              ? 'it runs at LD_SERVER_URL, which this process does not manage'
              : state.health.windows > 0
                ? 'a window is connected to it'
                : 'an agent is listening on it'
          }. Close the window (and stop the other agent) and call open_window again to update.`,
      )
    }
  }

  let health: HealthResponse
  if (state.kind === 'ours') {
    health = state.health
  } else {
    if (external) {
      return {
        text:
          `The layout-debug server at ${base} (LD_SERVER_URL) does not answer: ${state.reason}. ` +
          'Start it there, or remove LD_SERVER_URL so open_window can start one itself.',
        server: 'external_down',
        browser: 'skipped',
      }
    }
    const started = await startServer(base, port, env, telemetryClient)
    if (!('ok' in started)) {
      return { text: `Could not open the layout-debug window. ${started.text}`, server: started.outcome, browser: 'skipped' }
    }
    health = started
    if (server === 'reused') server = 'started'
    notes.push(`Started the layout-debug server (pid ${health.pid}); its log: ${serverLogPath(port)}.`)
  }

  const url = health.windowUrl
  let opened: string
  let browser: BrowserOutcome
  if (health.windows > 0) {
    opened = `A layout-debug window is already open (${url}); the user works there.`
    browser = 'already_open'
  } else {
    const failure = await openBrowser(url)
    opened = failure
      ? `Could not open a browser (${failure}). Ask the user to open ${url}`
      : `Opened the layout-debug window in the browser: ${url}`
    browser = !failure ? 'opened' : env.LD_NO_BROWSER?.trim() === '1' ? 'disabled' : 'failed'
  }

  const text = [
    opened,
    `Server: ${PACKAGE_NAME} ${health.version}, target: ${health.target} ${health.target === 'web' ? health.targetUrl : ''}`.trimEnd() +
      `, project: ${health.projectDir}.`,
    ...notes,
    '',
    LISTEN_INSTRUCTIONS,
  ].join('\n')
  return { text, server, browser }
}
