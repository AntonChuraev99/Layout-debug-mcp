/**
 * Shared vocabulary for all three processes:
 *   inspector (runs inside the target page)  <-- postMessage -->  UI (browser)
 *   UI  <-- WebSocket -->  server (Node)  <-- in-process -->  MCP / agent
 *
 * The snapshot format is deliberately target-agnostic: the future Android
 * adapter must be able to produce the exact same shape so the UI and the agent
 * bridge stay unchanged.
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
}

// ---------------------------------------------------------------------------
// inspector <-> UI (postMessage)
// ---------------------------------------------------------------------------

export type InspectorToUi =
  | { tag: typeof PROTOCOL_TAG; from: 'inspector'; t: 'hello'; version: number; url: string }
  | { tag: typeof PROTOCOL_TAG; from: 'inspector'; t: 'snapshot'; snapshot: Snapshot }
  | { tag: typeof PROTOCOL_TAG; from: 'inspector'; t: 'error'; message: string }

export type UiToInspector =
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'capture' }
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'setOverride'; override: Override }
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'clearOverride'; nodeId: NodeId }
  | { tag: typeof PROTOCOL_TAG; from: 'ui'; t: 'clearAllOverrides' }

// ---------------------------------------------------------------------------
// UI <-> server (WebSocket)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  pending?: boolean
}

export type UiToServer =
  | { t: 'snapshot'; snapshot: Snapshot }
  | { t: 'select'; nodeId: NodeId | null }
  | { t: 'overrides'; overrides: Override[] }
  | { t: 'submit'; comment: string }
  | { t: 'clearRequests' }
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
      agentAvailable: boolean
    }
  | { t: 'chat'; message: ChatMessage }
  | { t: 'chatDone' }
  | { t: 'requests'; requests: EditRequest[] }
  /** Android snapshot pushed by the server; `frame` busts the screenshot cache. */
  | { t: 'androidSnapshot'; snapshot: Snapshot; frame: number }
  | { t: 'error'; message: string }
