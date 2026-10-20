import { execFile, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'
import type { AndroidApp, ErrorCode, LayoutNode, NodeId, Override, Snapshot } from '../shared/protocol.ts'
import {
  checkAppIdentity,
  isAdbTimeout,
  linkVerdictOf,
  parseAgentIdentity,
  parsePidof,
  RetryGate,
  type AgentIdentity,
  type LinkVerdict,
} from './androidApp.ts'
import { Budget } from './androidCapture.ts'
import { LocalizedError } from './i18n.ts'

const execFileAsync = promisify(execFile)

/**
 * Every adb call goes through here. `windowsHide`: the server runs detached without
 * a console (src/mcp/launch.ts), so on Windows each console child (adb.exe) would
 * otherwise open a console window of its own and flash on screen.
 */
function exec(file: string, args: string[], options: ExecFileOptions = {}) {
  return execFileAsync(file, args, { ...options, windowsHide: true, encoding: 'utf8' })
}

/**
 * While the agent stays unreachable the window polls every 800 ms; `adb forward` is
 * re-armed at most this often, and between attempts the last failure is reported as is.
 */
const FORWARD_RETRY_MS = 5_000
/** How long a checked app identity (or the reason it failed) is reused before asking again. */
const IDENTITY_TTL_MS = 5_000

/**
 * One capture (tree and picture together, or one live edit) ends within this, retry
 * included: the window counts a capture that has not landed after 8 s as failed
 * (src/ui/useAndroidAutoRefresh.ts) and asks again, so a server still waiting past
 * that would pile requests up behind a hung agent.
 */
export const CAPTURE_BUDGET_MS = 7_000
/** One HTTP request to the agent; the tree is ~40 KB and the PNG ~1.5 MB over wireless adb. */
const REQUEST_TIMEOUT_MS = 6_000
/** A retry after re-arming `adb forward` only starts while this much of the budget is left. */
const MIN_RETRY_MS = 1_500
/** adb calls on the capture path (`forward`, `pidof`) and the `/health` probe. */
const ADB_TIMEOUT_MS = 3_000
/** A failed `getprop ro.product.model` is not asked again for this long (each window connect asked). */
const MODEL_RETRY_MS = 30_000
/**
 * `adb shell echo ok` after a capture that failed like a silent agent: longest wait,
 * shortest wait (when the capture budget is nearly spent — a live shell answers in
 * well under a second, also over Wi-Fi), and how long its verdict is reused, so the
 * probe runs at most once per LINK_TTL_MS however often the window polls.
 */
const LINK_PROBE_MAX_MS = 2_500
const LINK_PROBE_MIN_MS = 1_000
const LINK_TTL_MS = 5_000

/** A capture: the tree, and the device picture taken alongside it (or why there is none). */
export interface CapturedFrame {
  snapshot: Snapshot
  png: Buffer | null
  pngError: unknown
}

/** What the on-device agent serves at /tree. */
interface DeviceNode {
  id: string
  parentId: string | null
  childIds: string[]
  depth: number
  kind: string
  label: string
  bounds: { x: number; y: number; w: number; h: number }
  source: { file: string; line: number } | null
  movable: boolean
}

interface DeviceTree {
  target: 'android'
  unit: 'dp'
  pxPerUnit: number
  viewport: { w: number; h: number; scale: number }
  rootId: string
  nodes: Record<string, DeviceNode>
  error?: string
  /** Optional, newer agents: the same identity fields as `/health`. */
  package?: unknown
  pid?: unknown
}

type IdentityResult = { ok: true; app: AndroidApp | null } | { ok: false; error: unknown }

export class AndroidAdapter {
  private forwarded = false
  private forwarding: Promise<void> | null = null
  private forwardError: unknown = null
  private readonly forwardGate = new RetryGate(FORWARD_RETRY_MS)
  private identity: { at: number; result: IdentityResult } | null = null
  private readonly warned = new Set<string>()

  constructor(
    private readonly port: number,
    private readonly device: string | null,
    /** The application id the agent must belong to (LD_ANDROID_PACKAGE); null checks nothing. */
    private readonly expectedPackage: string | null = null,
  ) {}

  private get adbArgs(): string[] {
    return this.device ? ['-s', this.device] : []
  }

  private get base(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /**
   * `adb forward` is idempotent, but running it on every request costs a process
   * spawn per capture, so it happens once and is retried only after a failure — and
   * then at most once per FORWARD_RETRY_MS: a failed forward (no device) is reported
   * again from memory until the next attempt is due. Concurrent callers share one run.
   */
  async ensureForward(budget?: Budget): Promise<void> {
    if (this.forwarded) return
    if (this.forwarding) return this.forwarding
    if (!this.forwardGate.ready() && this.forwardError) throw this.forwardError
    this.forwardGate.mark()
    const timeout = budget ? budget.timeout(ADB_TIMEOUT_MS) : ADB_TIMEOUT_MS
    this.forwarding = exec('adb', [...this.adbArgs, 'forward', `tcp:${this.port}`, `tcp:${this.port}`], { timeout })
      .then(() => {
        this.forwarded = true
        this.forwardError = null
      })
      .catch((err: unknown) => {
        this.forwardError = err
        throw err
      })
      .finally(() => {
        this.forwarding = null
      })
    return this.forwarding
  }

  /**
   * GET `path` on the agent, the body read in full, all within `budget`. A body that
   * stalls halfway counts against the same timeout as the headers.
   */
  private async request(path: string, budget: Budget): Promise<{ res: Response; body: Buffer }> {
    await this.ensureForward(budget)
    try {
      return await this.fetchOnce(path, budget)
    } catch (err) {
      // The app may have restarted (or another one took the port): ask again who it is.
      this.identity = null
      // A dropped forward looks exactly like a dead agent from here; re-arm and retry
      // once so replugging the device does not require restarting the tool. Not more
      // often than FORWARD_RETRY_MS: until then the failure itself is the answer
      // (classified as `device_no_bridge`), without spawning adb on every poll. And
      // only while the capture budget has room for it: a hung agent is reported once
      // the first attempt times out, not after a second full wait.
      if (!budget.allows(MIN_RETRY_MS)) throw err
      // The tree and the picture fail together: the second one rides on the re-arm the first started.
      const rearming = this.forwarding
      if (rearming) {
        await rearming
        return this.fetchOnce(path, budget)
      }
      if (!this.forwardGate.ready()) throw err
      this.forwarded = false
      await this.ensureForward(budget)
      return this.fetchOnce(path, budget)
    }
  }

  private async fetchOnce(path: string, budget: Budget): Promise<{ res: Response; body: Buffer }> {
    const res = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(budget.timeout(REQUEST_TIMEOUT_MS)) })
    return { res, body: Buffer.from(await res.arrayBuffer()) }
  }

  /**
   * JSON from the agent at `path`. A non-2xx answer or a body that is not JSON is a
   * LocalizedError naming the path, the status and what to do — not a SyntaxError
   * that reaches the window as a bare "Unexpected token".
   */
  private async requestJson<T>(path: string, budget: Budget): Promise<T> {
    const { res, body } = await this.request(path, budget)
    const text = body.toString('utf8')
    if (!res.ok) {
      throw new LocalizedError('deviceAgentHttp', { path: path.split('?')[0]!, status: res.status, reason: agentReason(text) })
    }
    try {
      return JSON.parse(text) as T
    } catch (err) {
      throw new LocalizedError('deviceAgentBadReply', {
        path: path.split('?')[0]!,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async capture(budget: Budget = new Budget(CAPTURE_BUDGET_MS)): Promise<Snapshot> {
    const tree = await this.requestJson<DeviceTree>('/tree', budget)
    if (tree.error) throw new LocalizedError('deviceAgentError', { reason: tree.error })
    const app = await this.appIdentity(tree, budget)
    const snapshot = normalize(tree)
    if (app) snapshot.app = app
    return snapshot
  }

  /**
   * The tree and the device picture, requested at the same time under one budget:
   * one round-trip instead of two in a row, and the picture belongs to the same
   * moment as the tree. A failed picture does not fail the capture — the tree is
   * still good, and the window's frame request reports the picture's own error.
   */
  async captureFrame(): Promise<CapturedFrame> {
    // The link was found dead moments ago: say so at once instead of another 6 s wait.
    const known = this.link
    if (known && known.verdict.kind === 'unresponsive' && Date.now() - known.at < LINK_TTL_MS) {
      throw this.unresponsiveError()
    }
    const budget = new Budget(CAPTURE_BUDGET_MS)
    const [tree, png] = await Promise.allSettled([this.capture(budget), this.screenshot(budget)])
    if (tree.status === 'rejected') throw await this.explainFailure(tree.reason, budget)
    if (this.link?.verdict.kind === 'unresponsive') {
      console.log(`[layout-debug] the adb link to ${this.device ?? 'the device'} answers again`)
      this.link = null
    }
    return png.status === 'fulfilled'
      ? { snapshot: tree.value, png: png.value, pngError: null }
      : { snapshot: tree.value, png: null, pngError: png.reason }
  }

  private link: { at: number; verdict: LinkVerdict } | null = null
  private linkProbe: Promise<LinkVerdict> | null = null

  /**
   * A capture that failed like a silent agent (timeout, refused or reset connection,
   * an adb call on the capture path killed by its timeout) can also be a dead adb
   * link: `adb devices` still lists the device, but nothing reaches it, and every
   * request through the forward just hangs. Restarting the app does not help then, so
   * the window must not say "start the app". One short shell probe tells the two apart.
   */
  private async explainFailure(err: unknown, budget: Budget): Promise<unknown> {
    if (!needsLinkCheck(err)) return err
    const verdict = await this.checkLink(budget)
    switch (verdict.kind) {
      case 'alive':
        return err
      case 'unresponsive':
        return this.unresponsiveError()
      case 'failed':
        // adb's own answer ("device offline", "not found") names the cause better than a timeout.
        return classifyCaptureError(verdict.error) === 'device' ? err : verdict.error
    }
  }

  private unresponsiveError(): LocalizedError {
    return new LocalizedError('deviceUnresponsive', { serial: this.device ?? '<serial from adb devices>' })
  }

  /** `adb shell echo ok`, its verdict reused for LINK_TTL_MS; concurrent callers share one run. */
  private checkLink(budget: Budget): Promise<LinkVerdict> {
    const known = this.link
    if (known && Date.now() - known.at < LINK_TTL_MS) return Promise.resolve(known.verdict)
    if (this.linkProbe) return this.linkProbe
    const timeout = Math.max(LINK_PROBE_MIN_MS, Math.min(LINK_PROBE_MAX_MS, budget.remaining()))
    this.linkProbe = exec('adb', [...this.adbArgs, 'shell', 'echo', 'ok'], { timeout })
      .then(
        ({ stdout }) => linkVerdictOf({ ok: true, stdout: String(stdout) }),
        (error: unknown) => linkVerdictOf({ ok: false, error }),
      )
      .then((verdict) => {
        const was = this.link?.verdict.kind
        if (verdict.kind === 'unresponsive' && was !== 'unresponsive') {
          console.warn(
            `[layout-debug] adb lists ${this.device ?? 'the device'} but \`adb shell\` did not answer within ${timeout} ms: ` +
              'the adb link is stalled (reconnect wireless debugging or replug USB)',
          )
        } else if (verdict.kind === 'alive' && was === 'unresponsive') {
          console.log(`[layout-debug] the adb link to ${this.device ?? 'the device'} answers again`)
        }
        this.link = { at: Date.now(), verdict }
        return verdict
      })
      .finally(() => {
        this.linkProbe = null
      })
    return this.linkProbe
  }

  /**
   * Which app the agent on the port belongs to, checked against LD_ANDROID_PACKAGE.
   * Throws a LocalizedError (`device_wrong_app`) on a mismatch or when the configured
   * app is not running. Null when nothing is known and nothing is configured, which
   * keeps an older agent working exactly as before.
   */
  private async appIdentity(tree: DeviceTree, budget: Budget): Promise<AndroidApp | null> {
    // Identity inside /tree costs nothing extra: no cache, no /health call.
    const fromTree = parseAgentIdentity({ package: tree.package, pid: tree.pid })
    this.warnProblems('/tree', fromTree.problems)
    if (fromTree.package) return this.settle(fromTree, budget)

    const cached = this.identity
    if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) {
      if (cached.result.ok) return cached.result.app
      throw cached.result.error
    }
    let result: IdentityResult
    try {
      result = { ok: true, app: await this.settle(await this.healthIdentity(budget), budget) }
    } catch (err) {
      result = { ok: false, error: err }
    }
    this.identity = { at: Date.now(), result }
    if (result.ok) return result.app
    throw result.error
  }

  private async settle(reported: AgentIdentity, budget: Budget): Promise<AndroidApp | null> {
    const verdict = checkAppIdentity(this.expectedPackage, reported)
    switch (verdict.kind) {
      case 'ok':
        return verdict.app
      case 'mismatch':
        throw new LocalizedError('deviceWrongApp', {
          port: this.port,
          expected: verdict.expected,
          actual: verdict.actual,
        })
      case 'check-adb': {
        const pid = await this.pidof(verdict.expected, budget)
        if (pid === null) {
          throw new LocalizedError('deviceAppNotRunning', { port: this.port, expected: verdict.expected })
        }
        this.warnOnce(
          'no-package',
          `[layout-debug] the agent on port ${this.port} does not report its package in /health; ` +
            `adb only confirmed that ${verdict.expected} is running (pid ${pid})`,
        )
        return { package: verdict.expected, pid, source: 'adb' }
      }
    }
  }

  /**
   * `package`/`pid` from the agent's `/health`. Any failure here means "the agent did
   * not say", never a failed capture: /tree already answered, and an older agent has
   * no such fields. Logged once per kind of failure.
   */
  private async healthIdentity(budget: Budget): Promise<AgentIdentity> {
    try {
      const res = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(budget.timeout(ADB_TIMEOUT_MS)) })
      if (!res.ok) {
        this.warnOnce(`health-${res.status}`, `[layout-debug] the device agent answered /health with HTTP ${res.status}`)
        return { package: null, pid: null }
      }
      const parsed = parseAgentIdentity(await res.json())
      this.warnProblems('/health', parsed.problems)
      return parsed
    } catch (err) {
      this.warnOnce(
        'health-failed',
        `[layout-debug] could not read /health of the device agent (${err instanceof Error ? err.message : String(err)})`,
      )
      return { package: null, pid: null }
    }
  }

  /** `adb shell pidof <package>`: the pid, or null when the app is not running. */
  private async pidof(pkg: string, budget: Budget): Promise<number | null> {
    try {
      // `pkg` passed isAndroidPackage (config.ts), so it is safe in the device shell.
      const { stdout } = await exec('adb', [...this.adbArgs, 'shell', 'pidof', pkg], {
        timeout: budget.timeout(ADB_TIMEOUT_MS),
      })
      return parsePidof(String(stdout))
    } catch (err) {
      // pidof exits 1 with no output when nothing runs under that name.
      const e = err as { code?: unknown; stdout?: unknown }
      if (e.code === 1 && !String(e.stdout ?? '').trim()) return null
      throw err
    }
  }

  private warnProblems(where: string, problems: string[]) {
    for (const p of problems) this.warnOnce(`${where} ${p}`, `[layout-debug] ignoring a ${where} field: ${p}`)
  }

  private warnOnce(key: string, line: string) {
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn(line)
  }

  async screenshot(budget: Budget = new Budget(CAPTURE_BUDGET_MS)): Promise<Buffer> {
    const { res, body } = await this.request('/screenshot', budget)
    if (!res.ok) throw screenshotError(res.status, body.toString('utf8'))
    return body
  }

  async setOverride(override: Override): Promise<void> {
    const budget = new Budget(CAPTURE_BUDGET_MS)
    const params = new URLSearchParams({
      id: override.nodeId,
      dx: String(Math.round(override.dx)),
      dy: String(Math.round(override.dy)),
      w: override.width != null ? String(Math.round(override.width)) : '-1',
      h: override.height != null ? String(Math.round(override.height)) : '-1',
    })
    const body = await this.requestJson<{ ok?: boolean; error?: string }>(`/override?${params}`, budget)
    if (body.error) throw new Error(body.error)
  }

  /**
   * Same rule as every JSON route: a non-2xx status (deviceAgentHttp, from requestJson) or an
   * `error` field in a 2xx body (the agent could not reach its main thread, say) is a failure.
   */
  async clearOverrides(): Promise<void> {
    const body = await this.requestJson<{ ok?: boolean; error?: string }>('/overrides/clear', new Budget(CAPTURE_BUDGET_MS))
    if (body.error) throw new Error(body.error)
  }

  private model: string | null = null
  private modelTriedAt = Number.NEGATIVE_INFINITY
  private modelLookup: Promise<string | null> | null = null

  /** The model if it is already known; never runs adb. */
  get knownModel(): string | null {
    return this.model
  }

  /**
   * `ro.product.model` ("Pixel 8") for the window's device chip. Null when adb cannot
   * tell — no adb, no device, several devices without LD_DEVICE — logged, never thrown:
   * a missing model must not keep the window from getting `ready`. A found model is
   * cached for good; a failure is answered from memory for MODEL_RETRY_MS, so windows
   * that connect meanwhile do not each spawn adb, and plugging the device in later is
   * still picked up. Concurrent callers share one adb run.
   */
  deviceModel(): Promise<string | null> {
    if (this.model) return Promise.resolve(this.model)
    if (this.modelLookup) return this.modelLookup
    if (Date.now() - this.modelTriedAt < MODEL_RETRY_MS) return Promise.resolve(null)
    this.modelLookup = this.readModel().finally(() => {
      this.modelLookup = null
    })
    return this.modelLookup
  }

  private async readModel(): Promise<string | null> {
    this.modelTriedAt = Date.now()
    try {
      const { stdout } = await exec('adb', [...this.adbArgs, 'shell', 'getprop', 'ro.product.model'], { timeout: 3_000 })
      const model = String(stdout).trim()
      if (!model) {
        console.warn('[layout-debug] adb returned an empty ro.product.model; the device chip shows a generic name')
        return null
      }
      this.model = model
      return model
    } catch (err) {
      console.warn(
        `[layout-debug] could not read the device model via adb (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); ` +
          'the device chip shows a generic name',
      )
      return null
    }
  }

  /** Which devices adb can see — used to explain "no device" with actual data. */
  static async devices(): Promise<string[]> {
    const { stdout } = await exec('adb', ['devices'])
    return String(stdout)
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.endsWith('device'))
      .map((line) => line.split(/\s+/)[0]!)
  }
}

