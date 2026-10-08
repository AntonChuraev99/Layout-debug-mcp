import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage, EditRequest } from '../shared/protocol.ts'
import { useT } from './i18n.ts'
import { describeOverride } from './NodeDetails.tsx'
import { BrandGlyph, IconArrowUp, IconChevronLeft, IconCircleX, IconInbox, IconPlug, IconRefresh, IconX } from './icons.tsx'
import { REFRESH_NOTE_PREFIX } from './refresh.ts'
import { displayLabel, ERROR_LINE_PREFIX, shortenPaths } from './thread.ts'

/** A message typed here that the server has not echoed back yet. */
export interface LocalMessage {
  key: string
  text: string
  failed?: string
}

interface Props {
  kind: string
  label: string
  anchor: string
  /** The thread was opened from the inbox and the element is not on the page now. */
  missing: boolean
  messages: ChatMessage[]
  local: LocalMessage[]
  requestsById: ReadonlyMap<string, EditRequest>
  projectDir: string | null
  /** An agent is listening over MCP; without one, messages wait in the Inbox. */
  listening: boolean
  /** Requests of this thread still waiting for an agent to take them. */
  queuedIds: ReadonlySet<string>
  online: boolean
  /** The agent is on one of this element's requests and has not started replying. */
  working: boolean
  /** Live tweak that will travel with the next message, already worded. */
  attach: string | null
  onSend: (text: string) => void
  /** Opens the header's "how to connect an agent" popover. */
  onConnect: () => void
  onBack: () => void
  onClose: () => void
}

const MAX_TEXTAREA = 120

