import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { browserCommand } from './browser.ts'
import { otherServerLine, parseCliArgs, USAGE } from './cli.ts'
import { findPackageRoot, PACKAGE_ROOT, PACKAGE_VERSION } from './paths.ts'

describe('parseCliArgs', () => {
  test('no arguments: the stdio MCP server', () => {
    assert.deepEqual(parseCliArgs([]), { cmd: 'mcp' })
    assert.deepEqual(parseCliArgs(['']), { cmd: 'mcp' })
  })
  test('window', () => {
    assert.deepEqual(parseCliArgs(['window']), { cmd: 'window' })
  })
  test('--version / -v and --help / -h, also next to a command', () => {
    assert.deepEqual(parseCliArgs(['--version']), { cmd: 'version' })
    assert.deepEqual(parseCliArgs(['-v']), { cmd: 'version' })
    assert.deepEqual(parseCliArgs(['--help']), { cmd: 'help' })
    assert.deepEqual(parseCliArgs(['-h']), { cmd: 'help' })
    assert.deepEqual(parseCliArgs(['window', '--help']), { cmd: 'help' })
  })
  test('unknown arguments are an error that names them', () => {
    assert.deepEqual(parseCliArgs(['serve']), { cmd: 'error', message: 'unknown argument "serve"' })
    assert.deepEqual(parseCliArgs(['--port=1']), { cmd: 'error', message: 'unknown argument "--port=1"' })
    assert.deepEqual(parseCliArgs(['window', 'now']), { cmd: 'error', message: 'unexpected argument "now" after "window"' })
  })
  test('telemetry on|off|status, status by default; anything else is an error', () => {
    assert.deepEqual(parseCliArgs(['telemetry']), { cmd: 'telemetry', action: 'status' })
    assert.deepEqual(parseCliArgs(['telemetry', 'on']), { cmd: 'telemetry', action: 'on' })
    assert.deepEqual(parseCliArgs(['telemetry', 'off']), { cmd: 'telemetry', action: 'off' })
    assert.deepEqual(parseCliArgs(['telemetry', 'status']), { cmd: 'telemetry', action: 'status' })
    assert.deepEqual(parseCliArgs(['telemetry', 'maybe']), {
      cmd: 'error',
      message: 'unknown telemetry action "maybe"; expected on, off or status',
    })
    assert.deepEqual(parseCliArgs(['telemetry', 'off', 'now']), {
      cmd: 'error',
      message: 'unexpected argument "now" after "telemetry off"',
    })
  })
  test('usage lists the telemetry command and its variables', () => {
    assert.match(USAGE, /telemetry \[on\|off\|status\]/)
    for (const v of ['LD_TELEMETRY=0', 'LD_TELEMETRY_DEBUG=1', 'DO_NOT_TRACK=1']) assert.ok(USAGE.includes(v), v)
  })
  test('usage shows the MCP client config line', () => {
    assert.match(USAGE, /"command": "npx", "args": \["-y", "layout-debug-mcp"\]/)
  })
})

describe('otherServerLine (window with the port already served)', () => {
  const health = { pid: 4242, version: '0.2.0', windowUrl: 'http://127.0.0.1:5175/' }
  test('this process own server: no line, the normal "Ctrl+C stops the server" path', () => {
    assert.equal(otherServerLine(health, 4242), null)
  })
  test('another process: names its pid and URL, no Ctrl+C hint', () => {
    const line = otherServerLine(health, 1)!
    assert.match(line, /already served by layout-debug-mcp 0\.2\.0 \(pid 4242\) at http:\/\/127\.0\.0\.1:5175\//)
    assert.doesNotMatch(line, /Ctrl\+C/)
  })
})

describe('the bin from source', () => {
  const cli = fileURLToPath(new URL('../cli.ts', import.meta.url))
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8', cwd: PACKAGE_ROOT })

  test('--version prints the package.json version', () => {
    const r = run('--version')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), PACKAGE_VERSION)
  })
  test('an unknown argument exits 1 with the usage on stderr', () => {
    const r = run('bogus')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /unknown argument "bogus"/)
    assert.match(r.stderr, /Usage: layout-debug-mcp/)
    assert.equal(r.stdout, '')
  })
})

describe('paths', () => {
  test('the package root is found from any depth', () => {
    const manifest = JSON.parse(readFileSync(`${PACKAGE_ROOT}/package.json`, 'utf8')) as { name: string; version: string }
    assert.equal(manifest.name, 'layout-debug-mcp')
    assert.equal(manifest.version, PACKAGE_VERSION)
    assert.equal(findPackageRoot(fileURLToPath(new URL('../server/index.ts', import.meta.url))), PACKAGE_ROOT)
  })
})

describe('browserCommand', () => {
  test('no shell: cmd /c start with an empty title on Windows, open / xdg-open elsewhere', () => {
    assert.deepEqual(browserCommand('http://127.0.0.1:5175/', 'win32'), ['cmd', ['/c', 'start', '', 'http://127.0.0.1:5175/']])
    assert.deepEqual(browserCommand('http://127.0.0.1:5175/', 'darwin'), ['open', ['http://127.0.0.1:5175/']])
    assert.deepEqual(browserCommand('http://127.0.0.1:5175/', 'linux'), ['xdg-open', ['http://127.0.0.1:5175/']])
  })
})
