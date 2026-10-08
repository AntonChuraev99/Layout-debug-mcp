/**
 * Shared vocabulary for all three processes:
 *   inspector (runs inside the target page)  <-- postMessage -->  UI (browser)
 *   UI  <-- WebSocket -->  server (Node)  <-- HTTP -->  MCP process (stdio)  <-->  any agent
 *
 * The snapshot format is deliberately target-agnostic: the Android adapter
 * produces the exact same shape, so the UI and the MCP tools do not know where
 * the data came from.
 */

export const PROTOCOL_TAG = 'layout-debug'
export const PROTOCOL_VERSION = 1

export type NodeId = string
export type TargetKind = 'web' | 'android'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Everything an agent can use to find this element in source. */
export interface Anchors {
  /** `data-source-loc="src/App.tsx:42"` if a build plugin injected it. */
  sourceLoc?: string
  domId?: string
  testId?: string
  /** Full class string. For Tailwind projects this is the strongest grep anchor. */
  className?: string
  /** Trimmed own text content, capped. */
  text?: string
  /** `div.card > button.primary:nth-of-type(2)` */
  path: string
}

/**
 * Layout-relevant properties as a flat bag, kept small on purpose.
 *
 * A fixed CSS-shaped record would not survive the Android adapter: Compose has no
 * `display` or `margin`, and the useful facts there (composable name, source, size in
 * dp) have no CSS counterpart. Each adapter fills what its platform actually has.
 */
export type StyleDigest = Record<string, string>

export interface LayoutNode {
  id: NodeId
  parentId: NodeId | null
  childIds: NodeId[]
  depth: number
  /** Tag name on web, composable name on Android. */
  kind: string
  /** Short human label for breadcrumbs and the tree panel. */
  label: string
  /** Viewport-relative, in `unit`. */
  bounds: Rect
  anchors: Anchors
  styles: StyleDigest
}

export interface Snapshot {
  id: string
  target: TargetKind
  createdAt: number
  /** The unit an agent should write into code: css-px on web, dp on Android. */
  unit: 'css-px' | 'dp'
  /**
   * Frame pixels per [unit] — 1 on web, screen density on Android.
   *
   * `bounds` and `Override` are always in *frame pixels* so they line up with what is
   * on screen without conversion; divide by this to get the number that belongs in
   * source code.
   */
  pxPerUnit: number
  viewport: { w: number; h: number }
  rootId: NodeId
  nodes: Record<NodeId, LayoutNode>
}

/**
 * A live, in-memory tweak. Never written to disk, never survives a reload —
 * turning one into real code is what the agent is for.
 */
export interface Override {
  nodeId: NodeId
  dx: number
  dy: number
  width?: number
  height?: number
  hidden?: boolean
}

/** What the agent receives. The whole point of the tool. */
export interface EditRequest {
  id: string
  createdAt: number
  target: TargetKind
  comment: string
  node: {
    id: NodeId
    kind: string
    label: string
    bounds: Rect
    anchors: Anchors
    styles: StyleDigest
  }
  /** Root-to-node chain, so the agent can say "the button inside the card". */
  ancestors: Array<{ kind: string; label: string; anchors: Anchors }>
  siblings: Array<{ kind: string; label: string; bounds: Rect }>
  parentBounds: Rect | null
  /** Live tweaks the user made before pressing Apply. Frame pixels, like `bounds`. */
  overrides: Override[]
  unit: 'css-px' | 'dp'
  /** Divide any measurement here by this to get the number that belongs in source. */
  pxPerUnit: number
  consumed: boolean
  /**
   * Current lifecycle status, owned by the server (see `RequestStatus`). Every
   * `requests` broadcast carries it, so a window that connects late gets the state
   * without a replay of `requestStatus` events. Optional only for old payloads.
   */
  status?: RequestStatus
  /** Set with `status: 'error'`. */
  errorCode?: ErrorCode
  errorMessage?: string
}

// ---------------------------------------------------------------------------
// inspector <-> UI (postMessage)
// ---------------------------------------------------------------------------

