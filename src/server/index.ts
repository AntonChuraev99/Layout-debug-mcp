import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { SERVER_PORT, UI_PORT, WINDOW_ORIGINS } from '../shared/ports.ts'
import { serverFailedLine, serverReadyLine } from '../shared/devMarkers.mjs'
import { DEMO_DIR, INSPECTOR_BUNDLE, PACKAGE_NAME, PACKAGE_VERSION, UI_DIST_DIR } from '../shared/paths.ts'
import { countBucket, durationBucket, initTelemetry, installCrashHandlers, minutesBucket } from '../shared/telemetry.ts'
import { parseWaitTimeout, WAIT_MAX_SECONDS, WAIT_MIN_SECONDS } from '../shared/wait.ts'
import {
  DEFAULT_LOCALE,
  type ChatMessage,
  type ConsumeRequestsBody,
  type ConsumeRequestsResponse,
  type HealthResponse,
  type Locale,
  type Override,
  type PostChatBody,
  type PostChatResponse,
  type ServerToUi,
  type Snapshot,
  type UiToServer,
  type WaitResponse,
} from '../shared/protocol.ts'
import { AndroidAdapter, classifyCaptureError, type DeviceNotes, newWarnings } from './android.ts'
import { Coalescer, FrameCache, parseFrameParam } from './androidCapture.ts'
import { loadConfig, type Config } from './config.ts'
import { probeFraming, ProbeError } from './framingProbe.ts'
import { startFramingProxy, type FramingProxy } from './framingProxy.ts'
import { errorText, resolveLocale, t } from './i18n.ts'
import {
  checkApiRequest,
  checkShutdownRequest,
  checkStaticRequest,
  checkStreamUpgrade,
  checkWsUpgrade,
  resolveStaticPath,
  wsRouteOf,
} from './security.ts'
import { encodePacket, type StreamErrorCode, type StreamToUi } from '../shared/stream.ts'
import { resolveScrcpyServer, ScrcpyStream } from './scrcpyStream.ts'
import { Session } from './session.ts'
import { parseUiMessage } from './uiMessage.ts'
import { WaitHub } from './waiters.ts'

const LISTEN_HOST = '127.0.0.1'
const SERVER_ORIGIN = `http://${LISTEN_HOST}:${SERVER_PORT}`
/** Free identifier in the inspector bundle, replaced on every serve (src/inspector/index.ts). */
const UI_ORIGINS_PLACEHOLDER = '__LD_UI_ORIGINS__'
const UI_INDEX = join(UI_DIST_DIR, 'index.html')
/** A chat post or a consume body is a few KB at most; anything larger is a bug or an abuse. */
const MAX_BODY_BYTES = 256_000

// Anonymous usage telemetry (src/shared/telemetry.ts); its notice and debug lines go to stderr.
const telemetry = initTelemetry({ process: 'server' })
installCrashHandlers(telemetry)

let config: Config
try {
  config = loadConfig()
} catch (err) {
  // scripts/dev.mjs and open_window both read this line (shared/devMarkers.mjs, the log file).
  console.error(serverFailedLine((err as Error).message.replace(/^\[layout-debug\] /, '')))
  telemetry.track({ type: 'server_start_failed', reason: 'config_error' })
  await telemetry.flush()
  process.exit(1)
}

/**
 * `npm run dev` serves the window from Vite on LD_UI_PORT (scripts/dev.mjs sets
 * LD_DEV=1); everywhere else, the package included, this server serves the built
 * window from its own port.
 */
const DEV_WINDOW = process.env.LD_DEV?.trim() === '1'
const WINDOW_URL = DEV_WINDOW ? `http://${LISTEN_HOST}:${UI_PORT}/` : `${SERVER_ORIGIN}/`

const session = new Session()
const clients = new Set<WebSocket>()
const startedAt = Date.now()
/** Last moment a window socket was connected (now, while one is). */
let lastWindowAt = startedAt

/** What this server process saw, for the `server_session_ended` telemetry event (counts only). */
const usage = {
  windows: 0,
  snapshots: 0,
  selections: 0,
  liveEdits: 0,
  editsSent: 0,
  repliesDone: 0,
  repliesError: 0,
  agentListened: false,
}

/** A snapshot arrived (from the window or the device): counted, and the first one is `target_attached`. */
function noteSnapshot(snapshot: Snapshot) {
  usage.snapshots++
  if (usage.snapshots > 1) return
  telemetry.track({
    type: 'target_attached',
    target: snapshot.target,
    nodes: countBucket(Object.keys(snapshot.nodes).length),
    unit: snapshot.unit ?? (snapshot.target === 'android' ? 'dp' : 'css-px'),
  })
}

/**
 * Language of window-facing text. Each window reports its own on connect and on
 * every switch; replies to one window use that window's, broadcasts use the last
 * one any window reported.
 */
let uiLocale: Locale = DEFAULT_LOCALE
const clientLocales = new Map<WebSocket, Locale>()
const localeOf = (ws: WebSocket): Locale => clientLocales.get(ws) ?? uiLocale

