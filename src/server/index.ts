import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { SERVER_PORT, UI_ORIGINS, UI_PORT } from '../shared/ports.ts'
import { serverFailedLine, serverReadyLine } from '../shared/devMarkers.mjs'
import {
  DEFAULT_LOCALE,
  type ChatMessage,
  type ConsumeRequestsBody,
  type ConsumeRequestsResponse,
  type ErrorCode,
  type Locale,
  type PostChatBody,
  type PostChatResponse,
  type RequestStatus,
  type ServerToUi,
  type UiToServer,
} from '../shared/protocol.ts'
import { runAgent } from './agent.ts'
import { AndroidAdapter, classifyCaptureError } from './android.ts'
import { loadConfig } from './config.ts'
import { errorText, resolveLocale, t } from './i18n.ts'
import { checkApiRequest, checkStaticRequest, checkWsUpgrade } from './security.ts'
import { Session } from './session.ts'
import { parseUiMessage } from './uiMessage.ts'

const LISTEN_HOST = '127.0.0.1'
const ROOT = resolve(fileURLToPath(import.meta.url), '../../..')
const INSPECTOR_BUNDLE = join(ROOT, 'dist/inspector/inspector.js')
const DEMO_DIR = join(ROOT, 'demo')
/** Free identifier in the inspector bundle, replaced on every serve (src/inspector/index.ts). */
const UI_ORIGINS_PLACEHOLDER = '__LD_UI_ORIGINS__'

const config = loadConfig(ROOT)
const session = new Session()
const clients = new Set<WebSocket>()
/**
 * Language of window-facing text. Each window reports its own on connect and on
 * every switch; replies to one window use that window's, broadcasts use the last
 * one any window reported.
 */
let uiLocale: Locale = DEFAULT_LOCALE
const clientLocales = new Map<WebSocket, Locale>()
const localeOf = (ws: WebSocket): Locale => clientLocales.get(ws) ?? uiLocale

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
  const url = new URL(req.url ?? '/', `http://${LISTEN_HOST}:${SERVER_PORT}`)

  // The API sends no CORS headers: the window reaches /api through the Vite proxy
  // (same origin) and the MCP process is not a browser, so a page on any other
  // origin gets neither a readable /api response nor a side effect. The one CORS
  // exception is the public inspector.js (see serveInspector).
  const isApi = url.pathname.startsWith('/api/')
  const verdict = isApi ? checkApiRequest(req.headers) : checkStaticRequest(req.headers)
  if (!verdict.ok) return reject(req, res, verdict.reason, isApi)

  if (url.pathname === '/inspector.js') return serveInspector(res)
  if (url.pathname.startsWith('/demo')) return serveDemo(url.pathname, res)
  if (url.pathname === '/api/android/screenshot') return void serveAndroidScreenshot(res)
  if (isApi) return serveApi(url.pathname, req, res)

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('layout-debug server. The UI lives at http://localhost:' + UI_PORT)
})

function reject(req: IncomingMessage, res: ServerResponse, reason: string, asJson: boolean) {
  console.warn(`[layout-debug] rejected ${req.method} ${req.url}: ${reason}`)
  res.writeHead(403, { 'content-type': asJson ? MIME['.json']! : 'text/plain; charset=utf-8' })
  res.end(asJson ? JSON.stringify({ error: reason }) : reason)
}

