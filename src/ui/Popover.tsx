import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  /** The element that toggles the popover: a click on it is not an "outside" click. */
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  label: string
  className?: string
  style?: React.CSSProperties
  children: ReactNode
}

/** Floating card under a header control. Esc and a click outside close it, focus returns to the control. */
export function Popover({ anchorRef, onClose, label, className, style, children }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return
      closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // The innermost layer wins: nothing behind the popover reacts to this Escape.
      e.stopImmediatePropagation()
      closeRef.current()
      anchorRef.current?.focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [anchorRef])

  return (
    <div ref={ref} className={`pop${className ? ` ${className}` : ''}`} role="dialog" aria-label={label} style={style}>
      {children}
    </div>
  )
}
