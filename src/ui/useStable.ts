import { useCallback, useRef } from 'react'

/**
 * A function whose identity never changes and that always runs the latest `fn`.
 *
 * The window passes many handlers to memoized children (Overlay, palette, chat, header).
 * Recreated on every render, they would make each of those re-render with it, several times
 * per device frame on Android.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...args: A) => ref.current(...args), [])
}