/** Longest piece of an agent's error body quoted back to the window. */
const AGENT_REASON_MAX = 200

/**
 * What a non-2xx agent body says, for the error text: `{"error": "..."}` → that
 * string, any other text → the text itself; whitespace collapsed, capped, and
 * prefixed for the template (": …"), empty when the body says nothing. Pure;
 * exported for tests.
 */
export function agentReason(body: string): string {
  let reason = body
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      reason = (parsed as { error: string }).error
    }
  } catch {
    // Not JSON: the text as is.
  }
  reason = reason.replace(/\s+/g, ' ').trim()
  if (!reason) return ''
  if (reason.length > AGENT_REASON_MAX) reason = `${reason.slice(0, AGENT_REASON_MAX)}…`
  return `: ${reason}`
}

/**
 * A non-2xx `/screenshot` answer as the window's error: with the agent's own reason when its
 * body names one (`{"error":"screenshots need Android 8.0 …"}`), else just the status. Pure;
 * exported for tests.
 */
export function screenshotError(status: number, body: string): LocalizedError {
  const reason = agentReason(body)
  return reason
    ? new LocalizedError('deviceScreenshotAgentError', { status, reason })
    : new LocalizedError('deviceScreenshotError', { status })
}

/**
 * Does this capture failure need the adb link probe to be told apart from a silent
 * agent? Yes for what looks like "nothing answers" — a timed-out or refused request
 * through the forward, or an adb call on the capture path killed by its timeout. No
 * for anything the agent or adb actually said (an agent error, a wrong app, the
 * configured app not running, no device, no adb): those already name their cause.
 * Pure; exported for tests.
 */
