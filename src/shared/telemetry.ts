/**
 * Anonymous, opt-out usage telemetry, sent to Amplitude over its HTTP V2 API with
 * the global fetch (no SDK). What may leave the machine is fixed here: events are
 * typed, and a sanitizer keeps only the properties on each event's allow-list,
 * strings capped at 64 characters. Never page content, paths, URLs, error messages.
 *
 * Telemetry never throws, never writes to stdout (in the MCP process stdout carries
 * MCP frames) and never holds an exit for more than the flush deadline. Off when the
 * key is empty, when LD_TELEMETRY=0, DO_NOT_TRACK or CI is set, or after
 * `layout-debug-mcp telemetry off`. LD_TELEMETRY_DEBUG=1 prints events to stderr
 * instead of sending them.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PACKAGE_VERSION } from './paths.ts'
import type { ErrorCode, TargetKind } from './protocol.ts'

/** Public ingestion key of the Amplitude project. Empty: telemetry is off, nothing is read or written. */
export const AMPLITUDE_API_KEY = '7dba48c7607393fe9141b3d531ddedc1'
export const AMPLITUDE_URL = 'https://api2.amplitude.com/2/httpapi'

/** Amplitude's free plan takes at most 10 events per request. */
export const MAX_BATCH = 10
const FLUSH_INTERVAL_MS = 10_000
export const DEFAULT_FLUSH_DEADLINE_MS = 1_500
const MAX_STRING = 64
/** The same event (type + key properties) more often than this per process is dropped. */
const DEFAULT_REPEAT_LIMIT = 20

export const DEBUG_PREFIX = '[layout-debug telemetry]'

export const TELEMETRY_NOTICE =
  'layout-debug-mcp collects anonymous usage data (tool calls, error codes, OS, client name; never page content ' +
  'or paths). Turn it off: LD_TELEMETRY=0, DO_NOT_TRACK=1 or `npx layout-debug-mcp telemetry off`. ' +
  'Details: https://github.com/AntonChuraev99/Layout-debug-mcp#telemetry'

export const OPEN_WINDOW_NOTE =
  'Note for the user: anonymous usage telemetry is on; to turn it off set LD_TELEMETRY=0 or run ' +
  'npx layout-debug-mcp telemetry off.'

type Env = Record<string, string | undefined>

export type TelemetryProcess = 'mcp' | 'server' | 'cli'

// --- events -------------------------------------------------------------------

export type DurationBucket = '<1s' | '1-5s' | '5-30s' | '30-60s' | '>60s'
export type CountBucket = '0' | '1' | '2-5' | '6-20' | '21-100' | '101-1000' | '>1000'
export type MinutesBucket = '<1m' | '1-5m' | '5-15m' | '15-60m' | '1-4h' | '>4h'

export type ToolName =
  | 'open_window'
  | 'wait_for_message'
  | 'layout_snapshot'
  | 'selected_element'
  | 'pending_requests'
  | 'reply_in_window'

export type ToolOutcome =
  | 'ok'
  | 'empty'
  | 'delivered'
  | 'cancelled'
  | 'server_hung'
  | 'unreachable'
  | 'http_403'
  | 'http_404'
  | 'http_error'
  | 'internal_error'
  | 'window_closed'
  | 'id_unmatched'

export type ServerOutcome =
  | 'started'
  | 'reused'
  | 'replaced_stale'
  | 'kept_stale'
  | 'port_busy'
  | 'external_down'
  | 'spawn_failed'
  | 'exited_at_start'
  | 'start_timeout'
  | 'stop_failed'

export type BrowserOutcome = 'opened' | 'already_open' | 'failed' | 'disabled' | 'skipped'