export type InspectorToUi =
  | { tag: typeof PROTOCOL_TAG; from: 'inspector'; t: 'hello'; version: number; url: string }
  | { tag: typeof PROTOCOL_TAG; from: 'inspector'; t: 'snapshot'; snapshot: Snapshot }
  | { tag: typeof PROTOCOL_TAG; from: 'inspector'; t: 'error'; message: string }
  /**
   * The selection modifier changed while the page has focus (the window sees no keys
   * then). `blur`: the page lost focus — the window drops Alt unless focus came to it.
   */
  | { tag: typeof PROTOCOL_TAG; from: 'inspector'; t: 'alt'; down: boolean; blur?: boolean }
  /**
   * An Alt+click reached the page before the window knew Alt was down. The inspector
   * swallowed it (Alt+click on a link downloads it) and hands it over as a pick.
   * Viewport css-px of the page, the overlay's own space on web.
   */
  | { tag: typeof PROTOCOL_TAG; from: 'inspector'; t: 'altPick'; x: number; y: number }
  /** The page is scrolling the selected element: its box is stale until the next snapshot. */
  | { tag: typeof PROTOCOL_TAG; from: 'inspector'; t: 'scrolling' }
  /** Answer to `pointerQuery`: where the cursor rests over the page (viewport css-px). */
  | { tag: typeof PROTOCOL_TAG; from: 'inspector'; t: 'pointer'; x: number; y: number }

export type UiToInspector =
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'capture' }
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'setOverride'; override: Override }
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'clearOverride'; nodeId: NodeId }
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'clearAllOverrides' }
  /** A wheel over the selected layer's body, which the overlay caught: scroll the page under it. */
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'wheel'; x: number; y: number; dx: number; dy: number }
  /** The palette's nudge row is on: arrows pressed in the page go to the window. */
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'nudge'; on: boolean }
  /** The selected layer: only scrolls that move it hide the window's boxes. */
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'selected'; nodeId: NodeId | null }
  /** Alt went down in the window: say where the cursor rests over the page, if it does. */
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'pointerQuery' }
  /** The window made a pick during this Alt press: its keyup is not a bare Alt tap. */
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'picked' }

// ---------------------------------------------------------------------------
// UI <-> server (WebSocket)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  pending?: boolean
  /**
   * The EditRequest this message answers or belongs to. Set by the server for the
   * user's own submit and for MCP `reply_in_window` calls that pass one.
   * Absent on free-standing messages — the UI must never guess it from the id.
   */
  requestId?: string
}

/**
 * Machine-readable reason of a server `error`. `message` next to it stays the
 * localized human text; logic in the UI branches on `code` only, never on text.
 *
 * - `bad_message`       — a UI→server frame failed to parse or validate.
 * - `nothing_selected`  — submit with no snapshot or no selected node.
 * - `agent_failed`      — the connected agent closed the request as failed (`reply_in_window`
 *                         with `status: "error"`); `message` is the agent's reply, capped.
 * - `device_no_adb`     — adb binary missing / not on PATH.
 * - `device_not_found`  — no device, device offline or unauthorized.
 * - `device_no_bridge`  — device reachable but the debug bridge in the app does not answer.
 * - `device`            — any other device capture failure.
 * - `live_edit`         — applying a live override on the device failed.
 * - `reset_edits`       — clearing device overrides failed.
 * - `screenshot`        — the device returned no usable frame.
 */
export type ErrorCode =
  | 'bad_message'
  | 'nothing_selected'
  | 'agent_failed'
  | 'device_no_adb'
  | 'device_not_found'
  | 'device_no_bridge'
  | 'device'
  | 'live_edit'
  | 'reset_edits'
  | 'screenshot'

/** Codes that describe the device capture path (the UI's Android "connect" state). */
export const DEVICE_ERROR_CODES: readonly ErrorCode[] = [
  'device_no_adb',
  'device_not_found',
  'device_no_bridge',
  'device',
  'screenshot',
]

/** Codes tied to a specific EditRequest — the server sets `requestId` on these. */
export const AGENT_ERROR_CODES: readonly ErrorCode[] = ['agent_failed']

/**
 * Lifecycle of one EditRequest as the server sees it. The server is the only source
 * of truth; the UI no longer infers it from chat ids.
 *
 * - `queued`  — accepted, no agent has read it yet (waits for `wait_for_message` / `pending_requests`).
 * - `working` — an agent received it: `wait_for_message` returned it, or `pending_requests` read it.
 * - `done`    — the agent replied with this `requestId` (`reply_in_window`).
 * - `error`   — the agent replied with `status: "error"`; `code` + `message` say why.
 */
export type RequestStatus = 'queued' | 'working' | 'done' | 'error'

// ---------------------------------------------------------------------------
// server HTTP API payloads shared with the MCP process
// ---------------------------------------------------------------------------

