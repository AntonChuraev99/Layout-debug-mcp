import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PROTOCOL_TAG } from '../shared/protocol.ts'
import { altHeld, forwardedKey, isKeyMessage, isTypingTarget, keyTarget, type KeyLike } from './keys.ts'

const press = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
})
const body = { tagName: 'BODY', isContentEditable: false }
const ARROWS = ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']

describe('forwardedKey', () => {
  it('forwards C in either case, and Escape', () => {
    assert.equal(forwardedKey(press('c'), body), 'c')
    assert.equal(forwardedKey(press('C'), body), 'c')
    assert.equal(forwardedKey(press('Escape'), body), 'Escape')
  })

  it('no longer forwards the removed tool letters V / M / H', () => {
    for (const k of ['v', 'm', 'h', 'V']) assert.equal(forwardedKey(press(k), body), null, k)
  })

  it('uses the physical key with a non-Latin layout', () => {
    assert.equal(forwardedKey({ ...press('с'), code: 'KeyC' }, body), 'c')
  })

  it('forwards arrows only while the nudge row is on, with no other key', () => {
    for (const k of ARROWS) {
      assert.equal(forwardedKey(press(k), body), null, `${k} off`)
      assert.equal(forwardedKey(press(k), body, { arrows: true }), k, `${k} on`)
      // Holding an arrow nudges again and again.
      assert.equal(forwardedKey(press(k, { repeat: true }), body, { arrows: true }), k, `${k} repeat`)
    }
  })

  it('ignores other keys', () => {
    for (const k of ['a', 'x', 'Enter', ' ', 'Tab']) assert.equal(forwardedKey(press(k), body, { arrows: true }), null, k)
  })

  it('ignores chords, auto-repeat of letters and Escape, IME composition and keys the page handled', () => {
    assert.equal(forwardedKey(press('c', { ctrlKey: true }), body), null)
    assert.equal(forwardedKey(press('c', { metaKey: true }), body), null)
    assert.equal(forwardedKey(press('c', { altKey: true }), body), null)
    assert.equal(forwardedKey(press('c', { repeat: true }), body), null)
    assert.equal(forwardedKey(press('Escape', { repeat: true }), body), null)
    assert.equal(forwardedKey(press('c', { isComposing: true }), body), null)
    assert.equal(forwardedKey(press('c', { defaultPrevented: true }), body), null)
    assert.equal(forwardedKey(press('Escape', { defaultPrevented: true }), body), null)
    assert.equal(forwardedKey(press('ArrowLeft', { defaultPrevented: true }), body, { arrows: true }), null)
  })

  it('never forwards while the user types into the page', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      assert.equal(forwardedKey(press('c'), { tagName }), null, tagName)
      assert.equal(forwardedKey(press('Escape'), { tagName }), null, tagName)
      assert.equal(forwardedKey(press('ArrowLeft'), { tagName }, { arrows: true }), null, tagName)
    }
    assert.equal(forwardedKey(press('c'), { tagName: 'DIV', isContentEditable: true }), null)
    assert.equal(forwardedKey(press('c'), { tagName: 'BUTTON' }), 'c')
    assert.equal(forwardedKey(press('c'), null), 'c')
  })
})

describe('isTypingTarget', () => {
  it('is false for no target and plain elements', () => {
    assert.equal(isTypingTarget(null), false)
    assert.equal(isTypingTarget({}), false)
    assert.equal(isTypingTarget({ tagName: 'A' }), false)
  })

  it('is true for text-entry inputs, with or without an explicit type', () => {
    const textTypes = ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week']
    for (const type of textTypes) assert.equal(isTypingTarget({ tagName: 'INPUT', type }), true, type)
    assert.equal(isTypingTarget({ tagName: 'INPUT' }), true)
    assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'EMAIL' }), true)
  })

  it('is false for inputs that take no letters, so shortcuts keep working after a click on them', () => {
    const controls = ['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'file', 'image', 'hidden']
    for (const type of controls) {
      assert.equal(isTypingTarget({ tagName: 'INPUT', type }), false, type)
      assert.equal(forwardedKey(press('c'), { tagName: 'INPUT', type }), 'c', type)
    }
  })

  it('is true for textarea, select (type-ahead) and contenteditable', () => {
    assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true)
    assert.equal(isTypingTarget({ tagName: 'SELECT' }), true)
    assert.equal(isTypingTarget({ tagName: 'SPAN', isContentEditable: true }), true)
    assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'checkbox', isContentEditable: true }), true)
  })
})

describe('keyTarget', () => {
  it('sees the input inside an open shadow root, not the retargeted host', () => {
    const host = { tagName: 'SL-INPUT' }
    const inner = { tagName: 'INPUT' }
    const e = { target: host, composedPath: () => [inner, host] }
    assert.equal(keyTarget(e), inner)
    assert.equal(forwardedKey(press('c'), keyTarget(e)), null)
  })

  it('falls back to target without composedPath, and to null for non-elements', () => {
    assert.deepEqual(keyTarget({ target: { tagName: 'BUTTON' } }), { tagName: 'BUTTON' })
    assert.equal(keyTarget({ target: null, composedPath: () => [] }), null)
    assert.equal(keyTarget({ target: {}, composedPath: () => [{}] }), null)
  })
})

describe('isKeyMessage', () => {
  const ok = { tag: PROTOCOL_TAG, from: 'inspector', t: 'key', key: 'c' }

  it('accepts a well-formed message', () => {
    assert.equal(isKeyMessage(ok), true)
    assert.equal(isKeyMessage({ ...ok, key: 'Escape' }), true)
    assert.equal(isKeyMessage({ ...ok, key: 'ArrowUp', shift: true }), true)
  })

  it('rejects anything else', () => {
    assert.equal(isKeyMessage(null), false)
    assert.equal(isKeyMessage('c'), false)
    assert.equal(isKeyMessage({ ...ok, tag: 'other' }), false)
    assert.equal(isKeyMessage({ ...ok, from: 'ui' }), false)
    assert.equal(isKeyMessage({ ...ok, t: 'snapshot' }), false)
    assert.equal(isKeyMessage({ ...ok, key: 'x' }), false)
    assert.equal(isKeyMessage({ ...ok, key: 'C' }), false)
    assert.equal(isKeyMessage({ ...ok, key: 'v' }), false)
    assert.equal(isKeyMessage({ ...ok, key: 1 }), false)
    assert.equal(isKeyMessage({ ...ok, key: 'ArrowUp', shift: 'yes' }), false)
  })
})

describe('altHeld', () => {
  it('follows the event altKey: Alt down, Alt up', () => {
    assert.equal(altHeld({ altKey: true, key: 'Alt' }), true)
    assert.equal(altHeld({ altKey: false, key: 'Alt' }), false)
    // Pointer and wheel events carry no key: the flag alone decides (the Alt+Tab resync).
    assert.equal(altHeld({ altKey: true }), true)
    assert.equal(altHeld({ altKey: false }), false)
  })

  it('AltGr is not the selection modifier: AltGraph key or Ctrl+Alt', () => {
    assert.equal(altHeld({ altKey: true, ctrlKey: false, key: 'AltGraph' }), false)
    assert.equal(altHeld({ altKey: true, ctrlKey: true, key: 'Alt' }), false)
    assert.equal(altHeld({ altKey: true, ctrlKey: true }), false)
  })
})
