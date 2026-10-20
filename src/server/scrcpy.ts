import { dirname, join } from 'node:path'

/**
 * Pure pieces of the scrcpy video relay (scrcpyStream.ts does the I/O): the byte parser
 * of the video socket, the device command line, and where a scrcpy install keeps its
 * server. Unit-tested directly (scrcpy.test.ts).
 *
 * Protocol of scrcpy 4.x (doc/develop.md "Protocol", server Streamer.java), video socket
 * only, forward tunnel, `send_device_meta=false`:
 *
 *     1 byte    dummy byte (tells a live server from a forward nobody listens behind)
 *     u32       codec id ("h264" = 0x68323634; 0 / 1: the device disabled the stream)
 *     then 12-byte headers, each followed by its payload:
 *       session packet  MSB of byte 0 set; u32 width at 4, u32 height at 8; no payload
 *       media packet    u64 at 0: bit 63 = 0, bit 62 config, bit 61 key frame, low 61 bits PTS (µs);
 *                       u32 packet size at 8, then that many bytes
 *
 * The protocol is internal to scrcpy and changes between versions, which is why the
 * server and the version string handed to it must match exactly.
 */

const CODEC_H264 = 0x68323634
/** A packet larger than this is a broken stream, not a frame (a 4K key frame is a few MB). */
export const MAX_PACKET_BYTES = 32 * 1024 * 1024

const HEADER_BYTES = 12
const SESSION_FLAG = 0x80
const CONFIG_BIT = 1n << 62n
const KEY_BIT = 1n << 61n
const PTS_MASK = (1n << 61n) - 1n

export type ScrcpyEvent =
  | { kind: 'ready' }
  | { kind: 'session'; width: number; height: number }
  | { kind: 'packet'; config: boolean; key: boolean; pts: number; data: Buffer }

/** A stream the relay cannot go on with; `message` says what came instead. */
export class ScrcpyProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScrcpyProtocolError'
  }
}

/**
 * Incremental parser of the video socket: feed it chunks as they come, get whole events.
 * `ready` comes once, after the codec id; packets are split at their real boundaries
 * whatever the chunking.
 */
export class ScrcpyParser {
  private stage: 'dummy' | 'codec' | 'packets' = 'dummy'
  private chunks: Buffer[] = []
  private length = 0

  /**
   * The server answered (the dummy byte came). A forward accepts a connection even when
   * nothing listens behind it yet, and then closes it without a byte.
   */
  get answered(): boolean {
    return this.stage !== 'dummy'
  }

  push(chunk: Buffer): ScrcpyEvent[] {
    if (chunk.length) {
      this.chunks.push(chunk)
      this.length += chunk.length
    }
    const events: ScrcpyEvent[] = []
    for (;;) {
      if (this.stage === 'dummy') {
        if (this.length < 1) break
        this.take(1)
        this.stage = 'codec'
        continue
      }
      if (this.stage === 'codec') {
        if (this.length < 4) break
        const id = this.take(4).readUInt32BE(0)
        if (id === 0 || id === 1) {
          throw new ScrcpyProtocolError(
            id === 1 ? 'the device reported a configuration error and stopped the video' : 'the device disabled the video stream',
          )
        }
        if (id !== CODEC_H264) throw new ScrcpyProtocolError(`the device streams codec ${codecName(id)}, expected h264`)
        this.stage = 'packets'
        events.push({ kind: 'ready' })
        continue
      }
      if (this.length < HEADER_BYTES) break
      const header = this.peek(HEADER_BYTES)
      if (header[0]! & SESSION_FLAG) {
        this.take(HEADER_BYTES)
        events.push({ kind: 'session', width: header.readUInt32BE(4), height: header.readUInt32BE(8) })
        continue
      }
      const size = header.readUInt32BE(8)
      if (size > MAX_PACKET_BYTES) throw new ScrcpyProtocolError(`a video packet claims ${size} bytes`)
      if (this.length < HEADER_BYTES + size) break
      this.take(HEADER_BYTES)
      const flags = header.readBigUInt64BE(0)
      const config = (flags & CONFIG_BIT) !== 0n
      events.push({
        kind: 'packet',
        config,
        key: !config && (flags & KEY_BIT) !== 0n,
        pts: config ? 0 : Number(flags & PTS_MASK),
        data: this.take(size),
      })
    }
    return events
  }

  private peek(n: number): Buffer {
    if (this.chunks[0]!.length < n) this.chunks = [Buffer.concat(this.chunks)]
    return this.chunks[0]!.subarray(0, n)
  }

  /** The next `n` bytes, consumed. Joins chunks only when a piece spans them. */
  private take(n: number): Buffer {
    if (this.chunks[0]!.length < n) this.chunks = [Buffer.concat(this.chunks)]
    const head = this.chunks[0]!
    if (head.length === n) this.chunks.shift()
    else this.chunks[0] = head.subarray(n)
    this.length -= n
    return head.subarray(0, n)
  }
}

function codecName(id: number): string {
  const text = Buffer.alloc(4)
  text.writeUInt32BE(id >>> 0)
  const ascii = text.toString('latin1').replace(/^\0+/, '')
  return /^[\x20-\x7e]+$/.test(ascii) ? `"${ascii}"` : `0x${(id >>> 0).toString(16)}`
}

