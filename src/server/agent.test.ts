import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { agentEvents, extractEvents, type AgentEvent } from './agent.ts'

async function collect(messages: unknown[], opts: { throwAfter?: Error } = {}) {
  let stopped = 0
  async function* stream() {
    for (const m of messages) yield m
    if (opts.throwAfter) throw opts.throwAfter
  }
  const events: AgentEvent[] = []
  for await (const e of agentEvents(stream(), () => stopped++)) events.push(e)
  return { events, stopped }
}

const retry = (over: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'api_retry',
  attempt: 1,
  max_retries: 10,
  retry_delay_ms: 500,
  error_status: 529,
  error: 'overloaded',
  ...over,
})

describe('extractEvents: API retries', () => {
  test('a 401 retry is a fatal auth error, not a retry', () => {
    assert.deepEqual(extractEvents(retry({ error_status: 401, error: 'authentication_failed' })), [
      { kind: 'error', code: 'agent_auth', text: 'HTTP 401' },
    ])
  })

  test('authentication_failed without an HTTP status is an auth error too', () => {
    const [e] = extractEvents(retry({ error_status: null, error: 'authentication_failed' }))
    assert.equal(e?.kind, 'error')
    assert.equal(e?.kind === 'error' && e.code, 'agent_auth')
  })

  test('other retryable errors become a retry event with attempt counters', () => {
    assert.deepEqual(extractEvents(retry({ attempt: 3 })), [
      { kind: 'retry', text: 'HTTP 529', attempt: 3, maxRetries: 10 },
    ])
  })
})

describe('extractEvents: result', () => {
  test('is_error wins over a non-empty result string', () => {
    const events = extractEvents({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500 boom' })
    assert.deepEqual(events, [{ kind: 'error', code: 'agent_failed', text: 'API Error: 500 boom' }])
  })

  test('an error subtype is an error even without is_error, and carries errors[]', () => {
    const events = extractEvents({ type: 'result', subtype: 'error_max_turns', errors: ['hit max turns'] })
    assert.deepEqual(events, [{ kind: 'error', code: 'agent_failed', text: 'hit max turns' }])
  })

  test('an invalid-key result is classified as auth', () => {
    const [e] = extractEvents({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' })
    assert.equal(e?.kind === 'error' && e.code, 'agent_auth')
  })

  test('a successful result is the reply text', () => {
    assert.deepEqual(extractEvents({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }), [
      { kind: 'text', text: 'Done.' },
    ])
  })

  test('an assistant turn flagged authentication_failed is an auth error, not reply text', () => {
    const events = extractEvents({
      type: 'assistant',
      error: 'authentication_failed',
      message: { content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] },
    })
    assert.deepEqual(events, [{ kind: 'error', code: 'agent_auth', text: 'Invalid API key · Please run /login' }])
  })

  for (const error of ['billing_error', 'rate_limit', 'server_error', 'invalid_request', 'unknown', 'max_output_tokens']) {
    test(`an assistant turn flagged ${error} is agent_failed, not reply text`, () => {
      const events = extractEvents({
        type: 'assistant',
        error,
        message: { content: [{ type: 'text', text: 'Credit balance is too low' }] },
      })
      assert.deepEqual(events, [{ kind: 'error', code: 'agent_failed', text: 'Credit balance is too low' }])
    })
  }

  test('an error turn with no text falls back to the SDK error kind', () => {
    const events = extractEvents({ type: 'assistant', error: 'server_error', message: { content: [] } })
    assert.deepEqual(events, [{ kind: 'error', code: 'agent_failed', text: 'server_error' }])
  })

  test('assistant text and tool blocks still come through', () => {
    const events = extractEvents({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Looking' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/App.tsx' } },
        ],
      },
    })
    assert.deepEqual(events, [
      { kind: 'text', text: 'Looking' },
      { kind: 'tool', text: 'Read src/App.tsx' },
    ])
  })
})

describe('agentEvents: run-level rules', () => {
  test('401 stops the run immediately: one auth error, query aborted, no done', async () => {
    const { events, stopped } = await collect([
      retry({ error_status: 401, error: 'authentication_failed', attempt: 1 }),
      retry({ error_status: 401, error: 'authentication_failed', attempt: 2 }),
      { type: 'result', subtype: 'success', is_error: false, result: 'should never be read' },
    ])
    assert.deepEqual(events, [{ kind: 'error', code: 'agent_auth', text: 'HTTP 401' }])
    assert.equal(stopped, 1)
  })

  test('retries are reported once per run, not per attempt', async () => {
    const { events } = await collect([
      retry({ attempt: 1 }),
      retry({ attempt: 2 }),
      retry({ attempt: 3 }),
      { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
    ])
    assert.deepEqual(
      events.map((e) => e.kind),
      ['retry', 'text', 'done'],
    )
  })

  test('a failed result ends with exactly one error and no done, even if the SDK throws after it', async () => {
    const { events, stopped } = await collect(
      [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['crashed'] }],
      { throwAfter: new Error('Claude Code process exited with code 1') },
    )
    assert.deepEqual(events, [{ kind: 'error', code: 'agent_failed', text: 'crashed' }])
    assert.equal(stopped, 0)
  })

  test('a thrown error alone becomes agent_failed', async () => {
    const { events } = await collect([], { throwAfter: new Error('spawn claude ENOENT') })
    assert.deepEqual(events, [{ kind: 'error', code: 'agent_failed', text: 'spawn claude ENOENT' }])
  })

  test('billing error turn then failed result: one error, the API text never becomes a reply', async () => {
    const { events } = await collect([
      {
        type: 'assistant',
        error: 'billing_error',
        message: { content: [{ type: 'text', text: 'Credit balance is too low' }] },
      },
      { type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low' },
    ])
    assert.deepEqual(events, [{ kind: 'error', code: 'agent_failed', text: 'Credit balance is too low' }])
  })

  test('the success result does not repeat text the assistant already streamed', async () => {
    const { events } = await collect([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Changed padding in Card.tsx' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Changed padding in Card.tsx' },
    ])
    assert.deepEqual(events, [
      { kind: 'text', text: 'Changed padding in Card.tsx' },
      { kind: 'done', text: '' },
    ])
  })

  test('the success result is the reply when no assistant text streamed', async () => {
    const { events } = await collect([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.tsx' } }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Done.' },
    ])
    assert.deepEqual(events, [
      { kind: 'tool', text: 'Edit a.tsx' },
      { kind: 'text', text: 'Done.' },
      { kind: 'done', text: '' },
    ])
  })

  test('a clean run ends with done', async () => {
    const { events } = await collect([{ type: 'result', subtype: 'success', is_error: false, result: 'ok' }])
    assert.deepEqual(events.at(-1), { kind: 'done', text: '' })
  })
})
