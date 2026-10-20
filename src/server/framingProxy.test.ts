import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import {
  proxyRequestCookies,
  proxyRequestHeaders,
  proxyResponseHeaders,
  proxySetCookie,
  startFramingProxy,
  type FramingProxy,
} from './framingProxy.ts'

const WINDOW = ['http://127.0.0.1:5174', 'http://localhost:5174']
const PROXY = 'http://127.0.0.1:5176'
const target = new URL('http://localhost:5173/')

describe('framing proxy: header rewrite', () => {
  test('request: the target Host, Origin and Referer of the proxy pointed at the target, hop-by-hop dropped', () => {
    const out = proxyRequestHeaders(
      {
        host: '127.0.0.1:5176',
        origin: PROXY,
        referer: `${PROXY}/cart?x=1`,
        connection: 'keep-alive, x-private',
        'x-private': 'drop me',
        'keep-alive': 'timeout=5',
        accept: 'text/html',
      },
      target,
      PROXY,
    )
    assert.deepEqual(out, { host: 'localhost:5173', origin: 'http://localhost:5173', referer: 'http://localhost:5173/cart?x=1', accept: 'text/html' })
  })
  test('request: a foreign Origin is passed as it is; an upgrade keeps Connection and Upgrade', () => {
    const out = proxyRequestHeaders({ origin: 'http://127.0.0.1:51760', connection: 'Upgrade', upgrade: 'websocket' }, target, PROXY, true)
    assert.equal(out.origin, 'http://127.0.0.1:51760')
    assert.equal(out.connection, 'Upgrade')
    assert.equal(out.upgrade, 'websocket')
  })
  test('response: X-Frame-Options gone, frame-ancestors out of the CSP, the rest kept, the window-only rule added', () => {
    const out = proxyResponseHeaders(
      {
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'; img-src *",
        'content-security-policy-report-only': "frame-ancestors 'none'",
        'content-type': 'text/html',
        'set-cookie': ['a=1', 'b=2'],
        'transfer-encoding': 'chunked',
      },
      target,
      PROXY,
      WINDOW,
    )
    assert.equal(out['x-frame-options'], undefined)
    assert.equal(out['content-security-policy'], `default-src 'self'; img-src *, frame-ancestors ${WINDOW.join(' ')}`)
    assert.equal(out['content-security-policy-report-only'], "frame-ancestors 'none'", 'report-only blocks nothing; kept')
    assert.deepEqual(out['set-cookie'], ['ldp5176_a=1', 'ldp5176_b=2'], 'namespaced (see the cookie tests below)')
    assert.equal(out['content-type'], 'text/html')
    assert.equal(out['transfer-encoding'], undefined)
  })
  test('response: a CSP that is only frame-ancestors leaves just the window rule; redirects to the target come back to the proxy', () => {
    const out = proxyResponseHeaders({ 'content-security-policy': "frame-ancestors 'self'", location: 'http://localhost:5173/login?next=/' }, target, PROXY, WINDOW)
    assert.equal(out['content-security-policy'], `frame-ancestors ${WINDOW.join(' ')}`)
    assert.equal(out.location, `${PROXY}/login?next=/`)
    const away = proxyResponseHeaders({ location: 'https://auth.example.com/' }, target, PROXY, WINDOW)
    assert.equal(away.location, 'https://auth.example.com/', 'a redirect elsewhere is not rewritten')
    const relative = proxyResponseHeaders({ location: '/next' }, target, PROXY, WINDOW)
    assert.equal(relative.location, '/next')
  })
})

describe('framing proxy: cookies are namespaced to this proxy', () => {
  const P = 'ldp5176_'
  test('request: only cookies with the prefix go to the target, prefix stripped; no such cookie, no header', () => {
    assert.equal(proxyRequestCookies(`other=1; ${P}sid=abc; ${P}theme=dark; x=2`, P), 'sid=abc; theme=dark')
    assert.equal(proxyRequestCookies('other=1; dev_session=zzz', P), null)
    assert.equal(proxyRequestCookies(undefined, P), null)
  })
  test('Set-Cookie: the name gets the prefix, Domain goes, every other attribute stays', () => {
    assert.equal(
      proxySetCookie('sid=abc; Domain=localhost; Path=/; HttpOnly; SameSite=Lax', P),
      `${P}sid=abc; Path=/; HttpOnly; SameSite=Lax`,
    )
    assert.equal(proxySetCookie('a=b=c;domain=.example.com', P), `${P}a=b=c`)
  })
  test('the header rewrite applies them: Cookie filtered, Set-Cookie renamed', () => {
    const req = proxyRequestHeaders({ cookie: `foreign=1; ${P}sid=abc` }, target, PROXY)
    assert.equal(req.cookie, 'sid=abc')
    assert.equal(proxyRequestHeaders({ cookie: 'foreign=1' }, target, PROXY).cookie, undefined)
    const res = proxyResponseHeaders({ 'set-cookie': ['sid=abc; Domain=localhost', 'x=1'] }, target, PROXY, WINDOW)
    assert.deepEqual(res['set-cookie'], [`${P}sid=abc`, `${P}x=1`])
  })
  test('a scheme-relative redirect to the target is pointed back at the proxy too', () => {
    const out = proxyResponseHeaders({ location: '//localhost:5173/next?a=1' }, target, PROXY, WINDOW)
    assert.equal(out.location, `${PROXY}/next?a=1`)
    assert.equal(proxyResponseHeaders({ location: '//other.example/x' }, target, PROXY, WINDOW).location, '//other.example/x')
  })
})

