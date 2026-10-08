import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveWaitSeconds } from '../mcp/connection.ts'
import { parseWaitTimeout, WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS, WAIT_MIN_SECONDS } from './wait.ts'

test('parseWaitTimeout: absent → default, the MCP range is accepted, anything else is null', () => {
  assert.equal(parseWaitTimeout(null), WAIT_DEFAULT_SECONDS)
  assert.equal(parseWaitTimeout(''), WAIT_DEFAULT_SECONDS)
  assert.equal(parseWaitTimeout(String(WAIT_MIN_SECONDS)), WAIT_MIN_SECONDS)
  assert.equal(parseWaitTimeout(String(WAIT_MAX_SECONDS)), WAIT_MAX_SECONDS)
  for (const bad of ['1', '4', '51', '10.5', '-5', 'x']) assert.equal(parseWaitTimeout(bad), null, bad)
})

test('server and MCP accept the same range: every LD_WAIT_SECONDS the MCP takes, the server takes', () => {
  for (let n = 0; n <= 60; n++) {
    const mcp = resolveWaitSeconds({ LD_WAIT_SECONDS: String(n) })
    const mcpAccepts = !mcp.warning
    assert.equal(parseWaitTimeout(String(n)) !== null, mcpAccepts, `n=${n}`)
  }
})