const android =
  config.target === 'android' ? new AndroidAdapter(config.androidPort, config.device, config.androidPackage) : null
/** Bumped on every device capture so the UI's <img> refetches instead of showing a stale frame. */
let androidFrame = 0
/** The device picture of the newest frame (one, so memory stays bounded); see serveAndroidScreenshot. */
const androidFrames = new FrameCache<Buffer>()
/** Last picture failure logged, so a device that keeps failing logs it once, not on every poll. */
let lastFrameWarning = ''
/** Window sockets whose last `androidCapture` said the live video shows the picture (`picture: false`). */
const videoWindows = new Set<WebSocket>()
/** Running scrcpy servers, one per `/ws/stream` socket; stopped with their socket and on shutdown. */
const streams = new Set<ScrcpyStream>()

/**
 * One device capture at a time, whoever asks: every open window polls, and each poll
 * used to start its own capture. Callers that come while one runs share its result,
 * which every window gets through the same `androidSnapshot` broadcast.
 */
const androidCaptures = android
  ? new Coalescer(async () => {
      // A live edit or a reset that lands while this capture runs makes its picture stale:
      // it is then not kept, and the window fetches the frame live (androidFrames.put).
      const takenAt = androidFrames.epoch
      // Windows that show the live video need the tree only: the PNG is most of a capture's time.
      const withPicture = clients.size === 0 || [...clients].some((ws) => !videoWindows.has(ws))
      const { snapshot, png, pngError, notes } = await android.captureFrame(withPicture)
      announceDeviceNotes(notes)
      session.setSnapshot(snapshot)
      noteSnapshot(snapshot)
      androidFrame++
      if (png) {
        androidFrames.put(androidFrame, png, takenAt)
        lastFrameWarning = ''
      } else if (pngError) {
        const why = errorText('en', pngError)
        if (why !== lastFrameWarning) {
          console.warn(`[layout-debug] the device picture of a capture failed (${why}); the window asks for it again`)
          lastFrameWarning = why
        }
      }
      broadcast({ t: 'androidSnapshot', snapshot, frame: androidFrame })
    })
  : null

const hub = new WaitHub({
  pending: () => session.undelivered(),
  // The agent is busy with what wait_for_message gave it: still listening until it replies.
  stillWorking: (id) => session.requests.find((r) => r.id === id)?.status === 'working',
  delivered: (id) => {
    for (const consumed of session.markConsumed([id])) announceStatus(consumed)
    broadcast({ t: 'requests', requests: session.requests })
  },
  listeningChanged: (listening) => {
    if (listening) usage.agentListened = true
    console.log(`[layout-debug] agent ${listening ? 'is listening' : 'stopped listening'}`)
    broadcast({ t: 'agentStatus', listening })
  },
})

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

// --- http -------------------------------------------------------------------

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', SERVER_ORIGIN)

  // The API sends no CORS headers: the window is same-origin with it (served from
  // this port, or through the Vite proxy in dev) and the MCP process is not a
  // browser, so a page on any other origin gets neither a readable /api response nor
  // a side effect. The one CORS exception is the public inspector.js (see serveInspector).
  const isApi = url.pathname.startsWith('/api/')
  const verdict = isApi ? checkApiRequest(req.headers) : checkStaticRequest(req.headers)
  if (!verdict.ok) return reject(req, res, verdict.reason, isApi)

  if (url.pathname === '/inspector.js') return serveInspector(res)
  if (url.pathname === '/demo' || url.pathname.startsWith('/demo/')) return serveDemo(url.pathname, res)
  if (url.pathname === '/api/android/screenshot') return void serveAndroidScreenshot(url, res)
  if (isApi) return serveApi(url, req, res)
  return serveWindow(url.pathname, req, res)
})

function reject(req: IncomingMessage, res: ServerResponse, reason: string, asJson: boolean) {
  console.warn(`[layout-debug] rejected ${req.method} ${req.url}: ${reason}`)
  res.writeHead(403, { 'content-type': asJson ? MIME['.json']! : 'text/plain; charset=utf-8' })
  res.end(asJson ? JSON.stringify({ error: reason }) : reason)
}

function sendJson(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': MIME['.json']!, 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
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
  // The inspector trusts only these parents; they follow the ports of *this* server.
  res.end(bundle.replaceAll(UI_ORIGINS_PLACEHOLDER, JSON.stringify(WINDOW_ORIGINS)))
}

/** A regular file under `root` that `rel` names, or null (see resolveStaticPath). */
function staticFile(root: string, rel: string): string | null {
  const file = resolveStaticPath(root, rel)
  if (!file) return null
  try {
    return statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

function serveDemo(pathname: string, res: ServerResponse) {
  const rel = pathname.replace(/^\/demo\/?/, '') || 'index.html'
  const file = staticFile(DEMO_DIR, rel) ?? staticFile(DEMO_DIR, 'index.html')
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('demo not found')
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
  })
  createReadStream(file).pipe(res)
}

/**
 * The built window (dist/ui): files as they are, and index.html for any other path
 * without an extension, so a reload on a client route still opens the window.
 */