export type TelemetryEvent =
  | { type: 'mcp_started'; external_server: boolean }
  | {
      type: 'tool_called'
      tool: ToolName
      outcome: ToolOutcome
      duration: DurationBucket
      wait_timeouts?: CountBucket
      status?: 'done' | 'error'
      has_request_id?: boolean
    }
  | { type: 'window_open'; server: ServerOutcome; browser: BrowserOutcome }
  | {
      type: 'server_started'
      target: TargetKind
      config_file: boolean
      android_devices?: CountBucket
      multi_device_no_pick?: boolean
    }
  | { type: 'server_start_failed'; reason: 'config_error' | 'port_in_use' | 'port_access' | 'other' }
  | { type: 'window_connected'; target: TargetKind }
  | { type: 'target_attached'; target: TargetKind; nodes: CountBucket; unit: 'css-px' | 'dp' }
  | { type: 'edit_sent'; target: TargetKind; agent_listening: boolean; has_live_edits: boolean; has_comment: boolean }
  | { type: 'agent_replied'; status: 'done' | 'error'; matched: boolean; latency?: DurationBucket }
  | { type: 'error_shown'; code: ErrorCode; target: TargetKind }
  | {
      type: 'server_session_ended'
      reason: 'idle' | 'signal' | 'api_shutdown'
      duration: MinutesBucket
      windows: CountBucket
      snapshots: CountBucket
      selections: CountBucket
      live_edits: CountBucket
      edits_sent: CountBucket
      replies_done: CountBucket
      replies_error: CountBucket
      agent_listened: boolean
    }
  | { type: 'crash'; error_name: string; error_code?: string }
  | { type: 'telemetry_capped'; capped_event: string }

export type TelemetryEventType = TelemetryEvent['type']

/** Properties every event carries (set by the process, not by the caller). */
const COMMON_PROPS = [
  'process',
  'app_version',
  'os',
  'arch',
  'node_major',
  'client_name',
  'client_version',
  'launched_by',
] as const

/** The only properties that leave the machine, per event. Anything else is dropped. */
export const ALLOWED_PROPS: Record<TelemetryEventType, readonly string[]> = {
  mcp_started: ['external_server'],
  tool_called: ['tool', 'outcome', 'duration', 'wait_timeouts', 'status', 'has_request_id'],
  window_open: ['server', 'browser'],
  server_started: ['target', 'config_file', 'android_devices', 'multi_device_no_pick'],
  server_start_failed: ['reason'],
  window_connected: ['target'],
  target_attached: ['target', 'nodes', 'unit'],
  edit_sent: ['target', 'agent_listening', 'has_live_edits', 'has_comment'],
  agent_replied: ['status', 'matched', 'latency'],
  error_shown: ['code', 'target'],
  server_session_ended: [
    'reason',
    'duration',
    'windows',
    'snapshots',
    'selections',
    'live_edits',
    'edits_sent',
    'replies_done',
    'replies_error',
    'agent_listened',
  ],
  crash: ['error_name', 'error_code'],
  telemetry_capped: ['capped_event'],
}

/** Properties that tell repeats of one event apart for the rate guard (the rest are buckets). */
const REPEAT_KEY_PROPS: Partial<Record<TelemetryEventType, readonly string[]>> = {
  tool_called: ['tool', 'outcome'],
  error_shown: ['code'],
}
const REPEAT_LIMITS: Partial<Record<TelemetryEventType, number>> = { error_shown: 3 }

type Props = Record<string, string | boolean>

/**
 * Keeps only allow-listed properties with string or boolean values; strings are cut
 * to 64 characters. Unknown event types keep nothing. Pure; exported for tests.
 */
export function sanitizeProps(type: string, props: Record<string, unknown>): Props {
  const allowed = new Set<string>([...(ALLOWED_PROPS[type as TelemetryEventType] ?? []), ...COMMON_PROPS])
  const out: Props = {}
  for (const [key, value] of Object.entries(props)) {
    if (!allowed.has(key)) continue
    if (typeof value === 'boolean') out[key] = value
    else if (typeof value === 'string') out[key] = value.slice(0, MAX_STRING)
  }
  return out
}

// --- buckets ------------------------------------------------------------------

export function durationBucket(ms: number): DurationBucket {
  if (!(ms >= 0) || ms < 1_000) return '<1s'
  if (ms < 5_000) return '1-5s'
  if (ms < 30_000) return '5-30s'
  if (ms < 60_000) return '30-60s'
  return '>60s'
}

export function countBucket(n: number): CountBucket {
  if (!(n > 0)) return '0'
  if (n <= 1) return '1'
  if (n <= 5) return '2-5'
  if (n <= 20) return '6-20'
  if (n <= 100) return '21-100'
  if (n <= 1000) return '101-1000'
  return '>1000'
}

export function minutesBucket(ms: number): MinutesBucket {
  const min = ms / 60_000
  if (!(min >= 1)) return '<1m'
  if (min < 5) return '1-5m'
  if (min < 15) return '5-15m'
  if (min < 60) return '15-60m'
  if (min < 240) return '1-4h'
  return '>4h'
}

