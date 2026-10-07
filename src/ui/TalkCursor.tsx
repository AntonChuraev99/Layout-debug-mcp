import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { IconChat } from './icons.tsx'

/**
 * "Talk cursor" (DESIGN_SPEC talk-cursor, revised: the standard arrow stays): while picking,
 * a small "Select to chat" bubble rides just under the system arrow, its sharp corner by the
 * arrow's lower right. The arrow itself is the browser's — hardware, no lag, nothing drawn.
 *
 * - Portalled to <body>, fixed: inside the canvas (overflow hidden) it would be cut at the
 *   edges.
 * - The position never goes through React state: every move writes `transform` on the ref,
 *   and classes (shown, quiet, flips) are toggled on the element. React renders only when
 *   the label changes; a state per pointermove would re-render the window on every pixel.
 * - The bubble flips at the stage's right / bottom edge (the canvas, not the window), with
 *   16 px of hysteresis so it does not flicker on the line.
 */

export interface TalkCursorApi {
  /**
   * The pointer is at (x, y), client px. `eligible`: the bubble may show there (picking,
   * a mouse, over the overlay but not over a grab zone or handle). `layer`: the layer under
   * the hot spot, null for none (the bubble goes quiet). Returns whether it shows.
   */
  move: (x: number, y: number, eligible: boolean, layer: string | null) => boolean
  hide: () => void
  /** A pick just happened on `layer`: the bubble rests until another layer is under the cursor. */
  quiet: (layer: string | null) => void
}

/**
 * Where the bubble's sharp corner sits from the hot spot: just past the lower right of a
 * standard arrow (about 12 × 19 px on Windows and macOS, tail down-left), not over it.
 * Keep in step with .tc__bubble in styles.css. PAD: room kept from the stage edge.
 */
const BUBBLE_X = 12
const BUBBLE_Y = 18
const PAD = 8
const HYST = 16

interface Props {
  label: string
  compact: boolean
  /** The stage the bubble stays inside (client px). */
  stage: () => DOMRect | null
  apiRef: Ref<TalkCursorApi>
}

interface FollowState {
  shown: boolean
  flipX: boolean
  flipY: boolean
  /** Layer the last pick landed on; undefined — no rest. */
  restOn: string | null | undefined
  layer: string | null
}

export function TalkCursor({ label, compact, stage, apiRef }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const size = useRef({ w: 0, h: 18 })
  const st = useRef<FollowState>({ shown: false, flipX: false, flipY: false, restOn: undefined, layer: null })
  const forced = useRef(false)
  const live = useRef({ stage })
  live.current = { stage }

  // The bubble's size is measured when its text changes, not on every move (`tc--off` only
  // hides it, so it is laid out and measurable).
  useLayoutEffect(() => {
    // A class, not the className prop: React rewriting className would drop the toggled state.
    rootRef.current?.classList.toggle('tc--compact', compact)
    const b = bubbleRef.current
    if (b) size.current = { w: b.offsetWidth, h: b.offsetHeight }
  }, [label, compact])

  const ops = useRef({
    isQuiet: () => st.current.layer === null || st.current.restOn === st.current.layer,
    setShown: (on: boolean) => {
      const el = rootRef.current
      const s = st.current
      if (!el || s.shown === on) return
      s.shown = on
      if (on) {
        // Shown from its quiet state, so the bubble grows out from under the arrow.
        el.classList.add('tc--quiet')
        el.classList.remove('tc--off')
        void el.offsetWidth
        el.classList.toggle('tc--quiet', ops.current.isQuiet())
      } else {
        el.classList.add('tc--off')
      }
    },
  })

  useImperativeHandle(
    apiRef,
    () => ({
      move: (x, y, eligible, layer) => {
        const el = rootRef.current
        const s = st.current
        const { setShown, isQuiet } = ops.current
        if (!el || !eligible || forced.current) {
          setShown(false)
          return false
        }
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`
        s.layer = layer
        // The rest after a pick ends once another layer is under the hot spot.
        if (s.restOn !== undefined && layer !== s.restOn) s.restOn = undefined
        const r = live.current.stage()
        if (r) {
          const flipX = x + BUBBLE_X + size.current.w + PAD > r.right - (s.flipX ? HYST : 0)
          const flipY = y + BUBBLE_Y + size.current.h + PAD > r.bottom - (s.flipY ? HYST : 0)
          if (flipX !== s.flipX) el.classList.toggle('tc--flip-x', (s.flipX = flipX))
          if (flipY !== s.flipY) el.classList.toggle('tc--flip-y', (s.flipY = flipY))
        }
        if (s.shown) el.classList.toggle('tc--quiet', isQuiet())
        setShown(true)
        return true
      },
      hide: () => ops.current.setShown(false),
      quiet: (layer) => {
        st.current.restOn = layer
        rootRef.current?.classList.add('tc--quiet')
      },
    }),
    [],
  )

  // After Alt goes up the events go to the iframe and no pointerleave comes; the window
  // losing focus or the tab hiding takes the bubble away in the same frame. Forced colors:
  // no bubble at all.
  useEffect(() => {
    const hide = () => ops.current.setShown(false)
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hide()
    }
    const mq = window.matchMedia?.('(forced-colors: active)')
    const onForced = () => {
      forced.current = Boolean(mq?.matches)
      if (forced.current) hide()
    }
    onForced()
    window.addEventListener('blur', hide)
    document.addEventListener('visibilitychange', onVisibility)
    mq?.addEventListener?.('change', onForced)
    return () => {
      window.removeEventListener('blur', hide)
      document.removeEventListener('visibilitychange', onVisibility)
      mq?.removeEventListener?.('change', onForced)
    }
  }, [])

  return createPortal(
    <div ref={rootRef} className="tc tc--off tc--quiet" aria-hidden="true" data-testid="talk-cursor">
      <div ref={bubbleRef} className="tc__bubble">
        {compact ? (
          <>
            <i className="tc__dot" />
            <i className="tc__dot" />
            <i className="tc__dot" />
          </>
        ) : (
          <>
            <IconChat size={10} strokeWidth={2.25} />
            <span className="tc__label">{label}</span>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