export function needsLinkCheck(err: unknown): boolean {
  if (err instanceof LocalizedError) return false
  if (isAdbTimeout(err)) return true
  return classifyCaptureError(err) === 'device_no_bridge'
}

/**
 * Why a device capture failed, as an ErrorCode the window branches on (the
 * localized text next to it is for people only). Pure; exported for tests.
 */
export function classifyCaptureError(err: unknown): ErrorCode {
  if (err instanceof LocalizedError) {
    if (err.key === 'deviceAgentError') return 'device_no_bridge'
    if (err.key === 'deviceWrongApp' || err.key === 'deviceAppNotRunning') return 'device_wrong_app'
    if (err.key === 'deviceScreenshotError' || err.key === 'deviceScreenshotAgentError') return 'screenshot'
    if (err.key === 'deviceUnresponsive') return 'device_unresponsive'
    // The agent answered, just not with a usable tree: its own words are the cause, not the bridge setup.
    if (err.key === 'deviceAgentHttp' || err.key === 'deviceAgentBadReply') return 'device'
  }
  const e = err as { code?: unknown; message?: unknown; stderr?: unknown; cause?: { code?: unknown } } | null
  const text = [e?.message, e?.stderr].filter((s) => typeof s === 'string').join('\n')
  if (e?.code === 'ENOENT' || /ENOENT|not recognized|spawn adb/i.test(text)) return 'device_no_adb'
  if (/no devices|no emulators|device .*not found|device offline|unauthorized/i.test(text)) return 'device_not_found'
  // adb forward worked but nothing answers on the port: the app is not running or has no bridge.
  if (
    /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|timed? ?out|aborted/i.test(text) ||
    e?.cause?.code === 'ECONNREFUSED' ||
    e?.cause?.code === 'ECONNRESET'
  ) {
    return 'device_no_bridge'
  }
  return 'device'
}

