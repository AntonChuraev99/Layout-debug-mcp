import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { StreamErrorCode } from '../shared/stream.ts'
import {
  adbFailureCode,
  DEVICE_JAR,
  findOnPath,
  parseForwardPort,
  parseScrcpyVersion,
  processErrorText,
  ScrcpyParser,
  scidOf,
  serverCandidates,
  serverCommand,
  socketNameOf,
  type ScrcpyEvent,
} from './scrcpy.ts'

const execFileAsync = promisify(execFile)

/** `windowsHide`: the server may run detached without a console (see android.ts `exec`). */
function run(file: string, args: string[], timeout: number) {
  return execFileAsync(file, args, { timeout, windowsHide: true, encoding: 'utf8' })
}

const ADB_TIMEOUT_MS = 10_000
/** From `app_process` to the dummy byte; a cold start over wireless adb takes about a second. */
const CONNECT_TIMEOUT_MS = 10_000
const CONNECT_RETRY_MS = 100
/** The tail of the server's own output kept for the error text (version mismatch, encoder errors). */
const OUTPUT_TAIL = 1_500

/** Why a run or a lookup failed; becomes the window's `{t: 'error'}` (src/shared/stream.ts). */
export interface ScrcpyFailure {
  code: StreamErrorCode
  detail: string
}

export interface ScrcpyServerFile {
  jar: string
  version: string
}

export interface ScrcpySettings {
  /** LD_SCRCPY_SERVER / "scrcpyServer": the scrcpy-server file. Null: look for a scrcpy install. */
  server: string | null
  /** LD_SCRCPY_VERSION / "scrcpyVersion". Null: ask `scrcpy --version`. */
  version: string | null
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

let resolved: { key: string; file: ScrcpyServerFile } | null = null

/**
 * Which scrcpy-server to push and which version string it wants. The configured file
 * (LD_SCRCPY_SERVER, "scrcpyServer") first, else the one a scrcpy install on PATH ships.
 * scrcpy's own SCRCPY_SERVER_PATH is not read: left over from another install it would
 * shadow the working one, and its version could not be told. The version comes from the configuration or from
 * `scrcpy --version` of the install next to the file (or on PATH). A success is kept for
 * the life of the process; a failure is asked again next time (the user may install scrcpy
 * meanwhile). Nothing is bundled with this package.
 */
export async function resolveScrcpyServer(
  settings: ScrcpySettings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; file: ScrcpyServerFile } | ({ ok: false } & ScrcpyFailure)> {
  const key = JSON.stringify([settings, env.PATH ?? ''])
  if (resolved?.key === key) return { ok: true, file: resolved.file }

  const explicit = settings.server
  if (explicit && !isFile(explicit)) {
    return { ok: false, code: 'scrcpy_not_found', detail: `LD_SCRCPY_SERVER / "scrcpyServer" points at ${explicit}, which is not a file` }
  }

  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  const onPath = findOnPath('scrcpy', env, process.platform, isFile)
  const pathExe = onPath ? real(onPath) : null
  let jar = explicit
  if (!jar && pathExe) jar = serverCandidates(pathExe).find(isFile) ?? null
  if (!jar) {
    return {
      ok: false,
      code: 'scrcpy_not_found',
      detail: pathExe
        ? `scrcpy is at ${pathExe}, but there is no scrcpy-server in ${serverCandidates(pathExe).join(' or ')}`
        : 'no scrcpy on PATH, and LD_SCRCPY_SERVER is not set',
    }
  }

  let version = settings.version
  if (!version) {
    // The install the file came from knows its version; a scrcpy elsewhere on PATH may be another one.
    const besideJar = findOnPath('scrcpy', { PATH: dirname(jar), PATHEXT: env.PATHEXT }, process.platform, isFile)
    const exe = besideJar ?? (explicit ? null : pathExe)
    if (exe) {
      try {
        const { stdout } = await run(exe, ['--version'], ADB_TIMEOUT_MS)
        version = parseScrcpyVersion(String(stdout))
      } catch (err) {
        return { ok: false, code: 'scrcpy_version_unknown', detail: `${exe} --version failed: ${processErrorText(err)}` }
      }
    }
    if (!version) {
      return {
        ok: false,
        code: 'scrcpy_version_unknown',
        detail: exe
          ? `${exe} --version did not print a scrcpy version`
          : `no scrcpy executable next to ${jar} to ask its version; set LD_SCRCPY_VERSION`,
      }
    }
  }
  const file = { jar, version }
  resolved = { key, file }
  return { ok: true, file }
}

export interface StreamHandlers {
  event: (e: ScrcpyEvent) => void
  /** Called once: null after `stop()`, a failure otherwise. */
  end: (failure: ScrcpyFailure | null) => void
}

/**
 * One scrcpy-server run on the device for one window stream: push, `adb forward tcp:0`
 * to its socket, `app_process`, read the video socket. `stop()` (or any failure) closes
 * the socket — the server exits when its socket goes — kills the local `adb shell` and
 * removes the forward, so nothing is left behind on either side.
 */
export class ScrcpyStream {
  readonly scid = scidOf(Math.random())
  private child: ChildProcess | null = null
  private socket: Socket | null = null
  private port: number | null = null
  private output = ''
  private ended = false
  private readonly parser = new ScrcpyParser()

