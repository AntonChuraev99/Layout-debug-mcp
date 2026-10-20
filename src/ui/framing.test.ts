import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { envSnippet, framingFix } from './framing.ts'

const proxy = { origin: 'http://127.0.0.1:5176', target: 'http://localhost:3000' }

describe('framingFix: the next step the blocked-frame banner offers', () => {
  test('no proxy: turn it on for this page', () => {
    assert.deepEqual(framingFix('http://localhost:3000/', 'http://localhost:3000/', null), { kind: 'enableProxy' })
  })
  test('proxy on for another origin than the frame: point the target here', () => {
    assert.deepEqual(framingFix('http://localhost:4000/', 'http://localhost:4000/', proxy), {
      kind: 'otherTarget',
      target: 'http://localhost:3000',
    })
  })
  test('frame through the proxy, but a redirect left it: name where it went, not "restart with this page"', () => {
    assert.deepEqual(framingFix('http://127.0.0.1:5176/', 'http://127.0.0.1:3000/login', proxy), {
      kind: 'redirectedAway',
      origin: 'http://127.0.0.1:3000',
      target: 'http://localhost:3000',
    })
  })
  test('an unparsable probe address through the proxy still gives a step', () => {
    assert.equal(framingFix('http://127.0.0.1:5176/', 'nope', proxy).kind, 'otherTarget')
  })
})

describe('envSnippet', () => {
  test('the MCP client env form the banner text asks for', () => {
    assert.equal(
      envSnippet({ LD_FRAMING_PROXY: '1', LD_TARGET_URL: 'http://localhost:3000/a?b="c"' }),
      '"env": { "LD_FRAMING_PROXY": "1", "LD_TARGET_URL": "http://localhost:3000/a?b=\\"c\\"" }',
    )
  })
})