/** `crash` properties: the error class name and a short code such as ECONNRESET, never the message. */
export function crashEvent(err: unknown): TelemetryEvent {
  const name = err instanceof Error ? err.name || 'Error' : typeof err
  const code = (err as { code?: unknown } | null)?.code
  const event: TelemetryEvent = { type: 'crash', error_name: name }
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) event.error_code = code
  return event
}

// --- opt-out ------------------------------------------------------------------

export interface Resolution {
  enabled: boolean
  /** Why: shown by `layout-debug-mcp telemetry status`. */
  reason: string
  /** LD_TELEMETRY_DEBUG=1: print events to stderr, send nothing. */
  debug: boolean
}

const OFF_VALUES = new Set(['0', 'false', 'off', 'no'])
const FALSY_FLAG = new Set(['', '0', 'false'])

/** A variable like DO_NOT_TRACK or CI counts as set unless it is empty, "0" or "false". */
function flagSet(raw: string | undefined): boolean {
  return raw !== undefined && !FALSY_FLAG.has(raw.trim().toLowerCase())
}

/**
 * Whether telemetry runs. `persistedEnabled` is the `enabled` field of the state file
 * (undefined when absent or not read yet). LD_TELEMETRY=1 overrides only CI. Pure.
 */
export function resolveTelemetry(env: Env, apiKey: string, persistedEnabled?: boolean): Resolution {
  const debug = env.LD_TELEMETRY_DEBUG?.trim() === '1'
  const ld = env.LD_TELEMETRY?.trim().toLowerCase() ?? ''
  const off = (reason: string): Resolution => ({ enabled: false, reason, debug })
  if (OFF_VALUES.has(ld)) return off(`LD_TELEMETRY=${env.LD_TELEMETRY!.trim()} is set`)
  if (flagSet(env.DO_NOT_TRACK)) return off('DO_NOT_TRACK is set')
  if (persistedEnabled === false) return off('turned off with `layout-debug-mcp telemetry off`')
  if (flagSet(env.CI) && ld !== '1') return off('CI is set (LD_TELEMETRY=1 turns it on there)')
  if (!apiKey && !debug) return off('this build has no telemetry key')
  if (debug) return { enabled: true, reason: 'LD_TELEMETRY_DEBUG=1: events are printed to stderr, not sent', debug }
  return { enabled: true, reason: 'on by default', debug }
}

// --- state file ---------------------------------------------------------------

export interface TelemetryState {
  deviceId?: string
  enabled?: boolean
  noticeShownAt?: string
  windowNoticeDismissedAt?: string
}

/** `%APPDATA%\layout-debug-mcp`, `$XDG_CONFIG_HOME/layout-debug-mcp` or `~/.config/layout-debug-mcp`. */
export function telemetryDir(env: Env, platform: NodeJS.Platform = process.platform, home = safeHome()): string {
  const override = env.LD_TELEMETRY_DIR?.trim()
  if (override) return override
  if (platform === 'win32') return join(env.APPDATA?.trim() || join(home, 'AppData', 'Roaming'), 'layout-debug-mcp')
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'layout-debug-mcp')
}

export function telemetryStatePath(env: Env): string {
  return join(telemetryDir(env), 'telemetry.json')
}

function safeHome(): string {
  try {
    return homedir()
  } catch {
    return '.'
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `missing`: no file yet; `bad`: unreadable or not a JSON object (left as it is). */
export function readState(path: string): { state: TelemetryState; status: 'ok' | 'missing' | 'bad' } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { state: {}, status: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'bad' }
  }
  try {
    const data = JSON.parse(raw) as unknown
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return { state: {}, status: 'bad' }
    const d = data as Record<string, unknown>
    const state: TelemetryState = {}
    if (typeof d.deviceId === 'string' && UUID_RE.test(d.deviceId)) state.deviceId = d.deviceId
    if (typeof d.enabled === 'boolean') state.enabled = d.enabled
    if (typeof d.noticeShownAt === 'string') state.noticeShownAt = d.noticeShownAt
    if (typeof d.windowNoticeDismissedAt === 'string') state.windowNoticeDismissedAt = d.windowNoticeDismissedAt
    return { state, status: 'ok' }
  } catch {
    return { state: {}, status: 'bad' }
  }
}

function writeState(path: string, state: TelemetryState, exclusive = false): 'ok' | 'exists' | 'failed' {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' })
    return 'ok'
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed'
  }
}

/**
 * Merges `patch` into the file as it is now (another process may have written it).
 * Never throws; false when the file could not be written or is not ours to rewrite.
 */
