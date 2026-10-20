import { memo, useRef, useState } from 'react'
import { describeChange, editKey, exportJson, exportMarkdown, type LiveEdit } from '../shared/liveEdits.ts'
import { useT, type MsgKey } from './i18n.ts'
import { displayLabel, bestAnchor } from './thread.ts'

interface Props {
  edits: LiveEdit[]
  /** The page on screen: its edits are split into placed and not found; the rest are other pages'. */
  page: string
  /** An edit on the page: take it off (the same as Reset edits in the palette). */
  onReset: (edit: LiveEdit) => void
  /** An edit not on the page: forget it. */
  onDiscard: (edits: LiveEdit[]) => void
}

/**
 * The header's live edit list (DESIGN: the Inbox popover's vocabulary). Edits whose element
 * the last reload did not bring back come first and stay until discarded; "Copy all edits"
 * hands the whole list to any agent as Markdown or JSON.
 */
export const LiveEditsPanel = memo(function LiveEditsPanel({ edits, page, onReset, onDiscard }: Props) {
  const { t } = useT()
  const missing = edits.filter((e) => e.page === page && !e.resolved)
  const here = edits.filter((e) => e.page === page && e.resolved)
  const elsewhere = edits.filter((e) => e.page !== page)
  const copy = useCopy()

  return (
    <div className="inbox edits">
      <div className="inbox__head">
        <h2 className="inbox__title">{t('edits.title')}</h2>
      </div>

      {edits.length > 0 && (
        <div className="inbox__chat">
          <span className="inbox__chat-text">{t('edits.copyAll')}</span>
          <button type="button" className="link-btn" onClick={() => copy.run('md', exportMarkdown(edits))}>
            {t('edits.copyMarkdown')}
          </button>
          <button type="button" className="link-btn" onClick={() => copy.run('json', exportJson(edits))}>
            {t('edits.copyJson')}
          </button>
          <span className={`edits__copied${copy.state.kind === 'fail' ? ' inbox__chat-error' : ''}`} role="status">
            {copy.state.kind === 'ok'
              ? t(copy.state.format === 'md' ? 'edits.copiedMarkdown' : 'edits.copiedJson')
              : copy.state.kind === 'fail'
                ? t('copy.failed', { reason: copy.state.reason })
                : ''}
          </span>
        </div>
      )}

      <div className="inbox__scroll">
        {edits.length === 0 && (
          <div className="inbox__empty">
            <div className="inbox__empty-title">{t('edits.emptyTitle')}</div>
            <div className="inbox__empty-sub">{t('edits.emptySub')}</div>
          </div>
        )}

        {missing.length > 0 && (
          <Section label={t('edits.missing')} note={t('edits.missingNote')}>
            {missing.map((e) => (
              <Row key={editKey(e)} edit={e} action="edits.discard" onAction={() => onDiscard([e])} warn />
            ))}
            {missing.length > 1 && (
              <button type="button" className="inbox__more" onClick={() => onDiscard(missing)}>
                {t('edits.discardMissing', { count: missing.length })}
              </button>
            )}
          </Section>
        )}

        {here.length > 0 && (
          <Section label={t('edits.here')}>
            {here.map((e) => (
              <Row key={editKey(e)} edit={e} action="edits.reset" onAction={() => onReset(e)} />
            ))}
          </Section>
        )}

        {elsewhere.length > 0 && (
          <Section label={t('edits.elsewhere')}>
            {elsewhere.map((e) => (
              <Row key={editKey(e)} edit={e} action="edits.discard" onAction={() => onDiscard([e])} page />
            ))}
          </Section>
        )}
      </div>
    </div>
  )
})

function Section({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="inbox__section" aria-label={label}>
      <h3 className="inbox__label">{label}</h3>
      {note && <div className="inbox__quiet">{note}</div>}
      {children}
    </section>
  )
}

function Row({ edit, action, onAction, warn = false, page = false }: { edit: LiveEdit; action: MsgKey; onAction: () => void; warn?: boolean; page?: boolean }) {
  const { t, quotes } = useT()
  const label = displayLabel(edit.kind, edit.label, quotes)
  const name = `${edit.kind}${label ? ` ${label}` : ''}`
  return (
    <div className={`edit-row${warn ? ' edit-row--missing' : ''}`}>
      <div className="edit-row__main">
        <span className="rcard__el">
          <b>{edit.kind}</b> <span>{label}</span>
        </span>
        <span className="edit-row__change">{describeChange(edit)}</span>
        <span className="edit-row__anchor mono" title={bestAnchor(edit.anchors)}>
          {page ? edit.page : bestAnchor(edit.anchors)}
        </span>
      </div>
      <button type="button" className="link-btn" aria-label={`${t(action)}: ${name}`} onClick={onAction}>
        {t(action)}
      </button>
    </div>
  )
}

type CopyState = { kind: 'idle' } | { kind: 'ok'; format: 'md' | 'json' } | { kind: 'fail'; reason: string }

/** Writes to the clipboard and says so next to the buttons for a moment; a failure says why. */
function useCopy() {
  const { t } = useT()
  const [state, setState] = useState<CopyState>({ kind: 'idle' })
  const timer = useRef<number | undefined>(undefined)
  const run = async (format: 'md' | 'json', text: string) => {
    window.clearTimeout(timer.current)
    try {
      if (!navigator.clipboard) throw new Error(t('copy.noClipboard'))
      await navigator.clipboard.writeText(text)
      setState({ kind: 'ok', format })
    } catch (err) {
      setState({ kind: 'fail', reason: err instanceof Error ? err.message : String(err) })
    }
    timer.current = window.setTimeout(() => setState({ kind: 'idle' }), 2400)
  }
  return { state, run }
}
