import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { SERVER_PORT, UI_PORT } from '../shared/ports.ts'
import {
  checkApiRequest,
  checkShutdownRequest,
  checkStaticRequest,
  checkWsUpgrade,
  resolveStaticPath,
  type Verdict,
} from './security.ts'

const ok = (v: Verdict) => assert.deepEqual(v, { ok: true })
const denied = (v: Verdict, pattern?: RegExp) => {
  assert.equal(v.ok, false, 'ожидался отказ')
  if (pattern && !v.ok) assert.match(v.reason, pattern)
}

const serverHost = `127.0.0.1:${SERVER_PORT}`
const uiOrigin = `http://localhost:${UI_PORT}`

describe('WebSocket upgrade', () => {
  test('окно через Vite-прокси (Host сохраняется, Origin UI) пропускается', () => {
    ok(checkWsUpgrade({ host: `localhost:${UI_PORT}`, origin: uiOrigin }))
    ok(checkWsUpgrade({ host: `127.0.0.1:${UI_PORT}`, origin: `http://127.0.0.1:${UI_PORT}` }))
  })
  test('прямое подключение из окна пропускается', () => {
    ok(checkWsUpgrade({ host: `localhost:${SERVER_PORT}`, origin: uiOrigin }))
  })
  test('чужой origin отклоняется', () => {
    denied(checkWsUpgrade({ host: serverHost, origin: 'https://evil.example' }), /Origin/)
  })
  test('origin другого локального порта отклоняется', () => {
    denied(checkWsUpgrade({ host: serverHost, origin: 'http://localhost:3000' }), /Origin/)
  })
  test('origin "null" (sandbox iframe, file://) отклоняется', () => {
    denied(checkWsUpgrade({ host: serverHost, origin: 'null' }), /Origin/)
  })
  test('rebinding-Host отклоняется даже с разрешённым origin', () => {
    denied(checkWsUpgrade({ host: `evil.com:${SERVER_PORT}`, origin: uiOrigin }), /Host/)
  })
  test('без Host отклоняется', () => {
    denied(checkWsUpgrade({ origin: uiOrigin }), /Host/)
  })
})

describe('HTTP /api', () => {
  test('без Origin с loopback-Host (MCP, curl) пропускается', () => {
    ok(checkApiRequest({ host: serverHost }))
    ok(checkApiRequest({ host: `localhost:${SERVER_PORT}` }))
  })
  test('окно через Vite-прокси (changeOrigin: Host сервера) пропускается', () => {
    ok(checkApiRequest({ host: serverHost, 'sec-fetch-site': 'same-origin' }))
    ok(checkApiRequest({ host: serverHost, origin: uiOrigin, 'sec-fetch-site': 'same-origin' }))
  })
  test('чужой origin отклоняется (POST text/plain без preflight)', () => {
    denied(checkApiRequest({ host: serverHost, origin: 'https://evil.example' }), /Origin/)
  })
  test('origin "null" отклоняется', () => {
    denied(checkApiRequest({ host: serverHost, origin: 'null' }), /Origin/)
  })
  test('rebinding-Host отклоняется', () => {
    denied(checkApiRequest({ host: `evil.com:${SERVER_PORT}` }), /Host/)
    denied(checkApiRequest({ host: 'evil.example' }), /Host/)
  })
  test('межсайтовый GET без Origin (<img src>) отклоняется по Sec-Fetch-Site', () => {
    denied(checkApiRequest({ host: serverHost, 'sec-fetch-site': 'cross-site' }), /Sec-Fetch-Site/)
    denied(checkApiRequest({ host: serverHost, 'sec-fetch-site': 'same-site' }), /Sec-Fetch-Site/)
  })
})

describe('статика (inspector.js, demo)', () => {
  test('грузится с любой страницы', () => {
    ok(checkStaticRequest({ host: `localhost:${SERVER_PORT}`, 'sec-fetch-site': 'cross-site' }))
    ok(checkStaticRequest({ host: serverHost, origin: 'http://localhost:3000' }))
  })
  test('rebinding-Host отклоняется', () => {
    denied(checkStaticRequest({ host: `evil.com:${SERVER_PORT}` }), /Host/)
  })
})

