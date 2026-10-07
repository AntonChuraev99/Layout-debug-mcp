import { useEffect, useState } from 'react'
import type { EditRequest, ErrorCode } from '../shared/protocol.ts'
import { IconCheck, IconCircleX, IconFile, IconInbox, IconPlug, Spinner } from './icons.tsx'
import { formatAgo, useT, type MsgKey } from './i18n.ts'
import { displayLabel, isOpen, type RequestStatus } from './thread.ts'

export interface InboxItem {
  request: EditRequest
  status: RequestStatus
  /** Agent's tool lines, oldest first. */
  steps: string[]
  error: string | null
  /** Why the run failed, when the server said; `agent_auth` gets its own hint. */
  errorCode: ErrorCode | null
  unread: boolean
}

export interface LooseEntry {
  id: string
  text: string
  tone: 'error' | 'note'
  at: number | null
}

interface Props {
  items: InboxItem[]
  loose: LooseEntry[]
  onOpen: (request: EditRequest) => void
}

const DONE_SHOWN = 5
const STEPS_SHOWN = 3

export function Inbox({ items, loose, onOpen }: Props) {
  const { t, locale } = useT()
  const [filter, setFilter] = useState<'active' | 'all'>('active')
  const [allDone, setAllDone] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // "2 min" has to keep moving while the list is open.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(t)
  }, [])

  const newestFirst = [...items].sort((a, b) => b.request.createdAt - a.request.createdAt)
  // A failed run needs the person (sign in, resend), so it stays in sight next to open
  // work instead of folding into "Done". Order: in work, queued, failed.
  const rank = (s: RequestStatus) => (s === 'work' ? 2 : s === 'error' ? 0 : 1)
  const current = newestFirst.filter((i) => isOpen(i.status) || i.status === 'error').sort((a, b) => rank(b.status) - rank(a.status))
  const finished = newestFirst.filter((i) => !isOpen(i.status) && i.status !== 'error')
  const anyOpen = current.some((i) => isOpen(i.status))
  const doneShown = allDone ? finished : finished.slice(0, DONE_SHOWN)
  const nothing = items.length === 0 && loose.length === 0

  return (
    <div className="inbox">
      <div className="inbox__head">
        <h2 className="inbox__title">{t('inbox.requests')}</h2>
        <div className="seg" role="radiogroup" aria-label={t('inbox.filter')}>
          <button type="button" role="radio" aria-checked={filter === 'active'} className="seg__btn" onClick={() => setFilter('active')}>
            {t('inbox.active')}
          </button>
          <button type="button" role="radio" aria-checked={filter === 'all'} className="seg__btn" onClick={() => setFilter('all')}>
            {t('inbox.all')}
          </button>
        </div>
      </div>

      <div className="inbox__scroll">
        {nothing && (
          <div className="inbox__empty">
            <div className="inbox__empty-title">{t('inbox.emptyTitle')}</div>
            <div className="inbox__empty-sub">{t('inbox.emptySub')}</div>
          </div>
        )}

        {!nothing && (
          <section className="inbox__section" aria-label={t('inbox.now')}>
            <h3 className="inbox__label">{t('inbox.now')}</h3>
            {!anyOpen && <div className="inbox__quiet">{t('inbox.idle')}</div>}
            {current.map((i) => (
              <Card key={i.request.id} item={i} now={now} onOpen={onOpen} />
            ))}
          </section>
        )}

        {loose.length > 0 && (
          <section className="inbox__section" aria-label={t('inbox.loose')}>
            <h3 className="inbox__label">{t('inbox.loose')}</h3>
            {(filter === 'all' ? loose : loose.slice(-3)).map((e) => (
              <div key={e.id} className={`loose loose--${e.tone}`}>
                {e.tone === 'error' ? <IconCircleX size={14} /> : <IconPlug size={14} />}
                <span className="loose__text">{e.text}</span>
                {e.at && <span className="loose__time">{formatAgo(now - e.at, locale)}</span>}
              </div>
            ))}
          </section>
        )}

        {filter === 'all' && finished.length > 0 && (
          <section className="inbox__section" aria-label={t('inbox.done')}>
            <h3 className="inbox__label">{t('inbox.done')}</h3>
            {doneShown.map((i) => (
              <Card key={i.request.id} item={i} now={now} onOpen={onOpen} />
            ))}
            {!allDone && finished.length > DONE_SHOWN && (
              <button type="button" className="inbox__more" onClick={() => setAllDone(true)}>
                {t('common.more', { count: finished.length - DONE_SHOWN })}
              </button>
            )}
          </section>
        )}

        {filter === 'active' && finished.length > 0 && (
          <button type="button" className="inbox__more" onClick={() => setFilter('all')}>
            {t('inbox.showDone', { count: finished.length })}
          </button>
        )}
      </div>
    </div>
  )
}

function Card({ item, now, onOpen }: { item: InboxItem; now: number; onOpen: (r: EditRequest) => void }) {
  const { t, rich, locale, quotes } = useT()
  const { request: r, status } = item
  const steps = item.steps.slice(-STEPS_SHOWN)
  const working = status === 'work'
  return (
    <button type="button" className={`rcard${working ? ' rcard--work' : ''}`} onClick={() => onOpen(r)}>
      <span className="rcard__top">
        <span className="rcard__el">
          {item.unread && <span className="rcard__unread" aria-label={t('inbox.newReply')} />}
          <b>{r.node.kind}</b> <span>{displayLabel(r.node.kind, r.node.label, quotes)}</span>
        </span>
        <StatusTag status={status} />
      </span>
      <span className="rcard__comment">{r.comment}</span>
      {steps.length > 0 && (
        <span className="rcard__steps">
          {steps.map((s, idx) => (
            <span key={`${idx}-${s}`} className={`rcard__step${working && idx === steps.length - 1 ? ' shimmer-text' : ''}`}>
              <IconFile size={13} />
              <span className="mono">{s}</span>
            </span>
          ))}
        </span>
      )}
      {item.errorCode === 'agent_auth' ? (
        <>
          <span className="rcard__error">{t('agent.authTitle')}</span>
          <span className="rcard__hint">{rich('agent.authHint', { cmd: <code>claude login</code> })}</span>
        </>
      ) : (
        status === 'error' && <span className="rcard__error">{item.error || t('chat.failed')}</span>
      )}
      <span className="rcard__time">{formatAgo(now - r.createdAt, locale)}</span>
      {working && <span className="rcard__bar" aria-hidden="true" />}
    </button>
  )
}

const TAGS: Record<RequestStatus, { text: MsgKey; cls: string }> = {
  work: { text: 'tag.work', cls: 'tag--work' },
  queued: { text: 'tag.queued', cls: 'tag--queued' },
  done: { text: 'tag.done', cls: 'tag--ok' },
  error: { text: 'tag.error', cls: 'tag--danger' },
  dismissed: { text: 'tag.dismissed', cls: 'tag--muted' },
  stale: { text: 'tag.stale', cls: 'tag--muted' },
}

export function StatusTag({ status }: { status: RequestStatus }) {
  const { t: tr } = useT()
  const t = TAGS[status]
  return (
    <span className={`tag ${t.cls}`}>
      {status === 'work' && <Spinner />}
      {status === 'queued' && <IconInbox size={12} />}
      {status === 'done' && <IconCheck size={12} />}
      {status === 'error' && <IconCircleX size={12} />}
      {tr(t.text)}
    </span>
  )
}