function serveWindow(pathname: string, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
    res.end(`use GET for ${pathname}, not ${req.method}`)
    return
  }
  if (!existsSync(UI_INDEX)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(
      DEV_WINDOW
        ? `layout-debug server. In npm run dev the window lives at http://${LISTEN_HOST}:${UI_PORT}/`
        : `The layout-debug window is not built (${UI_INDEX} is missing). Run npm run build in the layout-debug-mcp directory.`,
    )
    return
  }
  const rel = pathname.replace(/^\/+/, '')
  let file = rel ? staticFile(UI_DIST_DIR, rel) : UI_INDEX
  if (!file && !extname(pathname)) file = UI_INDEX
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`not found: ${pathname}`)
    return
  }
  const isIndex = file === UI_INDEX
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    // Hashed asset names change on every build; the page itself must not be cached.
    'cache-control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
    // The window drives the device and the queue: no other page may frame it (clickjacking).
    ...(isIndex ? { 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' } : {}),
  })
  if (req.method === 'HEAD') return void res.end()
  createReadStream(file).pipe(res)
}

/**
 * The device picture. `?f=<frame>` (the frame of an `androidSnapshot`) is answered
 * from the picture the capture took together with that tree, without asking the
 * device again; a frame with no picture in memory (a live edit moved the frame on, or
 * the capture's picture failed) is fetched from the device once, shared by every
 * window asking meanwhile. Without `f`: the newest picture in memory, or a live one.
 */
async function serveAndroidScreenshot(url: URL, res: ServerResponse) {
  if (!android) {
    sendJson(res, { error: 'the target is not android (set LD_TARGET=android)' }, 409)
    return
  }
  try {
    const png = await androidFrames.get(parseFrameParam(url.searchParams), androidFrame, () => android.screenshot())
    res.writeHead(200, { 'content-type': MIME['.png']!, 'cache-control': 'no-store' })
    res.end(png)
  } catch (err) {
    sendJson(res, { error: errorText(uiLocale, err) }, 502)
  }
}

class BodyTooLarge extends Error {
  constructor() {
    super(`request body is larger than ${MAX_BODY_BYTES} bytes`)
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    const onData = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        // Stop reading at once instead of buffering the rest of an oversized body.
        req.off('data', onData)
        req.pause()
        reject(new BodyTooLarge())
        return
      }
      body += chunk
    }
    req.on('data', onData)
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

/** 400 for a bad body, 413 (and the connection dropped) for an oversized one. */
function badBody(req: IncomingMessage, res: ServerResponse, err: unknown) {
  if (err instanceof BodyTooLarge) {
    console.warn(`[layout-debug] ${req.method} ${req.url}: ${err.message}, connection dropped`)
    res.writeHead(413, { 'content-type': MIME['.json']!, connection: 'close' })
    res.end(JSON.stringify({ error: err.message }), () => req.destroy())
    return
  }
  sendJson(res, { error: (err as Error).message }, 400)
}

function requirePost(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (req.method === 'POST') return true
  res.setHeader('allow', 'POST')
  sendJson(res, { error: `use POST for ${path}, not ${req.method}` }, 405)
  return false
}

/**
 * MCP `reply_in_window`: the agent writes into the window's chat, so the user sees
 * what happened without switching to the agent's own interface.
 */
async function postChat(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'DELETE') {
    clearChat()
    return sendJson(res, { ok: true })
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST, DELETE')
    return sendJson(res, { error: `use POST (send) or DELETE (clear) for /api/chat, not ${req.method}` }, 405)
  }
  let parsed: Partial<PostChatBody>
  try {
    parsed = JSON.parse((await readBody(req)) || '{}') as Partial<PostChatBody>
  } catch (err) {
    return badBody(req, res, err)
  }
  const { text, role, requestId, status } = parsed
  if (typeof text !== 'string' || !text.trim()) return sendJson(res, { error: 'text is empty' }, 400)
  if (requestId != null && typeof requestId !== 'string') {
    return sendJson(res, { error: 'requestId must be a string (the id from wait_for_message or pending_requests)' }, 400)
  }
  if (status != null && status !== 'done' && status !== 'error') {
    return sendJson(res, { error: 'status must be "done" or "error"' }, 400)
  }

  const createdAt = requestId ? session.requests.find((r) => r.id === requestId)?.createdAt : undefined
  const { message, matched } = session.addReply(
    text.trim(),
    role === 'system' ? 'system' : 'assistant',
    requestId,
    status ?? 'done',
  )
  if (requestId && !matched) {
    console.warn(`[layout-debug] reply_in_window named unknown request ${requestId}; delivered as a general message`)
  }
  if (requestId) {
    if (matched && status === 'error') usage.repliesError++
    else if (matched) usage.repliesDone++
    telemetry.track({
      type: 'agent_replied',
      status: status ?? 'done',
      matched,
      ...(createdAt !== undefined ? { latency: durationBucket(Date.now() - createdAt) } : {}),
    })
  }
  broadcast({ t: 'chat', message })
  if (matched) {
    announceStatus(requestId!)
    broadcast({ t: 'requests', requests: session.requests })
    hub.refresh()
  }
  const body: PostChatResponse = { ok: true, delivered: clients.size }
  if (matched) body.requestId = requestId
  return sendJson(res, body)
}

