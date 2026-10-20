import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { agentReason, CAPTURE_BUDGET_MS, classifyCaptureError, needsLinkCheck, screenshotError } from './android.ts'
import { errorText, LocalizedError } from './i18n.ts'

describe('classifyCaptureError', () => {
  test('adb missing', () => {
    const err = Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' })
    assert.equal(classifyCaptureError(err), 'device_no_adb')
    assert.equal(classifyCaptureError(new Error("'adb' is not recognized as an internal command")), 'device_no_adb')
  })

  test('no device / offline / unauthorized', () => {
    assert.equal(classifyCaptureError(new Error('adb: no devices/emulators found')), 'device_not_found')
    assert.equal(classifyCaptureError(new Error("adb: device 'emulator-5556' not found")), 'device_not_found')
    assert.equal(
      classifyCaptureError(Object.assign(new Error('Command failed'), { stderr: 'error: device unauthorized.' })),
      'device_not_found',
    )
  })

  test('device reachable but the bridge does not answer', () => {
    assert.equal(classifyCaptureError(new TypeError('fetch failed')), 'device_no_bridge')
    assert.equal(classifyCaptureError(new LocalizedError('deviceAgentError', { reason: 'no compose root' })), 'device_no_bridge')
  })

  test('the agent belongs to another app, or the configured app is not running', () => {
    const wrong = new LocalizedError('deviceWrongApp', { port: 8790, expected: 'com.example.app', actual: 'com.example.other' })
    assert.equal(classifyCaptureError(wrong), 'device_wrong_app')
    assert.match(wrong.message, /belongs to com\.example\.other, not to com\.example\.app/)
    const absent = new LocalizedError('deviceAppNotRunning', { port: 8790, expected: 'com.example.app' })
    assert.equal(classifyCaptureError(absent), 'device_wrong_app')
    assert.match(absent.message, /did not report which app it belongs to/)
  })

  test('bad frame and anything else', () => {
    assert.equal(classifyCaptureError(new LocalizedError('deviceScreenshotError', { status: 500 })), 'screenshot')
    assert.equal(classifyCaptureError(new SyntaxError('Unexpected token < in JSON')), 'device')
    assert.equal(classifyCaptureError('weird'), 'device')
  })
})

describe('needsLinkCheck: which failures may be a stalled adb link', () => {
  test('nothing answers through the forward, or an adb call on the capture path timed out: probe', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    assert.equal(needsLinkCheck(timeout), true)
    assert.equal(needsLinkCheck(new TypeError('fetch failed')), true)
    assert.equal(needsLinkCheck(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), true)
    const killedPidof = Object.assign(new Error('Command failed: adb -s x shell pidof com.example.app'), {
      killed: true,
      signal: 'SIGTERM',
      code: null,
    })
    assert.equal(needsLinkCheck(killedPidof), true)
  })

  test('the app not running and every answered failure keep their own cause: no probe', () => {
    assert.equal(needsLinkCheck(new LocalizedError('deviceAppNotRunning', { port: 8790, expected: 'com.example.app' })), false)
    assert.equal(needsLinkCheck(new LocalizedError('deviceAgentError', { reason: 'no compose root' })), false)
    assert.equal(needsLinkCheck(new LocalizedError('deviceAgentHttp', { path: '/tree', status: 500, reason: '' })), false)
    assert.equal(
      needsLinkCheck(new LocalizedError('deviceWrongApp', { port: 8790, expected: 'com.example.app', actual: 'com.example.other' })),
      false,
    )
    assert.equal(needsLinkCheck(new Error('adb: no devices/emulators found')), false)
    assert.equal(needsLinkCheck(Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' })), false)
    assert.equal(needsLinkCheck(new SyntaxError('Unexpected token <')), false)
  })
})

describe('agent answers that are not a usable tree', () => {
  test('a non-2xx answer is a localized error with the path, the status and the next step, routed as `device`', () => {
    const err = new LocalizedError('deviceAgentHttp', { path: '/tree', status: 500, reason: agentReason('{"error":"no compose root"}') })
    assert.equal(classifyCaptureError(err), 'device')
    assert.match(err.message, /answered \/tree with HTTP 500: no compose root\. Restart the debug build/)
  })

  test('a reason that mentions a timeout still does not pass for a missing bridge', () => {
    const err = new LocalizedError('deviceAgentHttp', { path: '/tree', status: 503, reason: agentReason('request timed out') })
    assert.equal(classifyCaptureError(err), 'device')
  })

  test('a body that is not JSON is its own error, not a SyntaxError', () => {
    const err = new LocalizedError('deviceAgentBadReply', { path: '/tree', reason: 'Unexpected token <' })
    assert.equal(classifyCaptureError(err), 'device')
    assert.match(err.message, /reply to \/tree that is not JSON/)
  })

  test('agentReason: the JSON error, else the text; collapsed, capped, empty when there is nothing', () => {
    assert.equal(agentReason('{"error":"boom"}'), ': boom')
    assert.equal(agentReason('<html>\n  Not Found\n</html>'), ': <html> Not Found </html>')
    assert.equal(agentReason('   '), '')
    assert.equal(agentReason('{"ok":false}'), ': {"ok":false}')
    const long = agentReason('x'.repeat(500))
    assert.equal(long.length, ': '.length + 200 + 1)
    assert.ok(long.endsWith('…'))
  })

  test("a failed screenshot carries the agent's reason, and stays a `screenshot` error", () => {
    const withReason = screenshotError(503, '{"error":"screenshots need Android 8.0 (API 26) or newer"}')
    assert.equal(withReason.message, 'screenshot: the agent on the device answered HTTP 503: screenshots need Android 8.0 (API 26) or newer')
    assert.equal(errorText('ru', withReason), 'скриншот: агент на устройстве ответил HTTP 503: screenshots need Android 8.0 (API 26) or newer')
    assert.equal(classifyCaptureError(withReason), 'screenshot')
    assert.equal(needsLinkCheck(withReason), false)

    const bare = screenshotError(500, '')
    assert.equal(bare.message, 'screenshot: HTTP 500')
    assert.equal(classifyCaptureError(bare), 'screenshot')
  })

  test('the stalled adb link has its own code, and its text says the app is not at fault and how to reconnect', () => {
    const err = new LocalizedError('deviceUnresponsive', { serial: 'adb-XYZ._adb-tls-connect._tcp' })
    assert.equal(classifyCaptureError(err), 'device_unresponsive')
    assert.match(err.message, /does not answer over adb/)
    assert.match(err.message, /restarting it will not help/)
    assert.match(err.message, /adb disconnect adb-XYZ\._adb-tls-connect\._tcp/)
  })

  test('one capture finishes inside the window watchdog (useAndroidAutoRefresh: 8 s)', () => {
    assert.ok(CAPTURE_BUDGET_MS < 8_000)
  })
})
