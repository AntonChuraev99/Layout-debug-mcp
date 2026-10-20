import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  adbFailureCode,
  DEVICE_JAR,
  processErrorText,
  findOnPath,
  MAX_PACKET_BYTES,
  parseForwardPort,
  parseScrcpyVersion,
  ScrcpyParser,
  ScrcpyProtocolError,
  scidOf,
  serverCandidates,
  serverCommand,
  socketNameOf,
  type ScrcpyEvent,
} from './scrcpy.ts'

// Byte layouts as scrcpy 4.1's Streamer.java writes them (doc/develop.md "Protocol").
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const session = (w: number, h: number) => Buffer.concat([u32(0x80000000), u32(w), u32(h)])
function media(payload: Buffer, opts: { config?: boolean; key?: boolean; pts?: bigint } = {}) {
  const header = Buffer.alloc(12)
  const flags = opts.config ? 1n << 62n : (opts.pts ?? 0n) | (opts.key ? 1n << 61n : 0n)
  header.writeBigUInt64BE(flags)
  header.writeUInt32BE(payload.length, 8)
  return Buffer.concat([header, payload])
}
const H264 = u32(0x68323634)
// The config packet a Pixel 9 sent (SPS + PPS, High profile, level 4.2), shortened.
const CONFIG = Buffer.from('000000016764002aacb406c00000000168ee3cb0', 'hex')
const KEY = Buffer.from('0000000165b84f0f5bc9fff0', 'hex')
const DELTA = Buffer.from('0000000121e2233f00408747', 'hex')

const STREAM = Buffer.concat([
  Buffer.from([0]),
  H264,
  session(854, 1920),
  media(CONFIG, { config: true }),
  media(KEY, { key: true, pts: 1_000_000n }),
  media(DELTA, { pts: 1_016_666n }),
  session(1920, 854),
])

function summary(events: ScrcpyEvent[]) {
  return events.map((e) =>
    e.kind === 'packet' ? { ...e, data: e.data.toString('hex') } : e,
  )
}

describe('ScrcpyParser', () => {
  const expected = [
    { kind: 'ready' },
    { kind: 'session', width: 854, height: 1920 },
    { kind: 'packet', config: true, key: false, pts: 0, data: CONFIG.toString('hex') },
    { kind: 'packet', config: false, key: true, pts: 1_000_000, data: KEY.toString('hex') },
    { kind: 'packet', config: false, key: false, pts: 1_016_666, data: DELTA.toString('hex') },
    { kind: 'session', width: 1920, height: 854 },
  ]

  test('the whole stream in one chunk', () => {
    assert.deepEqual(summary(new ScrcpyParser().push(STREAM)), expected)
  })

  test('the same events whatever the chunking, down to one byte at a time', () => {
    for (const size of [1, 2, 5, 11, 13, 64]) {
      const p = new ScrcpyParser()
      const events: ScrcpyEvent[] = []
      for (let i = 0; i < STREAM.length; i += size) events.push(...p.push(STREAM.subarray(i, i + size)))
      assert.deepEqual(summary(events), expected, `chunks of ${size}`)
    }
  })

  test('answered only once the dummy byte came', () => {
    const p = new ScrcpyParser()
    assert.equal(p.answered, false)
    p.push(Buffer.alloc(0))
    assert.equal(p.answered, false)
    p.push(Buffer.from([0]))
    assert.equal(p.answered, true)
  })

  test('a packet split mid-payload waits for the rest', () => {
    const p = new ScrcpyParser()
    p.push(Buffer.concat([Buffer.from([0]), H264]))
    const pkt = media(KEY, { key: true, pts: 5n })
    assert.deepEqual(p.push(pkt.subarray(0, 15)), [])
    const [e] = p.push(pkt.subarray(15))
    assert.equal(e?.kind, 'packet')
  })

  test('the device disabling the stream, or another codec, is a protocol error naming it', () => {
    const start = (codec: Buffer) => new ScrcpyParser().push(Buffer.concat([Buffer.from([0]), codec]))
    assert.throws(() => start(u32(1)), (e: Error) => e instanceof ScrcpyProtocolError && /configuration error/.test(e.message))
    assert.throws(() => start(u32(0)), /disabled the video/)
    assert.throws(() => start(u32(0x68323635)), /codec "h265", expected h264/)
  })

  test('an absurd packet size is refused instead of buffered', () => {
    const header = Buffer.alloc(12)
    header.writeUInt32BE(MAX_PACKET_BYTES + 1, 8)
    assert.throws(() => new ScrcpyParser().push(Buffer.concat([Buffer.from([0]), H264, header])), /claims/)
  })
})