export function updateState(path: string, patch: Partial<Record<keyof TelemetryState, string | boolean | undefined>>): boolean {
  const current = readState(path)
  if (current.status === 'bad') return false
  const next: Record<string, unknown> = { ...current.state }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return writeState(path, next as TelemetryState) === 'ok'
}

/**
 * The device id from the state file, creating the file when there is none. The MCP
 * process and the server it starts both get here: the first creates the file
 * exclusively, the other re-reads it. A file that cannot be read or written leaves an
 * in-memory id for this process (`persisted: false`).
 */
export function loadState(path: string, newId: () => string = randomUUID): { state: TelemetryState; persisted: boolean } {
  const first = readState(path)
  if (first.status === 'ok' && first.state.deviceId) return { state: first.state, persisted: true }
  if (first.status === 'bad') return { state: { deviceId: newId() }, persisted: false }
  const created: TelemetryState = { ...first.state, deviceId: newId() }
  // The file exists without an id: add one. No file: create it, unless another process just did.
  const written = writeState(path, created, first.status === 'missing')
  if (written === 'ok') return { state: created, persisted: true }
  if (written === 'exists') {
    const again = readState(path)
    if (again.status === 'ok' && again.state.deviceId) return { state: again.state, persisted: true }
  }
  return { state: created, persisted: false }
}

// --- the client ---------------------------------------------------------------

export interface AmplitudeEvent {
  event_type: string
  device_id: string
  time: number
  insert_id: string
  session_id: number
  app_version: string
  platform: string
  os_name: string
  event_properties: Props
}

export interface TelemetryContext {
  client_name?: string
  client_version?: string
  launched_by?: 'mcp' | 'cli'
}

export interface TelemetryOptions {
  process: TelemetryProcess
  env?: Env
  apiKey?: string
  now?: () => number
  fetchImpl?: typeof fetch
  /** Where debug lines and the notice go; default process.stderr. */
  stderr?: (line: string) => void
  /** Periodic flush; 0 turns the timer off (tests). */
  flushIntervalMs?: number
  /** Print the first-run notice. Default: true for mcp and server, false for cli. */
  notice?: boolean
}

export class Telemetry {
  readonly enabled: boolean
  readonly debug: boolean
  readonly reason: string
  readonly statePath: string
  readonly deviceId: string
  private readonly persisted: boolean
  private readonly proc: TelemetryProcess
  private readonly apiKey: string
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly stderr: (line: string) => void
  private readonly sessionId: number
  private context: TelemetryContext = {}
  private queue: AmplitudeEvent[] = []
  private inflight = new Set<Promise<void>>()
  private repeats = new Map<string, number>()
  private cappedSent = false
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(opts: TelemetryOptions) {
    const env = opts.env ?? process.env
    this.proc = opts.process
    this.apiKey = opts.apiKey ?? AMPLITUDE_API_KEY
    this.now = opts.now ?? Date.now
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    this.stderr = opts.stderr ?? ((line) => safeStderr(line))
    this.sessionId = this.now()
    this.statePath = safe(() => telemetryStatePath(env), join('.', 'telemetry.json'))

    let resolution = resolveTelemetry(env, this.apiKey)
    let state: TelemetryState = {}
    let persisted = false
    // An env opt-out (or no key) touches no file at all; `telemetry off` in the file creates no device id.
    if (resolution.enabled) {
      const peek = safe(() => readState(this.statePath).state.enabled, undefined)
      resolution = resolveTelemetry(env, this.apiKey, peek)
    }
    if (resolution.enabled) {
      const loaded = safe(() => loadState(this.statePath), { state: { deviceId: randomUUID() }, persisted: false })
      state = loaded.state
      persisted = loaded.persisted
      resolution = resolveTelemetry(env, this.apiKey, state.enabled)
    }
    this.enabled = resolution.enabled
    this.debug = resolution.debug
    this.reason = resolution.reason
    this.persisted = persisted
    this.deviceId = state.deviceId ?? randomUUID()

    if (!this.enabled) return
    const launchedBy = env.LD_LAUNCHED_BY?.trim()
    if (launchedBy === 'mcp' || launchedBy === 'cli') this.context.launched_by = launchedBy
    else if (this.proc === 'server') this.context.launched_by = 'cli'
    const client = parseClient(env.LD_TELEMETRY_CLIENT)
    if (client) Object.assign(this.context, client)

    if ((opts.notice ?? this.proc !== 'cli') && !state.noticeShownAt) {
      this.stderr(TELEMETRY_NOTICE)
      if (this.persisted) safe(() => updateState(this.statePath, { noticeShownAt: new Date(this.now()).toISOString() }), false)
    }
    const interval = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS
    if (interval > 0 && !this.debug) {
      this.timer = setInterval(() => {
        if (this.queue.length) void this.flush()
      }, interval)
      this.timer.unref?.()
    }
  }

