/**
 * Runs inside the *target* page. Two jobs:
 *   1. walk the DOM into a normalized Snapshot and post it to the parent frame
 *   2. apply live overrides so the real page moves while the user drags
 *
 * Loaded as a plain classic script:
 *   <script src="http://127.0.0.1:5175/inspector.js"></script>
 * (5175 is the default; the server port follows LD_SERVER_PORT.)
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
import { altHeld, forwardedKey, keyTarget, type InspectorKeyMessage } from './keys.ts'

/**
 * Free identifier, left as is by the bundler: the server swaps it for the JSON
 * array of the window's origins every time it serves /inspector.js (see
 * serveInspector). The running server is the one that knows LD_UI_PORT, so a
 * bundle built under different env can never disagree with it.
 */
declare const __LD_UI_ORIGINS__: readonly string[]
const UI_ORIGINS: readonly string[] = __LD_UI_ORIGINS__

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

function post(msg: InspectorToUi | InspectorKeyMessage) {
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

  // Measure without the live moves (see liftTranslates); synchronous, so no frame
  // shows the elements back in place. reapplyOverrides puts them back even if the
  // walk throws, against the fresh element map.
  withoutObserving(liftTranslates)
  try {
    visit(root, null, 0)
    elementsById = elements
  } finally {
    withoutObserving(reapplyOverrides)
  }

  if (truncated) {
    post({ tag: PROTOCOL_TAG, from: 'inspector', t: 'error', message: `Tree truncated at ${MAX_NODES} nodes` })
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

/** Inline style properties a live override writes. */
const OVERRIDE_PROPS = ['translate', 'width', 'height', 'flex', 'boxSizing', 'visibility'] as const
type OverrideProp = (typeof OVERRIDE_PROPS)[number]

/**
 * The element's own inline values from before the first override, so clearing an
 * override hands the app back exactly what it had instead of blanking its styles.
 */
const originals = new WeakMap<HTMLElement, Record<OverrideProp, string>>()

function originalOf(el: HTMLElement): Record<OverrideProp, string> {
  let saved = originals.get(el)
  if (!saved) {
    saved = Object.fromEntries(OVERRIDE_PROPS.map((p) => [p, el.style[p]])) as Record<OverrideProp, string>
    originals.set(el, saved)
  }
  return saved
}

function applyOverride(o: Override) {
  const el = elementsById.get(o.nodeId)
  if (!el) return
  const orig = originalOf(el)
  const sized = o.width != null || o.height != null
  // `translate` is its own property, so it composes with any transform the app
  // already set instead of clobbering it.
  el.style.translate = o.dx || o.dy ? `${o.dx}px ${o.dy}px` : orig.translate
  el.style.width = o.width != null ? `${o.width}px` : orig.width
  el.style.height = o.height != null ? `${o.height}px` : orig.height
  // The handle measures the border box (getBoundingClientRect), and a flex item
  // with `flex: 1` ignores `width` altogether: without these two the real element
  // keeps its size while the overlay shows the new one.
  el.style.flex = sized ? 'none' : orig.flex
  el.style.boxSizing = sized ? 'border-box' : orig.boxSizing
  el.style.visibility = o.hidden ? 'hidden' : orig.visibility
}

function restoreOriginal(el: HTMLElement) {
  const orig = originals.get(el)
  if (!orig) return
  for (const p of OVERRIDE_PROPS) el.style[p] = orig[p]
  originals.delete(el)
}

function clearOverride(nodeId: NodeId) {
  const el = elementsById.get(nodeId)
  if (el) restoreOriginal(el)
  overrides.delete(nodeId)
}

/**
 * Snapshot bounds are where an element sits *before* its live move: the window
 * draws `bounds + dx/dy`, so measuring with the translate applied would count the
 * move twice. The move is lifted for the measurement only — no frame is painted
 * in between. Size overrides stay on: they reflow the page, and the new layout is
 * exactly what the window must show.
 */
function liftTranslates() {
  for (const o of overrides.values()) {
    const el = elementsById.get(o.nodeId)
    if (el && (o.dx || o.dy)) el.style.translate = originalOf(el).translate
  }
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
      // A size change reflows the page: neighbours (and the element itself, in a
      // centred or justified row) move, so the window needs fresh bounds.
      scheduleCapture()
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
    case 'wheel':
      scrollUnder(data.x, data.y, data.dx, data.dy)
      break
    case 'nudge':
      nudgeOn = data.on
      break
    case 'selected':
      selectedNodeId = data.nodeId
      break
    case 'pointerQuery':
      postPointer()
      break
    case 'picked':
      if (altSent) pickedDuringAlt = true
      break
  }
})

/** The layer selected in the window: scrolls that move it make its box stale. */
let selectedNodeId: NodeId | null = null

/** Where the cursor rests over the page; null once it left the page. */
let lastPointer: { x: number; y: number } | null = null
function postPointer() {
  if (lastPointer) post({ tag: PROTOCOL_TAG, from: 'inspector', t: 'pointer', x: lastPointer.x, y: lastPointer.y })
}
document.documentElement.addEventListener('pointerleave', () => {
  lastPointer = null
})

// --- keys and the selection modifier ------------------------------------------

/** The window's nudge row is on: arrows pressed here move or size the selected layer. */
let nudgeOn = false

// The page is live, so focus often sits in it; give the window its keys back
// (src/inspector/keys.ts). Bubble phase, so a key the page handled stays the page's.
// Escape is not swallowed — the page may close its own modal with it. Arrows are, while
// the nudge row is on: they would scroll the page under the element being nudged.
window.addEventListener('keydown', (e: KeyboardEvent) => {
  const key = forwardedKey(e, keyTarget(e), { arrows: nudgeOn })
  if (!key) return
  if (key.startsWith('Arrow')) e.preventDefault()
  post({ tag: PROTOCOL_TAG, from: 'inspector', t: 'key', key, shift: key.startsWith('Arrow') ? e.shiftKey : undefined })
})