/** POST /api/chat body (MCP `reply_in_window`). */
export interface PostChatBody {
  text: string
  role?: 'assistant' | 'system'
  /** Ties the reply to a request: the message carries it, and the request goes `done` (or `error`). */
  requestId?: string
  /** With `requestId`: how the request ends. Default `done`; `error` closes it as failed. */
  status?: 'done' | 'error'
}

/** POST /api/chat response. `requestId` echoes back only when it matched a known request. */
export interface PostChatResponse {
  ok: true
  delivered: number
  requestId?: string
}

/**
 * POST /api/requests/consume body. `ids` marks only those requests consumed (→ `working`);
 * omitted means "all unconsumed".
 */
export interface ConsumeRequestsBody {
  ids?: string[]
}

/** POST /api/requests/consume response. */
export interface ConsumeRequestsResponse {
  ok: true
  /** Ids that actually changed from unconsumed to consumed. */
  consumed: string[]
}

/**
 * POST /api/requests/wait?timeout=<1..50 s> (MCP `wait_for_message`): the oldest request no
 * agent has read yet, as soon as there is one, or `timeout` when none came in time.
 */
export type WaitResponse = { request: EditRequest } | { timeout: true }

/** GET /api/health. `name` tells this server apart from another program on the port. */
export interface HealthResponse {
  ok: true
  name: 'layout-debug-mcp'
  version: string
  pid: number
  /** Connected window sockets. */
  windows: number
  /**
   * An agent is waiting for messages, was a few seconds ago, or is still working on a
   * request wait_for_message gave it (until it replies or the queue is cleared).
   */
  listening: boolean
  /** Where the window is served: the server itself (package) or the Vite dev server (checkout). */
  windowUrl: string
  target: TargetKind
  targetUrl: string
  projectDir: string
}

/** Error body of every /api/* failure (4xx/5xx). */
export interface ApiErrorBody {
  error: string
}

/** Language of the window. The server uses the last one a window reported for text it sends to UIs. */
export type Locale = 'en' | 'ru'
export const DEFAULT_LOCALE: Locale = 'en'

export type UiToServer =
  | { t: 'locale'; locale: Locale }
  | { t: 'snapshot'; snapshot: Snapshot }
  | { t: 'select'; nodeId: NodeId | null }
  | { t: 'overrides'; overrides: Override[] }
  | { t: 'submit'; comment: string }
  | { t: 'clearRequests' }
  /** The user closed the one-time telemetry notice; the server remembers it in the telemetry state file. */
  | { t: 'telemetryNoticeDismissed' }
  // --- android target: the device is reachable only through the server ---
  | { t: 'androidCapture' }
  | { t: 'androidOverride'; override: Override }
  | { t: 'androidClearOverrides' }

export type ServerToUi =
  | {
      t: 'ready'
      target: TargetKind
      projectDir: string | null
      targetUrl: string
      device: string | null
      /** `ro.product.model` of the device, e.g. "Pixel 8"; null on web or when adb cannot tell. */
      deviceModel: string | null
      /** An agent is waiting for messages over MCP; later changes come as `agentStatus`. */
      listening: boolean
      /**
       * Anonymous usage telemetry of the server. `showNotice`: show the one-time notice
       * (enabled and not dismissed yet); closing it sends `telemetryNoticeDismissed`.
       */
      telemetry: { enabled: boolean; showNotice: boolean }
    }
  /**
   * The "agent listening" state changed. Listening = a wait_for_message call is open, one
   * ended < 10 s ago, or a request it handed out is still `working` (no reply yet).
   */
  | { t: 'agentStatus'; listening: boolean }
  | { t: 'chat'; message: ChatMessage }
  | { t: 'chatDone' }
  | { t: 'requests'; requests: EditRequest[] }
  /**
   * One EditRequest changed status. Broadcast to every window on each transition.
   * Late windows get current status from `EditRequest.status` in the `requests` frame.
   * `code`/`message` are set only with `status: 'error'`.
   */
  | { t: 'requestStatus'; id: string; status: RequestStatus; code?: ErrorCode; message?: string }
  /** Android snapshot pushed by the server; `frame` busts the screenshot cache. */
  | { t: 'androidSnapshot'; snapshot: Snapshot; frame: number }
  /** `message` is localized human text; branch on `code`. `requestId` is set for request errors. */
  | { t: 'error'; code: ErrorCode; message: string; requestId?: string }
