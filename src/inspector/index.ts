/**
 * Runs inside the *target* page. Two jobs:
 *   1. walk the DOM into a normalized Snapshot and post it to the parent frame
 *   2. apply live overrides so the real page moves while the user drags
 *
 * Loaded as a plain classic script:
 *   <script src="http://127.0.0.1:5175/inspector.js"></script>
 * Dev-only. It talks to the parent frame and to nothing else.
 */

import {
  PROTOCOL_TAG,
  PROTOCOL_VERSION,
  type InspectorToUi,
  type LayoutNode,
  type NodeId,
  type Override,
  type Rect,
  type Snapshot,
  type StyleDigest,
  type UiToInspector,
} from '../shared/protocol.ts'
import { UI_ORIGINS } from '../shared/ports.ts'

const MAX_NODES = 4000
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BR',
])

const ids = new WeakMap<Element, NodeId>()
let idSeq = 0
const overrides = new Map<NodeId, Override>()
/** Element lookup for the current snapshot, so overrides can find their target. */
let elementsById = new Map<NodeId, HTMLElement>()

/**
 * Writing an override mutates the style attribute, which the observer would
 * report, which would trigger a capture, which reapplies overrides — a 4 Hz
 * loop. disconnect() also drops queued records, so this breaks the cycle.
 */
const mo = new MutationObserver(() => scheduleCapture(250))
function observe() {
  mo.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  })
}
function withoutObserving(fn: () => void) {
  mo.disconnect()
  try {
    fn()
  } finally {
    observe()
  }
}

function idOf(el: Element): NodeId {
  let id = ids.get(el)
  if (!id) {
    id = `n${++idSeq}`
    ids.set(el, id)
  }
  return id
}

/**
 * The page is only ever talking to the layout-debug window. Any other site could
 * frame the same dev page, and a snapshot is the whole visible DOM, so messages
 * go out addressed to the window's origin, never `'*'`.
 *
 * Which of the allowed origins it is gets pinned by `ancestorOrigins`
 * (Chromium, WebKit) or by the first message the window sends. Until then each
 * candidate is tried and the browser drops the ones that do not match.
 */
let parentOrigin: string | null = (() => {
  const origin = location.ancestorOrigins?.[0]
  return origin && UI_ORIGINS.includes(origin) ? origin : null
})()

function post(msg: InspectorToUi) {
  if (window.parent === window) return
  for (const origin of parentOrigin ? [parentOrigin] : UI_ORIGINS) window.parent.postMessage(msg, origin)
}

// --- snapshot ---------------------------------------------------------------

function ownText(el: Element): string {
  let out = ''
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue ?? ''
  }
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > 60 ? out.slice(0, 60) + '…' : out
}