/** MCP `pending_requests` marks what it read. `{ids}` marks only those; no `ids` marks every unconsumed one. */
async function consumeRequests(req: IncomingMessage, res: ServerResponse) {
  if (!requirePost(req, res, '/api/requests/consume')) return
  let body: ConsumeRequestsBody
  try {
    body = JSON.parse((await readBody(req)) || '{}') as ConsumeRequestsBody
  } catch (err) {
    return badBody(req, res, err)
  }
  let ids: string[] | undefined
  if (body.ids !== undefined) {
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
      return sendJson(res, { error: 'ids must be an array of request id strings' }, 400)
    }
    ids = body.ids
  }
  const consumed = session.markConsumed(ids)
  for (const id of consumed) announceStatus(id)
  if (consumed.length) broadcast({ t: 'requests', requests: session.requests })
  const response: ConsumeRequestsResponse = { ok: true, consumed }
  return sendJson(res, response)
}

/**
 * MCP `wait_for_message`: long-poll for the next request from the window. The
 * request counts as delivered (consumed, `working`) only once the response is
 * written; a client that hangs up first releases its wait and consumes nothing.
 */
function waitForRequest(url: URL, req: IncomingMessage, res: ServerResponse) {
  if (!requirePost(req, res, '/api/requests/wait')) return
  const seconds = parseWaitTimeout(url.searchParams.get('timeout'))
  if (seconds === null) {
    return sendJson(
      res,
      { error: `timeout must be a whole number of seconds from ${WAIT_MIN_SECONDS} to ${WAIT_MAX_SECONDS}` },
      400,
    )
  }
  // No body is expected; drain whatever came so the socket stays usable.
  req.resume()

  let open = true
  let cancel: (() => void) | null = null
  res.once('close', () => {
    if (!open) return
    open = false
    cancel?.()
  })
  const gone = () => res.destroyed || Boolean(req.socket?.destroyed)
  if (gone()) return

  cancel = hub.wait(
    {
      deliver(request, written) {
        open = false
        if (gone()) return written(false)
        res.once('finish', () => written(true))
        res.once('close', () => {
          if (!res.writableFinished) written(false)
        })
        // As the agent will see it once this response is out: read, being worked on.
        const body: WaitResponse = { request: { ...request, consumed: true, status: 'working' } }
        sendJson(res, body)
      },
      timeout() {
        open = false
        const body: WaitResponse = { timeout: true }
        if (!gone()) sendJson(res, body)
      },
    },
    seconds * 1000,
  )
}

/** Origins the framing probe may fetch besides loopback: the configured target (it may be remote). */
function probeOrigins(): string[] {
  const origins: string[] = []
  try {
    origins.push(new URL(config.targetUrl).origin)
  } catch {
    // not a URL: nothing to add
  }
  return origins
}

/**
 * The window asks which framing headers the page it frames sends, to name the one that keeps
 * the page out instead of a generic "inspector didn't respond" (src/shared/framing.ts).
 */
async function serveFramingProbe(url: URL, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET')
    return sendJson(res, { error: `use GET for /api/framing, not ${req.method}` }, 405)
  }
  try {
    sendJson(res, await probeFraming(url.searchParams.get('url'), probeOrigins()))
  } catch (err) {
    sendJson(res, { error: (err as Error).message }, err instanceof ProbeError ? err.status : 500)
  }
}

function health(): HealthResponse {
  return {
    ok: true,
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    pid: process.pid,
    windows: clients.size,
    listening: hub.listening,
    windowUrl: WINDOW_URL,
    target: config.target,
    targetUrl: config.targetUrl,
    projectDir: config.projectDir,
  }
}

function serveApi(url: URL, req: IncomingMessage, res: ServerResponse) {
  switch (url.pathname) {
    case '/api/chat':
      return void postChat(req, res)
    case '/api/health':
      return sendJson(res, health())
    case '/api/snapshot':
      return sendJson(res, { snapshot: session.snapshot })
    case '/api/selected': {
      const node = session.selectedNode()
      return sendJson(res, {
        node,
        ancestors: node ? session.ancestorsOf(node.id) : [],
        overrides: session.overrides,
        unit: session.snapshot?.unit ?? null,
        pxPerUnit: session.snapshot?.pxPerUnit ?? null,
        app: session.snapshot?.app ?? null,
      })
    }
    case '/api/requests':
      if (req.method === 'DELETE') {
        session.clearRequests()
        broadcast({ t: 'requests', requests: session.requests })
        hub.refresh()
        return sendJson(res, { ok: true })
      }
      return sendJson(res, { requests: session.requests })
    case '/api/framing':
      return void serveFramingProbe(url, req, res)
    case '/api/live-edits':
      // DELETE discards every live edit: the windows drop them from their pages too.
      if (req.method === 'DELETE') {
        session.setLiveEdits([])
        broadcast({ t: 'liveEdits', edits: session.liveEdits })
        return sendJson(res, { ok: true })
      }
      return sendJson(res, { edits: session.liveEdits })
    case '/api/requests/consume':
      return void consumeRequests(req, res)
    case '/api/requests/wait':
      return waitForRequest(url, req, res)
    case '/api/shutdown': {
      const verdict = checkShutdownRequest(req.headers)
      if (!verdict.ok) return reject(req, res, verdict.reason, true)
      if (!requirePost(req, res, '/api/shutdown')) return
      console.log('[layout-debug] shutdown requested over /api/shutdown')
      res.once('finish', () => shutdown(0, 'api_shutdown'))
      return sendJson(res, { ok: true, pid: process.pid })
    }
    default:
      return sendJson(res, { error: 'unknown endpoint' }, 404)
  }
}