/**
 * Device tree → the same Snapshot shape the web adapter produces, so the UI, the MCP
 * server and the agent prompt stay identical across targets.
 */
function normalize(tree: DeviceTree): Snapshot {
  const nodes: Record<NodeId, LayoutNode> = {}

  for (const [id, n] of Object.entries(tree.nodes)) {
    const dp = (px: number) => `${Math.round((px / tree.pxPerUnit) * 10) / 10}dp`
    nodes[id] = {
      id,
      parentId: n.parentId,
      childIds: n.childIds,
      depth: n.depth,
      kind: n.kind,
      label: n.kind,
      bounds: n.bounds,
      anchors: {
        sourceLoc: n.source ? `${n.source.file}:${n.source.line}` : undefined,
        path: pathOf(tree, id),
      },
      styles: {
        composable: n.kind,
        width: dp(n.bounds.w),
        height: dp(n.bounds.h),
        x: dp(n.bounds.x),
        y: dp(n.bounds.y),
        // Compose tweaks land on the node that owns the modifier chain; a node without
        // one can be selected and described but not dragged.
        movable: n.movable ? 'yes' : 'no',
      },
    }
  }

  return {
    id: `android-${Date.now()}`,
    target: 'android',
    createdAt: Date.now(),
    unit: 'dp',
    pxPerUnit: tree.pxPerUnit,
    viewport: { w: tree.viewport.w, h: tree.viewport.h },
    rootId: tree.rootId,
    nodes,
  }
}

/** `Scaffold > Column > Row > Text` — the readable trail an agent can search by. */
function pathOf(tree: DeviceTree, id: string): string {
  const parts: string[] = []
  let cur: DeviceNode | undefined = tree.nodes[id]
  while (cur && parts.length < 8) {
    parts.unshift(cur.kind)
    cur = cur.parentId ? tree.nodes[cur.parentId] : undefined
  }
  return parts.join(' > ')
}