export function ChatPopover(props: Props) {
  const { t, rich, quotes } = useT()
  const [text, setText] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const hintTimer = useRef<number | undefined>(undefined)
  const logRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    areaRef.current?.focus()
    return () => window.clearTimeout(hintTimer.current)
  }, [])

  // Follow the conversation unless the user scrolled up to read.
  useLayoutEffect(() => {
    const log = logRef.current
    if (log && stickRef.current) log.scrollTop = log.scrollHeight
  }, [props.messages, props.local, props.working])

  // 1–6 lines, then scroll.
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA)}px`
  }, [text])

  const blocked = !props.online
    ? t('chat.offline')
    : props.missing
      ? t('chat.missingBlocked')
      : null

  const flash = (message: string) => {
    window.clearTimeout(hintTimer.current)
    setHint(message)
    hintTimer.current = window.setTimeout(() => setHint(null), 2000)
  }

  const send = () => {
    const comment = text.trim()
    if (blocked) return flash(blocked)
    if (!comment) return flash(t('chat.describeFirst'))
    props.onSend(comment)
    setText('')
    stickRef.current = true
  }

  const empty = props.messages.length === 0 && props.local.length === 0 && !props.working

  return (
    <div className="chat" role="dialog" aria-modal="false" aria-label={t('chat.label', { name: `${props.kind} ${props.label}` })}>
      <div className="chat__head">
        <button type="button" className="icon-btn" aria-label={t('chat.back')} title={t('chat.back')} onClick={props.onBack}>
          <IconChevronLeft size={16} />
        </button>
        <div className="chat__title">
          <div className="chat__name">
            <b>{props.kind}</b> <span>{displayLabel(props.kind, props.label, quotes)}</span>
          </div>
          <div className="chat__anchor mono" title={props.anchor}>
            {props.anchor}
          </div>
        </div>
        <button type="button" className="icon-btn" aria-label={t('common.close')} title={t('common.close')} onClick={props.onClose}>
          <IconX size={16} />
        </button>
      </div>

      {props.missing && (
        <div className="notice notice--muted">
          <IconInbox size={15} />
          {t('chat.missing')}
        </div>
      )}
      {props.online && !props.listening && !props.missing && (
        // Not a warning: sending still works, the message just waits for an agent.
        <div className="notice notice--muted notice--agent">
          <IconPlug size={15} />
          <span className="notice__text">{t('chat.noAgent')}</span>
          <button type="button" className="link-btn" onClick={props.onConnect}>
            {t('agent.connect')}
          </button>
        </div>
      )}

      <div
        ref={logRef}
        className="chat__log"
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {empty && (
          <div className="chat__empty">
            <div className="chat__empty-title">{t('chat.emptyTitle')}</div>
            <div className="chat__empty-sub">{t('chat.emptySub')}</div>
          </div>
        )}
        {props.messages.map((m) => (
          <Message key={m.id} m={m} request={props.requestsById.get(m.id)} projectDir={props.projectDir} queuedIds={props.queuedIds} />
        ))}
        {props.local.map((m) => (
          <div key={m.key} className={`msg msg--user${m.failed ? '' : ' msg--sending'}`}>
            <div className="msg__bubble">{m.text}</div>
            {m.failed && <div className="msg__meta msg__meta--danger">{t('chat.notSent', { reason: m.failed })}</div>}
          </div>
        ))}
        {props.working && (
          <div className="msg msg--agent">
            <span className="avatar">
              <BrandGlyph size={13} />
            </span>
            <span className="shimmer-text">{t('chat.working')}</span>
          </div>
        )}
      </div>

      <div className="chat__compose">
        {props.attach && (
          <div className="attach">
            <span className="attach__pill">↔ {props.attach}</span>
            <span className="attach__note">{t('chat.attachNote')}</span>
          </div>
        )}
        <div className="composer">
          <textarea
            ref={areaRef}
            rows={1}
            value={text}
            placeholder={t('chat.placeholder')}
            aria-label={t('chat.inputLabel')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="composer__bar">
            <span className="composer__keys">
              {rich('chat.keys', { enter: <kbd>Enter</kbd>, shiftEnter: <kbd>Shift Enter</kbd> })}
            </span>
            <button
              type="button"
              className="send"
              aria-label={t('chat.send')}
              title={blocked ?? (text.trim() ? t('chat.send') : t('chat.describeFirst'))}
              disabled={Boolean(blocked) || !text.trim()}
              onClick={send}
            >
              <IconArrowUp size={15} />
            </button>
          </div>
        </div>
        {(hint || !props.online) && (
          <div className="composer__hint" aria-live="polite">
            {hint ?? blocked}
          </div>
        )}
      </div>
    </div>
  )
}

interface MessageProps {
  m: ChatMessage
  request: EditRequest | undefined
  projectDir: string | null
  queuedIds: ReadonlySet<string>
}

function Message({ m, request, projectDir, queuedIds }: MessageProps) {
  const { t } = useT()
  if (m.role === 'user') {
    const own = request?.overrides.find((o) => o.nodeId === request.node.id) ?? request?.overrides[0]
    const tweak = own && request ? describeOverride(own, request.pxPerUnit, '', t).trim() : ''
    return (
      <div className="msg msg--user">
        <div className="msg__bubble">{m.text}</div>
        {tweak && <div className="msg__meta">{t('chat.withEdit', { tweak })}</div>}
      </div>
    )
  }
  if (m.role === 'system') {
    if (m.id.startsWith(ERROR_LINE_PREFIX)) {
      return (
        <div className="msg msg--system msg--error">
          <IconCircleX size={14} />
          <span>{m.text || t('chat.failed')}</span>
        </div>
      )
    }
    // The server's "no agent is listening" note for a request (`<id>-queued`). It says what
    // was true at send time; once an agent took the request it is history, not news.
    if (m.requestId && m.id === `${m.requestId}-queued`) {
      if (!queuedIds.has(m.requestId)) return null
      return (
        <div className="msg msg--system msg--waiting">
          <IconInbox size={14} />
          <span>{t('chat.waiting')}</span>
        </div>
      )
    }
    return (
      <div className="msg msg--system">
        {m.id.startsWith(REFRESH_NOTE_PREFIX) ? <IconRefresh size={14} /> : <IconInbox size={14} />}
        <span>{m.text}</span>
      </div>
    )
  }
  return (
    <div className={`msg msg--agent${m.pending ? ' msg--streaming' : ''}`}>
      <span className="avatar">
        <BrandGlyph size={13} />
      </span>
      <div className="msg__text">{m.text ? shortenPaths(m.text, projectDir) : m.pending ? '…' : t('chat.noReply')}</div>
    </div>
  )
}
