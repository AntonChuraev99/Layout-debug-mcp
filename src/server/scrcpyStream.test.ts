import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { resolveScrcpyServer, ScrcpyStream, type ScrcpyFailure } from './scrcpyStream.ts'

const base = mkdtempSync(join(tmpdir(), 'ld-scrcpy-'))
after(() => rmSync(base, { recursive: true, force: true }))

describe('resolveScrcpyServer', () => {
  test("a stale SCRCPY_SERVER_PATH (scrcpy's own variable) does not hide a working install on PATH", async () => {
    const install = join(base, 'install')
    mkdirSync(install, { recursive: true })
    writeFileSync(join(install, process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy'), '')
    writeFileSync(join(install, 'scrcpy-server'), 'jar')
    const r = await resolveScrcpyServer(
      { server: null, version: '4.1' },
      { PATH: install, PATHEXT: '.EXE', SCRCPY_SERVER_PATH: join(base, 'gone', 'scrcpy-server') },
    )
    assert.deepEqual(r, { ok: true, file: { jar: join(install, 'scrcpy-server'), version: '4.1' } })
  })

  test('LD_SCRCPY_SERVER pointing at nothing names that setting', async () => {
    const r = await resolveScrcpyServer({ server: join(base, 'nope'), version: '4.1' }, { PATH: '' })
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.detail : '', /LD_SCRCPY_SERVER \/ "scrcpyServer" points at .*nope, which is not a file/)
  })
})

/** A stream whose forward is a local TCP server; no adb is run. */
class LocalStream extends ScrcpyStream {
  protected override removeForward(): void {}
  connectTo(port: number) {
    ;(this as unknown as { port: number }).port = port
    return (this as unknown as { connectWhenUp: (deadline: number) => Promise<void> }).connectWhenUp(Date.now() + 5_000)
  }
}

/** The device side: hands out each accepted connection, resolves when it closes. */
async function fakeForward(onConnection: (s: Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(onConnection)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as { port: number }).port }
}

const closed = (s: Socket) => new Promise<void>((r) => (s.destroyed ? r() : s.once('close', () => r())))
const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} did not happen within ${ms} ms`)), ms))])

describe('ScrcpyStream sockets', () => {
  test('stop() while connected but before the dummy byte closes that connection', async () => {
    let accepted!: (s: Socket) => void
    const got = new Promise<Socket>((r) => (accepted = r))
    const { server, port } = await fakeForward((s) => accepted(s))
    const ends: Array<ScrcpyFailure | null> = []
    const stream = new LocalStream(null, { jar: 'x', version: '4.1' }, { event: () => {}, end: (f) => ends.push(f) })
    void stream.connectTo(port)
    const deviceSide = await got
    stream.stop()
    await within(closed(deviceSide), 2_000, 'the connection closing')
    assert.deepEqual(ends, [null])
    server.close()
  })

  test('a foreign codec on the first chunk ends the stream and closes the connection', async () => {
    let accepted!: (s: Socket) => void
    const got = new Promise<Socket>((r) => (accepted = r))
    const { server, port } = await fakeForward((s) => {
      // Dummy byte, then "h265".
      s.write(Buffer.from([0, 0x68, 0x32, 0x36, 0x35]))
      accepted(s)
    })
    const ends: Array<ScrcpyFailure | null> = []
    const stream = new LocalStream(null, { jar: 'x', version: '4.1' }, { event: () => {}, end: (f) => ends.push(f) })
    void stream.connectTo(port)
    await within(closed(await got), 2_000, 'the connection closing')
    assert.equal(ends[0]?.code, 'stream_protocol')
    server.close()
  })
})
