import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ErrorCode } from '../shared/protocol.ts'
import { androidStateFor, errorRoute, rejectsSubmit, resolveRequestErrors } from './errors.ts'

const ALL: ErrorCode[] = [
  'bad_message',
  'nothing_selected',
  'agent_failed',
  'device_no_adb',
  'device_not_found',
  'device_no_bridge',
  'device',
  'live_edit',
  'reset_edits',
  'screenshot',
]

describe('errorRoute', () => {
  test('every device capture code goes to the connect state', () => {
    for (const c of ['device_no_adb', 'device_not_found', 'device_no_bridge', 'device', 'screenshot'] as const) {
      assert.equal(errorRoute(c, undefined), 'capture', c)
    }
  })

  test('agent errors land on their request; without an id they are general', () => {
    assert.equal(errorRoute('agent_failed', 'r1'), 'request')
    assert.equal(errorRoute('agent_failed', undefined), 'general')
  })

  test('the server-own errors and a code-less legacy error are general', () => {
    for (const c of ['bad_message', 'nothing_selected', 'live_edit', 'reset_edits'] as const) {
      assert.equal(errorRoute(c, undefined), 'general', c)
    }
    assert.equal(errorRoute(undefined, undefined), 'general')
  })

  test('the routing does not depend on the localized text: every code has exactly one route', () => {
    const routes = new Set(ALL.map((c) => errorRoute(c, 'r1')))
    assert.deepEqual([...routes].sort(), ['capture', 'general', 'request'])
  })
})

describe('rejectsSubmit', () => {
  test('only the answers to a submit that built no request', () => {
    assert.deepEqual(
      ALL.filter(rejectsSubmit),
      ['bad_message', 'nothing_selected'],
    )
    assert.equal(rejectsSubmit(undefined), false)
  })
})

describe('androidStateFor', () => {
  test('no error yet — connecting', () => {
    assert.equal(androidStateFor(null), 'connecting')
  })
  test('adb missing, no device, silent app', () => {
    assert.equal(androidStateFor('device_no_adb'), 'no-adb')
    assert.equal(androidStateFor('device_not_found'), 'no-device')
    assert.equal(androidStateFor('device_no_bridge'), 'no-agent')
  })
  test('only a silent bridge gets the bridge steps; any other adb failure shows its own cause', () => {
    // e.g. "more than one device/emulator" without LD_DEVICE — classified as `device`.
    assert.equal(androidStateFor('device'), 'device-error')
    assert.equal(androidStateFor('screenshot'), 'device-error')
    assert.equal(androidStateFor('live_edit'), 'device-error')
  })
})

describe('resolveRequestErrors', () => {
  const fallback = (code: ErrorCode | null) => `fallback:${code}`
  const st = (entries: Record<string, { status: string; code?: ErrorCode; message?: string }>) => new Map(Object.entries(entries))

  test("this window's error frame beats the status text rendered in another window's language", () => {
    const map = resolveRequestErrors(
      [{ requestId: 'r1', code: 'agent_failed', message: 'The agent ended with an error', locale: 'en' }],
      st({ r1: { status: 'error', code: 'agent_failed', message: 'Агент завершился с ошибкой' } }),
      'en',
      fallback,
    )
    assert.deepEqual(map.get('r1'), { code: 'agent_failed', message: 'The agent ended with an error' })
  })

  test('no frame in this window (opened after the failure) — the status text', () => {
    const map = resolveRequestErrors([], st({ r1: { status: 'error', code: 'agent_failed', message: 'build broke' } }), 'en', fallback)
    assert.deepEqual(map.get('r1'), { code: 'agent_failed', message: 'build broke' })
  })

  test('a frame from before a language switch is replaced with the window wording', () => {
    const map = resolveRequestErrors(
      [{ requestId: 'r1', code: 'agent_failed', message: 'Агент завершился с ошибкой', locale: 'ru' }],
      st({ r1: { status: 'error', code: 'agent_failed', message: 'Агент завершился с ошибкой' } }),
      'en',
      fallback,
    )
    assert.deepEqual(map.get('r1'), { code: 'agent_failed', message: 'fallback:agent_failed' })
  })

  test('the latest frame per request wins; frames without a request are ignored', () => {
    const map = resolveRequestErrors(
      [
        { requestId: 'r1', code: 'agent_failed', message: 'first', locale: 'en' },
        { code: 'live_edit', message: 'general', locale: 'en' },
        { requestId: 'r1', code: 'agent_failed', message: 'second', locale: 'en' },
      ],
      st({}),
      'en',
      fallback,
    )
    assert.deepEqual([...map.keys()], ['r1'])
    assert.deepEqual(map.get('r1'), { code: 'agent_failed', message: 'second' })
  })

  test('an error status with no text anywhere still gets a message', () => {
    const map = resolveRequestErrors([], st({ r1: { status: 'error' }, r2: { status: 'done' } }), 'en', fallback)
    assert.deepEqual(map.get('r1'), { code: null, message: 'fallback:null' })
    assert.equal(map.has('r2'), false)
  })
})
