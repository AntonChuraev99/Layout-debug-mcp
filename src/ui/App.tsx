import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatMessage, EditRequest, ErrorCode, LayoutNode, NodeId, Override, Snapshot, TargetKind } from '../shared/protocol.ts'
import { ActionPalette } from './ActionPalette.tsx'
import { Blank, CopyBlock } from './Blank.tsx'
import { ChatPopover, type LocalMessage } from './ChatPopover.tsx'
import { frameCropRect, placeHeldPopover, placePopover, union, type Side } from './geometry.ts'
import { androidStateFor, rejectsSubmit, resolveRequestErrors, type AndroidState } from './errors.ts'
import { Header, type StatusInfo } from './Header.tsx'
import { useT, type MsgKey } from './i18n.ts'
import { IconGlobe, IconPlug, IconRefresh, IconSmartphone, IconX } from './icons.tsx'
import { Inbox, type InboxItem, type LooseEntry } from './Inbox.tsx'
import { describeOverride } from './NodeDetails.tsx'
import { effectiveRect, Overlay, type Mark, type OriginGhost, type OverlayApi, type PickSource } from './Overlay.tsx'
import { COMPACT_AFTER_PICKS, escapeStep, inheritedShifts, isArrowKey, isOffscreen, nudgeOverride, type NudgeKind } from './pick.ts'
import { useAltKey } from './useAltKey.ts'
import {
  decideRefresh,
  overridesHandedOver,
  reapplyPlan,
  frameStack,
  overlaySource,
  REFRESH_NOTE_PREFIX,
  showsConnecting,
  snapshotFingerprint,
  type CarriedOverride,
  type HeldView,
} from './refresh.ts'
import {
  analyzeChat,
  bestAnchor,
  ellipsize,
  ERROR_LINE_PREFIX,
  findNode,
  finishedBetween,
  isOpen,
  progressSteps,
  requestStatus,
  RETRY_LINE_PREFIX,
  sameElement,
  threadFor,
  unownedMessages,
  type RequestStatus,
} from './thread.ts'
import { useAndroidAutoRefresh } from './useAndroidAutoRefresh.ts'
import { useDeviceFrame } from './useDeviceFrame.ts'
import { RECONNECT_MS, useServer } from './useServer.ts'
import { useTarget } from './useTarget.ts'

/** Slow enough that adb keeps up, fast enough that dragging still feels live. */
const ANDROID_OVERRIDE_INTERVAL_MS = 150
/** How long "no ghost on the old place" stays in the status pill (Android). */
const GHOST_NOTE_MS = 6000
/** Why a moved element on Android got no ghost (i18n `ghost.<reason>`). */
type GhostFailure = 'noFrame' | 'frameChanged' | 'noCanvas' | 'offFrame'
/** After the page fired `load`, this long without a hello means no inspector script in it. */
const INSPECTOR_TIMEOUT_MS = 2500
/** A blip shorter than this (first connect, server restart) is not worth a red pill. */
const OFFLINE_GRACE_MS = 1200
const DONE_FADE_MS = 650
/** After "done", this long for hot reload to bring the edit in before the window reloads the page itself. */
const HMR_GRACE_MS = 1500
/** A refresh that brings no fresh snapshot within this is reported; the blur goes anyway. */
const REFRESH_TIMEOUT_MS = 5000
const DISMISSED_KEY = 'layout-debug.dismissed'
/** Successful Alt picks so far; past COMPACT_AFTER_PICKS the header hint folds to its key cap. */
const ALT_PICKS_KEY = 'layout-debug.altPicks'
/** The first-run hint was seen once in this browser. */
const COACH_SEEN_KEY = 'layout-debug.coachSeen'

function readNumber(key: string): number {
  try {
    const n = Number(localStorage.getItem(key))
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    // Blocked storage: no hint rather than the hint on every load.
    return true
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private window: the convenience holds for this session only.
  }
}

/** macOS calls the key Option; the copy and the key cap follow. */
const IS_MAC = (() => {
  if (typeof navigator === 'undefined') return false
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ''
  return /mac/i.test(platform)
})()
const FLOAT_MARGIN = 12
/** DESIGN_SPEC Motion: the palette/chat card fades out this long (styles.css `float-out`). */
const FLOAT_HIDE_MS = 100

type ChatTarget = null | { kind: 'node' } | { kind: 'missing'; request: EditRequest }

interface PendingLocal extends LocalMessage {
  at: number
  anchors: LayoutNode['anchors']
  nodeId: NodeId
}

/** A system line the window adds to an element's thread itself (a refresh that did not work out). */
interface RefreshNote {
  id: string
  anchors: LayoutNode['anchors']
  nodeId: NodeId
  /** Placed after the last message of these requests. */
  requestIds: string[]
  key: MsgKey
  count?: number
}

/**
 * One refresh at a time, for every request that finished while it runs.
 * - `grace` (web): waiting for hot reload to change the page;
 * - `fresh`: the page was reloaded / the device asked for a frame; waiting for the result.
 */
