import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { LayoutNode, NodeId, Override, Snapshot } from '../shared/protocol.ts'
import {
  IconArrowUp,
  IconChat,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircleX,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconList,
  IconMove,
  IconResize,
  IconUndo,
  IconX,
} from './icons.tsx'
import { useT, type MsgKey } from './i18n.ts'
import { NodeDetails, ancestorsOf } from './NodeDetails.tsx'
import type { ArrowKey, NudgeKind } from './pick.ts'
import { bestAnchor, displayLabel } from './thread.ts'

const CRUMBS_SHOWN = 3

/** On-screen arrows of the nudge row, in reading order ← ↑ ↓ →, named per row. */
const NUDGE_BUTTONS: Array<{ key: ArrowKey; icon: ReactNode; move: MsgKey; resize: MsgKey }> = [
  { key: 'ArrowLeft', icon: <IconChevronLeft size={14} />, move: 'nudge.left', resize: 'nudge.narrower' },
  { key: 'ArrowUp', icon: <IconChevronUp size={14} />, move: 'nudge.up', resize: 'nudge.shorter' },
  { key: 'ArrowDown', icon: <IconChevronDown size={14} />, move: 'nudge.down', resize: 'nudge.taller' },
  { key: 'ArrowRight', icon: <IconChevronRight size={14} />, move: 'nudge.right', resize: 'nudge.wider' },
]

interface Props {
  snapshot: Snapshot
  node: LayoutNode
  override: Override | undefined
  /** Which nudge row is on (arrows step the layer); dragging in the frame works either way. */
  nudge: NudgeKind | null
  /** The nudge row was closed by key while focus was in it: focus goes back to its row. */
  nudgeExit: { kind: NudgeKind; nonce: number } | null
  /** Null when live tweaks can be sent; otherwise why not (Android without the server). */
  tweakBlocked: string | null
  /** Null when the target has a channel for visibility; otherwise why it does not. */
  hideBlocked: string | null
  /** The element has a request in work or in the queue. */
  waiting: boolean
  threadSize: number
  detailsOpen: boolean
  /** Bumped to move focus into the palette: 'first' row or into the 'chat' field. */
  focusRequest: { row: 'first' | 'chat'; nonce: number } | null
  /** What is typed in the palette's field for this element (kept by the window across chat and back). */
  draft: string
  /** Null when a message can go out now; otherwise why not (offline, agent busy). */
  sendBlocked: string | null
  /** The server is gone: the reason shows under the field without waiting for a send. */
  offline: boolean
  onDraftChange: (text: string) => void
  /** Sends the field's text and opens the element's chat to follow the answer. */
  onSend: (text: string) => void
  /** Escape in the field with text in it: focus goes back to the frame, the draft stays. */
  onLeaveField: () => void
  onSelect: (id: NodeId) => void
  onOpenChat: () => void
  onDeselect: () => void
  onToggleNudge: (kind: NudgeKind) => void
  onNudge: (key: ArrowKey, shift: boolean) => void
  onToggleHidden: () => void
  onClearOverride: () => void
  onStopWaiting: () => void
  onToggleDetails: () => void
}

type CopyState = { kind: 'idle' } | { kind: 'ok' } | { kind: 'fail'; reason: string }