function serveInspector(res: ServerResponse) {
  if (!existsSync(INSPECTOR_BUNDLE)) {
    res.writeHead(200, { 'content-type': MIME['.js']! })
    res.end(
      `console.error("[layout-debug] the inspector bundle is not built. Run: npm run build:inspector");\n`,
    )
    return
  }
  const bundle = readFileSync(INSPECTOR_BUNDLE, 'utf8')
  if (!bundle.includes(UI_ORIGINS_PLACEHOLDER)) {
    res.writeHead(200, { 'content-type': MIME['.js']!, 'cache-control': 'no-store' })
    res.end(
      `console.error("[layout-debug] the inspector bundle is outdated (no ${UI_ORIGINS_PLACEHOLDER}). Run: npm run build:inspector");\n`,
    )
    return
  }
  res.writeHead(200, {
    'content-type': MIME['.js']!,
    'cache-control': 'no-store',
    // Public code with nothing secret in it; lets a page load it with
    // `crossorigin` or as a module, which a plain <script src> does not need.
    'access-control-allow-origin': '*',
  })
  // The inspector trusts only these parents; they follow LD_UI_PORT of *this* server.
  res.end(bundle.replaceAll(UI_ORIGINS_PLACEHOLDER, JSON.stringify(UI_ORIGINS)))
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
    res.end(JSON.stringify({ error: 'the target is not android (set LD_TARGET=android)' }))
    return
  }
  try {
    const png = await android.screenshot()
    res.writeHead(200, { 'content-type': MIME['.png']!, 'cache-control': 'no-store' })
    res.end(png)
  } catch (err) {
    res.writeHead(502, { 'content-type': MIME['.json']! })
    res.end(JSON.stringify({ error: errorText(uiLocale, err) }))
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      // A chat post is a few KB at most; anything larger is a bug or an abuse.
      if (body.length > 256_000) reject(new Error('request body is too large'))
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
  if (req.method !== 'POST') return json({ error: `use POST for /api/chat, not ${req.method}` }, 405)
  try {
    const raw = await readBody(req)
    const { text, role, requestId } = JSON.parse(raw || '{}') as Partial<PostChatBody>
    if (typeof text !== 'string' || !text.trim()) return json({ error: 'text is empty' }, 400)
    if (requestId != null && typeof requestId !== 'string') {
      return json({ error: 'requestId must be a string (the id from pending_requests)' }, 400)
    }

    const { message, matched } = session.addReply(text.trim(), role === 'system' ? 'system' : 'assistant', requestId)
    if (requestId && !matched) {
      console.warn(`[layout-debug] reply_in_window named unknown request ${requestId}; delivered as a general message`)
    }
    broadcast({ t: 'chat', message })
    if (matched) {
      announceStatus(requestId!)
      broadcast({ t: 'requests', requests: session.requests })
    }
    const body: PostChatResponse = { ok: true, delivered: clients.size }
    if (matched) body.requestId = requestId
    return json(body)
  } catch (err) {
    return json({ error: (err as Error).message }, 400)
  }
}

/**
 * MCP `pending_requests` marks what it read. POST `{ids}` marks only those; GET (older
 * MCP builds) or a body without `ids` marks every unconsumed request.
 */
async function consumeRequests(req: IncomingMessage, res: ServerResponse) {
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': MIME['.json']! })
    res.end(JSON.stringify(body))
  }
  try {
    let ids: string[] | undefined
    if (req.method === 'POST') {
      const raw = await readBody(req)
      const body = JSON.parse(raw || '{}') as ConsumeRequestsBody
      if (body.ids !== undefined) {
        if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
          return json({ error: 'ids must be an array of request id strings' }, 400)
        }
        ids = body.ids
      }
    }
    const consumed = session.markConsumed(ids)
    for (const id of consumed) announceStatus(id)
    if (consumed.length) broadcast({ t: 'requests', requests: session.requests })
    const response: ConsumeRequestsResponse = { ok: true, consumed }
    return json(response)
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
      return void consumeRequests(req, res)
    default:
      return json({ error: 'unknown endpoint' }, 404)
  }
}

// --- websocket --------------------------------------------------------------

const wss = new WebSocketServer({
  server: http,
  path: '/ws',
  // WebSockets are exempt from CORS: without this any open tab could drive the agent.
  verifyClient: ({ req }, done) => {
    const verdict = checkWsUpgrade(req.headers)
    if (verdict.ok) return done(true)
    console.warn(`[layout-debug] rejected WebSocket: ${verdict.reason}`)
    done(false, 403, 'Forbidden')
  },
})
// Listen errors (port taken) reach ws too; they are reported once, on `http` below.
wss.on('error', () => {})

function send(ws: WebSocket, msg: ServerToUi) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(msg: ServerToUi) {
  for (const ws of clients) send(ws, msg)
}

/** Tells every window the current status of one request, as Session holds it. */
function announceStatus(id: string) {
  const r = session.requests.find((x) => x.id === id)
  if (!r?.status) return
  const msg: ServerToUi = { t: 'requestStatus', id, status: r.status }
  if (r.status === 'error') {
    if (r.errorCode) msg.code = r.errorCode
    if (r.errorMessage) msg.message = r.errorMessage
  }
  broadcast(msg)
}