interface RefreshCycle {
  target: TargetKind
  requests: EditRequest[]
  phase: 'grace' | 'fresh'
  /** Page fingerprint at "done" (web). */
  baseline: string | null
  /** Android: the frame number that counts as fresh. */
  frameTarget: number
  timer: number | undefined
}

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function normalizeUrl(raw: string): string {
  const v = raw.trim()
  if (!v) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`
}

export function App() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const canvasRef = useRef<HTMLElement | null>(null)
  const floatRef = useRef<HTMLDivElement | null>(null)
  const overlayApi = useRef<OverlayApi | null>(null)
  const alt = useAltKey()
  const targetEvents = useRef({
    onAlt: alt.report,
    onAltPick: (x: number, y: number) => {
      alt.markPicked()
      overlayApi.current?.pickAt(x, y, 'alt')
    },
    onPointer: (x: number, y: number) => overlayApi.current?.hoverAt(x, y),
  })
  const web = useTarget(iframeRef, targetEvents)
  const { t: translateKey, rich, locale } = useT()
  const altName = IS_MAC ? 'Option' : 'Alt'
  // Every text that names the modifier says Option on macOS.
  const t: typeof translateKey = (key, params) => translateKey(key, { alt: altName, ...params })
  const { state, send, submit, clearError } = useServer(locale)
  const isAndroid = state.target === 'android'

  const [url, setUrl] = useState('')
  const [urlDraft, setUrlDraft] = useState('')
  const [frameKey, setFrameKey] = useState(0)
  const frameKeyRef = useRef(frameKey)
  frameKeyRef.current = frameKey
  /**
   * A refresh the window started itself: the old iframe (`key`) stays over the new one until
   * the new page is in (frameStack), and `view` is what the overlay draws meanwhile (overlaySource).
   */
  const [swap, setSwap] = useState<{ key: number; view: HeldView<Snapshot, Record<NodeId, Override>> } | null>(null)
  const [frameLoaded, setFrameLoaded] = useState(false)
  const [inspectorSilent, setInspectorSilent] = useState(false)
  const [bannerHidden, setBannerHidden] = useState(false)

  const [selectedId, setSelectedId] = useState<NodeId | null>(null)
  const [pipette, setPipette] = useState(false)
  /** The palette's arrow-key row: Move or Resize, at most one. */
  const [nudge, setNudge] = useState<NudgeKind | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  /** Read once: a hint that folds in the middle of a session would move the address bar under the cursor. */
  const [learned] = useState(() => readNumber(ALT_PICKS_KEY) >= COMPACT_AFTER_PICKS)
  const [coachSeen, setCoachSeen] = useState(() => readFlag(COACH_SEEN_KEY))
  const [chat, setChat] = useState<ChatTarget>(null)
  const [dragging, setDragging] = useState(false)
  const [focusRequest, setFocusRequest] = useState<{ row: 'first' | 'chat'; nonce: number } | null>(null)
  /** Text typed in the palette's field; it belongs to the selected element and is dropped with it. */
  const [paletteDraft, setPaletteDraft] = useState('')
  const [popover, setPopover] = useState<'inbox' | 'status' | null>(null)

  const [androidOverrides, setAndroidOverrides] = useState<Record<NodeId, Override>>({})
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed)
  const [unread, setUnread] = useState<Set<string>>(new Set())
  const [fading, setFading] = useState<Set<string>>(new Set())
  const [local, setLocal] = useState<PendingLocal[]>([])
  const [hiddenErrorSeq, setHiddenErrorSeq] = useState(0)
  const [offlineVisible, setOfflineVisible] = useState(false)
  /** Requests whose blur stays on until the refreshed frame is in. */
  const [holding, setHolding] = useState<Set<string>>(new Set())
  const [notes, setNotes] = useState<RefreshNote[]>([])
  const sessionStart = useRef(Date.now())
  const cycle = useRef<RefreshCycle | null>(null)
  /** Live edits to put back once the reloaded page is in (they would be lost with the old document). */
  const carried = useRef<{ list: CarriedOverride[]; lost: number; requests: EditRequest[] } | null>(null)
  /** When the reloaded frame fired `load`; a snapshot older than this is from the page that went away. */
  const reloadLoadedAt = useRef<number | null>(null)

  // First `ready` from the server seeds the web target URL from config.
  const seeded = useRef(false)
  useEffect(() => {
    if (isAndroid || seeded.current || !state.targetUrl) return
    seeded.current = true
    setUrl(state.targetUrl)
    setUrlDraft(state.targetUrl)
  }, [isAndroid, state.targetUrl])

  useEffect(() => {
    if (state.online) {
      setOfflineVisible(false)
      return
    }
    const t = window.setTimeout(() => setOfflineVisible(true), OFFLINE_GRACE_MS)
    return () => window.clearTimeout(t)
  }, [state.online])

  // --- one vocabulary over both adapters ---
  // While the window reloads the page itself, the old tree stays up until the new one is in:
  // the selection, the open chat and its draft must not blink away with the document.
  const lastWebSnapshot = useRef(web.snapshot)
  if (web.snapshot) lastWebSnapshot.current = web.snapshot
  const reloading = cycle.current?.target === 'web' && cycle.current.phase === 'fresh'
  // While the old page is held over the reloaded one, the overlay draws what that page shows:
  // its snapshot with its live edits (overlaySource). The same flag drops the held frame.
  const webView = overlaySource(swap?.view ?? null, { snapshot: web.snapshot, overrides: web.overrides })
  const holdingFrame = !isAndroid && swap !== null && webView.holding
  const snapshot = isAndroid ? state.androidSnapshot : (webView.snapshot ?? (reloading ? lastWebSnapshot.current : null))
  const overrides = isAndroid ? androidOverrides : webView.overrides
  const selected = selectedId && snapshot ? snapshot.nodes[selectedId] : undefined

  // A drag fires a pointermove per pixel. On web that is a postMessage; on Android it
  // is an adb round-trip plus a screenshot refetch, so it has to be rate-limited —
  // with a trailing send, or the element stops one move short of where it was dropped.
  const lastSentAt = useRef(0)
  const trailing = useRef<number | undefined>(undefined)

  // Android: the device picture is the only copy of how a moved element looked before the
  // move, and the next frame already shows it moved — so the ghost is cut out at the first step.
  const deviceImgRef = useRef<HTMLImageElement | null>(null)
  const [originGhosts, setOriginGhosts] = useState<Record<NodeId, OriginGhost>>({})
  const dropOriginGhost = useCallback((nodeId: NodeId) => {
    setOriginGhosts((g) => {
      if (!(nodeId in g)) return g
      const next = { ...g }
      delete next[nodeId]
      return next
    })
  }, [])
  /** Why a moved element got no ghost: said in the status pill, not only in the console. */
  const [ghostNote, setGhostNote] = useState<{ reason: GhostFailure; seq: number } | null>(null)
  const ghostFailed = useCallback((reason: GhostFailure, detail?: unknown) => {
    console.warn(`[layout-debug] the moved element gets no ghost on its old place: ${reason}`, detail ?? '')
    setGhostNote({ reason, seq: Date.now() })
  }, [])
  // Goes by itself after a few seconds, but not while its popover is open and being read.
  const statusOpen = popover === 'status'
  useEffect(() => {
    if (!ghostNote || statusOpen) return
    const timer = window.setTimeout(() => setGhostNote(null), GHOST_NOTE_MS)
    return () => window.clearTimeout(timer)
  }, [ghostNote, statusOpen])

  const takeOriginGhost = useCallback(
    (nodeId: NodeId, prev: Override | undefined) => {
      const snap = live.current.androidSnapshot
      const node = snap?.nodes[nodeId]
      const img = deviceImgRef.current
      // No <img> at all: the first device picture has not arrived (or failed).
      if (!snap || !node || !img) return ghostFailed('noFrame')
      // Its place as shown now: own size edits count, the move does not exist yet.
      const base = effectiveRect(node, prev && { ...prev, dx: 0, dy: 0 })
      const carried = inheritedShifts(snap.nodes, live.current.androidOverrides).get(nodeId)
      const shown = { ...base, x: base.x + (carried?.x ?? 0), y: base.y + (carried?.y ?? 0) }
      const src = img.currentSrc || img.src

      const cut = () => {
        const crop = frameCropRect(shown, { w: img.naturalWidth, h: img.naturalHeight }, snap.viewport)
        if (!crop) return ghostFailed('offFrame')
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(crop.w))
        canvas.height = Math.max(1, Math.round(crop.h))
        const ctx = canvas.getContext('2d')
        if (!ctx) return ghostFailed('noCanvas')
        ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height)
        setOriginGhosts((g) => ({ ...g, [nodeId]: { src: canvas.toDataURL('image/png'), base } }))
      }

      if (img.complete && img.naturalWidth > 0) return cut()
      // The picture is still being decoded: the auto refresh (every ~0.8 s) or an earlier
      // edit swapped the <img> to a newer frame a moment ago. That frame was captured before
      // this move — the move's own frame is bumped only after the server has applied it,
      // which is after this call — so it still shows the element in place. Wait for exactly
      // that picture; if the <img> moves on to yet another frame first (decode() rejects),
      // that one may already show the move, and no ghost is better than a wrong one.
      img.decode().then(
        () => {
          const still = live.current.androidOverrides[nodeId]
          // Reset (or moved back to zero) while the picture was decoding: nothing to show.
          if (!still || (!still.dx && !still.dy)) return
          if ((img.currentSrc || img.src) !== src || !img.naturalWidth) return ghostFailed('frameChanged')
          cut()
        },
        (err: unknown) => ghostFailed((img.currentSrc || img.src) !== src ? 'frameChanged' : 'noFrame', err),
      )
    },
    [ghostFailed],
  )

  const setOverride = useCallback(
    (override: Override) => {
      if (!isAndroid) {
        web.setOverride(override)
        return
      }
      const prev = live.current.androidOverrides[override.nodeId]
      const moved = Boolean(override.dx || override.dy)
      const wasMoved = Boolean(prev && (prev.dx || prev.dy))
      if (moved && !wasMoved) takeOriginGhost(override.nodeId, prev)
      else if (!moved && wasMoved) dropOriginGhost(override.nodeId)
      setAndroidOverrides((prev) => ({ ...prev, [override.nodeId]: override }))
      const flush = () => {
        lastSentAt.current = Date.now()
        send({ t: 'androidOverride', override })
      }
      window.clearTimeout(trailing.current)
      const since = Date.now() - lastSentAt.current
      if (since >= ANDROID_OVERRIDE_INTERVAL_MS) flush()
      else trailing.current = window.setTimeout(flush, ANDROID_OVERRIDE_INTERVAL_MS - since)
    },
    [isAndroid, send, web, takeOriginGhost, dropOriginGhost],
  )

  const clearOverride = useCallback(
    (nodeId: NodeId) => {
      if (isAndroid) {
        // The device agent has no per-node undo: clear everything, then re-apply the rest.
        const rest = Object.values(androidOverrides).filter((o) => o.nodeId !== nodeId)
        setAndroidOverrides(Object.fromEntries(rest.map((o) => [o.nodeId, o])))
        dropOriginGhost(nodeId)
        send({ t: 'androidClearOverrides' })
        for (const o of rest) send({ t: 'androidOverride', override: o })
      } else {
        web.clearOverride(nodeId)
      }
    },
    [androidOverrides, isAndroid, send, web, dropOriginGhost],
  )

  const deviceFrame = useDeviceFrame(state.androidFrame, isAndroid && Boolean(state.androidSnapshot))
  const androidCapture = useCallback(() => send({ t: 'androidCapture' }), [send])
  const refresh = useAndroidAutoRefresh({
    enabled: isAndroid && state.online,
    paused: dragging,
    frame: state.androidFrame,
    errorSeq: state.captureErrorSeq,
    capture: androidCapture,
  })

  // Timers outlive the render that set them; they read the window's current state here.
  const live = useRef({ isAndroid, overrides, androidOverrides, androidSnapshot: state.androidSnapshot, webSnapshot: web.snapshot, androidFrame: state.androidFrame, refresh, web, send })
  live.current = { isAndroid, overrides, androidOverrides, androidSnapshot: state.androidSnapshot, webSnapshot: web.snapshot, androidFrame: state.androidFrame, refresh, web, send }

  // The web adapter owns its snapshot, so the server needs a copy for MCP consumers.
  // A 4000-node tree on every mutation would flood the socket — at most one send per
  // 800 ms. A throttle, not a debounce: a page that changes more often than that (a clock,
  // a spinner) would otherwise reset the timer forever and never be mirrored.
  // Every new socket gets the current snapshot again (`openedAt`): a send that met a closed
  // socket is lost, and the server forgets it on a restart; a static page never produces
  // another snapshot on its own, so MCP would see no page until the user touched it.
  const mirrorTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (isAndroid || !web.snapshot || !state.online) return
    if (mirrorTimer.current !== undefined) return // already due; it sends whatever is latest then
    mirrorTimer.current = window.setTimeout(() => {
      mirrorTimer.current = undefined
      const { isAndroid: android, webSnapshot, send: sendNow } = live.current
      if (!android && webSnapshot) sendNow({ t: 'snapshot', snapshot: webSnapshot })
    }, 800)
  }, [isAndroid, web.snapshot, state.online, state.openedAt])
  useEffect(
    () => () => {
      // Reset too: StrictMode remounts with the same ref, and a stale id would block every send.
      window.clearTimeout(mirrorTimer.current)
      mirrorTimer.current = undefined
    },
    [],
  )

  // The device keeps its tweaks across a desktop reload, but the ids that addressed
  // them are gone — so the first snapshot of a session resets the device to a state
  // the window can actually manage.
  const androidSynced = useRef(false)
  useEffect(() => {
    if (!isAndroid || !state.androidSnapshot || androidSynced.current) return
    androidSynced.current = true
    send({ t: 'androidClearOverrides' })
    setOriginGhosts({})
  }, [isAndroid, state.androidSnapshot, send])

  useEffect(() => {
    send({ t: 'select', nodeId: selectedId })
  }, [selectedId, send, state.online])

  const overrideList = useMemo(() => Object.values(overrides), [overrides])
  useEffect(() => {
    send({ t: 'overrides', overrides: overrideList })
  }, [overrideList, send, state.online])

  // A new element starts with the toggles off and the chat closed; re-picking the same one changes nothing.
  const selectedRef = useRef<NodeId | null>(null)
  selectedRef.current = selectedId
  const selectNode = useCallback((id: NodeId | null) => {
    if (id === selectedRef.current) return
    setSelectedId(id)
    setNudge(null)
    setChat((c) => (c?.kind === 'node' ? null : c))
    // Another element: its palette starts with an empty field and takes no focus by itself
    // (an old request would put the caret in the field the moment the palette mounts).
    setPaletteDraft('')
    setFocusRequest(null)
  }, [])

  // Node ids do not survive a page reload or a device recapture: the selection follows its
  // element by anchor. Gone for good — the selection goes, and an open thread stays on screen
  // as the "element not found" chat, still tied to the anchor.
  const selectedAnchor = useRef<{ id: NodeId; anchors: LayoutNode['anchors'] } | null>(null)
  useEffect(() => {
    if (!selectedId) {
      selectedAnchor.current = null
      return
    }
    if (!snapshot) return
    const prev = selectedAnchor.current
    const cur = snapshot.nodes[selectedId]
    if (prev && prev.id === selectedId && (!cur || !sameElement(cur, prev))) {
      const found = findNode(snapshot, prev)
      if (found) {
        setSelectedId(found.id)
        return
      }
      selectedAnchor.current = null
      const thread = state.requests.filter((r) => sameElement(r.node, prev))
      const last = thread[thread.length - 1]
      setSelectedId(null)
      setNudge(null)
      setChat((c) => (c?.kind === 'node' ? (last ? { kind: 'missing', request: last } : null) : c))
      return
    }
    if (cur) selectedAnchor.current = { id: selectedId, anchors: cur.anchors }
    // state.requests is read only when the element is gone; a new list alone changes nothing here.
  }, [snapshot, selectedId])

  // --- web frame lifecycle: loading → hello, or silence ---
  useEffect(() => {
    setFrameLoaded(false)
    setInspectorSilent(false)
    setBannerHidden(false)
  }, [url, frameKey])
  useEffect(() => {
    if (web.connected) {
      setInspectorSilent(false)
      return
    }
    if (!frameLoaded) return
    const t = window.setTimeout(() => setInspectorSilent(true), INSPECTOR_TIMEOUT_MS)
    return () => window.clearTimeout(t)
  }, [frameLoaded, web.connected])

  // --- requests: statuses, marks, unread ---
  const analysis = useMemo(() => analyzeChat(state.chat, state.requests), [state.chat, state.requests])
  const statuses = useMemo(() => {
    const ctx = { since: sessionStart.current, dismissed, server: state.statuses }
    return new Map(state.requests.map((r) => [r.id, requestStatus(r, analysis, ctx)] as const))
  }, [state.requests, analysis, dismissed, state.statuses])

  const requestsById = useMemo(() => new Map(state.requests.map((r) => [r.id, r])), [state.requests])

  /** Why a request's run failed, in this window's language (see resolveRequestErrors). */
  const requestErrors = useMemo(
    () =>
      resolveRequestErrors(state.errors, state.statuses, locale, (code: ErrorCode | null) =>
        code === 'agent_auth' ? t('agent.authTitle') : t('chat.failed'),
      ),
    // `t` follows `locale`.
    [state.errors, state.statuses, locale],
  )

  const nodeOfRequest = useMemo(() => {
    const map = new Map<string, LayoutNode | undefined>()
    for (const r of state.requests) map.set(r.id, snapshot ? findNode(snapshot, r.node) : undefined)
    return map
  }, [state.requests, snapshot])

  const chatTargetIsNode = useCallback(
    (r: EditRequest) => {
      if (!chat) return false
      if (chat.kind === 'missing') return sameElement(chat.request.node, r.node)
      return Boolean(selected && sameElement(selected, r.node))
    },
    [chat, selected],
  )

  // --- after "done": bring the agent's edit into the frame ---
  const fadeOut = (ids: string[]) => {
    if (!ids.length) return
    setFading((s) => new Set([...s, ...ids]))
    window.setTimeout(() => setFading((s) => new Set([...s].filter((id) => !ids.includes(id)))), DONE_FADE_MS)
  }

  /** One line per element, after its thread; it counts as a new reply until the chat is opened. */
  const addNotes = (requests: EditRequest[], key: MsgKey, count?: number) => {
    const groups: EditRequest[][] = []
    for (const r of requests) {
      const g = groups.find((x) => sameElement(x[0]!.node, r.node))
      if (g) g.push(r)
      else groups.push([r])
    }
    const stamp = Date.now()
    setNotes((n) => [
      ...n,
      ...groups.map((g, i) => ({
        id: `${REFRESH_NOTE_PREFIX}${stamp}-${i}`,
        anchors: g[0]!.node.anchors,
        nodeId: g[0]!.node.id,
        requestIds: g.map((r) => r.id),
        key,
        count,
      })),
    ])
    setUnread((s) => new Set([...s, ...requests.map((r) => r.id)]))
  }

  const finishCycle = (failed: boolean) => {
    const c = cycle.current
    if (!c) return
    window.clearTimeout(c.timer)
    cycle.current = null
    // The new page is in (or never came): it takes over from the held old one either way.
    setSwap(null)
    const ids = c.requests.map((r) => r.id)
    setHolding((s) => new Set([...s].filter((id) => !ids.includes(id))))
    fadeOut(ids)
    if (failed) addNotes(c.requests, c.target === 'android' ? 'refresh.failedDevice' : 'refresh.failed')
  }

  /** Android: drops the edits these requests carried, keeps the rest on the device. */
  const clearHandedOverAndroid = (requests: EditRequest[]) => {
    const L = live.current
    const handed = overridesHandedOver(L.androidOverrides, requests)
    if (!handed.size) return
    // The device agent has no per-node undo: clear everything, then re-apply the rest.
    const rest = Object.values(L.androidOverrides).filter((o) => !handed.has(o.nodeId))
    setAndroidOverrides(Object.fromEntries(rest.map((o) => [o.nodeId, o])))
    L.send({ t: 'androidClearOverrides' })
    for (const o of rest) L.send({ t: 'androidOverride', override: o })
  }

  const afterGrace = () => {
    const c = cycle.current
    if (!c || c.phase !== 'grace') return
    const L = live.current
    const handed = overridesHandedOver(L.overrides, c.requests)
    if (decideRefresh('web', c.baseline, snapshotFingerprint(L.webSnapshot)) === 'keep') {
      for (const id of handed) L.web.clearOverride(id)
      finishCycle(false)
      return
    }
    // A reload starts a new document without the window's inline styles: the edits the
    // agent got go with it on purpose, the others are carried over to the new page.
    const list: CarriedOverride[] = []
    let lost = 0
    for (const o of Object.values(L.overrides)) {
      if (handed.has(o.nodeId)) continue
      const anchors = L.webSnapshot?.nodes[o.nodeId]?.anchors
      if (anchors) list.push({ override: o, anchors })
      else lost++
    }
    carried.current = list.length || lost ? { list, lost, requests: [...c.requests] } : null
    reloadLoadedAt.current = null
    c.phase = 'fresh'
    c.timer = window.setTimeout(() => finishCycle(true), REFRESH_TIMEOUT_MS)
    // The page loads into a new iframe under the current one, which stays on screen until
    // the new page reports its first snapshot: no white frame between the two documents.
    // The overlay keeps drawing that page as it is now — with every live edit still on it.
    setSwap({ key: frameKeyRef.current, view: { snapshot: L.webSnapshot, overrides: L.overrides, loadedAt: null } })
    setFrameKey((k) => k + 1)
  }

  const startRefresh = (requests: EditRequest[]) => {
    const L = live.current
    setHolding((s) => new Set([...s, ...requests.map((r) => r.id)]))
    const c = cycle.current
    if (c) {
      c.requests.push(...requests)
      if (c.target === 'android') {
        clearHandedOverAndroid(requests)
        c.frameTarget = L.androidFrame + (L.refresh.inflight ? 2 : 1)
        L.refresh.refreshNow()
      } else if (c.phase === 'grace') {
        window.clearTimeout(c.timer)
        c.timer = window.setTimeout(afterGrace, HMR_GRACE_MS)
      } else if (carried.current) {
        // Already reloading: what these requests carried must not come back on the new page.
        const handed = overridesHandedOver(Object.fromEntries(carried.current.list.map((x) => [x.override.nodeId, x.override])), requests)
        carried.current.list = carried.current.list.filter((x) => !handed.has(x.override.nodeId))
      }
      return
    }
    if (L.isAndroid) {
      clearHandedOverAndroid(requests)
      // A capture already on the wire may predate the edit; the one after it is the fresh one.
      cycle.current = {
        target: 'android',
        requests: [...requests],
        phase: 'fresh',
        baseline: null,
        frameTarget: L.androidFrame + (L.refresh.inflight ? 2 : 1),
        timer: window.setTimeout(() => finishCycle(true), REFRESH_TIMEOUT_MS),
      }
      L.refresh.refreshNow()
      return
    }
    cycle.current = {
      target: 'web',
      requests: [...requests],
      phase: 'grace',
      baseline: snapshotFingerprint(L.webSnapshot),
      frameTarget: 0,
      timer: window.setTimeout(afterGrace, HMR_GRACE_MS),
    }
  }

  // The reloaded page is in: put the carried edits back, then let the blur go.
  useEffect(() => {
    const snap = web.snapshot
    const loadedAt = reloadLoadedAt.current
    if (isAndroid || !snap || loadedAt === null || snap.createdAt < loadedAt) return
    reloadLoadedAt.current = null
    const pending = carried.current
    carried.current = null
    if (pending) {
      const { apply, lost } = reapplyPlan(pending.list, snap)
      for (const o of apply) web.setOverride(o)
      if (lost + pending.lost) addNotes(pending.requests, 'refresh.lostEdits', lost + pending.lost)
    }
    if (cycle.current?.target === 'web' && cycle.current.phase === 'fresh') finishCycle(false)
    // Only a new snapshot matters; the helpers read current state through refs.
  }, [isAndroid, web.snapshot])

  useEffect(() => {
    const c = cycle.current
    if (c?.target === 'android' && state.androidFrame >= c.frameTarget) finishCycle(false)
  }, [state.androidFrame])

  // Another page (or target) makes a pending refresh meaningless; its edits belong to the old one.
  useEffect(() => {
    carried.current = null
    reloadLoadedAt.current = null
    setSwap(null)
    finishCycle(false)
  }, [url, isAndroid])

  useEffect(() => () => window.clearTimeout(cycle.current?.timer), [])

  // Replay is told apart by the frame, not by the clock: the first `requests` frame of a
  // socket only seeds the baseline (what finished while the window was away is not news),
  // and every status change after it — however soon after connecting — is live.
  const prevStatuses = useRef<Map<string, RequestStatus>>(new Map())
  const seenSeed = useRef(state.requestsSeed)
  useEffect(() => {
    const seedFrame = seenSeed.current !== state.requestsSeed
    seenSeed.current = state.requestsSeed
    const prev = prevStatuses.current
    prevStatuses.current = statuses
    if (seedFrame) return
    const ids = new Set(finishedBetween(prev, statuses))
    const finished = state.requests.filter((r) => ids.has(r.id))
    if (!finished.length) return
    // A finished edit is in the code, not yet in the frame: keep the blur until it is.
    const toRefresh = finished.filter((r) => statuses.get(r.id) === 'done' && r.target === state.target)
    fadeOut(finished.filter((r) => !toRefresh.includes(r)).map((r) => r.id))
    if (toRefresh.length) startRefresh(toRefresh)
    const unseen = finished.filter((r) => !chatTargetIsNode(r))
    if (unseen.length) setUnread((s) => new Set([...s, ...unseen.map((r) => r.id)]))
  }, [statuses, state.requests, state.requestsSeed, state.target, chatTargetIsNode])

  // An open chat reads its element's answers.
  useEffect(() => {
    if (!chat) return
    const read = state.requests.filter((r) => unread.has(r.id) && chatTargetIsNode(r))
    if (read.length) setUnread((s) => new Set([...s].filter((id) => !read.some((r) => r.id === id))))
  }, [chat, chatTargetIsNode, state.requests, unread])

  const marks = useMemo<Mark[]>(() => {
    const byNode = new Map<NodeId, Mark>()
    for (const r of state.requests) {
      const node = nodeOfRequest.get(r.id)
      if (!node) continue
      const s = statuses.get(r.id)
      const kind: Mark['kind'] | null =
        s === 'work' ? 'work' : holding.has(r.id) ? 'refresh' : s === 'queued' ? 'queued' : fading.has(r.id) ? 'done' : null
      if (!kind) continue
      const prev = byNode.get(node.id)
      const rank = { work: 4, refresh: 3, queued: 2, done: 1 }
      if (!prev || rank[kind] > rank[prev.kind]) byNode.set(node.id, { nodeId: node.id, kind })
    }
    return [...byNode.values()]
  }, [state.requests, nodeOfRequest, statuses, fading, holding])

  const unreadNodes = useMemo(() => {
    const set = new Set<NodeId>()
    for (const id of unread) {
      const node = nodeOfRequest.get(id)
      if (node) set.add(node.id)
    }
    return set
  }, [unread, nodeOfRequest])

  // A message typed here that never became a request failed with the error the server
  // answered the submit with. Agent errors carry their request id and land on that request.
  const lastErrorSeq = useRef(0)
  useEffect(() => {
    const fresh = state.errors.filter((e) => e.seq > lastErrorSeq.current)
    if (!fresh.length) return
    lastErrorSeq.current = fresh[fresh.length - 1]!.seq
    const rejected = fresh.filter((e) => rejectsSubmit(e.code))
    const latest = rejected[rejected.length - 1]
    if (latest) setLocal((l) => l.map((m) => (m.failed ? m : { ...m, failed: latest.message })))
  }, [state.errors])

  // The server's echo replaces the optimistic copy.
  useEffect(() => {
    setLocal((l) =>
      l.filter(
        (m) =>
          !state.requests.some(
            (r) => r.comment === m.text && r.createdAt >= m.at - 5000 && sameElement(r.node, { id: m.nodeId, anchors: m.anchors }),
          ),
      ),
    )
  }, [state.requests])

  const persistDismissed = (next: Set<string>) => {
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next].slice(-200)))
    } catch {
      // Private window: the choice still holds for this session.
    }
  }

  // --- derived for the selected element ---
  const requestsOf = useCallback(
    (target: { id: NodeId; anchors: LayoutNode['anchors'] }) => state.requests.filter((r) => sameElement(r.node, target)),
    [state.requests],
  )
  const selectedRequests = useMemo(() => (selected ? requestsOf(selected) : []), [selected, requestsOf])
  const selectedWorking = selectedRequests.some((r) => statuses.get(r.id) === 'work' || holding.has(r.id))
  const selectedWaiting = selectedRequests.some((r) => isOpen(statuses.get(r.id) ?? 'done'))

  const tweakBlocked = isAndroid && !state.online ? t('blocked.offlineMove') : null
  const hideBlocked = isAndroid ? t('blocked.hideAndroid') : null

  // --- picking: Alt held or the pipette on (web); Android selects by a plain click too ---
  const toolsBlocked = !snapshot ? (isAndroid ? t('blocked.needDevice') : t('blocked.needPage')) : null
  const pipetteOn = pipette && !isAndroid && Boolean(snapshot)
  const picking = Boolean(snapshot) && (alt.down || pipetteOn)

  // The pipette is for one pick of this page; another page or target turns it off.
  useEffect(() => {
    if (!snapshot || isAndroid) setPipette(false)
  }, [snapshot, isAndroid])

  // The inspector hides boxes only for scrolls that move the selected element (DESIGN_SPEC §9),
  // so it needs to know which one that is.
  useEffect(() => {
    if (!isAndroid) web.setSelected(selectedId)
  }, [selectedId, isAndroid, web.setSelected, web.snapshot])

  // Arrows typed while focus sits in the page reach the window only while a nudge row is on.
  useEffect(() => {
    if (!isAndroid) web.setNudge(nudge !== null)
  }, [nudge, isAndroid, web.setNudge, web.connected])

  const coachOpen = !isAndroid && web.connected && !coachSeen
  const closeCoach = useCallback(() => {
    setCoachSeen(true)
    writeStorage(COACH_SEEN_KEY, '1')
  }, [])

  /**
   * A pick gesture finished. `empty`: it landed on no layer (the selection went, nothing new
   * was picked) — the Alt release is still not a bare tap, but the pipette stays on for a
   * real pick, and nothing counts as learned.
   */
  const onPicked = useCallback(
    (source: PickSource, empty = false) => {
      if (source !== 'click') {
        // Both sides must know: the Alt keyup goes to whichever document has focus.
        alt.markPicked()
        if (!isAndroid) web.notifyPicked()
      }
      if (empty) return
      if (source === 'pipette') setPipette(false)
      // The hint folds only on web; Android shows no cap to fold to (DESIGN_SPEC §8).
      if (source === 'alt' && !isAndroid) writeStorage(ALT_PICKS_KEY, String(readNumber(ALT_PICKS_KEY) + 1))
      if (!coachSeen) closeCoach()
    },
    [alt.markPicked, isAndroid, web.notifyPicked, coachSeen, closeCoach],
  )

  // Alt pressed with the cursor resting on the page: highlight at once, not on the next move.
  // The window sees no pointer over the iframe, so the inspector says where it is.
  useEffect(() => {
    if (alt.down && !isAndroid) web.queryPointer()
  }, [alt.down, isAndroid, web.queryPointer])

  /** One arrow step of the nudge row (DESIGN_SPEC §5). */
  const nudgeBy = useCallback(
    (key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown', shift: boolean) => {
      if (!nudge || !selected || !snapshot || tweakBlocked) return
      const rect = effectiveRect(selected, overrides[selected.id])
      setOverride(nudgeOverride(nudge, key, shift, selected.id, overrides[selected.id], rect, snapshot.pxPerUnit))
    },
    [nudge, selected, snapshot, tweakBlocked, overrides, setOverride],
  )

  // --- canvas geometry ---
  const [canvasBox, setCanvasBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCanvasBox({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // A phone screen is taller than the window, so the device frame is scaled to fit.
  // Bounds stay in device pixels; only drawing and pointer maths know about this.
  const device = useMemo(() => {
    if (!isAndroid || !snapshot || canvasBox.w === 0) return { scale: 1, x: 0, y: 0 }
    const pad = 16
    const scale = Math.min(1, (canvasBox.w - pad * 2) / snapshot.viewport.w, (canvasBox.h - pad * 2) / snapshot.viewport.h)
    return {
      scale,
      x: Math.round((canvasBox.w - snapshot.viewport.w * scale) / 2),
      y: Math.round((canvasBox.h - snapshot.viewport.h * scale) / 2),
    }
  }, [isAndroid, snapshot, canvasBox])

  // --- floating card placement (palette or chat) ---
  // A layer scrolled out of the frame keeps its selection, but the palette has nothing to point at.
  const shifts = useMemo(() => (snapshot ? inheritedShifts(snapshot.nodes, overrides) : null), [snapshot, overrides])
  const selectedOffscreen = Boolean(
    selected && snapshot && isOffscreen(effectiveRect(selected, overrides[selected.id], shifts?.get(selected.id)), snapshot.viewport),
  )
  const showFloat = (chat?.kind === 'missing' || (Boolean(selected) && !selectedOffscreen)) && !dragging
  const stale = !isAndroid && web.scrolling
  // An open chat stays put while the page scrolls: the user may be typing in it.
  const floatStale = stale && !chat
  /** `maxH`: the open chat's room on its side (placeHeldPopover); the palette has none. */
  const [floatPos, setFloatPos] = useState<{ x: number; y: number; side: Side; maxH?: number } | null>(null)
  const [floatSize, setFloatSize] = useState({ w: 0, h: 0 })
  /** The side the open chat took when it opened, and whose chat it is: it grows there instead of jumping elsewhere. */
  const chatSide = useRef<{ side: Side; anchors: LayoutNode['anchors'] } | null>(null)

  useEffect(() => {
    const el = floatRef.current?.firstElementChild as HTMLElement | null | undefined
    if (!el) return
    const observer = new ResizeObserver(() => setFloatSize({ w: el.offsetWidth, h: el.offsetHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [showFloat, chat?.kind, selectedId])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const card = floatRef.current?.firstElementChild as HTMLElement | null | undefined
    // A chat that closes (or turns into the palette) gives up its side; the next one picks afresh.
    // So does a chat that switches to another element in one render (opened from the Inbox).
    // A reload keeps the side: the id changes, the element's anchors do not.
    const owner = selectedId ? snapshot?.nodes[selectedId] : undefined
    if (chat?.kind !== 'node' || (owner && chatSide.current && !sameElement(owner, { ...owner, anchors: chatSide.current.anchors }))) chatSide.current = null
    if (!showFloat || !canvas || !card) {
      setFloatPos(null)
      return
    }
    const size = { w: card.offsetWidth, h: card.offsetHeight }
    const box = { w: canvas.clientWidth, h: canvas.clientHeight }
    if (chat?.kind === 'missing') {
      setFloatPos({ x: Math.max(FLOAT_MARGIN, box.w - size.w - FLOAT_MARGIN), y: FLOAT_MARGIN, side: 'corner' })
      return
    }
    const c = canvas.getBoundingClientRect()
    const rects = [...canvas.querySelectorAll<HTMLElement>('[data-anchor]')].map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height }
    })
    if (!rects.length) {
      setFloatPos(null)
      return
    }
    const anchor = rects.reduce(union)
    // The chat grows with every line: it keeps the side it opened on and is capped to that
    // side's room (its log scrolls), instead of being re-placed from its grown size.
    const p: { x: number; y: number; side: Side; maxH?: number } =
      chat?.kind === 'node'
        ? placeHeldPopover(anchor, size, box, chatSide.current?.side ?? null, 12, FLOAT_MARGIN)
        : placePopover(anchor, size, box, 12, FLOAT_MARGIN)
    if (chat?.kind === 'node') {
      const anchors = owner?.anchors ?? chatSide.current?.anchors
      chatSide.current = anchors ? { side: p.side, anchors } : null
    }
    setFloatPos((prev) => (prev && prev.x === p.x && prev.y === p.y && prev.side === p.side && prev.maxH === p.maxH ? prev : p))
  }, [showFloat, chat, selectedId, overrides, canvasBox, floatSize, detailsOpen, device, snapshot])

  // The palette (or chat) closing: a static copy of the last frame fades out for
  // FLOAT_HIDE_MS. Switching palette ↔ chat swaps cards without a gap, so it is not a close.
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const shownCard = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const card = (floatRef.current?.firstElementChild as HTMLElement | null | undefined) ?? null
    const prev = shownCard.current
    shownCard.current = card
    const host = ghostRef.current
    if (card || !prev || !host || prev.style.visibility === 'hidden') return
    const ghost = prev.cloneNode(true) as HTMLElement
    ghost.classList.add('float__card--leaving')
    ghost.inert = true
    host.appendChild(ghost)
    const remove = () => ghost.remove()
    ghost.addEventListener('animationend', remove, { once: true })
    // animationend does not fire when animations are off (e.g. a hidden tab): remove anyway.
    window.setTimeout(remove, FLOAT_HIDE_MS + 80)
  })

  // --- actions ---
  const openUrl = () => {
    const next = normalizeUrl(urlDraft)
    setUrlDraft(next)
    selectNode(null)
    setChat(null)
    // The user asked for this load: it shows as one, with no old page held over it.
    setSwap(null)
    if (next === url) setFrameKey((k) => k + 1)
    else setUrl(next)
  }

  const openChat = () => {
    if (!selected) return
    setChat({ kind: 'node' })
  }

  const closeChatToPalette = () => {
    const wasMissing = chat?.kind === 'missing'
    setChat(null)
    if (!wasMissing) setFocusRequest({ row: 'chat', nonce: Date.now() })
  }

  const sendMessage = (text: string) => {
    if (!selected || !snapshot) return
    const key = `local-${Date.now()}`
    const entry: PendingLocal = { key, text, at: Date.now(), anchors: selected.anchors, nodeId: selected.id }
    // The server builds the request from its own copy of the snapshot and selection;
    // refresh both first so a message sent right after a click cannot miss them.
    if (!isAndroid) send({ t: 'snapshot', snapshot })
    send({ t: 'select', nodeId: selected.id })
    send({ t: 'overrides', overrides: overrideList })
    if (!submit(text)) entry.failed = t('send.offline')
    setLocal((l) => [...l, entry])
  }

  /** Enter in the palette's field: the message goes out and the chat opens to show the answer. */
  const sendFromPalette = (text: string) => {
    if (!selected) return
    sendMessage(text)
    setPaletteDraft('')
    setChat({ kind: 'node' })
  }

  const stopWaiting = () => {
    const next = new Set(dismissed)
    for (const r of selectedRequests) if (isOpen(statuses.get(r.id) ?? 'done')) next.add(r.id)
    persistDismissed(next)
  }

  const toggleHidden = () => {
    if (!selected) return
    const prev = overrides[selected.id]
    const hidden = !prev?.hidden
    const next: Override = { nodeId: selected.id, dx: prev?.dx ?? 0, dy: prev?.dy ?? 0, width: prev?.width, height: prev?.height, hidden }
    if (!hidden && !next.dx && !next.dy && next.width == null && next.height == null) clearOverride(selected.id)
    else setOverride(next)
  }

  const openFromInbox = (r: EditRequest) => {
    setPopover(null)
    const node = nodeOfRequest.get(r.id)
    if (node) {
      selectNode(node.id)
      setChat({ kind: 'node' })
    } else {
      setChat({ kind: 'missing', request: r })
    }
  }

  const selectByKeyboard = selectNode

  // --- keyboard ---
  /** Moves focus back to the palette row whose nudge row just closed by key. */
  const [nudgeExit, setNudgeExit] = useState<{ kind: NudgeKind; nonce: number } | null>(null)
  const closeNudge = () => {
    if (!nudge) return
    const inside = document.activeElement?.closest('.nudge')
    setNudge(null)
    if (inside) setNudgeExit({ kind: nudge, nonce: Date.now() })
  }

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      if (e.key === 'Escape') {
        switch (escapeStep({ coach: coachOpen, chat: Boolean(chat), details: detailsOpen, nudge: nudge !== null, pipette: pipetteOn, selected: Boolean(selectedId) })) {
          case 'coach':
            return closeCoach()
          case 'chat':
            return closeChatToPalette()
          case 'details':
            return setDetailsOpen(false)
          case 'nudge':
            return closeNudge()
          case 'pipette':
            return setPipette(false)
          case 'selection':
            return selectNode(null)
          default:
            return
        }
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return
      // The nudge row: arrows step the selected layer, Enter leaves the row.
      // Not from the header: its buttons and switches keep their own arrow keys.
      if (nudge && selected && !e.defaultPrevented && !el?.closest('.tb')) {
        if (isArrowKey(e.key)) {
          e.preventDefault()
          nudgeBy(e.key, e.shiftKey)
          return
        }
        const onOtherControl = el && el.closest('button, a, [role="menuitem"], [role="menuitemcheckbox"]') && !el.closest('.nudge')
        if (e.key === 'Enter' && !onOtherControl) {
          e.preventDefault()
          closeNudge()
          return
        }
      }
      const k = e.key.toLowerCase()
      // The physical key as well, so the shortcut works with a non-Latin layout switched on.
      if ((k === 'c' || e.code === 'KeyC') && selected && !e.repeat) {
        // The key must not also land as a character in the field it focuses.
        e.preventDefault()
        // Palette shown: C puts the caret in its chat field. Chat already open: as before.
        if (chat) openChat()
        else setFocusRequest({ row: 'chat', nonce: Date.now() })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onCanvasKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || !snapshot) return
    // With the nudge row on, arrows and Enter belong to it (the window handler).
    if (nudge && (e.key === 'Enter' || isArrowKey(e.key))) return
    const cur = selected
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      if (cur?.parentId) selectByKeyboard(cur.parentId)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const base = cur ?? snapshot.nodes[snapshot.rootId]
      const child = base?.childIds[0]
      selectByKeyboard(cur ? (child ?? cur.id) : snapshot.rootId)
      return
    }
    if (e.key === 'Tab' && cur?.parentId) {
      const siblings = snapshot.nodes[cur.parentId]?.childIds ?? []
      const at = siblings.indexOf(cur.id)
      const next = siblings[at + (e.shiftKey ? -1 : 1)]
      if (next) {
        e.preventDefault()
        selectByKeyboard(next)
      }
    }
  }

  // --- android state ---
  const androidState: AndroidState = !isAndroid || snapshot ? 'live' : androidStateFor(state.captureCode)

  // --- status pill: only when something needs attention ---
  const serverPopover = (
    <div className="pop__body">
      <h2 className="pop__title">{t('offline.title')}</h2>
      <p className="pop__text">{t('offline.text')}</p>
      <CopyBlock text="npm run dev" />
      <p className="pop__note">{t('offline.note', { seconds: RECONNECT_MS / 1000 })}</p>
    </div>
  )

  let status: StatusInfo | null = null
  if (offlineVisible && !state.online) {
    status = { tone: 'danger', text: t('status.offline'), popover: serverPopover }
  } else if (isAndroid && androidState === 'no-agent') {
    status = {
      tone: 'warn',
      text: t('status.noAgent'),
      popover: (
        <div className="pop__body">
          <h2 className="pop__title">{t('noAgent.title')}</h2>
          <ol className="steps">
            <li>{t('noAgent.step1')}</li>
            <li>{t('noAgent.step2')}</li>
            <li>{t('noAgent.step3')}</li>
          </ol>
          {state.captureError && <p className="pop__note mono">{state.captureError}</p>}
        </div>
      ),
    }
  } else if (isAndroid && androidState === 'device-error') {
    status = {
      tone: 'warn',
      text: t('status.deviceError'),
      popover: (
        <div className="pop__body">
          <h2 className="pop__title">{t('deviceError.title')}</h2>
          <p className="pop__text">{t('deviceError.text')}</p>
          <p className="pop__text pop__text--wrap mono">{state.captureError || t('deviceError.noDetails')}</p>
          <ol className="steps">
            <li>{rich('deviceError.step1', { cmd: <code>adb devices</code> })}</li>
            <li>{rich('deviceError.step2', { env: <code>LD_DEVICE</code> })}</li>
            <li>{t('noAgent.step3')}</li>
          </ol>
        </div>
      ),
    }
  } else if (isAndroid && androidState === 'connecting' && state.online) {
    status = { tone: 'busy', text: t('status.connectingDevice') }
  } else if (isAndroid && snapshot && refresh.failures > 0) {
    status = {
      tone: 'warn',
      text: t('status.stale'),
      popover: (
        <div className="pop__body">
          <h2 className="pop__title">{t('stale.title')}</h2>
          <p className="pop__text">{t('stale.text', { count: refresh.failures })}</p>
          {state.captureError && <p className="pop__note mono">{state.captureError}</p>}
          <button type="button" className="btn btn--icon" onClick={refresh.refreshNow} disabled={refresh.inflight || !state.online}>
            <IconRefresh size={14} />
            {refresh.inflight ? t('stale.capturing') : t('stale.refresh')}
          </button>
        </div>
      ),
    }
  } else if (isAndroid && snapshot && deviceFrame.error) {
    status = {
      tone: 'warn',
      text: t('status.frameError'),
      popover: (
        <div className="pop__body">
          <h2 className="pop__title">{t('frameError.title')}</h2>
          <p className="pop__text">{deviceFrame.src ? t('frameError.textStale') : t('frameError.textNone')}</p>
          <p className="pop__note mono">{deviceFrame.error.message || t('frameError.noDetails')}</p>
          <button type="button" className="btn btn--icon" onClick={refresh.refreshNow} disabled={refresh.inflight || !state.online}>
            <IconRefresh size={14} />
            {refresh.inflight ? t('stale.capturing') : t('stale.refresh')}
          </button>
        </div>
      ),
    }
  } else if (isAndroid && ghostNote) {
    status = {
      tone: 'warn',
      text: t('status.ghostFailed'),
      title: t(`ghost.${ghostNote.reason}`),
      popover: (
        <div className="pop__body">
          <h2 className="pop__title">{t('ghost.title')}</h2>
          <p className="pop__text pop__text--wrap">{t(`ghost.${ghostNote.reason}`)}</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setGhostNote(null)
              setPopover(null)
            }}
          >
            {t('error.dismiss')}
          </button>
        </div>
      ),
    }
  } else if (state.error && state.errorSeq > hiddenErrorSeq) {
    status = {
      tone: 'danger',
      text: ellipsize(state.error, 32),
      title: state.error,
      popover: (
        <div className="pop__body">
          <h2 className="pop__title">{t('error.title')}</h2>
          <p className="pop__text pop__text--wrap">{state.error}</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setHiddenErrorSeq(state.errorSeq)
              clearError()
              setPopover(null)
            }}
          >
            {t('error.dismiss')}
          </button>
        </div>
      ),
    }
  } else if (!isAndroid && url && inspectorSilent) {
    status = { tone: 'warn', text: t('status.inspectorSilent'), onClick: () => setBannerHidden(false) }
  } else if (!isAndroid && web.error) {
    status = {
      tone: 'warn',
      text: t('status.inspectorError'),
      popover: (
        <div className="pop__body">
          <h2 className="pop__title">{t('inspectorError.title')}</h2>
          <p className="pop__text pop__text--wrap">{web.error}</p>
        </div>
      ),
    }
  }
  const webConnecting = !isAndroid && showsConnecting({ url, connected: web.connected, silent: inspectorSilent, swapping: holdingFrame })
  if (!status && webConnecting) status = { tone: 'busy', text: t('status.connectingInspector') }

  const loading = webConnecting || (isAndroid && androidState === 'connecting' && state.online)

  // --- inbox data ---
  const inboxItems: InboxItem[] = state.requests.map((r) => ({
    request: r,
    status: statuses.get(r.id) ?? 'work',
    steps: progressSteps(state.chat, r.id, state.projectDir),
    error: requestErrors.get(r.id)?.message || null,
    errorCode: requestErrors.get(r.id)?.code ?? null,
    unread: unread.has(r.id),
  }))
  const loose: LooseEntry[] = [
    ...unownedMessages(state.chat, analysis).map((m) => ({ id: m.id, text: m.text, tone: 'note' as const, at: null })),
    ...state.errors
      // An error with a known request id is shown on that request's card.
      .filter((e) => !(e.requestId && requestsById.has(e.requestId)))
      .map((e) => ({ id: `err-${e.seq}`, text: e.message, tone: 'error' as const, at: e.at })),
  ]
  const openCount = inboxItems.filter((i) => isOpen(i.status)).length

  // --- chat data ---
  const chatRequests = chat?.kind === 'missing' ? requestsOf({ id: chat.request.node.id, anchors: chat.request.node.anchors }) : selectedRequests
  const chatIds = chatRequests.map((r) => r.id)
  const chatThread = chat ? threadFor(state.chat, analysis, chatIds) : []
  const chatTargetNode = chat?.kind === 'missing' ? chat.request.node : chat ? selected : undefined
  const chatMessages: ChatMessage[] = [...chatThread]
  /** Window-made lines go after the last message of their requests (or at the end). */
  const insertLine = (line: ChatMessage, requestIds: string[]) => {
    let at = -1
    chatMessages.forEach((m, i) => {
      if (analysis.owners.get(m.id)?.some((id) => requestIds.includes(id))) at = i
    })
    chatMessages.splice(at === -1 ? chatMessages.length : at + 1, 0, line)
  }
  const lastChatRequest = chatRequests[chatRequests.length - 1]
  const chatAuthError = Boolean(
    lastChatRequest && statuses.get(lastChatRequest.id) === 'error' && requestErrors.get(lastChatRequest.id)?.code === 'agent_auth',
  )
  if (chatTargetNode) {
    for (const r of chatRequests) {
      const err = statuses.get(r.id) === 'error' ? requestErrors.get(r.id) : undefined
      // The latest auth failure is the notice above the thread, with the fix; no second copy.
      const inNotice = chatAuthError && r === lastChatRequest
      if (err && !inNotice) {
        insertLine({ id: `${ERROR_LINE_PREFIX}${r.id}`, role: 'system', text: err.code === 'agent_auth' ? t('agent.authTitle') : err.message }, [r.id])
      }
      const retry = statuses.get(r.id) === 'work' ? state.retrying.get(r.id) : undefined
      if (retry) insertLine({ id: `${RETRY_LINE_PREFIX}${r.id}`, role: 'system', text: retry.message }, [r.id])
    }
    for (const n of notes) {
      if (!sameElement({ id: n.nodeId, anchors: n.anchors }, chatTargetNode)) continue
      insertLine({ id: n.id, role: 'system', text: t(n.key, n.count != null ? { count: n.count } : undefined) }, n.requestIds)
    }
  }
  const chatLocal = chat?.kind === 'node' && selected ? local.filter((m) => sameElement({ id: m.nodeId, anchors: m.anchors }, selected)) : []
  const lastMsg = chatThread[chatThread.length - 1]
  const chatWorking =
    chatRequests.some((r) => statuses.get(r.id) === 'work') && !(lastMsg?.role === 'assistant' && lastMsg.pending && lastMsg.text)
  // The server starts one agent run per message, in parallel, on the same project: two
  // runs editing one file lose an edit. So a new message waits until the running one ends —
  // in any window: the server's status is shared, `busy` covers the gap before it arrives.
  const agentBusy =
    state.agentAvailable && (state.busy || [...state.statuses.values()].some((s) => s.status === 'working'))
  const selectedOverride = selected ? overrides[selected.id] : undefined
  const attach = selectedOverride && snapshot ? describeOverride(selectedOverride, snapshot.pxPerUnit, '', t).trim() || null : null

  const meta = snapshot ? t('meta.layers', { count: Object.keys(snapshot.nodes).length }) : null
  const deviceChip =
    !isAndroid || androidState === 'no-device' || androidState === 'no-adb'
      ? null
      : { name: state.deviceModel ?? (state.device ? 'Android' : t('device.generic')), serial: state.device }

  const suggestions = [...new Set(['http://localhost:5173', 'http://localhost:3000', state.targetUrl ?? ''].filter(Boolean))]

  return (
    <div className="app">
      <Header
        pick={{
          pipette: pipetteOn,
          alt: picking && alt.down,
          blocked: toolsBlocked,
          compact: learned && !isAndroid,
          mac: IS_MAC,
          onPipette: () => setPipette((v) => !v),
        }}
        coach={coachOpen ? { onClose: closeCoach } : null}
        t={t}
        target={isAndroid ? 'android' : 'web'}
        urlDraft={urlDraft}
        onUrlDraft={setUrlDraft}
        onOpenUrl={openUrl}
        device={deviceChip}
        inbox={{ open: openCount, working: inboxItems.some((i) => i.status === 'work'), unread: unread.size > 0 }}
        inboxOpen={popover === 'inbox'}
        onInboxToggle={(open) => setPopover(open ? 'inbox' : null)}
        inboxContent={<Inbox items={inboxItems} loose={loose} onOpen={openFromInbox} />}
        status={status}
        statusOpen={popover === 'status'}
        onStatusToggle={(open) => setPopover(open ? 'status' : null)}
        meta={meta}
        loading={loading}
      />

      <main
        ref={canvasRef}
        className={`canvas${isAndroid || !url ? ' canvas--dots' : ''}${picking && !isAndroid ? ' canvas--picking' : ''}`}
        tabIndex={snapshot ? 0 : -1}
        aria-label={isAndroid ? t('canvas.labelAndroid') : t('canvas.label')}
        onKeyDown={onCanvasKey}
      >
        {isAndroid ? (
          snapshot ? (
            // No picture yet (first frame in flight or failed): the overlay still works on the
            // tree, and a failed frame is explained by the status pill.
            deviceFrame.src && (
              <img
                ref={deviceImgRef}
                className="device"
                src={deviceFrame.src}
                alt={t('canvas.deviceAlt')}
                draggable={false}
                onError={deviceFrame.onDecodeError}
                style={{
                  left: device.x,
                  top: device.y,
                  width: snapshot.viewport.w * device.scale,
                  height: snapshot.viewport.h * device.scale,
                }}
              />
            )
          ) : androidState === 'device-error' ? (
            <Blank icon={<IconSmartphone size={18} />} title={t('deviceError.title')}>
              <p className="blank__text">{t('deviceError.text')}</p>
              <p className="blank__text mono">{state.captureError || t('deviceError.noDetails')}</p>
              <ol className="steps">
                <li>{rich('deviceError.step1', { cmd: <code>adb devices</code> })}</li>
                <li>{rich('deviceError.step2', { env: <code>LD_DEVICE</code> })}</li>
                <li>{t('noAgent.step3')}</li>
              </ol>
              <button type="button" className="btn btn--icon" onClick={refresh.refreshNow} disabled={refresh.inflight || !state.online}>
                <IconRefresh size={14} />
                {refresh.inflight ? t('android.checking') : t('android.checkAgain')}
              </button>
            </Blank>
          ) : androidState === 'no-device' || androidState === 'no-adb' ? (
            <Blank icon={<IconSmartphone size={18} />} title={androidState === 'no-adb' ? t('android.noAdbTitle') : t('android.noDeviceTitle')}>
              <p className="blank__text">
                {androidState === 'no-adb' ? t('android.noAdbText') : t('android.noDeviceText')}
              </p>
              <ol className="steps">
                <li>{t('android.step1')}</li>
                <li>{rich('android.step2', { cmd: <code>adb devices</code> })}</li>
                <li>{t('android.step3')}</li>
              </ol>
              <button type="button" className="btn btn--icon" onClick={refresh.refreshNow} disabled={refresh.inflight || !state.online}>
                <IconRefresh size={14} />
                {refresh.inflight ? t('android.checking') : t('android.checkAgain')}
              </button>
            </Blank>
          ) : (
            <Blank icon={<IconSmartphone size={18} />} title={androidState === 'no-agent' ? t('android.waitingTitle') : t('android.connectingTitle')}>
              <p className="blank__text">
                {androidState === 'no-agent' ? t('android.waitingText') : t('android.connectingText')}
              </p>
              {androidState === 'no-agent' && (
                <button type="button" className="btn btn--icon" onClick={refresh.refreshNow} disabled={refresh.inflight || !state.online}>
                  <IconRefresh size={14} />
                  {refresh.inflight ? t('android.checking') : t('android.checkAgain')}
                </button>
              )}
            </Blank>
          )
        ) : url ? (
          frameStack(frameKey, holdingFrame && swap ? swap.key : null).map((f) =>
            f.held ? (
              // The page before the window's own refresh: only a picture now. The bridge talks
              // to the new frame under it, so nothing it posts counts any more.
              <iframe key={f.key} src={url} className="frame--held" aria-hidden="true" tabIndex={-1} />
            ) : (
              <iframe
                key={f.key}
                ref={iframeRef}
                src={url}
                title={t('canvas.frameTitle')}
                onLoad={() => {
                  web.onFrameLoad()
                  setFrameLoaded(true)
                  const loadedAt = Date.now()
                  if (cycle.current?.phase === 'fresh' || carried.current) reloadLoadedAt.current = loadedAt
                  // The held old page goes with the first snapshot taken after this load.
                  setSwap((s) => (s && s.view.loadedAt === null ? { ...s, view: { ...s.view, loadedAt } } : s))
                  // The inspector posts its first snapshot on its own — possibly before this event,
                  // which has just cleared it. Ask once more, so a snapshot always follows a load.
                  web.capture()
                }}
              />
            ),
          )
        ) : (
          <Blank icon={<IconGlobe size={18} />} title={t('empty.title')}>
            <p className="blank__text">{t('empty.text')}</p>
            <div className="blank__urls">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="url-chip mono"
                  onClick={() => {
                    setUrlDraft(s)
                    selectNode(null)
                    setUrl(s)
                    setFrameKey((k) => k + 1)
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </Blank>
        )}

        {snapshot && (
          <Overlay
            snapshot={snapshot}
            overrides={overrides}
            selectedId={selectedId}
            alt={alt.down}
            pipette={pipetteOn}
            clickSelects={isAndroid}
            canTweak={!tweakBlocked}
            scale={device.scale}
            offset={{ x: device.x, y: device.y }}
            canvasWidth={canvasBox.w}
            marks={marks}
            originGhosts={isAndroid ? originGhosts : undefined}
            unread={chat?.kind === 'node' && selected ? new Set([...unreadNodes].filter((id) => id !== selected.id)) : unreadNodes}
            selectedWorking={selectedWorking}
            stale={stale}
            onDragChange={setDragging}
            onSelect={selectNode}
            onPicked={onPicked}
            onOverride={setOverride}
            onForwardWheel={isAndroid ? undefined : web.forwardWheel}
            cursorLabel={t('cursor.select')}
            cursorCompact={learned}
            apiRef={overlayApi}
          />
        )}

        {/* Closing cards fade out here, outside React: a re-rendered copy would remount and steal focus. */}
        <div className="float" ref={ghostRef} aria-hidden="true" />
        <div className={`float${floatStale ? ' float--stale' : ''}`} ref={floatRef}>
          {showFloat && chat?.kind === 'missing' && (
            <div
              className="float__card float__card--chat side-corner"
              style={floatPos ? { left: floatPos.x, top: floatPos.y, maxHeight: Math.min(480, canvasBox.h - 24) } : { visibility: 'hidden' }}
            >
              <ChatPopover
                kind={chat.request.node.kind}
                label={chat.request.node.label}
                anchor={bestAnchor(chat.request.node.anchors)}
                missing
                messages={chatMessages}
                local={[]}
                requestsById={requestsById}
                projectDir={state.projectDir}
                agentAvailable={state.agentAvailable}
                online={state.online}
                agentBusy={agentBusy}
                working={chatWorking}
                attach={null}
                authError={chatAuthError}
                onSend={() => {}}
                onBack={closeChatToPalette}
                onClose={() => setChat(null)}
              />
            </div>
          )}
          {showFloat && chat?.kind !== 'missing' && selected && snapshot && (
            <div
              className={`float__card float__card--${chat ? 'chat' : 'palette'} side-${floatPos?.side ?? 'right'}`}
              key={chat ? 'chat' : 'palette'}
              style={
                floatPos
                  ? {
                      left: floatPos.x,
                      top: floatPos.y,
                      maxHeight: chat ? Math.min(480, floatPos.maxH ?? canvasBox.h - 24) : canvasBox.h - 24,
                    }
                  : { visibility: 'hidden' }
              }
            >
              {chat ? (
                <ChatPopover
                  kind={selected.kind}
                  label={selected.label}
                  anchor={bestAnchor(selected.anchors)}
                  missing={false}
                  messages={chatMessages}
                  local={chatLocal}
                  requestsById={requestsById}
                  projectDir={state.projectDir}
                  agentAvailable={state.agentAvailable}
                  online={state.online}
                  agentBusy={agentBusy}
                  working={chatWorking}
                  attach={attach}
                  authError={chatAuthError}
                  onSend={sendMessage}
                  onBack={closeChatToPalette}
                  onClose={() => {
                    setChat(null)
                    setFocusRequest({ row: 'chat', nonce: Date.now() })
                  }}
                />
              ) : (
                <ActionPalette
                  snapshot={snapshot}
                  node={selected}
                  override={selectedOverride}
                  nudge={nudge}
                  nudgeExit={nudgeExit}
                  tweakBlocked={tweakBlocked}
                  hideBlocked={hideBlocked}
                  waiting={selectedWaiting}
                  threadSize={selectedRequests.length}
                  detailsOpen={detailsOpen}
                  focusRequest={focusRequest}
                  draft={paletteDraft}
                  sendBlocked={!state.online ? t('chat.offline') : agentBusy ? t('chat.agentBusy') : null}
                  offline={!state.online}
                  onDraftChange={setPaletteDraft}
                  onSend={sendFromPalette}
                  onLeaveField={() => canvasRef.current?.focus({ preventScroll: true })}
                  onSelect={selectNode}
                  onOpenChat={openChat}
                  onDeselect={() => selectNode(null)}
                  onToggleNudge={(kind) => setNudge((v) => (v === kind ? null : kind))}
                  onNudge={nudgeBy}
                  onToggleHidden={toggleHidden}
                  onClearOverride={() => clearOverride(selected.id)}
                  onStopWaiting={stopWaiting}
                  onToggleDetails={() => setDetailsOpen((v) => !v)}
                />
              )}
            </div>
          )}
        </div>

        {!isAndroid && url && inspectorSilent && !bannerHidden && (
          <div className="banner" role="status">
            <div className="banner__head">
              <IconPlug size={15} />
              <h2 className="banner__title">{t('banner.title')}</h2>
              <button type="button" className="icon-btn" aria-label={t('common.close')} title={t('common.close')} onClick={() => setBannerHidden(true)}>
                <IconX size={14} />
              </button>
            </div>
            <p className="banner__text">{t('banner.text')}</p>
            <CopyBlock text={`<script src="http://127.0.0.1:${__LD_SERVER_PORT__}/inspector.js"></script>`} />
          </div>
        )}
      </main>
    </div>
  )
}
