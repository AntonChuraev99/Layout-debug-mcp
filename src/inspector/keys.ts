/**
 * Tool shortcuts pressed while focus is inside the target page.
 *
 * With the Hand tool a click lands in the iframe, and from then on every key press
 * goes to the page's document, not to the window: V / M / H / C would silently stop
 * working. The inspector hands these few letters back to the window, which runs
 * them through its own shortcut handler (guards included).
 *
 * Pure on purpose: both sides import it (the inspector to decide, the window to
 * validate what arrives), and node --test covers it without a DOM.
 */

import { PROTOCOL_TAG } from '../shared/protocol.ts'

export const FORWARDED_KEYS = ['v', 'm', 'h', 'c'] as const
export type ForwardedKey = (typeof FORWARDED_KEYS)[number]

/** Inspector → window. Kept next to the logic until the shared protocol absorbs it. */
export interface InspectorKeyMessage {
  tag: typeof PROTOCOL_TAG
  from: 'inspector'
  t: 'key'
  key: ForwardedKey
}

export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  repeat?: boolean
  isComposing?: boolean
  defaultPrevented?: boolean
}

export interface TargetLike {
  tagName?: string
  /** `HTMLInputElement.type`: already lowercase, and "text" for a missing or unknown type. */
  type?: string
  isContentEditable?: boolean
}

/**
 * <input> types whose keys are text. The rest (checkbox, radio, range, color, button,
 * submit, reset, file, image, hidden) take no letters, so after a Hand-tool click on
 * one of them the tool shortcuts must keep working.
 */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
])

/**
 * The user is typing into the page: its keys are text, never shortcuts.
 * A focused <select> counts too: it uses printable keys for type-ahead (pressing "m"
 * jumps to the first option starting with M), and every forwarded key is a printable
 * letter, so taking those keys away would change the user's selection behind their back.
 */
export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false
  if (target.isContentEditable === true) return true
  const tag = (target.tagName ?? '').toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  // No type at all (a plain <input>, or a stand-in without the property) is a text field.
  const type = (target.type ?? 'text').toLowerCase()
  return TEXT_INPUT_TYPES.has(type)
}

export interface KeyEventLike {
  target: unknown
  composedPath?: () => unknown[]
}

/**
 * The element the key really went to. A window listener sees `target` retargeted to the
 * shadow host, so an <input> inside an open shadow root (Lit, Shoelace, Material Web)
 * looks like a plain custom element; composedPath()[0] is the inner element. A closed
 * shadow root reports the host either way: there is no other signal by design.
 */
export function keyTarget(e: KeyEventLike): TargetLike | null {
  const inner = e.composedPath?.()[0] ?? e.target
  return inner && typeof inner === 'object' && 'tagName' in inner ? (inner as TargetLike) : null
}

/**
 * Which tool shortcut this key press is, if any. The physical key counts too, so a
 * non-Latin layout still works (same rule as the window's own handler). A key the page
 * already handled (`defaultPrevented`) stays the page's.
 */
export function forwardedKey(e: KeyLike, target: TargetLike | null | undefined): ForwardedKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing || e.defaultPrevented) return null
  if (isTypingTarget(target)) return null
  const k = e.key.toLowerCase()
  for (const letter of FORWARDED_KEYS) {
    if (k === letter || e.code === `Key${letter.toUpperCase()}`) return letter
  }
  return null
}

/** The window's check of an incoming message: right shape and one of the four letters only. */
export function isKeyMessage(data: unknown): data is InspectorKeyMessage {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return (
    d.tag === PROTOCOL_TAG &&
    d.from === 'inspector' &&
    d.t === 'key' &&
    typeof d.key === 'string' &&
    (FORWARDED_KEYS as readonly string[]).includes(d.key)
  )
}