function domPath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur !== document.body && parts.length < 6) {
    let part = cur.tagName.toLowerCase()
    if (cur.id) {
      part += `#${cur.id}`
      parts.unshift(part)
      break
    }
    const parent: Element | null = cur.parentElement
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName)
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`
    }
    parts.unshift(part)
    cur = parent
  }
  return parts.join(' > ')
}

function styleDigest(cs: CSSStyleDeclaration): StyleDigest {
  const d: StyleDigest = {
    display: cs.display,
    position: cs.position,
    margin: cs.margin,
    padding: cs.padding,
    width: cs.width,
    height: cs.height,
    fontSize: cs.fontSize,
    color: cs.color,
    backgroundColor: cs.backgroundColor,
  }
  if (cs.display === 'flex' || cs.display === 'inline-flex' || cs.display === 'grid') {
    d.flexDirection = cs.flexDirection
    d.justifyContent = cs.justifyContent
    d.alignItems = cs.alignItems
    d.gap = cs.gap
  }
  return d
}

function isEmptyValue(value: string | undefined): boolean {
  return !value || value === 'none' || value === '0px' || value === 'normal'
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return {
    x: Math.round(r.left * 100) / 100,
    y: Math.round(r.top * 100) / 100,
    w: Math.round(r.width * 100) / 100,
    h: Math.round(r.height * 100) / 100,
  }
}

function labelOf(el: Element, text: string): string {
  const tag = el.tagName.toLowerCase()
  if (text) return `${tag} "${text.length > 24 ? text.slice(0, 24) + '…' : text}"`
  const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean)[0]
  return cls ? `${tag}.${cls}` : tag
}

function capture(): Snapshot {
  const nodes: Record<NodeId, LayoutNode> = {}
  const elements = new Map<NodeId, HTMLElement>()
  const root = document.body
  const rootId = idOf(root)
  let count = 0
  let truncated = false

  const visit = (el: HTMLElement, parentId: NodeId | null, depth: number) => {
    if (count >= MAX_NODES) {
      truncated = true
      return
    }
    const id = idOf(el)
    const cs = getComputedStyle(el)
    const bounds = rectOf(el)
    const text = ownText(el)
    const childIds: NodeId[] = []

    count++
    elements.set(id, el)
    nodes[id] = {
      id,
      parentId,
      childIds,
      depth,
      kind: el.tagName.toLowerCase(),
      label: labelOf(el, text),
      bounds,
      anchors: {
        sourceLoc: el.getAttribute('data-source-loc') ?? undefined,
        domId: el.id || undefined,
        testId: el.getAttribute('data-testid') ?? undefined,
        className: (el.getAttribute('class') ?? '').trim() || undefined,
        text: text || undefined,
        path: domPath(el),
      },
      styles: Object.fromEntries(
        Object.entries(styleDigest(cs)).filter(([, v]) => !isEmptyValue(v)),
      ),
    }

    // SVG internals are noise for layout work; keep the <svg> box, drop its guts.
    if (el.tagName.toLowerCase() === 'svg') return

    for (const child of Array.from(el.children)) {
      if (!(child instanceof HTMLElement)) continue
      if (SKIP_TAGS.has(child.tagName)) continue
      const ccs = getComputedStyle(child)
      // display:none has no box and nothing to select; visibility:hidden does.
      if (ccs.display === 'none') continue
      childIds.push(idOf(child))
      visit(child, id, depth + 1)
    }
  }

  visit(root, null, 0)
  elementsById = elements
  withoutObserving(reapplyOverrides)

  if (truncated) {
    post({ tag: PROTOCOL_TAG, from: 'inspector', t: 'error', message: `Дерево обрезано на ${MAX_NODES} узлах` })
  }

  return {
    id: `snap-${Date.now()}`,
    target: 'web',
    createdAt: Date.now(),
    unit: 'css-px',
    // Bounds already come from getBoundingClientRect in css-px, so no conversion.
    pxPerUnit: 1,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    rootId,
    nodes,
  }
}

// --- live overrides ---------------------------------------------------------

function applyOverride(o: Override) {
  const el = elementsById.get(o.nodeId)
  if (!el) return
  // `translate` is its own property, so it composes with any transform the app
  // already set instead of clobbering it.
  el.style.translate = o.dx || o.dy ? `${o.dx}px ${o.dy}px` : ''
  el.style.width = o.width != null ? `${o.width}px` : ''
  el.style.height = o.height != null ? `${o.height}px` : ''
  el.style.visibility = o.hidden ? 'hidden' : ''
}

function clearOverride(nodeId: NodeId) {
  const el = elementsById.get(nodeId)
  if (el) {
    el.style.translate = ''
    el.style.width = ''
    el.style.height = ''
    el.style.visibility = ''
  }
  overrides.delete(nodeId)
}

function reapplyOverrides() {
  for (const o of overrides.values()) applyOverride(o)
}

// --- wiring -----------------------------------------------------------------

let captureTimer: number | undefined
function scheduleCapture(delay = 120) {
  window.clearTimeout(captureTimer)
  captureTimer = window.setTimeout(() => {
    try {
      post({ tag: PROTOCOL_TAG, from: 'inspector', t: 'snapshot', snapshot: capture() })
    } catch (err) {
      post({
        tag: PROTOCOL_TAG,
        from: 'inspector',
        t: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, delay)
}

window.addEventListener('message', (event: MessageEvent) => {
  // Commands move and hide real elements: only the framing layout-debug window may send them.
  if (event.source !== window.parent || !UI_ORIGINS.includes(event.origin)) return
  const data = event.data as UiToInspector | undefined
  if (!data || typeof data !== 'object' || data.tag !== PROTOCOL_TAG || data.from !== 'ui') return
  parentOrigin = event.origin

  switch (data.t) {
    case 'capture':
      scheduleCapture(0)
      break
    case 'setOverride':
      overrides.set(data.override.nodeId, data.override)
      withoutObserving(() => applyOverride(data.override))
      break
    case 'clearOverride':
      withoutObserving(() => clearOverride(data.nodeId))
      scheduleCapture()
      break
    case 'clearAllOverrides':
      withoutObserving(() => {
        for (const id of Array.from(overrides.keys())) clearOverride(id)
      })
      scheduleCapture()
      break
  }
})

window.addEventListener('resize', () => scheduleCapture())
window.addEventListener('scroll', () => scheduleCapture(200), { passive: true, capture: true })

// The app re-renders on its own (hot reload, state changes) — keep the tree fresh,
// but never faster than the debounce or we drown the parent frame.
observe()

if (window.parent === window) {
  // eslint-disable-next-line no-console
  console.warn('[layout-debug] инспектор загружен вне iframe — открой страницу через окно layout-debug-mcp')
} else {
  post({ tag: PROTOCOL_TAG, from: 'inspector', t: 'hello', version: PROTOCOL_VERSION, url: location.href })
  scheduleCapture(0)
}
