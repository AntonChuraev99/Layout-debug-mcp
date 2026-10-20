import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  frameAncestorsOf,
  framingBlock,
  parseXFrameOptions,
  sourceMatches,
  stripFrameAncestors,
  windowOnlyFrameAncestors,
  xFrameOptionsBlocks,
} from './framing.ts'

const WINDOW = 'http://127.0.0.1:5174'
const TARGET = 'http://localhost:5173'

describe('X-Frame-Options', () => {
  test('values are trimmed, lowercased and deduplicated', () => {
    assert.deepEqual([...parseXFrameOptions(' DENY , deny,SameOrigin ')], ['deny', 'sameorigin'])
    assert.equal(parseXFrameOptions(null).size, 0)
    assert.equal(parseXFrameOptions(' , ').size, 0)
  })
  test('DENY blocks any parent', () => {
    assert.equal(xFrameOptionsBlocks('DENY', TARGET, WINDOW), true)
    assert.equal(xFrameOptionsBlocks('deny', TARGET, TARGET), true)
  })
  test('SAMEORIGIN blocks only another origin', () => {
    assert.equal(xFrameOptionsBlocks('SAMEORIGIN', TARGET, WINDOW), true)
    assert.equal(xFrameOptionsBlocks('SAMEORIGIN', WINDOW, WINDOW), false)
  })
  test('conflicting values block; ALLOW-FROM and garbage are invalid and allow', () => {
    assert.equal(xFrameOptionsBlocks('DENY, SAMEORIGIN', WINDOW, WINDOW), true)
    assert.equal(xFrameOptionsBlocks('ALLOW-FROM http://127.0.0.1:5174', TARGET, WINDOW), false)
    assert.equal(xFrameOptionsBlocks('allowall', TARGET, WINDOW), false)
    assert.equal(xFrameOptionsBlocks('allowall, other', TARGET, WINDOW), false)
    assert.equal(xFrameOptionsBlocks(null, TARGET, WINDOW), false)
  })
})

describe('CSP frame-ancestors: parse and strip', () => {
  test('the source list of the first directive, case-insensitive name', () => {
    assert.deepEqual(frameAncestorsOf("default-src 'self'; FRAME-ANCESTORS 'self'  https://a.example ; img-src *"), [
      "'self'",
      'https://a.example',
    ])
    assert.deepEqual(frameAncestorsOf("frame-ancestors 'none'; frame-ancestors *"), ["'none'"])
    assert.deepEqual(frameAncestorsOf('frame-ancestors'), [])
    assert.equal(frameAncestorsOf("default-src 'self'"), null)
  })
  test('strip keeps every other directive as written', () => {
    assert.equal(
      stripFrameAncestors("default-src 'self'; frame-ancestors 'none'; script-src 'self' 'nonce-abc'"),
      "default-src 'self'; script-src 'self' 'nonce-abc'",
    )
  })
  test('strip drops every frame-ancestors, in every policy of a list', () => {
    assert.equal(
      stripFrameAncestors("frame-ancestors 'none'; img-src *, default-src 'none'; Frame-Ancestors 'self'"),
      "img-src *, default-src 'none'",
    )
  })
  test('a policy without frame-ancestors is left alone; nothing left means null', () => {
    assert.equal(stripFrameAncestors("default-src 'self'"), "default-src 'self'")
    assert.equal(stripFrameAncestors("frame-ancestors 'none'"), null)
    assert.equal(stripFrameAncestors("frame-ancestors 'none';, frame-ancestors *"), null)
  })
  test('the window-only rule names the window origins', () => {
    assert.equal(windowOnlyFrameAncestors([WINDOW, 'http://localhost:5174']), `frame-ancestors ${WINDOW} http://localhost:5174`)
  })
})

describe('CSP frame-ancestors: source matching', () => {
  test("'self' is the protected page's own origin", () => {
    assert.equal(sourceMatches("'self'", TARGET, TARGET), true)
    assert.equal(sourceMatches("'SELF'", WINDOW, TARGET), false)
  })
  test("'none' and other keywords match nothing", () => {
    assert.equal(sourceMatches("'none'", WINDOW, TARGET), false)
    assert.equal(sourceMatches("'unsafe-inline'", WINDOW, TARGET), false)
  })
  test('* and scheme sources', () => {
    assert.equal(sourceMatches('*', WINDOW, TARGET), true)
    assert.equal(sourceMatches('http:', WINDOW, TARGET), true)
    assert.equal(sourceMatches('https:', WINDOW, TARGET), false)
  })
  test('host sources: exact, port, wildcard port, wildcard host, scheme', () => {
    assert.equal(sourceMatches('http://127.0.0.1:5174', WINDOW, TARGET), true)
    assert.equal(sourceMatches('127.0.0.1:5174', WINDOW, TARGET), true, 'no scheme: the page scheme')
    assert.equal(sourceMatches('127.0.0.1:5000', WINDOW, TARGET), false)
    assert.equal(sourceMatches('127.0.0.1:*', WINDOW, TARGET), true)
    assert.equal(sourceMatches('127.0.0.1', WINDOW, TARGET), false, 'no port: the default port only')
    assert.equal(sourceMatches('https://127.0.0.1:5174', WINDOW, TARGET), false)
    assert.equal(sourceMatches('*.example.com', 'https://app.example.com', 'https://example.com'), true)
    assert.equal(sourceMatches('*.example.com', 'https://example.com', 'https://example.com'), false)
    assert.equal(sourceMatches('http://localhost:*/some/path', 'http://localhost:5174', TARGET), true)
  })
})

describe('framingBlock', () => {
  const none = { xFrameOptions: null, contentSecurityPolicy: null }
  test('no framing headers: not blocked', () => {
    assert.equal(framingBlock(none, TARGET, WINDOW), null)
  })
  test('X-Frame-Options names itself with its value', () => {
    assert.deepEqual(framingBlock({ ...none, xFrameOptions: 'DENY' }, TARGET, WINDOW), { header: 'X-Frame-Options', value: 'DENY' })
  })
  test("frame-ancestors 'none' names only the directive, not the whole policy", () => {
    const csp = "default-src 'self'; frame-ancestors 'none'; img-src *"
    assert.deepEqual(framingBlock({ ...none, contentSecurityPolicy: csp }, TARGET, WINDOW), {
      header: 'Content-Security-Policy',
      value: "frame-ancestors 'none'",
    })
  })
  test('frame-ancestors that allows the window wins over X-Frame-Options', () => {
    const headers = { xFrameOptions: 'DENY', contentSecurityPolicy: `frame-ancestors ${WINDOW}` }
    assert.equal(framingBlock(headers, TARGET, WINDOW), null)
  })
  test('every policy with frame-ancestors must allow the window', () => {
    const headers = { xFrameOptions: null, contentSecurityPolicy: `frame-ancestors *, frame-ancestors 'self'` }
    assert.deepEqual(framingBlock(headers, TARGET, WINDOW), { header: 'Content-Security-Policy', value: "frame-ancestors 'self'" })
  })
  test('a long value is cut for display', () => {
    const block = framingBlock({ ...none, xFrameOptions: `DENY${' '.repeat(300)}x` }, TARGET, WINDOW)
    assert.equal(block, null, 'not a valid value: allows')
    const csp = `frame-ancestors ${Array.from({ length: 40 }, (_, i) => `https://host${i}.example`).join(' ')}`
    const long = framingBlock({ ...none, contentSecurityPolicy: csp }, TARGET, WINDOW)!
    assert.equal(long.value.length, 200)
    assert.ok(long.value.endsWith('…'))
  })
})
