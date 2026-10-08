import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DEFAULT_LOCALE } from '../shared/protocol.ts'
import { errorText, isLocale, LocalizedError, resolveLocale, t } from './i18n.ts'

describe('locale selection', () => {
  test('English is the default', () => {
    assert.equal(DEFAULT_LOCALE, 'en')
    assert.equal(t(DEFAULT_LOCALE, 'nothingToSubmit'), 'Nothing to send: select an element on the page first')
  })

  test('Russian on request', () => {
    assert.equal(resolveLocale('en', 'ru'), 'ru')
    assert.equal(t('ru', 'nothingToSubmit'), 'Нечего отправлять: выдели элемент на странице')
  })

  test('switching back to English works', () => {
    assert.equal(resolveLocale('ru', 'en'), 'en')
  })

  test('an invalid locale is ignored with a warning, the current one stays', (ctx) => {
    const warn = ctx.mock.method(console, 'warn', () => {})
    for (const bad of ['de', 'EN', '', null, undefined, 42, { locale: 'ru' }, '__proto__', 'toString']) {
      assert.equal(resolveLocale('ru', bad), 'ru', `value ${String(bad)}`)
      assert.equal(isLocale(bad), false, `value ${String(bad)}`)
    }
    assert.equal(warn.mock.callCount(), 9)
    assert.match(String(warn.mock.calls[0]!.arguments[0]), /unknown locale "de"/)
  })
})

describe('message rendering', () => {
  test('parameters are substituted in both languages', () => {
    assert.equal(t('en', 'deviceError', { reason: 'adb not found' }), 'Device: adb not found')
    assert.equal(t('ru', 'deviceError', { reason: 'adb not found' }), 'Устройство: adb not found')
  })

  test('a missing parameter stays visible as a placeholder instead of vanishing', () => {
    assert.equal(t('en', 'deviceError'), 'Device: {reason}')
  })

  test('LocalizedError renders in the window language, keeps English in .message', () => {
    const err = new LocalizedError('deviceScreenshotError', { status: 503 })
    assert.equal(err.message, 'screenshot: HTTP 503')
    assert.equal(errorText('ru', err), 'скриншот: HTTP 503')
    assert.equal(errorText('en', err), 'screenshot: HTTP 503')
  })

  test('"no agent listening" says how to connect one, in both languages', () => {
    for (const locale of ['en', 'ru'] as const) {
      assert.match(t(locale, 'queuedNoAgent'), /npx -y layout-debug-mcp/)
      assert.match(t(locale, 'queuedNoAgent'), /layout-debug/)
    }
  })

  test('plain errors pass through unchanged', () => {
    assert.equal(errorText('ru', new Error('spawn adb ENOENT')), 'spawn adb ENOENT')
    assert.equal(errorText('en', 'raw'), 'raw')
  })
})
