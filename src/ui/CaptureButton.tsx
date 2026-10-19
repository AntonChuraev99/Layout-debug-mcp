import { IconRefresh } from './icons.tsx'
import { useInflight, type AutoRefresh } from './useAndroidAutoRefresh.ts'

interface Props {
  refresh: AutoRefresh
  online: boolean
  /** Label while nothing is on the wire, and while a capture is. */
  idle: string
  busy: string
}

/**
 * "Refresh" / "Check again" for the device. The only place that shows whether a capture is on
 * the wire, so only this button re-renders when one goes out or answers.
 */
export function CaptureButton({ refresh, online, idle, busy }: Props) {
  const inflight = useInflight(refresh)
  return (
    <button type="button" className="btn btn--icon" onClick={() => refresh.refreshNow()} disabled={inflight || !online}>
      <IconRefresh size={14} />
      {inflight ? busy : idle}
    </button>
  )
}
