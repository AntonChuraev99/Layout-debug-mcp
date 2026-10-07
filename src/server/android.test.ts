import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { classifyCaptureError } from './android.ts'
import { LocalizedError } from './i18n.ts'

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

  test('bad frame and anything else', () => {
    assert.equal(classifyCaptureError(new LocalizedError('deviceScreenshotError', { status: 500 })), 'screenshot')
    assert.equal(classifyCaptureError(new SyntaxError('Unexpected token < in JSON')), 'device')
    assert.equal(classifyCaptureError('weird'), 'device')
  })
})