/** Session transition + `requestStatus` broadcast; a refused transition sends nothing. */
function setRequestStatus(id: string, status: RequestStatus, code?: ErrorCode, message?: string): boolean {
  if (!session.setStatus(id, status, code, message)) return false
  announceStatus(id)
  return true
}

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('message', (raw) => onUiMessage(ws, raw))
  ws.on('close', () => {
    clients.delete(ws)
    clientLocales.delete(ws)
  })
  void greet(ws)
})

async function greet(ws: WebSocket) {
  // adb answers in tens of ms; the timeout inside deviceModel() caps the worst case.
  const deviceModel = android ? await android.deviceModel() : null
  send(ws, {
    t: 'ready',
    target: config.target,
    projectDir: config.projectDir,
    targetUrl: config.targetUrl,
    device: config.device,
    deviceModel,
    agentAvailable: Boolean(config.projectDir),
  })
  send(ws, { t: 'requests', requests: session.requests })
  // Replay the thread so a reloaded window does not come back blank.
  for (const message of session.chat) send(ws, { t: 'chat', message })
  if (android) void captureAndroid(ws)
}

function onUiMessage(ws: WebSocket, raw: unknown) {
  const parsed = parseUiMessage(String(raw))
  if (!parsed.ok) {
    console.warn(`[layout-debug] refused a WebSocket message from the window: ${parsed.reason}`)
    send(ws, {
      t: 'error',
      code: 'bad_message',
      message: t(localeOf(ws), 'badUiMessage', { reason: parsed.reason }),
    })
    // A refused submit still ends the window's "sending" state, as every submit does.
    if (parsed.t === 'submit') send(ws, { t: 'chatDone' })
    return
  }
  const msg: UiToServer = parsed.msg

  switch (msg.t) {
    case 'locale': {
      const locale = resolveLocale(localeOf(ws), msg.locale)
      clientLocales.set(ws, locale)
      uiLocale = locale
      break
    }
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
    default: {
      // parseUiMessage refuses unknown types; reaching here means the two lists drifted.
      const type = JSON.stringify((msg as { t?: unknown }).t)
      console.warn(`[layout-debug] unhandled WebSocket message type: ${type}`)
      send(ws, {
        t: 'error',
        code: 'bad_message',
        message: t(localeOf(ws), 'badUiMessage', { reason: `unhandled message type ${type}` }),
      })
    }
  }
}

// --- android target ---------------------------------------------------------

async function captureAndroid(ws: WebSocket) {
  if (!android) return
  try {
    const snapshot = await android.capture()
    session.setSnapshot(snapshot)
    androidFrame++
    broadcast({ t: 'androidSnapshot', snapshot, frame: androidFrame })
  } catch (err) {
    send(ws, {
      t: 'error',
      code: classifyCaptureError(err),
      message: t(localeOf(ws), 'deviceError', { reason: errorText(localeOf(ws), err) }),
    })
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
    send(ws, {
      t: 'error',
      code: 'live_edit',
      message: t(localeOf(ws), 'overrideError', { reason: errorText(localeOf(ws), err) }),
    })
  }
}

async function clearAndroidOverrides(ws: WebSocket) {
  if (!android) return
  try {
    await android.clearOverrides()
    await captureAndroid(ws)
  } catch (err) {
    send(ws, {
      t: 'error',
      code: 'reset_edits',
      message: t(localeOf(ws), 'clearOverridesError', { reason: errorText(localeOf(ws), err) }),
    })
  }
}

/** Same event to every window, with the text rendered in each window's own language. */
function broadcastLocalized(build: (locale: Locale) => ServerToUi) {
  for (const ws of clients) send(ws, build(localeOf(ws)))
}

