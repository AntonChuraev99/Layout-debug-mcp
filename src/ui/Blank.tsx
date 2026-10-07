import { useRef, useState, type ReactNode } from 'react'
import { useT } from './i18n.ts'
import { IconCheck, IconCopy } from './icons.tsx'

/** Centered explanation in the frame: what is going on and what to do next. */
export function Blank({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="blank">
      <div className="blank__inner">
        <span className="blank__icon">{icon}</span>
        <h1 className="blank__title">{title}</h1>
        {children}
      </div>
    </div>
  )
}

/** Monospace snippet with a copy button; the result is announced and shown for 1.8 s. */
export function CopyBlock({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const [reason, setReason] = useState('')
  const timer = useRef<number | undefined>(undefined)
  const { t } = useT()

  const copy = async () => {
    window.clearTimeout(timer.current)
    try {
      if (!navigator.clipboard) throw new Error(t('copy.noClipboard'))
      await navigator.clipboard.writeText(text)
      setState('ok')
    } catch (err) {
      setReason(err instanceof Error ? err.message : String(err))
      setState('fail')
    }
    timer.current = window.setTimeout(() => setState('idle'), 1800)
  }

  return (
    <div className="codeblock">
      <code className="mono">{text}</code>
      <button
        type="button"
        className={`icon-btn codeblock__copy${state === 'ok' ? ' is-ok' : state === 'fail' ? ' is-fail' : ''}`}
        aria-label={t('copy.action')}
        title={state === 'ok' ? t('copy.done') : state === 'fail' ? t('copy.failed', { reason }) : t('copy.action')}
        onClick={copy}
      >
        {state === 'ok' ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
      <span className="sr-only" aria-live="polite">
        {state === 'ok' ? t('copy.done') : state === 'fail' ? t('copy.failed', { reason }) : ''}
      </span>
    </div>
  )
}
