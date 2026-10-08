import { useT } from './i18n.ts'

export const TELEMETRY_DOCS_URL = 'https://github.com/AntonChuraev99/Layout-debug-mcp#telemetry'

/**
 * One-time line under the header: the server sends anonymous usage data. It sits in the
 * window's column (not over the frame), takes no focus and listens to no keys, so picking,
 * the palette and every shortcut work while it shows.
 */
export function TelemetryNotice({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useT()
  return (
    <section className="tnotice" role="region" aria-label={t('telemetry.label')}>
      <p className="tnotice__text">
        {t('telemetry.text')}{' '}
        <a className="tnotice__link" href={TELEMETRY_DOCS_URL} target="_blank" rel="noopener noreferrer">
          {t('telemetry.howOff')}
        </a>
      </p>
      <button type="button" className="btn tnotice__ok" onClick={onDismiss}>
        {t('telemetry.ok')}
      </button>
    </section>
  )
}