async function handleSubmit(ws: WebSocket, comment: string) {
  const request = session.buildRequest(comment)
  if (!request) {
    send(ws, { t: 'error', code: 'nothing_selected', message: t(localeOf(ws), 'nothingToSubmit') })
    send(ws, { t: 'chatDone' })
    return
  }
  const requestId = request.id

  const post = (message: ChatMessage) => {
    session.addChat(message)
    broadcast({ t: 'chat', message })
  }

  post({ id: requestId, role: 'user', text: comment, requestId })
  // buildRequest starts every request `queued`; windows learn it from this frame and
  // from the explicit status event, the same way as every later transition.
  announceStatus(requestId)

  if (!config.projectDir) {
    broadcast({ t: 'requests', requests: session.requests })
    post({
      id: `${requestId}-queued`,
      role: 'system',
      text: t(uiLocale, 'queuedNoProject'),
      requestId,
    })
    send(ws, { t: 'chatDone' })
    return
  }

  setRequestStatus(requestId, 'working')
  broadcast({ t: 'requests', requests: session.requests })

  const messageId = `${requestId}-reply`
  let text = ''
  const push = (pending: boolean) => {
    post({ id: messageId, role: 'assistant', text, pending, requestId })
  }
  let failure: { code: ErrorCode; reason: string } | null = null
  const fail = (code: ErrorCode, reason: string) => {
    if (failure) return
    failure = { code, reason }
    const render = (locale: Locale) =>
      code === 'agent_auth'
        ? t(locale, 'agentAuth', { reason: reason || 'authentication_failed' })
        : reason || t(locale, 'agentFailed')
    console.warn(`[layout-debug] agent failed on request ${requestId} (${code}): ${reason || 'no reason given'}`)
    setRequestStatus(requestId, 'error', code, render(uiLocale))
    broadcastLocalized((locale) => ({ t: 'error', code, message: render(locale), requestId }))
  }

  try {
    for await (const event of runAgent(request, config.projectDir)) {
      switch (event.kind) {
        case 'text':
          text += (text ? '\n\n' : '') + event.text
          push(true)
          break
        case 'tool':
          post({ id: `${messageId}-${event.text}`, role: 'system', text: `→ ${event.text}`, requestId })
          break
        case 'retry':
          // Informational: the request stays `working`. runAgent yields this once per run.
          console.warn(`[layout-debug] agent API retry on request ${requestId}: ${event.text} (attempt ${event.attempt})`)
          broadcastLocalized((locale) => ({
            t: 'error',
            code: 'agent_retrying',
            message: t(locale, 'agentRetrying', {
              reason: event.text,
              attempt: event.attempt,
              max: event.maxRetries || '?',
            }),
            requestId,
          }))
          break
        case 'error':
          fail(event.code, event.text)
          break
        case 'done':
          break
      }
    }
  } catch (err) {
    fail('agent_failed', err instanceof Error ? err.message : String(err))
  }

  if (failure) {
    // Keep what the agent managed to say, but settled; an empty reply after an error
    // would read as "the agent answered nothing". The request stays unconsumed so the
    // MCP path (pending_requests) can still pick it up.
    if (text) push(false)
  } else {
    session.markConsumed([requestId])
    if (text) push(false)
    setRequestStatus(requestId, 'done')
  }
  broadcast({ t: 'requests', requests: session.requests })
  send(ws, { t: 'chatDone' })
}

http.on('error', (err: NodeJS.ErrnoException) => {
  const altPort = SERVER_PORT === 5185 ? 5195 : 5185
  const why =
    err.code === 'EADDRINUSE'
      ? `port ${SERVER_PORT} is already in use: a layout-debug server is already running or another process holds the port. ` +
        `Find it: ${
          process.platform === 'win32' ? `netstat -ano | findstr ${SERVER_PORT}` : `lsof -i :${SERVER_PORT}`
        }. Or start on another port: ${
          process.platform === 'win32'
            ? `$env:LD_SERVER_PORT=${altPort}; npm run dev`
            : `LD_SERVER_PORT=${altPort} npm run dev`
        } (the window port is LD_UI_PORT)`
      : err.code === 'EACCES'
        ? `no permission to listen on port ${SERVER_PORT}`
        : err.message
  // scripts/dev.mjs watches for this line (shared/devMarkers.mjs).
  console.error(serverFailedLine(why))
  process.exit(1)
})

// Loopback only: the API drives an agent with write access and exposes the phone's screen.
http.listen(SERVER_PORT, LISTEN_HOST, async () => {
  console.log(serverReadyLine(LISTEN_HOST, SERVER_PORT))
  if (android) {
    const devices = await AndroidAdapter.devices().catch(() => [])
    console.log(`[layout-debug] target: android, device agent port ${config.androidPort}`)
    console.log(
      `[layout-debug] devices: ${devices.length ? devices.join(', ') : 'adb sees none'}` +
        (config.device ? ` (selected: ${config.device})` : ''),
    )
    if (devices.length > 1 && !config.device) {
      console.warn('[layout-debug] more than one device and LD_DEVICE is not set, adb will pick one')
    }
  } else {
    console.log(`[layout-debug] target: ${config.targetUrl}`)
  }
  console.log(`[layout-debug] project: ${config.projectDir ?? 'not set: the agent is off, edits pile up in the queue'}`)
})
