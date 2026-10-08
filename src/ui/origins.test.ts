import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { frameOrigin, serverOrigin } from './origins.ts'

describe('frameOrigin', () => {
  test('http(s) pages: scheme, host and port, nothing of the path', () => {
    assert.equal(frameOrigin('http://localhost:5173/cart?x=1#top'), 'http://localhost:5173')
    assert.equal(frameOrigin('https://app.test/'), 'https://app.test')
    assert.equal(frameOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000')
  })

  test('no address or an opaque origin: nothing to post to, nothing to trust', () => {
    for (const src of [null, undefined, '', 'about:blank', 'file:///C:/page.html', 'data:text/html,hi', 'not a url']) {
      assert.equal(frameOrigin(src), null, String(src))
    }
  })
})

describe('serverOrigin', () => {
  const at = (port: string, protocol = 'http:') => ({ protocol, port })

  test('packaged: the window is served by the server, so its own port wins over the baked one', () => {
    assert.equal(serverOrigin(at('6123'), false, 5175), 'http://127.0.0.1:6123')
    assert.equal(serverOrigin(at('5175'), false, 5175), 'http://127.0.0.1:5175')
  })

  test('dev: the window is on the Vite port, the server port is the one Vite was started with', () => {
    assert.equal(serverOrigin(at('5174'), true, 5175), 'http://127.0.0.1:5175')
    assert.equal(serverOrigin(at('5174'), true, 6200), 'http://127.0.0.1:6200')
  })

  test('a location without a port falls back to the baked port', () => {
    assert.equal(serverOrigin(at(''), false, 5175), 'http://127.0.0.1:5175')
  })
})
