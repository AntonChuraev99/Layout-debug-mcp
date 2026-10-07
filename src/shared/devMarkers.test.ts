import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isServerReadyLine, serverFailedLine, serverFailureReason, serverReadyLine } from './devMarkers.mjs'

describe('dev markers: server lines ↔ runner checks', () => {
  it('the runner recognises the ready line the server prints', () => {
    const line = serverReadyLine('127.0.0.1', 5185)
    assert.equal(line, '[layout-debug] server http://127.0.0.1:5185')
    assert.equal(isServerReadyLine(line), true)
    assert.equal(serverFailureReason(line), null)
  })

  it('the runner extracts the reason from the failure line the server prints', () => {
    const line = serverFailedLine('port 5185 is already in use')
    assert.equal(serverFailureReason(line), 'port 5185 is already in use')
    assert.equal(isServerReadyLine(line), false)
  })

  it('other lines are neither', () => {
    for (const line of ['[layout-debug] target: http://127.0.0.1:5174/demo/', 'Error: boom', '']) {
      assert.equal(isServerReadyLine(line), false, line)
      assert.equal(serverFailureReason(line), null, line)
    }
  })
})