  constructor(
    private readonly device: string | null,
    private readonly file: ScrcpyServerFile,
    private readonly handlers: StreamHandlers,
  ) {}

  private get adbArgs(): string[] {
    return this.device ? ['-s', this.device] : []
  }

  async start(): Promise<void> {
    try {
      await run('adb', [...this.adbArgs, 'push', this.file.jar, DEVICE_JAR], ADB_TIMEOUT_MS)
      if (this.ended) return
      const { stdout } = await run(
        'adb',
        [...this.adbArgs, 'forward', 'tcp:0', `localabstract:${socketNameOf(this.scid)}`],
        ADB_TIMEOUT_MS,
      )
      const port = parseForwardPort(String(stdout))
      if (port === null) throw new Error(`adb forward did not print a port (got ${JSON.stringify(String(stdout).trim())})`)
      this.port = port
      if (this.ended) return this.release(false)
      this.spawnServer()
      await this.connectWhenUp(Date.now() + CONNECT_TIMEOUT_MS)
    } catch (err) {
      this.failOn(err)
    }
  }

  /** A failed adb call (push, forward, shell): adb's own words, under the code they point to. */
  private failOn(err: unknown) {
    const code = adbFailureCode(err)
    const text = processErrorText(err)
    this.fail(code, code === 'scrcpy_failed' ? this.withOutput(text) : text)
  }

  private spawnServer() {
    const child = spawn('adb', [...this.adbArgs, 'shell', serverCommand(this.file.version, this.scid)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    const keep = (chunk: Buffer) => {
      this.output = (this.output + chunk.toString('utf8')).slice(-OUTPUT_TAIL)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (err) => this.failOn(err))
    child.on('exit', (code) => {
      this.child = null
      // A server that stops while the window still streams: version mismatch, encoder failure, device gone.
      if (!this.ended) this.fail('scrcpy_failed', this.withOutput(`scrcpy-server exited (code ${code})`))
    })
  }

  /** Connects through the forward until the server's dummy byte comes (it listens only once it is up). */
  private async connectWhenUp(deadline: number): Promise<void> {
    while (!this.ended) {
      const answered = await this.tryConnect()
      if (answered || this.ended) return
      if (Date.now() > deadline) throw new Error(`scrcpy-server did not answer within ${CONNECT_TIMEOUT_MS / 1000} s`)
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS))
    }
  }

  /** True once the server answered on this connection; false when the forward hung up empty. */
  private tryConnect(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect(this.port!, '127.0.0.1')
      // Held from the start: a stop or a failure before the dummy byte must close it too.
      this.socket = socket
      let settled = false
      const settle = (answered: boolean) => {
        if (settled) return
        settled = true
        resolve(answered)
      }
      socket.on('data', (chunk) => {
        if (this.ended) return
        let events: ScrcpyEvent[]
        try {
          events = this.parser.push(chunk)
        } catch (err) {
          this.fail('stream_protocol', err instanceof Error ? err.message : String(err))
          return
        }
        if (this.parser.answered) settle(true)
        for (const e of events) this.handlers.event(e)
      })
      socket.on('error', () => settle(false))
      socket.on('close', () => {
        if (!settled) {
          // An empty hang-up of the forward: the next attempt gets its own socket.
          if (this.socket === socket) this.socket = null
          return settle(false)
        }
        if (!this.ended) this.fail('scrcpy_failed', this.withOutput('the video connection to the device closed'))
      })
    })
  }

  private withOutput(reason: string): string {
    const out = this.output.replace(/\s+$/, '')
    return out ? `${reason}. scrcpy-server said: ${out}` : reason
  }

  private fail(code: StreamErrorCode, detail: string) {
    if (this.ended) return
    this.ended = true
    console.warn(`[layout-debug] live video stopped (${code}): ${detail}`)
    this.release(false)
    this.handlers.end({ code, detail })
  }

  /** The window closed the stream or turned it off. */
  stop() {
    if (this.ended) return
    this.ended = true
    this.release(false)
    this.handlers.end(null)
  }

  /** Server shutdown: the same, but the forward is removed before the process exits. */
  stopSync() {
    if (this.ended) return
    this.ended = true
    this.release(true)
  }

  /**
   * Everything this run holds on either side. The server exits once its socket is gone;
   * killing the local `adb shell` ends the session if it never got that far (it would
   * wait in accept() otherwise).
   */
  private release(sync: boolean) {
    this.socket?.destroy()
    this.socket = null
    this.child?.kill()
    const port = this.port
    this.port = null
    if (port !== null) this.removeForward(port, sync)
  }

  protected removeForward(port: number, sync: boolean) {
    const args = [...this.adbArgs, 'forward', '--remove', `tcp:${port}`]
    if (sync) {
      try {
        execFileSync('adb', args, { timeout: 2_000, windowsHide: true, stdio: 'ignore' })
      } catch {
        // The device is gone: so is its forward.
      }
      return
    }
    run('adb', args, ADB_TIMEOUT_MS).catch((err: unknown) => {
      console.warn(`[layout-debug] could not remove the video forward tcp:${port}: ${processErrorText(err)}`)
    })
  }
}