// --- websocket --------------------------------------------------------------

const wss = new WebSocketServer({
  noServer: true,
  // WebSockets are exempt from CORS: without this any open tab could drive the queue and the device.
  verifyClient: ({ req }, done) => {
    const verdict = checkWsUpgrade(req.headers)
    if (verdict.ok) return done(true)
    console.warn(`[layout-debug] rejected WebSocket: ${verdict.reason}`)
    done(false, 403, 'Forbidden')
  },
})
/** `/ws/stream`: the Android screen as live video, one scrcpy run per socket (see openStream). */
const streamWss = new WebSocketServer({
  noServer: true,
  verifyClient: ({ req }, done) => {
    const verdict = checkStreamUpgrade(req.headers)
    if (verdict.ok) return done(true)
    console.warn(`[layout-debug] rejected the video WebSocket: ${verdict.reason}`)
    done(false, 403, 'Forbidden')
  },
})
wss.on('error', () => {})
streamWss.on('error', () => {})

// Two socket paths on one port: a WebSocketServer with `path` refuses every other path
// with 400 itself, so the handshake is routed here instead.
http.on('upgrade', (req, socket, head) => {
  const route = wsRouteOf(req.url)
  if (!route) {
    console.warn(`[layout-debug] rejected WebSocket to ${req.url}: unknown path`)
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  const server = route === 'window' ? wss : streamWss
  server.handleUpgrade(req, socket, head, (ws) => server.emit('connection', ws, req))
})

function send(ws: WebSocket, msg: ServerToUi) {
  // Only the code: the message is page or device text. Repeats are capped per code (telemetry rate guard).
  if (msg.t === 'error') telemetry.track({ type: 'error_shown', code: msg.code, target: config.target })
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(msg: ServerToUi) {
  for (const ws of clients) send(ws, msg)
}

/** Empties the chat history (window `clearChat` or `DELETE /api/chat`) and tells every window. */
function clearChat() {
  const count = session.clearChat()
  console.log(`[layout-debug] chat cleared (${count} message${count === 1 ? '' : 's'})`)
  broadcast({ t: 'chatCleared' })
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

wss.on('connection', (ws) => {
  clients.add(ws)
  lastWindowAt = Date.now()
  usage.windows++
  if (usage.windows === 1) telemetry.track({ type: 'window_connected', target: config.target })
  ws.on('message', (raw) => onUiMessage(ws, raw))
  ws.on('close', () => {
    clients.delete(ws)
    clientLocales.delete(ws)
    videoWindows.delete(ws)
    lastWindowAt = Date.now()
  })
  void greet(ws)
})

function greet(ws: WebSocket) {
  // `ready` never waits for adb: with no device, `getprop` took up to its 3 s timeout
  // on every window connect. A model not known yet follows as its own message.
  const deviceModel = android?.knownModel ?? null
  if (android && !deviceModel) {
    void android.deviceModel().then((model) => {
      if (model) send(ws, { t: 'deviceModel', deviceModel: model })
    })
  }
  send(ws, {
    t: 'ready',
    target: config.target,
    projectDir: config.projectDir,
    targetUrl: config.targetUrl,
    device: config.device,
    deviceModel,
    listening: hub.listening,
    telemetry: { enabled: telemetry.enabled, showNotice: telemetry.windowNoticePending() },
    framingProxy: framingProxy ? { origin: framingProxy.origin, target: framingProxy.target } : null,
  })
  send(ws, { t: 'requests', requests: session.requests })
  // A reloaded window puts these back on its page (and lists the ones it cannot place).
  send(ws, { t: 'liveEdits', edits: session.liveEdits })
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
      noteSnapshot(msg.snapshot)
      break
    case 'select':
      session.selectedId = msg.nodeId
      if (msg.nodeId) usage.selections++
      break
    case 'overrides':
      session.overrides = msg.overrides
      if (msg.overrides.length) usage.liveEdits++
      break
    case 'liveEdits':
      session.setLiveEdits(msg.edits)
      // The sender holds this list already; the other windows adopt it.
      for (const other of clients) if (other !== ws) send(other, { t: 'liveEdits', edits: session.liveEdits })
      break
    case 'telemetryNoticeDismissed':
      telemetry.dismissWindowNotice()
      break
    case 'clearRequests':
      session.clearRequests()
      broadcast({ t: 'requests', requests: session.requests })
      hub.refresh()
      break
    case 'clearChat':
      clearChat()
      break
    case 'submit':
      handleSubmit(ws, msg.comment, msg.page)
      break
    case 'androidCapture':
      if (msg.picture === false) videoWindows.add(ws)
      else videoWindows.delete(ws)
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

/** Agent warnings already shown this session: the agent repeats one on every capture. */
const shownDeviceWarnings = new Set<string>()

/**
 * What the on-device agent reported next to a good tree, to every window in its language:
 * a live edit it could not re-apply and dropped (each time it happens: the window would
 * otherwise believe the edit is still on the device), and a warning (once per session).
 */
function announceDeviceNotes(notes: DeviceNotes) {
  const fresh = newWarnings(shownDeviceWarnings, notes.warnings)
  for (const reason of fresh) console.warn(`[layout-debug] the device agent warns: ${reason}`)
  for (const e of notes.overrideErrors) console.warn(`[layout-debug] the device agent dropped the live edit of ${e.id}: ${e.reason}`)
  if (!fresh.length && !notes.overrideErrors.length) return
  for (const ws of clients) {
    const locale = localeOf(ws)
    for (const e of notes.overrideErrors) {
      send(ws, { t: 'error', code: 'live_edit', message: t(locale, 'overrideDropped', { id: e.id, reason: e.reason }) })
    }
    for (const reason of fresh) send(ws, { t: 'error', code: 'device_warning', message: t(locale, 'deviceWarning', { reason }) })
  }
}

/**
 * A device capture for `ws`: joins the one in flight, if any (polls from several
 * windows), or — `fresh`, after the caller changed the device — waits for one that
 * starts after now. The result reaches every window as `androidSnapshot`; a failure
 * goes to each window that asked.
 */
async function captureAndroid(ws: WebSocket, fresh = false) {
  if (!androidCaptures) return
  try {
    await (fresh ? androidCaptures.fresh() : androidCaptures.join())
  } catch (err) {
    send(ws, {
      t: 'error',
      code: classifyCaptureError(err),
      message: t(localeOf(ws), 'deviceError', { reason: errorText(localeOf(ws), err) }),
    })
  }
}

async function applyAndroidOverride(ws: WebSocket, override: Override) {
  if (!android) return
  usage.liveEdits++
  // Before: a capture in flight must not publish its picture after this edit. After: one
  // that started while the request was on its way may still have photographed the old state.
  androidFrames.changed()
  try {
    await android.setOverride(override)
    androidFrames.changed()
  } catch (err) {
    androidFrames.changed()
    send(ws, {
      t: 'error',
      code: 'live_edit',
      message: t(localeOf(ws), 'overrideError', { reason: errorText(localeOf(ws), err) }),
    })
    return
  }
  // The tweak only exists on the device; refetching the frame is the only way the
  // desktop sees what actually happened. With no capture yet there is no tree to
  // pair the frame with, so take a full one.
  if (!session.snapshot) return captureAndroid(ws, true)
  androidFrame++
  broadcast({ t: 'androidSnapshot', snapshot: session.snapshot, frame: androidFrame })
}

async function clearAndroidOverrides(ws: WebSocket) {
  if (!android) return
  // The same as a live edit: pictures taken before the reset landed are not kept.
  androidFrames.changed()
  try {
    try {
      await android.clearOverrides()
    } finally {
      androidFrames.changed()
    }
    await captureAndroid(ws, true)
  } catch (err) {
    send(ws, {
      t: 'error',
      code: 'reset_edits',
      message: t(localeOf(ws), 'clearOverridesError', { reason: errorText(localeOf(ws), err) }),
    })
  }
}

/** A video socket that has fallen this far behind drops frames until the next key frame. */
const STREAM_BACKLOG_BYTES = 8 * 1024 * 1024

streamWss.on('connection', (ws) => void openStream(ws))

/**
 * One `/ws/stream` socket: start scrcpy-server on the device and relay its H.264 packets
 * (src/shared/stream.ts). The run lives exactly as long as the socket — the window closing,
 * reloading or switching the video off stops it — and any failure is sent to the window as
 * a coded error before the socket closes, so it can fall back to snapshots and say why.
 */
async function openStream(ws: WebSocket) {
  const say = (msg: StreamToUi) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }
  const refuse = (code: StreamErrorCode, detail: string) => {
    say({ t: 'error', code, detail })
    ws.close(1000)
  }
  if (!android) return refuse('not_android', 'the server runs with LD_TARGET=web')

  let stream: ScrcpyStream | null = null
  let closed = false
  ws.on('close', () => {
    closed = true
    stream?.stop()
  })
  ws.on('error', () => {})

  const found = await resolveScrcpyServer({ server: config.scrcpyServer, version: config.scrcpyVersion })
  if (closed) return
  if (!found.ok) {
    console.warn(`[layout-debug] live video unavailable (${found.code}): ${found.detail}`)
    return refuse(found.code, found.detail)
  }
  const { jar, version } = found.file
  console.log(`[layout-debug] live video: starting scrcpy-server ${version} (${jar})`)
  say({ t: 'starting', version })

  let dropping = false
  let packets = 0
  const run: ScrcpyStream = new ScrcpyStream(config.device, found.file, {
    event(e) {
      if (e.kind === 'session') return say({ t: 'session', width: e.width, height: e.height })
      if (e.kind !== 'packet' || ws.readyState !== ws.OPEN) return
      if (!e.config) {
        // A frame depends on the ones before it: once one is dropped, the rest wait for a key frame.
        const behind = ws.bufferedAmount > STREAM_BACKLOG_BYTES
        if (behind && !dropping) console.warn('[layout-debug] live video: the window falls behind, dropping frames until the next key frame')
        if (behind || (dropping && !e.key)) {
          dropping = true
          return
        }
        dropping = false
      }
      if (++packets === 2) console.log(`[layout-debug] live video: streaming (scid ${run.scid})`)
      ws.send(encodePacket(e))
    },
    end(failure) {
      streams.delete(run)
      if (failure) refuse(failure.code, failure.detail)
      else console.log(`[layout-debug] live video: stopped (scid ${run.scid})`)
    },
  })
  stream = run
  streams.add(run)
  await run.start()
}

/**
 * The window sent an edit. It goes to the queue as `queued`; a listening agent gets
 * it through wait_for_message (now, or on its next call), any agent through
 * pending_requests. With no agent listening the window says so in the chat.
 */
function handleSubmit(ws: WebSocket, comment: string, page?: string) {
  const request = session.buildRequest(comment, page)
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

  usage.editsSent++
  telemetry.track({
    type: 'edit_sent',
    target: request.target,
    agent_listening: hub.listening,
    has_live_edits: request.overrides.length > 0,
    has_comment: comment.trim().length > 0,
  })
  post({ id: requestId, role: 'user', text: comment, requestId })
  // buildRequest starts every request `queued`; windows learn it from this frame and
  // from the explicit status event, the same way as every later transition.
  announceStatus(requestId)
  broadcast({ t: 'requests', requests: session.requests })
  if (!hub.listening) {
    post({ id: `${requestId}-queued`, role: 'system', text: t(uiLocale, 'queuedNoAgent'), requestId })
  }
  send(ws, { t: 'chatDone' })
  hub.dispatch()
}

// --- lifecycle --------------------------------------------------------------

let shuttingDown = false
function shutdown(code: number, reason: 'idle' | 'signal' | 'api_shutdown') {
  if (shuttingDown) return
  shuttingDown = true
  telemetry.track({
    type: 'server_session_ended',
    reason,
    duration: minutesBucket(Date.now() - startedAt),
    windows: countBucket(usage.windows),
    snapshots: countBucket(usage.snapshots),
    selections: countBucket(usage.selections),
    live_edits: countBucket(usage.liveEdits),
    edits_sent: countBucket(usage.editsSent),
    replies_done: countBucket(usage.repliesDone),
    replies_error: countBucket(usage.repliesError),
    agent_listened: usage.agentListened,
  })
  hub.close()
  // Before the exit: each removes its adb forward, and its device server ends with the socket.
  for (const s of streams) s.stopSync()
  streams.clear()
  for (const ws of clients) ws.terminate()
  for (const ws of streamWss.clients) ws.terminate()
  streamWss.close()
  wss.close()
  http.close()
  http.closeAllConnections?.()
  framingProxy?.server.close()
  framingProxy?.server.closeAllConnections?.()
  process.exitCode = code
  // Let the last log line and response flush; telemetry gets at most its flush deadline.
  void telemetry.flush().then(() => setTimeout(() => process.exit(code), 50).unref())
}

/** Started by open_window: no window and no waiting agent for this long → exit. */
if (config.idleExitMs > 0) {
  const idleMs = config.idleExitMs
  const timer = setInterval(() => {
    if (clients.size || hub.openWaits) return
    const lastActive = Math.max(startedAt, lastWindowAt, hub.lastActiveAt)
    if (Date.now() - lastActive < idleMs) return
    console.log(`[layout-debug] no window and no agent for ${Math.round(idleMs / 60_000)} min, exiting`)
    shutdown(0, 'idle')
  }, Math.min(60_000, Math.max(1_000, Math.floor(idleMs / 4))))
  timer.unref()
}

process.on('SIGINT', () => shutdown(0, 'signal'))
process.on('SIGTERM', () => shutdown(0, 'signal'))

/** What answers on our port, if it is a layout-debug server. */
async function probeOwnServer(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${SERVER_ORIGIN}/api/health`, { signal: AbortSignal.timeout(1500) })
    const body = (await res.json()) as Partial<HealthResponse>
    return body.name === PACKAGE_NAME ? (body as HealthResponse) : null
  } catch {
    return null
  }
}

http.on('error', async (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    const other = await probeOwnServer()
    if (other) {
      // Another copy already serves this port: nothing to do, and not an error for
      // open_window or `layout-debug-mcp window`. scripts/dev.mjs still reads it as a failure.
      console.log(
        serverFailedLine(
          `port ${SERVER_PORT} is already served by ${PACKAGE_NAME} ${other.version} (pid ${other.pid}); ` +
            `use that one: ${other.windowUrl}`,
        ),
      )
      process.exit(0)
    }
  }
  const altPort = SERVER_PORT === 5185 ? 5195 : 5185
  const why =
    err.code === 'EADDRINUSE'
      ? `port ${SERVER_PORT} is already in use by another program. ` +
        `Find it: ${
          process.platform === 'win32' ? `netstat -ano | findstr ${SERVER_PORT}` : `lsof -i :${SERVER_PORT}`
        }. Or use another port: set LD_SERVER_PORT=${altPort} in the environment of the MCP server ` +
        '(or of npm run dev; the window port in dev is LD_UI_PORT)'
      : err.code === 'EACCES'
        ? `no permission to listen on port ${SERVER_PORT} (set LD_SERVER_PORT to another port)`
        : err.message
  await failStart(why, err.code)
})

/** A listen error (server or framing proxy) ends the start: the failure line, its telemetry reason, exit 1. */
async function failStart(why: string, code: string | undefined): Promise<never> {
  // scripts/dev.mjs and open_window watch for this line (shared/devMarkers.mjs).
  console.error(serverFailedLine(why))
  telemetry.track({
    type: 'server_start_failed',
    reason: code === 'EADDRINUSE' ? 'port_in_use' : code === 'EACCES' ? 'port_access' : 'other',
  })
  await telemetry.flush()
  process.exit(1)
}

/**
 * Opt-in (LD_FRAMING_PROXY=1): the target without the headers that forbid framing, on its own
 * loopback port. Started before the server reports ready, so a taken port stops the start
 * with a message instead of a window that can't show the page.
 */
let framingProxy: FramingProxy | null = null
if (config.framingProxyPort !== null) {
  try {
    framingProxy = await startFramingProxy({
      port: config.framingProxyPort,
      targetUrl: config.targetUrl,
      windowOrigins: WINDOW_ORIGINS,
      unreachableText: (target, reason) => t(uiLocale, 'framingProxyUnreachable', { target, reason }),
    })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const port = config.framingProxyPort
    await failStart(
      code === 'EADDRINUSE'
        ? `the framing proxy port ${port} is already in use; set LD_FRAMING_PROXY_PORT to a free port`
        : code === 'EACCES'
          ? `no permission to listen on the framing proxy port ${port} (set LD_FRAMING_PROXY_PORT to another port)`
          : `the framing proxy could not start: ${(err as Error).message}`,
      code,
    )
  }
}

// Loopback only: the API exposes the queue, the chat and the phone's screen.
http.listen(SERVER_PORT, LISTEN_HOST, async () => {
  console.log(serverReadyLine(LISTEN_HOST, SERVER_PORT))
  console.log(`[layout-debug] ${PACKAGE_NAME} ${PACKAGE_VERSION}, pid ${process.pid}`)
  console.log(`[layout-debug] window: ${WINDOW_URL}`)
  if (!DEV_WINDOW && !existsSync(UI_INDEX)) {
    console.warn(`[layout-debug] the window is not built (${UI_INDEX} is missing); run npm run build`)
  }
  if (android) {
    // Warm the model cache so the first window's `ready` already carries it.
    void android.deviceModel()
    const devices = await AndroidAdapter.devices().catch(() => [])
    console.log(
      `[layout-debug] target: android, device agent port ${config.androidPort}` +
        (config.androidPackage ? `, expected app ${config.androidPackage}` : ''),
    )
    console.log(
      `[layout-debug] devices: ${devices.length ? devices.join(', ') : 'adb sees none'}` +
        (config.device ? ` (selected: ${config.device})` : ''),
    )
    if (devices.length > 1 && !config.device) {
      console.warn('[layout-debug] more than one device and LD_DEVICE is not set, adb will pick one')
    }
    telemetry.track({
      type: 'server_started',
      target: 'android',
      config_file: Boolean(config.configFile),
      android_devices: countBucket(devices.length),
      multi_device_no_pick: devices.length > 1 && !config.device,
    })
  } else {
    console.log(`[layout-debug] target: ${config.targetUrl}`)
    if (framingProxy) {
      console.log(
        `[layout-debug] framing proxy: ${framingProxy.origin} → ${framingProxy.target} ` +
          '(drops X-Frame-Options and CSP frame-ancestors; only this window may frame it)',
      )
    }
    telemetry.track({ type: 'server_started', target: config.target, config_file: Boolean(config.configFile) })
  }
  console.log(`[layout-debug] project: ${config.projectDir}`)
  console.log(`[layout-debug] config: ${config.configFile ?? 'none (defaults and LD_* variables)'}`)
  if (config.idleExitMs > 0) {
    console.log(`[layout-debug] exits after ${Math.round(config.idleExitMs / 60_000)} min with no window and no agent`)
  }
})