// --- the device command ------------------------------------------------------

/** Where the server goes on the device: readable by `shell`, not world-writable (scrcpy's own advice). */
export const DEVICE_JAR = '/data/local/tmp/layout-debug-scrcpy-server.jar'
/** Longest side of the video. The window scales the frame down to fit anyway. */
export const STREAM_MAX_SIZE = 1920

/** What a version string may look like: it goes into a device shell command. */
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/

export function isScrcpyVersion(v: string): boolean {
  return VERSION_RE.test(v)
}

/** `scrcpy --version` → "4.1"; null when the first line is not scrcpy's. */
export function parseScrcpyVersion(output: string): string | null {
  const m = /^\s*scrcpy\s+v?(\S+)/m.exec(output)
  return m && isScrcpyVersion(m[1]!) ? m[1]! : null
}

/** A 31-bit client id as scrcpy-server reads it (`scid`, hex) and names its socket after (`scrcpy_%08x`). */
export function scidOf(random: number): string {
  return (Math.floor(Math.abs(random) * 0x7fffffff) & 0x7fffffff).toString(16).padStart(8, '0')
}

export function socketNameOf(scid: string): string {
  return `scrcpy_${scid}`
}

/**
 * The `adb shell` command that starts the server: video only, H.264, forward tunnel,
 * no device name. Every value is checked here, because it runs in the device's shell.
 */
export function serverCommand(version: string, scid: string, maxSize = STREAM_MAX_SIZE): string {
  if (!isScrcpyVersion(version)) throw new Error(`not a scrcpy version: ${JSON.stringify(version)}`)
  if (!/^[0-9a-f]{8}$/.test(scid)) throw new Error(`not a scid: ${JSON.stringify(scid)}`)
  if (!Number.isInteger(maxSize) || maxSize < 0) throw new Error(`not a max size: ${maxSize}`)
  return [
    `CLASSPATH=${DEVICE_JAR}`,
    'app_process',
    '/',
    'com.genymobile.scrcpy.Server',
    version,
    `scid=${scid}`,
    'log_level=info',
    'video_codec=h264',
    'audio=false',
    'control=false',
    'tunnel_forward=true',
    'send_device_meta=false',
    `max_size=${maxSize}`,
  ].join(' ')
}

/** `adb forward tcp:0 …` prints the port it picked. */
export function parseForwardPort(stdout: string): number | null {
  const m = /^\s*(\d{1,5})\s*$/.exec(stdout)
  const port = m ? Number(m[1]) : NaN
  return port >= 1 && port <= 65535 ? port : null
}

// --- what adb said ------------------------------------------------------------

/**
 * A failed child process as text, adb's own words included. execFile puts only
 * "Command failed: <cmd>" on the first line of `message`; the cause (`more than one
 * device/emulator`, `unauthorized`) is in `stderr`, which is joined in, whitespace
 * collapsed.
 */
export function processErrorText(err: unknown): string {
  const e = err as { message?: unknown; stderr?: unknown } | null
  const message = typeof e?.message === 'string' ? e.message : String(err)
  const [head = '', ...rest] = message.split('\n')
  const stderr = typeof e?.stderr === 'string' ? e.stderr : rest.join('\n')
  const said = stderr.replace(/\s+/g, ' ').trim()
  const first = head.trim()
  return said && !first.includes(said) ? `${first}: ${said}` : first
}

/**
 * Which window code an adb failure on the video path gets: adb not installed, no usable
 * device, several devices and no LD_DEVICE, or anything else (`scrcpy_failed`).
 */
export function adbFailureCode(err: unknown): 'device_no_adb' | 'device_not_found' | 'device_ambiguous' | 'scrcpy_failed' {
  const e = err as { code?: unknown; message?: unknown; stderr?: unknown } | null
  const text = [e?.message, e?.stderr].filter((s) => typeof s === 'string').join('\n')
  if (e?.code === 'ENOENT' || /spawn adb|not recognized as an internal/i.test(text)) return 'device_no_adb'
  if (/more than one (device|emulator)/i.test(text)) return 'device_ambiguous'
  if (/no devices|no emulators|device .*not found|device offline|unauthorized/i.test(text)) return 'device_not_found'
  return 'scrcpy_failed'
}

// --- where scrcpy-server lives ----------------------------------------------

/**
 * The `scrcpy` executable on PATH, or null. Windows: every PATHEXT extension; elsewhere
 * the bare name. `exists` is injected so the search is testable.
 */
export function findOnPath(
  name: string,
  env: { PATH?: string; Path?: string; PATHEXT?: string },
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ''), `${name}${ext.toLowerCase()}`)
      if (exists(file)) return file
    }
  }
  return null
}

/**
 * Where a scrcpy install keeps the server, given its executable: next to it (the
 * Windows zip, a manual build) or in `share/scrcpy` beside its `bin` (Linux packages,
 * Homebrew). `exe` should already have symlinks resolved.
 */
export function serverCandidates(exe: string): string[] {
  const dir = dirname(exe)
  return [join(dir, 'scrcpy-server'), join(dir, '..', 'share', 'scrcpy', 'scrcpy-server')]
}
