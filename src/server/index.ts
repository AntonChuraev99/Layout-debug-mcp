import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { SERVER_PORT, UI_PORT } from '../shared/ports.ts'
import type { ChatMessage, ServerToUi, UiToServer } from '../shared/protocol.ts'
import { runAgent } from './agent.ts'
import { AndroidAdapter } from './android.ts'
import { loadConfig } from './config.ts'
import { Session } from './session.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..')
const INSPECTOR_BUNDLE = join(ROOT, 'dist/inspector/inspector.js')
const DEMO_DIR = join(ROOT, 'demo')

const config = loadConfig(ROOT)
const session = new Session()
const clients = new Set<WebSocket>()

const android = config.target === 'android' ? new AndroidAdapter(config.androidPort, config.device) : null
/** Bumped on every device capture so the UI's <img> refetches instead of showing a stale frame. */
let androidFrame = 0

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

// --- http -------------------------------------------------------------------

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${SERVER_PORT}`)

  // The inspector is loaded by a page on a different origin.
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (url.pathname === '/inspector.js') return serveInspector(res)
  if (url.pathname.startsWith('/demo')) return serveDemo(url.pathname, res)
  if (url.pathname === '/api/android/screenshot') return void serveAndroidScreenshot(res)
  if (url.pathname.startsWith('/api/')) return serveApi(url.pathname, req, res)

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('layout-debug server. UI живёт на http://localhost:' + UI_PORT)
})

function serveInspector(res: ServerResponse) {
  if (!existsSync(INSPECTOR_BUNDLE)) {
    res.writeHead(200, { 'content-type': MIME['.js']! })
    res.end(
      `console.error("[layout-debug] бандл инспектора не собран. Выполни: npm run build:inspector");\n`,
    )
    return
  }
  res.writeHead(200, { 'content-type': MIME['.js']!, 'cache-control': 'no-store' })
  createReadStream(INSPECTOR_BUNDLE).pipe(res)
}

function serveDemo(pathname: string, res: ServerResponse) {
  const rel = pathname.replace(/^\/demo\/?/, '') || 'index.html'
  const file = join(DEMO_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(DEMO_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
    const index = join(DEMO_DIR, 'index.html')
    if (!existsSync(index)) {
      res.writeHead(404).end('demo not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME['.html']! })
    createReadStream(index).pipe(res)
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}

async function serveAndroidScreenshot(res: ServerResponse) {
  if (!android) {
    res.writeHead(409, { 'content-type': MIME['.json']! })
    res.end(JSON.stringify({ error: 'цель не android' }))
    return
  }
  try {
    const png = await android.screenshot()
    res.writeHead(200, { 'content-type': MIME['.png']!, 'cache-control': 'no-store' })
    res.end(png)
  } catch (err) {
    res.writeHead(502, { 'content-type': MIME['.json']! })
    res.end(JSON.stringify({ error: (err as Error).message }))
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      // A chat post is a few KB at most; anything larger is a bug or an abuse.
      if (body.length > 256_000) reject(new Error('тело запроса слишком большое'))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

/**
 * Lets a Claude Code session working over MCP write into the window's chat, so the
 * user sees what happened without switching back to the terminal.
 */
async function postChat(req: IncomingMessage, res: ServerResponse) {
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': MIME['.json']! })
    res.end(JSON.stringify(body))
  }
  try {
    const raw = await readBody(req)
    const { text, role } = JSON.parse(raw || '{}') as { text?: string; role?: ChatMessage['role'] }
    if (!text || !text.trim()) return json({ error: 'пустой text' }, 400)

    const message: ChatMessage = {
      id: `mcp-${randomUUID()}`,
      role: role === 'system' ? 'system' : 'assistant',
      text: text.trim(),
    }
    session.addChat(message)
    broadcast({ t: 'chat', message })
    return json({ ok: true, delivered: clients.size })
  } catch (err) {
    return json({ error: (err as Error).message }, 400)
  }
}

function serveApi(pathname: string, req: IncomingMessage, res: ServerResponse) {
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': MIME['.json']! })
    res.end(JSON.stringify(body))
  }

  switch (pathname) {
    case '/api/chat':
      return void postChat(req, res)
    case '/api/health':
      return json({
        ok: true,
        target: config.target,
        targetUrl: config.targetUrl,
        projectDir: config.projectDir,
        windows: clients.size,
      })
    case '/api/snapshot':
      return json({ snapshot: session.snapshot })
    case '/api/selected': {
      const node = session.selectedNode()
      return json({
        node,
        ancestors: node ? session.ancestorsOf(node.id) : [],
        overrides: session.overrides,
        unit: session.snapshot?.unit ?? null,
        pxPerUnit: session.snapshot?.pxPerUnit ?? null,
      })
    }
    case '/api/requests':
      if (req.method === 'DELETE') {
        session.clearRequests()
        broadcast({ t: 'requests', requests: session.requests })
        return json({ ok: true })
      }
      return json({ requests: session.requests })
    case '/api/requests/consume':
      session.markConsumed()
      broadcast({ t: 'requests', requests: session.requests })
      return json({ ok: true })
    default:
      return json({ error: 'unknown endpoint' }, 404)
  }
}

// --- websocket --------------------------------------------------------------

const wss = new WebSocketServer({ server: http, path: '/ws' })

function send(ws: WebSocket, msg: ServerToUi) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(msg: ServerToUi) {
  for (const ws of clients) send(ws, msg)
}

wss.on('connection', (ws) => {
  clients.add(ws)
  send(ws, {
    t: 'ready',
    target: config.target,
    projectDir: config.projectDir,
    targetUrl: config.targetUrl,
    device: config.device,
    agentAvailable: Boolean(config.projectDir),
  })
  send(ws, { t: 'requests', requests: session.requests })
  // Replay the thread so a reloaded window does not come back blank.
  for (const message of session.chat) send(ws, { t: 'chat', message })
  if (android) void captureAndroid(ws)

  ws.on('message', (raw) => {
    let msg: UiToServer
    try {
      msg = JSON.parse(String(raw)) as UiToServer
    } catch {
      return send(ws, { t: 'error', message: 'не разобрал сообщение от UI' })
    }

    switch (msg.t) {
      case 'snapshot':
        session.setSnapshot(msg.snapshot)
        break
      case 'select':
        session.selectedId = msg.nodeId
        break
      case 'overrides':
        session.overrides = msg.overrides
        break
      case 'clearRequests':
        session.clearRequests()
        broadcast({ t: 'requests', requests: session.requests })
        break
      case 'submit':
        void handleSubmit(ws, msg.comment)
        break
      case 'androidCapture':
        void captureAndroid(ws)
        break
      case 'androidOverride':
        void applyAndroidOverride(ws, msg.override)
        break
      case 'androidClearOverrides':
        void clearAndroidOverrides(ws)
        break
    }
  })

  ws.on('close', () => clients.delete(ws))
})

// --- android target ---------------------------------------------------------

async function captureAndroid(ws: WebSocket) {
  if (!android) return
  try {
    const snapshot = await android.capture()
    session.setSnapshot(snapshot)
    androidFrame++
    broadcast({ t: 'androidSnapshot', snapshot, frame: androidFrame })
  } catch (err) {
    send(ws, { t: 'error', message: `устройство: ${(err as Error).message}` })
  }
}

async function applyAndroidOverride(ws: WebSocket, override: import('../shared/protocol.ts').Override) {
  if (!android) return
  try {
    await android.setOverride(override)
    // The tweak only exists on the device; refetching the frame is the only way the
    // desktop sees what actually happened.
    androidFrame++
    broadcast({ t: 'androidSnapshot', snapshot: session.snapshot!, frame: androidFrame })
  } catch (err) {
    send(ws, { t: 'error', message: `оверрайд: ${(err as Error).message}` })
  }
}

async function clearAndroidOverrides(ws: WebSocket) {
  if (!android) return
  try {
    await android.clearOverrides()
    await captureAndroid(ws)
  } catch (err) {
    send(ws, { t: 'error', message: `сброс правок: ${(err as Error).message}` })
  }
}

async function handleSubmit(ws: WebSocket, comment: string) {
  const request = session.buildRequest(comment)
  if (!request) {
    send(ws, { t: 'error', message: 'Нечего отправлять: выдели элемент на странице' })
    send(ws, { t: 'chatDone' })
    return
  }

  const post = (message: ChatMessage) => {
    session.addChat(message)
    broadcast({ t: 'chat', message })
  }

  post({ id: request.id, role: 'user', text: comment })
  broadcast({ t: 'requests', requests: session.requests })

  if (!config.projectDir) {
    post({
      id: `${request.id}-queued`,
      role: 'system',
      text: 'projectDir не задан — правка положена в очередь. Забери её из Claude Code инструментом pending_requests.',
    })
    send(ws, { t: 'chatDone' })
    return
  }

  const messageId = `${request.id}-reply`
  let text = ''
  const push = (pending: boolean) => {
    post({ id: messageId, role: 'assistant', text, pending })
  }

  for await (const event of runAgent(request, config.projectDir)) {
    switch (event.kind) {
      case 'text':
        text += (text ? '\n\n' : '') + event.text
        push(true)
        break
      case 'tool':
        post({ id: `${messageId}-${event.text}`, role: 'system', text: `→ ${event.text}` })
        break
      case 'error':
        send(ws, { t: 'error', message: event.text })
        break
      case 'done':
        break
    }
  }

  session.markConsumed([request.id])
  push(false)
  broadcast({ t: 'requests', requests: session.requests })
  send(ws, { t: 'chatDone' })
}

http.listen(SERVER_PORT, async () => {
  console.log(`[layout-debug] сервер http://localhost:${SERVER_PORT}`)
  if (android) {
    const devices = await AndroidAdapter.devices().catch(() => [])
    console.log(`[layout-debug] цель: android, порт агента ${config.androidPort}`)
    console.log(
      `[layout-debug] устройства: ${devices.length ? devices.join(', ') : 'adb никого не видит'}` +
        (config.device ? ` (выбрано: ${config.device})` : ''),
    )
    if (devices.length > 1 && !config.device) {
      console.warn('[layout-debug] устройств больше одного и LD_DEVICE не задан — adb выберет сам')
    }
  } else {
    console.log(`[layout-debug] цель: ${config.targetUrl}`)
  }
  console.log(`[layout-debug] проект: ${config.projectDir ?? 'не задан — агент выключен, правки копятся в очереди'}`)
})
