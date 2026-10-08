/**
 * The HTTP side of listen mode against a real server process: long-poll over a
 * socket, a client that hangs up, the window's WebSocket, method and origin rules.
 * The lifecycle logic itself is covered in waiters.test.ts.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { after, before, describe, test } from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { PACKAGE_ROOT } from '../shared/paths.ts'
import type { EditRequest, HealthResponse, ServerToUi, Snapshot } from '../shared/protocol.ts'

const SERVER_PORT = 5491
const UI_PORT = 5490
const BASE = `http://127.0.0.1:${SERVER_PORT}`
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`
const entry = fileURLToPath(new URL('./index.ts', import.meta.url))

let server: ChildProcess
let output = ''

const snapshot: Snapshot = {
  id: 's1',
  target: 'web',
  createdAt: 0,
  unit: 'css-px',
  pxPerUnit: 1,
  viewport: { w: 100, h: 100 },
  rootId: 'btn',
  nodes: {
    btn: {
      id: 'btn',
      parentId: null,
      childIds: [],
      depth: 0,
      kind: 'button',
      label: 'Buy',
      bounds: { x: 0, y: 0, w: 40, h: 20 },
      anchors: { path: 'button' },
      styles: {},
    },
  },
}

before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: {
      ...process.env,
      LD_SERVER_PORT: String(SERVER_PORT),
      LD_UI_PORT: String(UI_PORT),
      LD_TARGET: '',
      LD_TARGET_URL: '',
      LD_CONFIG: '',
      LD_DEV: '',
      LD_IDLE_EXIT_MINUTES: '',
      // Never send telemetry, also when this file runs under plain `node --test`.
      LD_TELEMETRY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout!.on('data', (c) => (output += c))
  server.stderr!.on('data', (c) => (output += c))
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (/\[layout-debug\] server http:/.test(output)) return
    if (server.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`the server did not start:\n${output}`)
})

after(async () => {
  if (server.exitCode === null) {
    server.kill()
    await new Promise((r) => server.once('exit', r))
  }
})

/** A window: connects to /ws and records every frame. */
async function openWindow() {
  const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws`, { headers: { origin: ORIGIN } })
  const frames: ServerToUi[] = []
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as ServerToUi))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const until = async (pred: (f: ServerToUi) => boolean, ms = 5_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = frames.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`no matching frame; got ${JSON.stringify(frames.map((f) => f.t))}`)
  }
  const sendMsg = (msg: unknown) => ws.send(JSON.stringify(msg))
  return { ws, frames, until, send: sendMsg }
}

const requests = async () => ((await (await fetch(`${BASE}/api/requests`)).json()) as { requests: EditRequest[] }).requests

describe('server: health, methods, origins', () => {
  test('health names the package and says nobody listens yet', async () => {
    const h = (await (await fetch(`${BASE}/api/health`)).json()) as HealthResponse
    assert.equal(h.name, 'layout-debug-mcp')
    assert.equal(typeof h.version, 'string')
    assert.equal(h.pid, server.pid)
    assert.equal(h.listening, false)
    assert.equal(h.windowUrl, `${BASE}/`)
  })

  test('GET /api/requests/consume is refused (state changes need POST)', async () => {
    const r = await fetch(`${BASE}/api/requests/consume`)
    assert.equal(r.status, 405)
    assert.equal((await fetch(`${BASE}/api/requests/wait`)).status, 405)
  })

  test('a foreign origin cannot shut the server down', async () => {
    const r = await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { origin: 'https://evil.example' } })
    assert.equal(r.status, 403)
    assert.equal(server.exitCode, null)
  })

  test('a same-origin page (the demo on this port) cannot shut the server down either', async () => {
    const r = await fetch(`${BASE}/api/shutdown`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    })
    assert.equal(r.status, 403)
    assert.match(((await r.json()) as { error: string }).error, /local tools only/)
    assert.equal(server.exitCode, null)
  })

  test('wait rejects a timeout outside the MCP range 5..50', async () => {
    for (const t of ['0', '1', '4', '51', 'x']) {
      assert.equal((await fetch(`${BASE}/api/requests/wait?timeout=${t}`, { method: 'POST' })).status, 400, t)
    }
  })

  test('an oversized body gets 413', async () => {
    const r = await fetch(`${BASE}/api/chat`, { method: 'POST', body: 'x'.repeat(300_000) }).catch((e: Error) => e)
    // Either the 413 arrives or the dropped connection surfaces as a fetch error.
    if (r instanceof Error) assert.match(String(r.cause ?? r.message), /socket|reset|closed|fetch failed/i)
    else assert.equal(r.status, 413)
  })

  test('/demo does not serve Windows device names', async () => {
    const r = await fetch(`${BASE}/demo/nul.html`)
    assert.equal(r.status, 200)
    assert.match(await r.text(), /<html/i, 'falls back to the demo page')
  })
})

describe('server: listen mode over HTTP', () => {
  test('a waiter that hangs up consumes nothing; the next wait gets the request; listening is broadcast', async () => {
    const win = await openWindow()
    const ready = await win.until((f) => f.t === 'ready')
    // No wait has been opened in this server yet.
    assert.equal(ready.t === 'ready' && ready.listening, false)

    const abort = new AbortController()
    const hungUp = fetch(`${BASE}/api/requests/wait?timeout=30`, { method: 'POST', signal: abort.signal }).catch(
      (e: Error) => e,
    )
    await win.until((f) => f.t === 'agentStatus' && f.listening)
    abort.abort()
    await hungUp
    await new Promise((r) => setTimeout(r, 200))

    win.send({ t: 'snapshot', snapshot })
    win.send({ t: 'select', nodeId: 'btn' })
    win.send({ t: 'submit', comment: 'make it wider' })
    await win.until((f) => f.t === 'requests' && f.requests.length === 1)
    await new Promise((r) => setTimeout(r, 200))
    const [queued] = await requests()
    assert.equal(queued!.status, 'queued', 'the hung-up waiter took nothing')
    assert.equal(queued!.consumed, false)

    const body = (await (await fetch(`${BASE}/api/requests/wait?timeout=5`, { method: 'POST' })).json()) as {
      request: EditRequest
    }
    assert.equal(body.request.id, queued!.id)
    assert.equal(body.request.comment, 'make it wider')
    await win.until((f) => f.t === 'requestStatus' && f.id === queued!.id && f.status === 'working')

    // Delivered once: the next wait gets nothing.
    assert.deepEqual(await (await fetch(`${BASE}/api/requests/wait?timeout=5`, { method: 'POST' })).json(), {
      timeout: true,
    })

    const reply = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'could not', requestId: queued!.id, status: 'error' }),
    })
    assert.equal(reply.status, 200)
    const status = await win.until((f) => f.t === 'requestStatus' && f.id === queued!.id && f.status === 'error')
    assert.equal(status.t === 'requestStatus' && status.code, 'agent_failed')
    // From the first wait to the reply the agent never counted as gone.
    assert.equal(win.frames.some((f) => f.t === 'agentStatus' && !f.listening), false)
    const h = (await (await fetch(`${BASE}/api/health`)).json()) as HealthResponse
    assert.equal(h.listening, true, 'within the grace period after the last wait')
    win.ws.close()
  })

  test('timeout answers {timeout:true}', async () => {
    const t0 = Date.now()
    const body = await (await fetch(`${BASE}/api/requests/wait?timeout=5`, { method: 'POST' })).json()
    assert.deepEqual(body, { timeout: true })
    assert.ok(Date.now() - t0 >= 4_900)
  })
})

describe('server: packaged window (served from the server port, no Vite)', () => {
  const built = existsSync(join(PACKAGE_ROOT, 'dist', 'ui', 'index.html'))
  const skip = built ? false : 'dist/ui/index.html is missing: run npm run build first (CI builds before tests)'

  test('GET / returns the window HTML with anti-framing headers', { skip }, async () => {
    const r = await fetch(`${BASE}/`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') ?? '', /text\/html/)
    assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'")
    assert.equal(r.headers.get('x-frame-options'), 'DENY')
    assert.equal(r.headers.get('cache-control'), 'no-store')
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    const html = await r.text()
    assert.match(html, /<title>layout-debug<\/title>/)
    // An asset the page references is served too.
    const asset = /(?:src|href)="(\/assets\/[^"]+)"/.exec(html)?.[1]
    assert.ok(asset, 'the built page references an /assets/ file')
    const a = await fetch(`${BASE}${asset}`)
    assert.equal(a.status, 200)
    assert.match(a.headers.get('cache-control') ?? '', /immutable/)
  })

  test('a client route falls back to the window; a missing asset is 404', { skip }, async () => {
    assert.match(await (await fetch(`${BASE}/some/route`)).text(), /<title>layout-debug<\/title>/)
    assert.equal((await fetch(`${BASE}/assets/missing-file.js`)).status, 404)
  })
})

describe('server: shutdown', () => {
  test('POST /api/shutdown from a local client stops the process', async () => {
    const r = await fetch(`${BASE}/api/shutdown`, { method: 'POST' })
    assert.equal(r.status, 200)
    const code = await new Promise<number | null>((resolve) => {
      if (server.exitCode !== null) return resolve(server.exitCode)
      server.once('exit', (c) => resolve(c))
    })
    assert.equal(code, 0)
  })
})
