import { useCallback, useEffect, useRef, useState } from 'react'
import { altHeld } from '../inspector/keys.ts'

/**
 * Is the selection modifier (Alt / Option) held right now?
 *
 * Several signals, one state (DESIGN_SPEC §9):
 * - key events of the window;
 * - the inspector's `alt` message, while focus is inside the page (`report`);
 * - `altKey` of every pointer and wheel event the window sees — the resync that keeps a
 *   lost keyup (Alt+Tab) from leaving selection stuck on.
 * Dropped on window blur and when the tab hides. A blur that only moved focus between
 * the window and its own frame is not a reason: the document still has focus then.
 */
export function useAltKey() {
  const [down, setDown] = useState(false)
  /** A pick happened during this press: its release must not reach the browser menu. */
  const picked = useRef(false)

  useEffect(() => {
    const sync = (e: KeyboardEvent | PointerEvent | WheelEvent) => setDown(altHeld(e))
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.isTrusted) return // keys the inspector replays carry no modifier state
      sync(e)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.isTrusted) return
      if (e.key === 'Alt' && picked.current) e.preventDefault()
      if (e.key === 'Alt' || e.key === 'AltGraph') picked.current = false
      sync(e)
    }
    let blurTimer: number | undefined
    const onBlur = () => {
      // Focus moving into the page's iframe blurs this window too; hasFocus() tells the
      // two apart once the move is done.
      window.clearTimeout(blurTimer)
      blurTimer = window.setTimeout(() => {
        if (!document.hasFocus()) setDown(false)
      }, 0)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') setDown(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointermove', sync, true)
    window.addEventListener('pointerdown', sync, true)
    window.addEventListener('wheel', sync, { capture: true, passive: true })
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearTimeout(blurTimer)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointermove', sync, true)
      window.removeEventListener('pointerdown', sync, true)
      window.removeEventListener('wheel', sync, true)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  /** The inspector's report. `blur`: the page lost focus — Alt goes unless focus came here. */
  const report = useCallback((value: boolean, blur: boolean) => {
    if (!blur) {
      setDown(value)
      return
    }
    window.setTimeout(() => {
      if (!document.hasFocus()) setDown(false)
    }, 0)
  }, [])

  const markPicked = useCallback(() => {
    picked.current = true
  }, [])

  return { down, report, markPicked }
}
