import type { AndroidApp } from '../shared/protocol.ts'

/**
 * Pure helpers of the Android adapter: which app the on-device agent belongs to, and
 * how often a dropped `adb forward` may be re-armed. No I/O, so they are unit-tested
 * directly (androidApp.test.ts).
 */

/**
 * An Android application id: two or more dot-separated segments, each a letter
 * followed by letters, digits or `_`. Also the guard that lets the value go into
 * `adb shell pidof`, which runs through the device shell.
 */
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/
const PACKAGE_MAX = 255

export function isAndroidPackage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PACKAGE_MAX && PACKAGE_RE.test(value)
}

/** What the on-device agent says about itself in `/health` (or `/tree`). */
export interface AgentIdentity {
  package: string | null
  pid: number | null
}

/**
 * `package` and `pid` from an agent response, each null when absent or malformed.
 * An older agent answers `{"ok":true,"port":8790}`: both null. `problems` lists the
 * fields that were present but unusable, so the caller can log them instead of
 * dropping them silently.
 */
export function parseAgentIdentity(body: unknown): AgentIdentity & { problems: string[] } {
  const problems: string[] = []
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { package: null, pid: null, problems }
  const b = body as Record<string, unknown>
  let pkg: string | null = null
  if (b.package !== undefined && b.package !== null) {
    if (isAndroidPackage(b.package)) pkg = b.package
    else problems.push(`package ${JSON.stringify(String(b.package).slice(0, 80))} is not an Android application id`)
  }
  let pid: number | null = null
  if (b.pid !== undefined && b.pid !== null) {
    if (typeof b.pid === 'number' && Number.isInteger(b.pid) && b.pid > 0) pid = b.pid
    else problems.push(`pid ${JSON.stringify(b.pid)} is not a positive integer`)
  }
  return { package: pkg, pid, problems }
}

/** `adb shell pidof <package>` stdout → the first pid, or null when the app is not running. */
export function parsePidof(stdout: string): number | null {
  const first = stdout.trim().split(/\s+/)[0]
  if (!first || !/^\d+$/.test(first)) return null
  const pid = Number(first)
  return pid > 0 ? pid : null
}

/**
 * What to do with an agent's identity, given the package the config expects:
 *
 * - `ok`          — nothing to complain about; `app` is what to show (null: nothing known).
 * - `mismatch`    — the agent on the port belongs to another app.
 * - `check-adb`   — an app is expected but the agent did not say which it is: confirm via adb.
 */
export type IdentityVerdict =
  | { kind: 'ok'; app: AndroidApp | null }
  | { kind: 'mismatch'; expected: string; actual: string }
  | { kind: 'check-adb'; expected: string }

export function checkAppIdentity(expected: string | null, reported: AgentIdentity): IdentityVerdict {
  if (reported.package) {
    if (expected && reported.package !== expected) {
      return { kind: 'mismatch', expected, actual: reported.package }
    }
    return { kind: 'ok', app: { package: reported.package, pid: reported.pid, source: 'agent' } }
  }
  if (expected) return { kind: 'check-adb', expected }
  // Nothing configured and nothing reported: exactly the old behaviour.
  return { kind: 'ok', app: null }
}

/**
 * What `adb shell echo ok` says about the adb link to the device:
 *
 * - `alive`        — the device shell answered: the link works, so a silent agent is the app's.
 * - `unresponsive` — adb gave up waiting (the probe's timeout killed it): adb lists the
 *                    device, but nothing reaches it. Typical of a stalled wireless debugging
 *                    connection; restarting the app does not help.
 * - `failed`       — adb answered with an error of its own (no device, offline,
 *                    unauthorized, no adb): `error` is that answer, a better cause than the
 *                    capture's timeout.
 */
export type LinkVerdict = { kind: 'alive' } | { kind: 'unresponsive' } | { kind: 'failed'; error: unknown }

export type ProbeOutcome = { ok: true; stdout: string } | { ok: false; error: unknown }

export function linkVerdictOf(outcome: ProbeOutcome): LinkVerdict {
  if (outcome.ok) {
    // Any answer from the device shell proves the link; "ok" is just what we asked it to say.
    return { kind: 'alive' }
  }
  return isAdbTimeout(outcome.error) ? { kind: 'unresponsive' } : { kind: 'failed', error: outcome.error }
}

/** An adb child that our `timeout` killed (execFile sets `killed`), as opposed to one that exited with an error. */
export function isAdbTimeout(err: unknown): boolean {
  const e = err as { killed?: unknown; code?: unknown; signal?: unknown } | null
  return Boolean(e && typeof e === 'object' && e.killed === true && e.code !== 'ENOENT')
}

/**
 * Lets an action run at most once per `intervalMs`. Used for `adb forward`: while
 * the agent stays unreachable the window polls every 800 ms, and re-arming the
 * forward on each poll spawned an adb process per poll (a console window flash
 * each on Windows) without changing the outcome.
 */
export class RetryGate {
  private lastAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** May the action run now? */
  ready(): boolean {
    return this.now() - this.lastAt >= this.intervalMs
  }

  /** The action ran (or is starting) now. */
  mark(): void {
    this.lastAt = this.now()
  }
}
