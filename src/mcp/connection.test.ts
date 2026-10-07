import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveServerBase, unreachableMessage } from './connection.ts'

test('resolveServerBase: port when LD_SERVER_URL is unset or blank', () => {
  assert.equal(resolveServerBase({}, 5185), 'http://127.0.0.1:5185')
  assert.equal(resolveServerBase({ LD_SERVER_URL: '   ' }, 5185), 'http://127.0.0.1:5185')
})

test('resolveServerBase: LD_SERVER_URL wins, trailing slash dropped', () => {
  assert.equal(resolveServerBase({ LD_SERVER_URL: ' http://127.0.0.1:6000/ ' }, 5185), 'http://127.0.0.1:6000')
})

test('unreachableMessage: default port names the URL and how to pass a custom port', () => {
  const msg = unreachableMessage('http://127.0.0.1:5175', 'fetch failed (connect ECONNREFUSED)', {})
  assert.match(msg, /unreachable at http:\/\/127\.0\.0\.1:5175: fetch failed \(connect ECONNREFUSED\)/)
  assert.match(msg, /default port 5175 \(LD_SERVER_PORT is not set here\)/)
  assert.match(msg, /LD_SERVER_URL=http:\/\/127\.0\.0\.1:<port>/)
  assert.match(msg, /npm run dev/)
})

test('unreachableMessage: LD_SERVER_PORT set → says the server must use the same port', () => {
  const msg = unreachableMessage('http://127.0.0.1:5185', 'fetch failed', { LD_SERVER_PORT: '5185' })
  assert.match(msg, /uses LD_SERVER_PORT=5185\. The server must be started with the same LD_SERVER_PORT/)
  assert.doesNotMatch(msg, /default port/)
})

test('unreachableMessage: LD_SERVER_URL set → points at that variable, not the port', () => {
  const msg = unreachableMessage('http://10.0.0.2:7000', 'fetch failed', {
    LD_SERVER_URL: 'http://10.0.0.2:7000',
    LD_SERVER_PORT: '5185',
  })
  assert.match(msg, /from LD_SERVER_URL=http:\/\/10\.0\.0\.2:7000/)
  assert.doesNotMatch(msg, /LD_SERVER_PORT=5185/)
})