describe('framing proxy: live', () => {
  let upstream: Server
  let wss: WebSocketServer
  let proxy: FramingProxy
  /** What the target saw of the last plain HTTP request. */
  let seen: { host?: string; origin?: string; cookie?: string } = {}

  before(async () => {
    upstream = createServer((req, res) => {
      seen = { host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie }
      if (req.url === '/login') {
        res.writeHead(200, { 'set-cookie': ['sid=new; Domain=127.0.0.1; Path=/; HttpOnly'] }).end('ok')
        return
      }
      if (req.url === '/old') {
        res.writeHead(302, { location: `http://127.0.0.1:${port(upstream)}/new` }).end()
        return
      }
      res.writeHead(200, { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'; img-src *", 'content-type': 'text/plain' })
      res.end(`hello ${req.method} ${req.url}`)
    })
    wss = new WebSocketServer({ server: upstream })
    wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo ${String(m)}`)))
    await new Promise<void>((ok) => upstream.listen(0, '127.0.0.1', () => ok()))
    proxy = await startFramingProxy({
      port: 0,
      targetUrl: `http://127.0.0.1:${port(upstream)}/`,
      windowOrigins: WINDOW,
      unreachableText: (t, r) => `unreachable ${t} ${r}`,
    })
  })
  after(async () => {
    proxy?.server.closeAllConnections()
    await new Promise((ok) => proxy?.server.close(ok))
    wss?.close()
    upstream?.closeAllConnections()
    await new Promise((ok) => upstream?.close(ok))
  })

  const port = (s: Server) => (s.address() as { port: number }).port
  const base = () => `http://127.0.0.1:${port(proxy.server)}`

  test('a page comes through without its framing headers, body untouched', async () => {
    const res = await fetch(`${base()}/page?x=1`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'hello GET /page?x=1')
    assert.equal(res.headers.get('x-frame-options'), null)
    assert.equal(res.headers.get('content-security-policy'), `img-src *, frame-ancestors ${WINDOW.join(' ')}`)
    assert.equal(seen.host, `127.0.0.1:${port(upstream)}`, 'the target sees its own Host')
  })

  test('a login cookie round-trips through the proxy; cookies of other local servers never reach the target', async () => {
    const prefix = `ldp${port(proxy.server)}_`
    const res = await fetch(`${base()}/login`, { headers: { cookie: `${prefix}sid=abc; other_app=secret` } })
    assert.equal(res.status, 200)
    assert.equal(seen.cookie, 'sid=abc')
    assert.deepEqual(res.headers.getSetCookie(), [`${prefix}sid=new; Path=/; HttpOnly`])
  })

  test('a redirect to the target is pointed back at the proxy', async () => {
    const res = await fetch(`${base()}/old`, { redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.equal(proxy.origin, base())
    assert.equal(res.headers.get('location'), `${base()}/new`)
  })

  test('an absolute-form request line (open-proxy use) is refused with 403', async () => {
    const reply = await new Promise<string>((ok, fail) => {
      const sock = connect(port(proxy.server), '127.0.0.1', () => {
        sock.write(`GET http://example.com/ HTTP/1.1\r\nHost: 127.0.0.1:${port(proxy.server)}\r\nConnection: close\r\n\r\n`)
      })
      let data = ''
      sock.on('data', (d) => (data += d))
      sock.on('end', () => ok(data))
      sock.on('error', fail)
    })
    assert.match(reply, /^HTTP\/1\.1 403/)
    assert.match(reply, /not a path/)
  })

  test('a foreign Host is refused (DNS rebinding)', async () => {
    const reply = await new Promise<string>((ok, fail) => {
      const sock = connect(port(proxy.server), '127.0.0.1', () => {
        sock.write('GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n')
      })
      let data = ''
      sock.on('data', (d) => (data += d))
      sock.on('end', () => ok(data))
      sock.on('error', fail)
    })
    assert.match(reply, /^HTTP\/1\.1 403/)
  })

  test('WebSocket upgrades (HMR) are piped to the target', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port(proxy.server)}/hmr`, { headers: { origin: base() } })
    const echoed = await new Promise<string>((ok, fail) => {
      ws.once('open', () => ws.send('ping'))
      ws.once('message', (m) => ok(String(m)))
      ws.once('error', fail)
    })
    assert.equal(echoed, 'echo ping')
    ws.close()
  })
})
