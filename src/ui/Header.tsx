import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import type { Tool } from './Overlay.tsx'
import { LOCALE_NAMES, LOCALES, useT, type MsgKey } from './i18n.ts'
import { Popover } from './Popover.tsx'
import { BrandGlyph, IconGlobe, IconHand, IconInbox, IconMove, IconPointer, IconSmartphone } from './icons.tsx'

export interface StatusInfo {
  tone: 'danger' | 'warn' | 'busy'
  text: string
  /** Full text for the accessible name when `text` is shortened. */
  title?: string
  /** Popover body; without it a click runs `onClick`. */
  popover?: ReactNode
  onClick?: () => void
}

interface Props {
  tool: Tool
  onTool: (tool: Tool) => void
  /** Null when tools work; otherwise why none do (nothing to inspect yet). */
  toolsBlocked: string | null
  /** Why the move tool specifically is off (Android without the server). */
  moveBlocked: string | null
  target: 'web' | 'android'
  urlDraft: string
  onUrlDraft: (v: string) => void
  onOpenUrl: () => void
  device: { name: string; serial: string | null } | null
  inbox: { open: number; working: boolean; unread: boolean }
  inboxOpen: boolean
  onInboxToggle: (open: boolean) => void
  inboxContent: ReactNode
  status: StatusInfo | null
  statusOpen: boolean
  onStatusToggle: (open: boolean) => void
  meta: string | null
  loading: boolean
}

const TOOLS: Array<{ id: Tool; label: MsgKey; key: string; icon: ReactNode }> = [
  { id: 'select', label: 'tool.select', key: 'V', icon: <IconPointer /> },
  { id: 'move', label: 'tool.move', key: 'M', icon: <IconMove /> },
  { id: 'hand', label: 'tool.hand', key: 'H', icon: <IconHand /> },
]

export function Header(p: Props) {
  const { t } = useT()
  const toolRefs = useRef<Array<HTMLButtonElement | null>>([])
  const inboxRef = useRef<HTMLButtonElement | null>(null)
  const statusRef = useRef<HTMLButtonElement | null>(null)

  // Roving tabindex: the group is one Tab stop, arrows walk inside it.
  const onToolsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const at = toolRefs.current.findIndex((el) => el === document.activeElement)
    const next = (at + (e.key === 'ArrowRight' ? 1 : TOOLS.length - 1)) % TOOLS.length
    toolRefs.current[next]?.focus()
  }

  return (
    <header className="tb">
      <div className="tb__brand" aria-label="layout-debug">
        <BrandGlyph />
        <span className="tb__brand-text">layout-debug</span>
      </div>
      <span className="tb__sep" aria-hidden="true" />

      <div className="tools" role="toolbar" aria-label={t('tools.label')} onKeyDown={onToolsKey}>
        {TOOLS.map((tool, i) => {
          const blocked = p.toolsBlocked ?? (tool.id === 'move' ? p.moveBlocked : null)
          const label = t(tool.label)
          return (
            <span key={tool.id} className="tipwrap">
              <button
                ref={(el) => {
                  toolRefs.current[i] = el
                }}
                type="button"
                className="tool"
                aria-pressed={p.tool === tool.id}
                aria-label={`${label} (${tool.key})`}
                aria-disabled={blocked ? true : undefined}
                tabIndex={p.tool === tool.id ? 0 : -1}
                onClick={() => {
                  if (!blocked) p.onTool(tool.id)
                }}
              >
                {tool.icon}
              </button>
              <span className="tip" role="tooltip">
                {blocked ? blocked : label} {!blocked && <kbd>{tool.key}</kbd>}
              </span>
            </span>
          )
        })}
      </div>
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
