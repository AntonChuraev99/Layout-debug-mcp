import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  checkAppIdentity,
  isAdbTimeout,
  isAndroidPackage,
  linkVerdictOf,
  parseAgentIdentity,
  parsePidof,
  RetryGate,
} from './androidApp.ts'

describe('linkVerdictOf: adb shell echo ok', () => {
  test('the shell answered: the link is alive', () => {
    assert.deepEqual(linkVerdictOf({ ok: true, stdout: 'ok\r\n' }), { kind: 'alive' })
  })

  test('our timeout killed adb while it waited for the device: unresponsive', () => {
    const killed = Object.assign(new Error('Command failed: adb -s x shell echo ok'), { killed: true, signal: 'SIGTERM', code: null })
    assert.deepEqual(linkVerdictOf({ ok: false, error: killed }), { kind: 'unresponsive' })
  })

  test('adb answered with its own error: that error is the cause, not a dead link', () => {
    const offline = Object.assign(new Error('Command failed'), { killed: false, code: 1, stderr: 'error: device offline' })
    assert.deepEqual(linkVerdictOf({ ok: false, error: offline }), { kind: 'failed', error: offline })
    const noAdb = Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' })
    assert.equal(linkVerdictOf({ ok: false, error: noAdb }).kind, 'failed')
  })

  test('isAdbTimeout only for a killed child', () => {
    assert.equal(isAdbTimeout(Object.assign(new Error('x'), { killed: true })), true)
    assert.equal(isAdbTimeout(Object.assign(new Error('x'), { killed: false, code: 1 })), false)
    assert.equal(isAdbTimeout(new Error('The operation was aborted due to timeout')), false)
    assert.equal(isAdbTimeout(null), false)
    assert.equal(isAdbTimeout('timeout'), false)
  })
})

describe('isAndroidPackage', () => {
  test('application ids pass', () => {
    for (const ok of ['com.example.app', 'com.example.app.debug', 'org.a_b.C9']) assert.ok(isAndroidPackage(ok), ok)
  })
  test('anything that is not one, shell metacharacters included, is refused', () => {
    for (const bad of ['', 'app', 'com..x', '1com.x', 'com.1x', 'com.x;reboot', 'com.x y', 'com.x$(id)', '.com.x', 'com.x.']) {
      assert.equal(isAndroidPackage(bad), false, bad)
    }
    assert.equal(isAndroidPackage(42), false)
    assert.equal(isAndroidPackage(`com.${'a'.repeat(300)}`), false)
  })
})

describe('parseAgentIdentity', () => {
  test('an older agent: no fields, no problems', () => {
    assert.deepEqual(parseAgentIdentity({ ok: true, port: 8790 }), { package: null, pid: null, problems: [] })
    assert.deepEqual(parseAgentIdentity(null), { package: null, pid: null, problems: [] })
    assert.deepEqual(parseAgentIdentity('ok'), { package: null, pid: null, problems: [] })
  })
  test('package and pid are read', () => {
    assert.deepEqual(parseAgentIdentity({ ok: true, port: 8790, package: 'com.example.app', pid: 4242 }), {
      package: 'com.example.app',
      pid: 4242,
      problems: [],
    })
  })
  test('malformed fields become null and are named in problems', () => {
    const r = parseAgentIdentity({ package: 'not a package', pid: -3 })
    assert.equal(r.package, null)
    assert.equal(r.pid, null)
    assert.equal(r.problems.length, 2)
    assert.match(r.problems[0]!, /not an Android application id/)
    assert.match(r.problems[1]!, /not a positive integer/)
  })
})

describe('parsePidof', () => {
  test('first pid of the output, null for none', () => {
    assert.equal(parsePidof('12345\n'), 12345)
    assert.equal(parsePidof('12345 678\r\n'), 12345)
    assert.equal(parsePidof(''), null)
    assert.equal(parsePidof('  \n'), null)
    assert.equal(parsePidof('pidof: not found'), null)
  })
})

describe('checkAppIdentity', () => {
  const reported = (pkg: string | null, pid: number | null = null) => ({ package: pkg, pid })

  test('nothing configured, nothing reported: no app, no error (the old behaviour)', () => {
    assert.deepEqual(checkAppIdentity(null, reported(null)), { kind: 'ok', app: null })
  })
  test('nothing configured, a reported package is shown as is', () => {
    assert.deepEqual(checkAppIdentity(null, reported('com.example.app', 7)), {
      kind: 'ok',
      app: { package: 'com.example.app', pid: 7, source: 'agent' },
    })
  })
  test('configured and matching', () => {
    assert.deepEqual(checkAppIdentity('com.example.app', reported('com.example.app')), {
      kind: 'ok',
      app: { package: 'com.example.app', pid: null, source: 'agent' },
    })
  })
  test('configured and another app answers: mismatch with both names', () => {
    assert.deepEqual(checkAppIdentity('com.example.app', reported('com.example.other', 9)), {
      kind: 'mismatch',
      expected: 'com.example.app',
      actual: 'com.example.other',
    })
  })
  test('configured but the agent does not say: confirm via adb', () => {
    assert.deepEqual(checkAppIdentity('com.example.app', reported(null)), { kind: 'check-adb', expected: 'com.example.app' })
  })
})

describe('RetryGate', () => {
  test('lets one attempt through per interval', () => {
    let now = 1_000
    const gate = new RetryGate(5_000, () => now)
    assert.equal(gate.ready(), true, 'the first attempt is never held back')
    gate.mark()
    // The window polls every 800 ms: none of these may re-run adb forward.
    for (let i = 0; i < 6; i++) {
      now += 800
      assert.equal(gate.ready(), false, `poll ${i + 1} at +${now - 1_000} ms`)
    }
    now = 1_000 + 5_000
    assert.equal(gate.ready(), true, 'due again after the interval')
    gate.mark()
    now += 1
    assert.equal(gate.ready(), false)
  })
})