  /** Client name and version (MCP initialize), or who started the server. */
  setContext(partial: TelemetryContext): void {
    if (!this.enabled) return
    for (const [key, value] of Object.entries(partial)) {
      if (typeof value === 'string' && value) (this.context as Record<string, string>)[key] = value.slice(0, MAX_STRING)
    }
  }

  get clientContext(): TelemetryContext {
    return { ...this.context }
  }

  /** Queues one event. Never throws. */
  track(event: TelemetryEvent): void {
    if (!this.enabled) return
    try {
      const { type, ...props } = event
      const repeatKey = [type, ...(REPEAT_KEY_PROPS[type] ?? []).map((k) => String((props as Record<string, unknown>)[k]))].join('|')
      const seen = (this.repeats.get(repeatKey) ?? 0) + 1
      this.repeats.set(repeatKey, seen)
      if (seen > (REPEAT_LIMITS[type] ?? DEFAULT_REPEAT_LIMIT)) {
        if (!this.cappedSent && type !== 'telemetry_capped') {
          this.cappedSent = true
          this.enqueue('telemetry_capped', { capped_event: type })
        }
        return
      }
      this.enqueue(type, props)
    } catch {
      // Telemetry must never break the tool.
    }
  }

  private enqueue(type: string, props: Record<string, unknown>) {
    const event: AmplitudeEvent = {
      event_type: type,
      device_id: this.deviceId,
      time: this.now(),
      insert_id: randomUUID(),
      session_id: this.sessionId,
      app_version: PACKAGE_VERSION,
      platform: 'node',
      os_name: process.platform,
      event_properties: sanitizeProps(type, {
        ...props,
        process: this.proc,
        app_version: PACKAGE_VERSION,
        os: process.platform,
        arch: process.arch,
        node_major: process.versions.node.split('.')[0] ?? '',
        ...this.context,
      }),
    }
    if (this.debug) {
      this.stderr(`${DEBUG_PREFIX} ${JSON.stringify(event)}`)
      return
    }
    this.queue.push(event)
    if (this.queue.length >= MAX_BATCH) void this.flush()
  }

  /**
   * Sends what is queued and waits for sends already in flight, but never longer than
   * `deadlineMs`. Resolves, never rejects.
   */
  flush(deadlineMs = DEFAULT_FLUSH_DEADLINE_MS): Promise<void> {
    if (!this.enabled || this.debug) return Promise.resolve()
    const deadline = this.now() + deadlineMs
    const batch = this.queue.splice(0)
    for (let i = 0; i < batch.length; i += MAX_BATCH) {
      const p = this.send(batch.slice(i, i + MAX_BATCH), deadline).catch(() => {})
      this.inflight.add(p)
      void p.finally(() => this.inflight.delete(p))
    }
    if (!this.inflight.size) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(0, deadlineMs))
      t.unref?.()
      void Promise.allSettled([...this.inflight]).then(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  /** One POST; a 5xx is retried once with the same insert_ids, anything else is dropped. */
  private async send(events: AmplitudeEvent[], deadline: number): Promise<void> {
    const body = JSON.stringify({ api_key: this.apiKey, events, options: { min_id_length: 1 } })
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - this.now()
      if (left <= 0) return
      let status: number
      try {
        const res = await this.fetchImpl(AMPLITUDE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: '*/*' },
          body,
          signal: AbortSignal.timeout(left),
        })
        status = res.status
        // Free the socket; the body is not needed.
        void res.body?.cancel().catch(() => {})
      } catch (err) {
        this.debugNote(`send failed: ${(err as Error)?.name ?? 'error'}`)
        return
      }
      if (status >= 200 && status < 300) return
      this.debugNote(`Amplitude answered HTTP ${status}; ${status >= 500 && attempt === 0 ? 'retrying once' : 'dropped'}`)
      if (status < 500) return
    }
  }

  private debugNote(line: string) {
    if (this.debug) this.stderr(`${DEBUG_PREFIX} ${line}`)
  }

  /** The window still shows its one-time notice: enabled and not dismissed (read fresh from the file). */
  windowNoticePending(): boolean {
    // Without a state file a dismissal could not be remembered: no notice rather than one every time.
    if (!this.enabled || !this.persisted) return false
    return !safe(() => readState(this.statePath).state.windowNoticeDismissedAt, undefined)
  }

  dismissWindowNotice(): void {
    if (!this.enabled || !this.persisted) return
    safe(() => updateState(this.statePath, { windowNoticeDismissedAt: new Date(this.now()).toISOString() }), false)
  }

  /** Stops the periodic flush (tests). */
  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/** `LD_TELEMETRY_CLIENT=name@version` → context, both parts capped. */
