import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PROTOCOL_TAG } from '../shared/protocol.ts'
import { forwardedKey, isKeyMessage, isTypingTarget, keyTarget, type KeyLike } from './keys.ts'

const press = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
})
const body = { tagName: 'BODY', isContentEditable: false }

describe('forwardedKey', () => {
  it('forwards the four tool letters in either case', () => {
    for (const k of ['v', 'm', 'h', 'c']) {
      assert.equal(forwardedKey(press(k), body), k)
      assert.equal(forwardedKey(press(k.toUpperCase()), body), k)
    }
  })

  it('uses the physical key with a non-Latin layout', () => {
    assert.equal(forwardedKey({ ...press('м'), code: 'KeyV' }, body), 'v')
    assert.equal(forwardedKey({ ...press('р'), code: 'KeyH' }, body), 'h')
  })

  it('ignores other keys', () => {
    for (const k of ['a', 'x', 'Escape', 'Enter', ' ', 'ArrowLeft']) assert.equal(forwardedKey(press(k), body), null)
  })

  it('ignores chords, auto-repeat, IME composition and keys the page handled', () => {
    assert.equal(forwardedKey(press('v', { ctrlKey: true }), body), null)
    assert.equal(forwardedKey(press('c', { metaKey: true }), body), null)
    assert.equal(forwardedKey(press('h', { altKey: true }), body), null)
    assert.equal(forwardedKey(press('m', { repeat: true }), body), null)
    assert.equal(forwardedKey(press('v', { isComposing: true }), body), null)
    assert.equal(forwardedKey(press('v', { defaultPrevented: true }), body), null)
  })

  it('never forwards while the user types into the page', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      assert.equal(forwardedKey(press('v'), { tagName }), null, tagName)
    }
    assert.equal(forwardedKey(press('h'), { tagName: 'DIV', isContentEditable: true }), null)
    assert.equal(forwardedKey(press('h'), { tagName: 'BUTTON' }), 'h')
    assert.equal(forwardedKey(press('h'), null), 'h')
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
      assert.equal(forwardedKey(press('v'), { tagName: 'INPUT', type }), 'v', type)
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
    assert.equal(forwardedKey(press('v'), keyTarget(e)), null)
  })

  it('falls back to target without composedPath, and to null for non-elements', () => {
    assert.deepEqual(keyTarget({ target: { tagName: 'BUTTON' } }), { tagName: 'BUTTON' })
    assert.equal(keyTarget({ target: null, composedPath: () => [] }), null)
    assert.equal(keyTarget({ target: {}, composedPath: () => [{}] }), null)
  })
})

describe('isKeyMessage', () => {
  const ok = { tag: PROTOCOL_TAG, from: 'inspector', t: 'key', key: 'v' }

  it('accepts a well-formed message', () => {
    assert.equal(isKeyMessage(ok), true)
  })

  it('rejects anything else', () => {
    assert.equal(isKeyMessage(null), false)
    assert.equal(isKeyMessage('v'), false)
    assert.equal(isKeyMessage({ ...ok, tag: 'other' }), false)
    assert.equal(isKeyMessage({ ...ok, from: 'ui' }), false)
    assert.equal(isKeyMessage({ ...ok, t: 'snapshot' }), false)
    assert.equal(isKeyMessage({ ...ok, key: 'x' }), false)
    assert.equal(isKeyMessage({ ...ok, key: 'V' }), false)
    assert.equal(isKeyMessage({ ...ok, key: 1 }), false)
  })
})