/**
 * Alt state as last reported to the window. The window cannot see keys while focus is
 * here, so every change goes out — from key events and, as a resync, from the `altKey`
 * of any pointer or wheel event (a keyup lost to Alt+Tab must not leave Alt stuck).
 */
let altSent = false
/** An Alt pick happened during this press: its keyup must not reach the browser menu. */
let pickedDuringAlt = false

function reportAlt(down: boolean, blur = false) {
  if (down === altSent && !blur) return
  altSent = down
  post({ tag: PROTOCOL_TAG, from: 'inspector', t: 'alt', down, blur: blur || undefined })
  // Alt pressed with the cursor resting here: the window highlights at once, not on the next move.
  if (down) postPointer()
}

window.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    if (e.key === 'Alt' || e.key === 'AltGraph' || e.altKey) reportAlt(altHeld(e))
  },
  true,
)
window.addEventListener(
  'keyup',
  (e: KeyboardEvent) => {
    if (e.key === 'Alt' && pickedDuringAlt) {
      // Chrome on Windows focuses its menu on a bare Alt release; after a pick this release
      // is not bare. Whether preventDefault keeps the menu away is browser-dependent.
      e.preventDefault()
    }
    if (e.key === 'Alt' || e.key === 'AltGraph') pickedDuringAlt = false
    reportAlt(altHeld(e))
  },
  true,
)
window.addEventListener('blur', () => {
  if (altSent) reportAlt(false, true)
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && altSent) reportAlt(false, true)
})

window.addEventListener(
  'pointermove',
  (e: PointerEvent) => {
    lastPointer = { x: e.clientX, y: e.clientY }
    reportAlt(altHeld(e))
  },
  { capture: true, passive: true },
)

/**
 * Alt+click is the window's, never the page's: in Chrome Alt+click on a link downloads it
 * (Option+click on macOS too). The Alt signal reaches the window asynchronously, so the
 * first click can land here before the overlay takes the mouse: swallow the whole click
 * sequence in the capture phase and hand the press over as a pick.
 */
function swallowAltClick(e: MouseEvent) {
  if (!altHeld(e)) return
  e.preventDefault()
  e.stopImmediatePropagation()
  reportAlt(true)
  if (e.type === 'pointerdown' && e.button === 0) {
    pickedDuringAlt = true
    post({ tag: PROTOCOL_TAG, from: 'inspector', t: 'altPick', x: e.clientX, y: e.clientY })
  }
}
for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu']) {
  window.addEventListener(type, swallowAltClick as EventListener, true)
}

// Alt+wheel walks layers in the window; here it must neither scroll the page nor go
// through history (Firefox). Non-passive, so preventDefault holds.
window.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (!altHeld(e)) return
    e.preventDefault()
    reportAlt(true)
  },
  { capture: true, passive: false },
)

/**
 * The window's overlay caught a wheel over the selected layer (its body takes the mouse
 * for dragging). Scroll what the user would have scrolled: the nearest scrollable
 * ancestor of the point, else the document.
 */
function scrollUnder(x: number, y: number, dx: number, dy: number) {
  let el: Element | null = document.elementFromPoint(x, y)
  while (el && el !== document.documentElement && el !== document.body) {
    const cs = getComputedStyle(el)
    const canY = /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight
    const canX = /(auto|scroll|overlay)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth
    if ((dy && canY) || (dx && canX)) {
      el.scrollBy({ left: dx, top: dy, behavior: 'instant' })
      return
    }
    el = el.parentElement
  }
  window.scrollBy({ left: dx, top: dy, behavior: 'instant' })
}

// --- scroll -------------------------------------------------------------------

/**
 * Boxes are viewport-relative, so a scroll that moves the selected element makes its box
 * stale until the next snapshot. The window hides the selection while this goes on (one
 * message per frame at most) and shows it again once the fresh snapshot is in. Other
 * scrolls (a carousel, a ticker) only refresh the tree: hiding on those would keep the
 * palette away for as long as the page animates.
 */
function movesSelection(target: EventTarget | null): boolean {
  if (!selectedNodeId) return false
  if (target === document || target === document.documentElement || target === document.body) return true
  const el = elementsById.get(selectedNodeId)
  return Boolean(el && target instanceof Node && target.contains(el))
}

// A clock, not requestAnimationFrame: a hidden tab never runs rAF, and the gate would stay shut.
let scrollPostedAt = 0
window.addEventListener(
  'scroll',
  (e: Event) => {
    const now = performance.now()
    if (movesSelection(e.target) && now - scrollPostedAt >= 16) {
      scrollPostedAt = now
      post({ tag: PROTOCOL_TAG, from: 'inspector', t: 'scrolling' })
    }
    scheduleCapture(100)
  },
  { passive: true, capture: true },
)

window.addEventListener('resize', () => scheduleCapture())

// The app re-renders on its own (hot reload, state changes) — keep the tree fresh,
// but never faster than the debounce or we drown the parent frame.
observe()

if (window.parent === window) {
  // eslint-disable-next-line no-console
  console.warn('[layout-debug] the inspector is loaded outside an iframe; open the page through the layout-debug-mcp window')
} else {
  post({ tag: PROTOCOL_TAG, from: 'inspector', t: 'hello', version: PROTOCOL_VERSION, url: location.href })
  scheduleCapture(0)
}