export function parseClient(raw: string | undefined): TelemetryContext | null {
  const v = raw?.trim()
  if (!v) return null
  const at = v.lastIndexOf('@')
  const name = (at > 0 ? v.slice(0, at) : v).slice(0, MAX_STRING)
  const version = at > 0 ? v.slice(at + 1).slice(0, MAX_STRING) : ''
  return version ? { client_name: name, client_version: version } : { client_name: name }
}

/** `name@version` for LD_TELEMETRY_CLIENT, capped. */
export function formatClient(ctx: TelemetryContext): string | null {
  if (!ctx.client_name) return null
  return `${ctx.client_name.slice(0, MAX_STRING)}${ctx.client_version ? `@${ctx.client_version.slice(0, MAX_STRING)}` : ''}`
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function safeStderr(line: string) {
  try {
    process.stderr.write(`${line}\n`)
  } catch {
    // stderr closed: nothing to do.
  }
}

// --- `layout-debug-mcp telemetry on|off|status` -------------------------------

/**
 * Runs the `telemetry` subcommand and returns what to print and the exit code. Sends
 * nothing; `status` only reads the state file.
 */
export function telemetryCommand(
  action: 'on' | 'off' | 'status',
  env: Env,
  apiKey: string = AMPLITUDE_API_KEY,
): { text: string; code: number } {
  const path = telemetryStatePath(env)
  if (action !== 'status') {
    const ok = updateState(path, { enabled: action === 'off' ? false : undefined })
    if (!ok) {
      return {
        text:
          `Could not write ${path}: the file is unreadable or not valid JSON, or the directory is not writable. ` +
          'Fix or delete it and run the command again, or set LD_TELEMETRY=0 in the environment instead.',
        code: 1,
      }
    }
  }
  const read = readState(path)
  const r = resolveTelemetry(env, apiKey, read.state.enabled)
  const lines = [
    `Telemetry: ${r.enabled ? 'enabled' : 'disabled'} (${r.reason}).`,
    `State file: ${path}${read.status === 'missing' ? ' (not created yet)' : read.status === 'bad' ? ' (unreadable or not valid JSON)' : ''}`,
    `Device id: ${read.state.deviceId ?? 'none yet'}`,
  ]
  if (action === 'on' && !r.enabled) lines.push('The file no longer turns it off, but the reason above still does.')
  return { text: lines.join('\n'), code: 0 }
}

// --- process-wide instance ----------------------------------------------------

let instance: Telemetry | null = null
let disabled: Telemetry | null = null

/** Creates the process-wide instance (once; later calls return it) and flushes it on beforeExit. */
export function initTelemetry(opts: TelemetryOptions): Telemetry {
  if (instance) return instance
  instance = safe(() => new Telemetry(opts), null) ?? new Telemetry({ ...opts, env: { LD_TELEMETRY: '0' } })
  const t = instance
  if (t.enabled && !t.debug) process.once('beforeExit', () => void t.flush())
  return t
}

/** The process-wide instance, or a disabled one before initTelemetry. */
export function getTelemetry(): Telemetry {
  return instance ?? (disabled ??= new Telemetry({ process: 'cli', env: { LD_TELEMETRY: '0' } }))
}

/**
 * Tracks an uncaught exception or unhandled rejection as `crash`, flushes for at most
 * 1 s, then does what Node would have done: prints the stack to stderr and exits 1.
 */
export function installCrashHandlers(t: Telemetry): void {
  let exiting = false
  const onFatal = (err: unknown) => {
    if (exiting) return
    exiting = true
    const die = () => {
      safeStderr(err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : `Uncaught ${String(err)}`)
      process.exit(1)
    }
    if (!t.enabled) return die()
    t.track(crashEvent(err))
    void t.flush(1_000).then(die, die)
  }
  process.on('uncaughtException', onFatal)
  process.on('unhandledRejection', onFatal)
}