describe('device command', () => {
  test('video only, h264, forward tunnel, no device name, the jar on the device', () => {
    assert.equal(
      serverCommand('4.1', '07c46637'),
      `CLASSPATH=${DEVICE_JAR} app_process / com.genymobile.scrcpy.Server 4.1 scid=07c46637 log_level=info ` +
        'video_codec=h264 audio=false control=false tunnel_forward=true send_device_meta=false max_size=1920',
    )
  })

  test('nothing that could break out of the device shell gets in', () => {
    assert.throws(() => serverCommand('4.1; reboot', '07c46637'))
    assert.throws(() => serverCommand('', '07c46637'))
    assert.throws(() => serverCommand('4.1', '07C46637 x'))
    assert.throws(() => serverCommand('4.1', '07c46637', -1))
  })

  test('scid: 8 hex digits within 31 bits; the socket is named after it', () => {
    for (const r of [0, 0.5, 0.999999]) {
      const scid = scidOf(r)
      assert.match(scid, /^[0-9a-f]{8}$/)
      assert.ok(parseInt(scid, 16) <= 0x7fffffff)
    }
    assert.equal(socketNameOf('07c46637'), 'scrcpy_07c46637')
  })

  test('the port adb forward tcp:0 prints', () => {
    assert.equal(parseForwardPort('61627\n'), 61627)
    assert.equal(parseForwardPort('  5000\r\n'), 5000)
    assert.equal(parseForwardPort(''), null)
    assert.equal(parseForwardPort('error: no devices'), null)
    assert.equal(parseForwardPort('70000'), null)
  })
})

describe('adb failures reach the window as adb said them', () => {
  // What execFile rejects with: the command line in `message`, adb's own words in `stderr`.
  const failed = (cmd: string, stderr: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { code: 1, stderr, ...extra })

  test("the text keeps adb's stderr, not only the command line", () => {
    const err = failed('adb push a /data/local/tmp/x', 'adb: more than one device/emulator\n')
    assert.equal(processErrorText(err), 'Command failed: adb push a /data/local/tmp/x: adb: more than one device/emulator')
    // stderr that the message does not carry is still added.
    const bare = Object.assign(new Error('Command failed: adb forward tcp:0 x'), { stderr: "error: device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set\n" })
    assert.match(processErrorText(bare), /device unauthorized\. This adb server/)
    assert.equal(processErrorText(new Error('plain')), 'plain')
    assert.equal(processErrorText('text'), 'text')
  })

  test('adb missing, device problems and the rest get their own codes', () => {
    assert.equal(adbFailureCode(Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' })), 'device_no_adb')
    assert.equal(adbFailureCode(failed('adb push', 'adb: more than one device/emulator')), 'device_ambiguous')
    assert.equal(adbFailureCode(failed('adb push', 'adb: no devices/emulators found')), 'device_not_found')
    assert.equal(adbFailureCode(failed('adb -s x push', "adb: device 'x' not found")), 'device_not_found')
    assert.equal(adbFailureCode(failed('adb push', 'adb: device offline')), 'device_not_found')
    assert.equal(adbFailureCode(failed('adb push', 'adb: device unauthorized.')), 'device_not_found')
    assert.equal(adbFailureCode(failed('adb push', 'adb: error: failed to copy: Permission denied')), 'scrcpy_failed')
  })
})

describe('scrcpy install', () => {
  test('version from the first line of scrcpy --version', () => {
    assert.equal(parseScrcpyVersion('scrcpy 4.1 <https://github.com/Genymobile/scrcpy>\n\nDependencies'), '4.1')
    assert.equal(parseScrcpyVersion('scrcpy v3.3.4\n'), '3.3.4')
    assert.equal(parseScrcpyVersion('something else'), null)
    assert.equal(parseScrcpyVersion('scrcpy $(reboot)'), null)
  })

  test('finds the executable on PATH, with PATHEXT on Windows', () => {
    const win = findOnPath('scrcpy', { PATH: 'C:\\a;"C:\\tools\\scrcpy"', PATHEXT: '.COM;.EXE' }, 'win32', (f) => f === join('C:\\tools\\scrcpy', 'scrcpy.exe'))
    assert.equal(win, join('C:\\tools\\scrcpy', 'scrcpy.exe'))
    const posix = findOnPath('scrcpy', { PATH: '/usr/bin:/opt/homebrew/bin' }, 'linux', (f) => f === join('/opt/homebrew/bin', 'scrcpy'))
    assert.equal(posix, join('/opt/homebrew/bin', 'scrcpy'))
    assert.equal(findOnPath('scrcpy', { PATH: '' }, 'linux', () => true), null)
  })

  test('the server is looked for next to the executable, then in share/scrcpy', () => {
    assert.deepEqual(serverCandidates(join('/usr', 'bin', 'scrcpy')), [
      join('/usr', 'bin', 'scrcpy-server'),
      join('/usr', 'share', 'scrcpy', 'scrcpy-server'),
    ])
  })
})
