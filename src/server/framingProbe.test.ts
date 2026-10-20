import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { probeFraming } from './framingProbe.ts'

/**
 * A loopback https dev server with a self-signed certificate. The certificate is made on the
 * spot with openssl (no key in the repository); without openssl the test is skipped.
 */
function openssl(): string | null {
  const candidates = ['openssl', ...(process.platform === 'win32' ? ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe'] : [])]
  for (const bin of candidates) {
    if (bin !== 'openssl' && !existsSync(bin)) continue
    const r = spawnSync(bin, ['version'], { encoding: 'utf8' })
    if (r.status === 0) return bin
  }
  return null
}

const OPENSSL = openssl()

describe('framing probe: a loopback https target with a self-signed certificate', { skip: OPENSSL ? false : 'openssl is not available' }, () => {
  let dir: string
  let server: Server
  let port: number

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ld-probe-tls-'))
    const r = spawnSync(
      OPENSSL!,
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'],
      // Git for Windows' openssl would read "/CN=localhost" as a path and rewrite it.
      { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' } },
    )
    assert.equal(r.status, 0, r.stderr)
    server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (_req, res) => {
      res.writeHead(200, { 'x-frame-options': 'DENY', 'content-type': 'text/html' }).end('<p>dev</p>')
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()))
    port = (server.address() as { port: number }).port
  })
  after(async () => {
    server?.closeAllConnections()
    await new Promise((ok) => server?.close(ok))
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('the probe reads its headers like the proxy reaches it (no certificate check on loopback)', async () => {
    const probe = await probeFraming(`https://127.0.0.1:${port}/`, [])
    assert.equal(probe.status, 200)
    assert.equal(probe.xFrameOptions, 'DENY')
  })
})
