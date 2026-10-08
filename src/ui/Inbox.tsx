import { useEffect, useState } from 'react'
import type { EditRequest } from '../shared/protocol.ts'
import { IconCheck, IconCircleX, IconInbox, IconPlug, Spinner } from './icons.tsx'
import { formatAgo, useT, type MsgKey } from './i18n.ts'
import { displayLabel, isOpen, type RequestStatus } from './thread.ts'

export interface InboxItem {
  request: EditRequest
  status: RequestStatus
  /** Why the agent closed it as failed (its own words, or the window's fallback). */
  error: string | null
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
  /** An agent is listening: queued requests are about to go out, not stuck. */
  listening: boolean
  onOpen: (request: EditRequest) => void
  /** Opens the header's "how to connect an agent" popover. */
  onConnect: () => void
}

const DONE_SHOWN = 5

export function Inbox({ items, loose, listening, onOpen, onConnect }: Props) {
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
  const anyWaiting = !listening && items.some((i) => i.status === 'queued')
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

      {anyWaiting && (
        <div className="inbox__agent">
          <IconPlug size={14} />
          <span className="inbox__agent-text">{t('inbox.noAgent')}</span>
          <button type="button" className="link-btn" onClick={onConnect}>
            {t('agent.connect')}
          </button>
        </div>
      )}

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
              <Card key={i.request.id} item={i} now={now} listening={listening} onOpen={onOpen} />
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
              <Card key={i.request.id} item={i} now={now} listening={listening} onOpen={onOpen} />
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

function Card({ item, now, listening, onOpen }: { item: InboxItem; now: number; listening: boolean; onOpen: (r: EditRequest) => void }) {
  const { t, locale, quotes } = useT()
  const { request: r, status } = item
  const working = status === 'work'
  return (
    <button type="button" className={`rcard${working ? ' rcard--work' : ''}`} onClick={() => onOpen(r)}>
      <span className="rcard__top">
        <span className="rcard__el">
          {item.unread && <span className="rcard__unread" aria-label={t('inbox.newReply')} />}
          <b>{r.node.kind}</b> <span>{displayLabel(r.node.kind, r.node.label, quotes)}</span>
        </span>
        <StatusTag status={status} listening={listening} />
      </span>
      <span className="rcard__comment">{r.comment}</span>
      {status === 'error' && <span className="rcard__error">{item.error || t('chat.failed')}</span>}
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

/**
 * `listening` only changes how a queued request reads: with nobody listening it is not "in
 * a queue that moves" but waiting for an agent to connect. Still not an error.
 */
export function StatusTag({ status, listening = true }: { status: RequestStatus; listening?: boolean }) {
  const { t: tr } = useT()
  const t = TAGS[status]
  const waiting = status === 'queued' && !listening
  return (
    <span className={`tag ${t.cls}`}>
      {status === 'work' && <Spinner />}
      {status === 'queued' && <IconInbox size={12} />}
      {status === 'done' && <IconCheck size={12} />}
      {status === 'error' && <IconCircleX size={12} />}
      {tr(waiting ? 'tag.waiting' : t.text)}
    </span>
  )
}