export function ActionPalette(props: Props) {
  const { snapshot, node, override: ov } = props
  const { t, quotes } = useT()
  const chain = ancestorsOf(snapshot, node.id)
  const [copy, setCopy] = useState<CopyState>({ kind: 'idle' })
  const [allCrumbs, setAllCrumbs] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)
  const moveRowRef = useRef<HTMLButtonElement | null>(null)
  const resizeRowRef = useRef<HTMLButtonElement | null>(null)
  const nudgeRef = useRef<HTMLDivElement | null>(null)
  const anchor = bestAnchor(node.anchors)
  const unit = snapshot.unit === 'dp' ? 'dp' : 'px'

  // A row turned on: focus goes to its first arrow, so the keyboard path starts right there.
  useEffect(() => {
    if (props.nudge) nudgeRef.current?.querySelector<HTMLElement>('button')?.focus()
  }, [props.nudge])

  useEffect(() => {
    if (!props.nudgeExit) return
    ;(props.nudgeExit.kind === 'move' ? moveRowRef : resizeRowRef).current?.focus()
  }, [props.nudgeExit])

  // A new node starts clean: no "copied", short breadcrumb.
  useEffect(() => {
    setCopy({ kind: 'idle' })
    setAllCrumbs(false)
    return () => window.clearTimeout(copyTimer.current)
  }, [node.id])

  useEffect(() => {
    if (!props.focusRequest) return
    if (props.focusRequest.row === 'chat') {
      const field = fieldRef.current
      field?.focus()
      // Back to a draft: the caret goes after it, ready to go on typing.
      field?.setSelectionRange(field.value.length, field.value.length)
    }
    else rootRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
  }, [props.focusRequest])

  const copyAnchor = async () => {
    window.clearTimeout(copyTimer.current)
    try {
      if (!navigator.clipboard) throw new Error(t('copy.noClipboard'))
      await navigator.clipboard.writeText(anchor)
      setCopy({ kind: 'ok' })
    } catch (err) {
      setCopy({ kind: 'fail', reason: err instanceof Error ? err.message : String(err) })
    }
    copyTimer.current = window.setTimeout(() => setCopy({ kind: 'idle' }), 1800)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // With a nudge row on, arrows step the layer (the window's key handler), not the focus.
    if (props.nudge) return
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    // In the field these keys move the caret.
    if (e.target instanceof HTMLTextAreaElement) return
    const items = [...(rootRef.current?.querySelectorAll<HTMLElement>('.palette__rows [role^="menuitem"]') ?? [])]
    if (!items.length) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const label = t('palette.label', { name: `${node.kind} ${node.label}` })
  const hidden = Boolean(ov?.hidden)
  const crumbs = allCrumbs || chain.length <= CRUMBS_SHOWN ? chain : chain.slice(-CRUMBS_SHOWN)
  const withClass = allCrumbs || crumbs.reduce((n, a) => n + crumbName(a, true).length, 0) <= CRUMB_CHARS
  const moveReason = props.tweakBlocked

  const nudgeRow = (kind: NudgeKind) =>
    props.nudge === kind && (
      <div ref={nudgeRef} className="nudge" role="group" aria-label={t('nudge.group')} title={t('nudge.title', { unit })}>
        {NUDGE_BUTTONS.map((b) => (
          <button
            key={b.key}
            type="button"
            className="icon-btn nudge__btn"
            aria-label={t(kind === 'move' ? b.move : b.resize, { unit })}
            onClick={(e) => props.onNudge(b.key, e.shiftKey)}
          >
            {b.icon}
          </button>
        ))}
        <span className="nudge__shift">{t('nudge.shift')}</span>
      </div>
    )

  return (
    <div
      ref={rootRef}
      className={`palette${props.detailsOpen ? ' palette--wide' : ''}`}
      // A card with a text field and a menu of rows: the field cannot live inside role=menu.
      role="dialog"
      aria-modal="false"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="icon-btn palette__close"
        aria-label={t('palette.deselect')}
        title={t('palette.deselect')}
        onClick={props.onDeselect}
      >
        <IconX size={14} />
      </button>
      <div className="palette__body" key={node.id}>
        {chain.length > 0 && (
          <nav className={`crumbs${allCrumbs ? ' crumbs--all' : ''}`} aria-label={t('palette.parents')}>
            {!allCrumbs && chain.length > CRUMBS_SHOWN && (
              <>
                <button type="button" className="crumb" aria-label={t('palette.allParents')} title={t('palette.allParents')} onClick={() => setAllCrumbs(true)}>
                  …
                </button>
                <span className="crumbs__sep" aria-hidden="true">›</span>
              </>
            )}
            {crumbs.map((a) => (
              <span key={a.id} className="crumbs__item">
                <button type="button" className="crumb" onClick={() => props.onSelect(a.id)} title={`${a.kind} ${a.label}\n${a.anchors.path}`}>
                  {crumbName(a, withClass)}
                </button>
                <span className="crumbs__sep" aria-hidden="true">›</span>
              </span>
            ))}
          </nav>
        )}

        <div className="palette__head">
          <div className="palette__title">
            <b>{node.kind}</b> <span>{displayLabel(node.kind, node.label, quotes)}</span>
          </div>
          <div className="palette__anchor" title={anchor}>
            {ov && <span className="live-dot" title={t('palette.liveEdit')} />}
            <span className="mono">{anchor}</span>
          </div>
        </div>

        <PaletteComposer
          fieldRef={fieldRef}
          draft={props.draft}
          blocked={props.sendBlocked}
          offline={props.offline}
          threadSize={props.threadSize}
          onDraftChange={props.onDraftChange}
          onSend={props.onSend}
          onOpenChat={props.onOpenChat}
          onLeave={props.onLeaveField}
        />

        <div className="palette__rows" role="menu" aria-label={label}>
          <div className="pgroup">
            <Row
              ref={moveRowRef}
              icon={<IconMove />}
              checked={props.nudge === 'move'}
              disabled={moveReason !== null}
              title={moveReason ?? t('palette.moveHint')}
              onClick={() => props.onToggleNudge('move')}
            >
              {t('palette.move')}
            </Row>
            {nudgeRow('move')}
            <Row
              ref={resizeRowRef}
              icon={<IconResize />}
              checked={props.nudge === 'resize'}
              disabled={moveReason !== null}
              title={moveReason ?? t('palette.resizeHint')}
              onClick={() => props.onToggleNudge('resize')}
            >
              {t('palette.resize')}
            </Row>
            {nudgeRow('resize')}
            <Row
              icon={hidden ? <IconEye /> : <IconEyeOff />}
              disabled={props.hideBlocked !== null}
              title={props.hideBlocked ?? (hidden ? t('palette.showHint') : t('palette.hideHint'))}
              onClick={props.onToggleHidden}
            >
              {hidden ? t('palette.show') : t('palette.hide')}
            </Row>
            {ov && (
              <Row icon={<IconUndo />} onClick={props.onClearOverride} title={t('palette.resetHint')} disabled={props.tweakBlocked !== null}>
                {t('palette.reset')}
              </Row>
            )}
            {props.waiting && (
              <Row icon={<IconCircleX />} onClick={props.onStopWaiting} title={t('palette.stopWaitingHint')}>
                {t('palette.stopWaiting')}
              </Row>
            )}
          </div>
          <div className="pgroup">
            <Row
              icon={copy.kind === 'ok' ? <IconCheck /> : <IconCopy />}
              tone={copy.kind === 'fail' ? 'warn' : copy.kind === 'ok' ? 'ok' : undefined}
              title={copy.kind === 'fail' ? copy.reason : anchor}
              onClick={copyAnchor}
            >
              <span aria-live="polite">
                {copy.kind === 'ok' ? t('palette.copied') : copy.kind === 'fail' ? t('palette.copyFailed') : t('palette.copyAnchor')}
              </span>
            </Row>
            <Row
              icon={<IconList />}
              expanded={props.detailsOpen}
              onClick={props.onToggleDetails}
              trail={<span className="chev"><IconChevronRight size={14} /></span>}
            >
              {t('palette.details')}
            </Row>
          </div>
        </div>

        <div className={`palette__details${props.detailsOpen ? ' is-open' : ''}`} inert={!props.detailsOpen}>
          <div className="palette__details-inner">
            {props.detailsOpen && <NodeDetails snapshot={snapshot} node={node} override={ov} onSelect={props.onSelect} />}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * `div.card` reads better than a bare `div`; Compose names are already specific.
 * The class is dropped when it would push three crumbs past the card width.
 */
function crumbName(n: LayoutNode, withClass: boolean): string {
  const cls = n.anchors.className?.split(/\s+/)[0]
  return withClass && cls && /^[a-z]/.test(n.kind) ? `${n.kind}.${cls}` : n.kind
}

/** Rough room for crumb text in a 240px card: three short names, not three long ones. */
const CRUMB_CHARS = 26

/** Four lines, then the field scrolls: the palette is a quick note, the chat is for long ones. */
const MAX_FIELD = 80

/**
 * The element's chat field, always open in the palette: Enter sends and opens the chat to
 * follow the answer. Not focused on selection — focus stays on the frame, whose keys walk
 * the tree; a click or C puts the caret here.
 */
function PaletteComposer(props: {
  fieldRef: React.RefObject<HTMLTextAreaElement | null>
  draft: string
  blocked: string | null
  offline: boolean
  threadSize: number
  onDraftChange: (text: string) => void
  onSend: (text: string) => void
  onOpenChat: () => void
  onLeave: () => void
}) {
  const { t } = useT()
  const [hint, setHint] = useState<string | null>(null)
  const hintTimer = useRef<number | undefined>(undefined)
  const { fieldRef, draft, blocked } = props

  useEffect(() => () => window.clearTimeout(hintTimer.current), [])

  useLayoutEffect(() => {
    const el = fieldRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD)}px`
  }, [draft, fieldRef])

  const flash = (message: string) => {
    window.clearTimeout(hintTimer.current)
    setHint(message)
    hintTimer.current = window.setTimeout(() => setHint(null), 2000)
  }

  const send = () => {
    const text = draft.trim()
    if (blocked) return flash(blocked)
    if (!text) {
      fieldRef.current?.focus()
      return flash(t('chat.describeFirst'))
    }
    props.onSend(text)
  }

  const count = props.threadSize
  return (
    <div className="palette__compose">
      <div className="composer composer--inline">
        <textarea
          ref={fieldRef}
          rows={1}
          value={draft}
          placeholder={t('chat.placeholder')}
          aria-label={t('chat.inputLabel')}
          aria-keyshortcuts="C"
          onChange={(e) => props.onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            } else if (e.key === 'Escape' && draft.trim()) {
              // With text typed, the first Escape only leaves the field and keeps the draft;
              // the next one walks the window's Escape order from the frame. An empty field
              // lets Escape through at once (chat → details → nudge → selection as before).
              e.preventDefault()
              e.stopPropagation()
              props.onLeave()
            }
          }}
        />
        <div className="composer__bar">
          <button
            type="button"
            className="pchat"
            title={t('palette.chatHint')}
            aria-label={count > 0 ? `${t('palette.chat')}, ${t('palette.edits', { count })}` : t('palette.chat')}
            onClick={props.onOpenChat}
          >
            <IconChat size={14} />
            <span>{t('palette.chat')}</span>
            {count > 0 && (
              <span className="count" aria-hidden="true">
                {count}
              </span>
            )}
          </button>
          <span className="pcompose__keys" aria-hidden="true">
            <kbd className="pcompose__idle" title={t('palette.focusField')}>
              C
            </kbd>
            <kbd className="pcompose__live" title={t('chat.send')}>
              Enter
            </kbd>
          </span>
          <button
            type="button"
            className="send"
            aria-label={t('chat.send')}
            title={blocked ?? (draft.trim() ? t('chat.send') : t('chat.describeFirst'))}
            // aria-disabled, not disabled: a press still says why nothing went out.
            aria-disabled={Boolean(blocked) || !draft.trim() || undefined}
            onClick={send}
          >
            <IconArrowUp size={15} />
          </button>
        </div>
      </div>
      {/* Offline is said up front, as in the chat; a busy agent only when a send hits it. */}
      {(hint || (props.offline && blocked)) && (
        <div className="composer__hint" aria-live="polite">
          {hint ?? blocked}
        </div>
      )}
    </div>
  )
}

function Row({
  icon,
  children,
  onClick,
  checked,
  expanded,
  disabled,
  title,
  trail,
  tone,
  ref,
}: {
  icon: ReactNode
  children: ReactNode
  onClick: () => void
  checked?: boolean
  expanded?: boolean
  disabled?: boolean
  title?: string
  trail?: ReactNode
  tone?: 'ok' | 'warn'
  ref?: React.Ref<HTMLButtonElement>
}) {
  return (
    <button
      ref={ref}
      type="button"
      role={checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={checked}
      aria-expanded={expanded}
      // aria-disabled keeps the row focusable, so its title still explains why.
      aria-disabled={disabled || undefined}
      className={`prow${checked ? ' prow--on' : ''}${tone ? ` prow--${tone}` : ''}`}
      title={title}
      onClick={() => {
        if (!disabled) onClick()
      }}
    >
      <span className="prow__icon">{icon}</span>
      <span className="prow__text">{children}</span>
      {trail && <span className="prow__trail">{trail}</span>}
    </button>
  )
}
