import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { LOCALE_NAMES, LOCALES, useT, type Translate } from './i18n.ts'
import { Popover } from './Popover.tsx'
import { BrandGlyph, IconGlobe, IconInbox, IconSmartphone } from './icons.tsx'

export interface StatusInfo {
  tone: 'danger' | 'warn' | 'busy'
  text: string
  /** Full text for the accessible name when `text` is shortened. */
  title?: string
  /** Popover body; without it a click runs `onClick`. */
  popover?: ReactNode
  onClick?: () => void
}

export interface PickInfo {
  /** Alt reached the window: the hint lights up (it doubles as proof the key got here). */
  alt: boolean
  /** Null when picking works; otherwise why not (nothing to inspect yet): the hint dims. */
  blocked: string | null
  /** The user has learned the gesture: the hint folds to its key cap. */
  compact: boolean
  /** The key cap says ⌥ Option. */
  mac: boolean
}

interface Props {
  pick: PickInfo
  /** The first-run hint under the pick group, once per browser (web only). */
  coach: { onClose: () => void } | null
  /** `t` with `{alt}` filled for this platform. */
  t: Translate
  target: 'web' | 'android'
  urlDraft: string
  onUrlDraft: (v: string) => void
  onOpenUrl: () => void
  device: { name: string; serial: string | null } | null
  inbox: { open: number; working: boolean; unread: boolean }
  inboxOpen: boolean
  onInboxToggle: (open: boolean) => void
  inboxContent: ReactNode
  /** Null while the server is out of reach: nobody can tell whether an agent listens. */
  agent: { listening: boolean } | null
  agentOpen: boolean
  onAgentToggle: (open: boolean) => void
  agentContent: ReactNode
  status: StatusInfo | null
  statusOpen: boolean
  onStatusToggle: (open: boolean) => void
  meta: string | null
  loading: boolean
}

export function Header(p: Props) {
  const { t } = p
  const inboxRef = useRef<HTMLButtonElement | null>(null)
  const statusRef = useRef<HTMLButtonElement | null>(null)
  const agentRef = useRef<HTMLButtonElement | null>(null)
  const web = p.target === 'web'
  const agentText = p.agent?.listening ? t('agent.listening') : t('agent.none')

  return (
    <header className="tb">
      <div className="tb__brand" aria-label="layout-debug">
        <BrandGlyph />
        <span className="tb__brand-text">layout-debug</span>
      </div>
      <span className={`tb__sep${web ? '' : ' tb__sep--pick'}`} aria-hidden="true" />

      <PickGroup pick={p.pick} web={web} t={t} coach={p.coach} />
      <span className="tb__sep" aria-hidden="true" />

      {p.target === 'web' ? (
        <form
          className="url"
          onSubmit={(e) => {
            e.preventDefault()
            p.onOpenUrl()
          }}
        >
          <label className="field">
            <IconGlobe size={14} />
            <input
              value={p.urlDraft}
              onChange={(e) => p.onUrlDraft(e.target.value)}
              placeholder="http://localhost:3000"
              aria-label={t('url.label')}
              spellCheck={false}
            />
          </label>
          <button type="submit" className="btn">
            {t('url.open')}
          </button>
        </form>
      ) : (
        <div className={`device-chip${p.device ? '' : ' device-chip--none'}`}>
          <IconSmartphone size={15} />
          {p.device ? (
            <>
              <b>{p.device.name}</b>
              {p.device.serial && <span className="device-chip__serial">{p.device.serial}</span>}
            </>
          ) : (
            <span>{t('device.none')}</span>
          )}
        </div>
      )}

      <span className="tb__spacer" />

      {p.agent && (
        <div className="tb__anchor">
          <button
            ref={agentRef}
            type="button"
            className={`agent${p.agent.listening ? ' agent--on' : ''}${p.agentOpen ? ' is-open' : ''}`}
            aria-expanded={p.agentOpen}
            aria-haspopup="dialog"
            onClick={() => p.onAgentToggle(!p.agentOpen)}
          >
            <span className="agent__dot" aria-hidden="true" />
            {/* Announced on change: the indicator is the only place that says it. */}
            <span aria-live="polite">{agentText}</span>
          </button>
          {p.agentOpen && (
            <Popover anchorRef={agentRef} onClose={() => p.onAgentToggle(false)} label={agentText} className="pop--agent">
              {p.agentContent}
            </Popover>
          )}
        </div>
      )}

      <div className="tb__anchor">
        <button
          ref={inboxRef}
          type="button"
          className={`icon-btn icon-btn--32 inbox-btn${p.inboxOpen ? ' is-open' : ''}`}
          aria-label={`${t('inbox.title')}${p.inbox.open ? `: ${t('inbox.openCount', { count: p.inbox.open })}` : ''}${p.inbox.unread ? `, ${t('inbox.newReplies')}` : ''}`}
          aria-expanded={p.inboxOpen}
          title={t('inbox.title')}
          onClick={() => p.onInboxToggle(!p.inboxOpen)}
        >
          <IconInbox />
          {p.inbox.open > 0 && (
            <span className={`badge${p.inbox.working ? ' badge--work' : ''}`} aria-hidden="true">
              {p.inbox.open}
            </span>
          )}
          {p.inbox.unread && p.inbox.open === 0 && <span className="inbox-btn__dot" aria-hidden="true" />}
          {p.inbox.unread && p.inbox.open > 0 && <span className="inbox-btn__dot inbox-btn__dot--with-badge" aria-hidden="true" />}
        </button>
        {p.inboxOpen && (
          <Popover anchorRef={inboxRef} onClose={() => p.onInboxToggle(false)} label={t('inbox.requests')} className="pop--inbox">
            {p.inboxContent}
          </Popover>
        )}
      </div>

      <div className="tb__anchor" aria-live="polite">
        {p.status && (
          <button
            ref={statusRef}
            type="button"
            className={`status status--${p.status.tone}`}
            title={p.status.title ?? p.status.text}
            aria-expanded={p.status.popover ? p.statusOpen : undefined}
            onClick={() => {
              if (p.status?.popover) p.onStatusToggle(!p.statusOpen)
              else p.status?.onClick?.()
            }}
          >
            {p.status.tone !== 'busy' && <span className="status__dot" aria-hidden="true" />}
            {p.status.text}
          </button>
        )}
        {p.status?.popover && p.statusOpen && (
          <Popover anchorRef={statusRef} onClose={() => p.onStatusToggle(false)} label={p.status.text}>
            {p.status.popover}
          </Popover>
        )}
      </div>

      {p.meta && <span className="tb__meta">{p.meta}</span>}
      <LanguageSwitch />
      {p.loading && <span className="tb__progress" aria-hidden="true" />}
    </header>
  )
}