describe('packaged mode: the window is served by the server from its own port', () => {
  const ownOrigin = `http://127.0.0.1:${SERVER_PORT}`
  test('WebSocket and API from the server origin pass', () => {
    ok(checkWsUpgrade({ host: serverHost, origin: ownOrigin }))
    ok(checkWsUpgrade({ host: `localhost:${SERVER_PORT}`, origin: `http://localhost:${SERVER_PORT}` }))
    ok(checkApiRequest({ host: serverHost, origin: ownOrigin, 'sec-fetch-site': 'same-origin' }))
  })
  test('a POST from the window without Origin header but same-origin passes (shutdown, chat)', () => {
    ok(checkApiRequest({ host: serverHost, 'sec-fetch-site': 'same-origin' }))
  })
  test('foreign and other-port origins are still refused', () => {
    denied(checkWsUpgrade({ host: serverHost, origin: 'https://evil.example' }), /Origin/)
    denied(checkApiRequest({ host: serverHost, origin: 'http://127.0.0.1:3000' }), /Origin/)
    denied(checkApiRequest({ host: serverHost, origin: `https://127.0.0.1:${SERVER_PORT}` }), /Origin/)
  })
  test('DNS rebinding with the server origin is refused by Host', () => {
    denied(checkApiRequest({ host: `attacker.example:${SERVER_PORT}`, origin: ownOrigin }), /Host/)
  })

  test('on custom ports both modes follow the env: dev (UI port) and packaged (server port)', () => {
    const securityUrl = new URL('./security.ts', import.meta.url).href
    const script = `
      import { checkWsUpgrade, checkApiRequest } from ${JSON.stringify(securityUrl)}
      const v = (x) => x.ok
      console.log(JSON.stringify({
        dev: v(checkWsUpgrade({ host: 'localhost:5384', origin: 'http://localhost:5384' })),
        packaged: v(checkApiRequest({ host: '127.0.0.1:5385', origin: 'http://127.0.0.1:5385' })),
        defaultServerOrigin: v(checkApiRequest({ host: '127.0.0.1:5385', origin: 'http://127.0.0.1:5175' })),
        defaultUiOrigin: v(checkWsUpgrade({ host: '127.0.0.1:5385', origin: 'http://localhost:5174' })),
      }))`
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, LD_UI_PORT: '5384', LD_SERVER_PORT: '5385' },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), {
      dev: true,
      packaged: true,
      defaultServerOrigin: false,
      defaultUiOrigin: false,
    })
  })
})

describe('/api/shutdown: local tools only', () => {
  test('a non-browser client (the MCP process: no Origin, no Sec-Fetch-Site) passes', () => {
    ok(checkShutdownRequest({ host: serverHost }))
  })
  test('a same-origin page (the demo on the server port) is refused', () => {
    denied(
      checkShutdownRequest({ host: serverHost, origin: `http://127.0.0.1:${SERVER_PORT}`, 'sec-fetch-site': 'same-origin' }),
      /local tools only/,
    )
    denied(checkShutdownRequest({ host: serverHost, 'sec-fetch-site': 'same-origin' }), /local tools only/)
    denied(checkShutdownRequest({ host: serverHost, origin: `http://127.0.0.1:${SERVER_PORT}` }), /local tools only/)
  })
  test('the window origins and foreign hosts are refused too', () => {
    denied(checkShutdownRequest({ host: serverHost, origin: uiOrigin }), /local tools only/)
    denied(checkShutdownRequest({ host: `evil.example:${SERVER_PORT}` }), /Host/)
  })
})

describe('resolveStaticPath', () => {
  const root = resolve('/srv/ui')
  test('names a file under the root', () => {
    assert.equal(resolveStaticPath(root, 'index.html'), join(root, 'index.html'))
    assert.equal(resolveStaticPath(root, 'assets/app-1a2b.js'), join(root, 'assets', 'app-1a2b.js'))
    assert.equal(resolveStaticPath(root, 'assets/my%20file.css'), join(root, 'assets', 'my file.css'))
  })
  test('the root itself is not a file', () => {
    assert.equal(resolveStaticPath(root, ''), null)
    assert.equal(resolveStaticPath(root, '/'), null)
  })
  test('.. and encoded .. are refused', () => {
    for (const rel of ['../secret.txt', 'assets/../../x', '%2e%2e/x', '..%2fx', 'a/%2E%2E/%2E%2E/x']) {
      assert.equal(resolveStaticPath(root, rel), null, rel)
    }
  })
  test('backslashes, drive letters, streams and NUL are refused', () => {
    for (const rel of ['..\\x', 'a%5c..%5cx', 'C:/Windows/win.ini', 'index.html::$DATA', 'a%00.html']) {
      assert.equal(resolveStaticPath(root, rel), null, rel)
    }
  })
  test('Windows device names are refused in any case, with any extension, in any directory', () => {
    for (const rel of ['con', 'NUL', 'nul.html', 'aux.txt', 'assets/com1.js', 'LPT9', 'prn.', 'con .html', 'CONIN$']) {
      assert.equal(resolveStaticPath(root, rel), null, rel)
    }
  })
  test('names that only start like a device name are fine', () => {
    assert.equal(resolveStaticPath(root, 'console.js'), join(root, 'console.js'))
    assert.equal(resolveStaticPath(root, 'com10.txt'), join(root, 'com10.txt'))
    assert.equal(resolveStaticPath(root, 'auxiliary.css'), join(root, 'auxiliary.css'))
  })
  test('malformed percent-encoding is refused, not thrown', () => {
    assert.equal(resolveStaticPath(root, '%E0%A4%A'), null)
  })
})