/**
 * The always-on hint "Alt · hover to inspect · click to select" (DESIGN_SPEC §6). Below
 * 1200 px (or once the gesture is learned) it folds to the key cap; the full text stays in
 * the tooltip. Android: no cap — a plain click selects there. Not a control: picking is the
 * Alt gesture itself, so the hint only describes it (the canvas label says it to screen
 * readers too).
 */
function PickGroup({ pick, web, t, coach }: { pick: PickInfo; web: boolean; t: Translate; coach: Props['coach'] }) {
  const blocked = Boolean(pick.blocked)
  // Android has no cap to fold to: compact there would leave an empty frame.
  const cls = `pick${pick.compact && web ? ' pick--compact' : ''}${web ? '' : ' pick--android'}${blocked ? ' is-blocked' : ''}${pick.alt ? ' is-alt' : ''}`
  const description = web ? t('pick.kapTitle') : t('pick.kapTitleAndroid')

  return (
    <div className="pick-anchor">
      <div className={cls} title={pick.blocked ?? (web ? undefined : description)}>
        <span className="tipwrap pick__wrap">
          <span className="pick__hint">
            {web && (
              <kbd className="pick__kap" aria-hidden="true">
                <span>
                  <span className="pick__kap-full">{pick.mac ? '⌥ Option' : 'Alt'}</span>
                  <span className="pick__kap-short">{pick.mac ? '⌥' : 'Alt'}</span>
                </span>
              </kbd>
            )}
            <span className="pick__stack">{t('pick.hint')}</span>
          </span>
          {web && (
            <span className="tip pick__tip" role="tooltip">
              {description}
            </span>
          )}
        </span>
      </div>
      {coach && web && <Coach t={t} onClose={coach.onClose} />}
    </div>
  )
}

/** First-run hint: the page is live now, clicks no longer select. Shown once per browser. */
function Coach({ t, onClose }: { t: Translate; onClose: () => void }) {
  const titleId = useId()
  return (
    <div className="coach" role="dialog" aria-modal="false" aria-labelledby={titleId}>
      <h2 className="coach__title" id={titleId}>
        {t('coach.title')}
      </h2>
      <p className="coach__text">{t('coach.text')}</p>
      <button type="button" className="btn coach__ok" onClick={onClose}>
        {t('coach.ok')}
      </button>
    </div>
  )
}

/** Two-option segment. Each option is named in its own language, so it reads the same either way. */
function LanguageSwitch() {
  const { t, locale, setLocale } = useT()
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  // Radio group: one Tab stop, arrows move the choice and the focus together.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (LOCALES.indexOf(locale) + step + LOCALES.length) % LOCALES.length
    setLocale(LOCALES[next]!)
    refs.current[next]?.focus()
  }

  return (
    <div className="seg seg--lang" role="radiogroup" aria-label={t('lang.label')} onKeyDown={onKey}>
      {LOCALES.map((l, i) => (
        <button
          key={l}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          lang={l}
          aria-checked={locale === l}
          aria-label={LOCALE_NAMES[l]}
          title={LOCALE_NAMES[l]}
          tabIndex={locale === l ? 0 : -1}
          className="seg__btn"
          onClick={() => setLocale(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
