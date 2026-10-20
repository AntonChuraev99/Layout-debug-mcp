import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { SERVER_PORT } from '../shared/ports.ts'
import { CONFIG_FILE_NAME, ConfigError, DEFAULT_FRAMING_PROXY_PORT, loadConfig, parseIdleMinutes } from './config.ts'

let base: string
const dir = (name: string, config?: unknown) => {
  const d = join(base, name)
  mkdirSync(d, { recursive: true })
  if (config !== undefined) {
    writeFileSync(join(d, CONFIG_FILE_NAME), typeof config === 'string' ? config : JSON.stringify(config))
  }
  return d
}

before(() => {
  base = mkdtempSync(join(tmpdir(), 'ld-config-'))
})
after(() => rmSync(base, { recursive: true, force: true }))

describe('loadConfig: where it reads from', () => {
  test('no file, no env: web demo target, projectDir = the directory it was started from', () => {
    const cwd = dir('empty')
    const c = loadConfig(cwd, {})
    assert.equal(c.target, 'web')
    assert.equal(c.targetUrl, `http://127.0.0.1:${SERVER_PORT}/demo/`)
    assert.equal(c.projectDir, cwd)
    assert.equal(c.androidPort, 8790)
    assert.equal(c.device, null)
    assert.equal(c.configFile, null)
    assert.equal(c.idleExitMs, 0)
  })

  test('the config file is read from cwd, and a relative projectDir resolves against the file', () => {
    const cwd = dir('with-file', { target: 'android', androidPort: 8800, device: 'emulator-5554', projectDir: 'app' })
    const c = loadConfig(cwd, {})
    assert.equal(c.target, 'android')
    assert.equal(c.androidPort, 8800)
    assert.equal(c.device, 'emulator-5554')
    assert.equal(c.projectDir, join(cwd, 'app'))
    assert.equal(c.configFile, join(cwd, CONFIG_FILE_NAME))
  })

  test('LD_* override the file; blank values count as unset', () => {
    const cwd = dir('override', { target: 'android', targetUrl: 'http://localhost:3000' })
    const c = loadConfig(cwd, {
      LD_TARGET: 'web',
      LD_TARGET_URL: '  ',
      LD_ANDROID_PORT: '9000',
      LD_DEVICE: '',
      LD_PROJECT_DIR: 'sub/dir',
    })
    assert.equal(c.target, 'web')
    assert.equal(c.targetUrl, 'http://localhost:3000')
    assert.equal(c.androidPort, 9000)
    assert.equal(c.device, null)
    assert.equal(c.projectDir, join(cwd, 'sub', 'dir'), 'a relative LD_PROJECT_DIR resolves against cwd')
  })

  test('LD_CONFIG names another file', () => {
    const cwd = dir('ld-config')
    const other = dir('elsewhere', { targetUrl: 'http://127.0.0.1:4000' })
    const c = loadConfig(cwd, { LD_CONFIG: join(other, CONFIG_FILE_NAME) })
    assert.equal(c.targetUrl, 'http://127.0.0.1:4000')
    assert.equal(c.configFile, join(other, CONFIG_FILE_NAME))
  })
})

describe('loadConfig: invalid values fail at start with the source named', () => {
  const fails = (fn: () => unknown, pattern: RegExp) =>
    assert.throws(fn, (err: unknown) => err instanceof ConfigError && pattern.test((err as Error).message))

  for (const bad of ['abc', '0', '70000', '87.5', '8790x']) {
    test(`LD_ANDROID_PORT="${bad}"`, () => {
      fails(() => loadConfig(dir('ap'), { LD_ANDROID_PORT: bad }), /LD_ANDROID_PORT="[^"]*" — expected an integer port/)
    })
  }

  test('LD_TARGET typo', () => {
    fails(() => loadConfig(dir('t'), { LD_TARGET: 'andriod' }), /LD_TARGET is "andriod"; expected "web" or "android"/)
  })

  test('target typo in the file names the file', () => {
    const cwd = dir('tf', { target: 'ios' })
    fails(() => loadConfig(cwd, {}), /"target" in .*layout-debug\.config\.json is "ios"/)
  })

  test('androidPort out of range or not a number in the file', () => {
    fails(() => loadConfig(dir('pf1', { androidPort: 0 }), {}), /"androidPort" in .* is 0/)
    fails(() => loadConfig(dir('pf2', { androidPort: '8790' }), {}), /"androidPort" in .* is "8790"/)
  })

  test('a field of the wrong type in the file', () => {
    fails(() => loadConfig(dir('wt', { targetUrl: 42 }), {}), /"targetUrl" in .* is 42; expected a string/)
  })

  test('malformed JSON and a non-object file', () => {
    fails(() => loadConfig(dir('bad-json', '{ nope'), {}), /is not valid JSON/)
    fails(() => loadConfig(dir('array', '[]'), {}), /must contain a JSON object/)
  })

  test('LD_CONFIG pointing at a missing file', () => {
    fails(() => loadConfig(dir('missing'), { LD_CONFIG: 'nope.json' }), /LD_CONFIG points at .*nope\.json, which does not exist/)
  })

  test('androidPackage: unset is null, env overrides the file, a non-application id fails', () => {
    assert.equal(loadConfig(dir('pkg-none'), {}).androidPackage, null)
    assert.equal(loadConfig(dir('pkg-file', { androidPackage: 'com.example.app' }), {}).androidPackage, 'com.example.app')
    assert.equal(
      loadConfig(dir('pkg-env', { androidPackage: 'com.example.app' }), { LD_ANDROID_PACKAGE: ' com.example.other ' })
        .androidPackage,
      'com.example.other',
    )
    fails(() => loadConfig(dir('pkg-bad-env'), { LD_ANDROID_PACKAGE: 'com.x;reboot' }), /LD_ANDROID_PACKAGE is "com\.x;reboot"; expected an Android application id/)
    fails(() => loadConfig(dir('pkg-bad-file', { androidPackage: 'app' }), {}), /"androidPackage" in .* is "app"; expected an Android application id/)
    fails(() => loadConfig(dir('pkg-type', { androidPackage: 7 }), {}), /"androidPackage" in .* is 7; expected a string/)
  })

  test('LD_IDLE_EXIT_MINUTES', () => {
    assert.equal(parseIdleMinutes(undefined), 0)
    assert.equal(parseIdleMinutes(' 30 '), 30)
    assert.throws(() => parseIdleMinutes('half an hour'), /LD_IDLE_EXIT_MINUTES="half an hour"/)
    assert.equal(loadConfig(dir('idle'), { LD_IDLE_EXIT_MINUTES: '30' }).idleExitMs, 30 * 60_000)
  })
})

describe('loadConfig: framing proxy', () => {
  const fails = (fn: () => unknown, pattern: RegExp) =>
    assert.throws(fn, (err: unknown) => err instanceof ConfigError && pattern.test((err as Error).message))
  const web = { LD_TARGET_URL: 'http://localhost:5173/' }

  test('off unless asked for', () => {
    assert.equal(loadConfig(dir('fp-off'), web).framingProxyPort, null)
    assert.equal(loadConfig(dir('fp-env-off', { framingProxy: true }), { ...web, LD_FRAMING_PROXY: '0' }).framingProxyPort, null)
  })
  test('on from the env or the file, on the default or the configured port', () => {
    assert.equal(loadConfig(dir('fp-env'), { ...web, LD_FRAMING_PROXY: '1' }).framingProxyPort, DEFAULT_FRAMING_PROXY_PORT)
    assert.equal(loadConfig(dir('fp-true'), { ...web, LD_FRAMING_PROXY: 'TRUE' }).framingProxyPort, DEFAULT_FRAMING_PROXY_PORT)
    assert.equal(loadConfig(dir('fp-file', { framingProxy: true, framingProxyPort: 6100 }), web).framingProxyPort, 6100)
    assert.equal(
      loadConfig(dir('fp-port-env', { framingProxy: true, framingProxyPort: 6100 }), { ...web, LD_FRAMING_PROXY_PORT: '6200' })
        .framingProxyPort,
      6200,
    )
  })
  test('invalid values fail with the source named', () => {
    fails(() => loadConfig(dir('fp-bad-env'), { ...web, LD_FRAMING_PROXY: 'yes' }), /LD_FRAMING_PROXY="yes"; expected 1 or 0/)
    fails(() => loadConfig(dir('fp-bad-file', { framingProxy: 'on' }), web), /"framingProxy" in .* is "on"; expected true or false/)
    fails(() => loadConfig(dir('fp-bad-port', { framingProxy: true, framingProxyPort: 0 }), web), /"framingProxyPort" in .* is 0/)
    fails(
      () => loadConfig(dir('fp-bad-port-env'), { ...web, LD_FRAMING_PROXY: '1', LD_FRAMING_PROXY_PORT: 'x' }),
      /LD_FRAMING_PROXY_PORT="x"/,
    )
  })
  test('a port typo fails even while the proxy is off (it would silently become the default later)', () => {
    fails(() => loadConfig(dir('fp-off-bad-port', { framingProxyPort: 'x' }), web), /"framingProxyPort" in .* is "x"/)
    fails(() => loadConfig(dir('fp-off-bad-port-env'), { ...web, LD_FRAMING_PROXY_PORT: '99999' }), /LD_FRAMING_PROXY_PORT="99999"/)
  })
  test('refused for android, a non-http target, or a port the tool or the target already uses', () => {
    fails(() => loadConfig(dir('fp-android'), { LD_TARGET: 'android', LD_FRAMING_PROXY: '1' }), /for the web target/)
    fails(() => loadConfig(dir('fp-file-url'), { LD_TARGET_URL: 'file:///x.html', LD_FRAMING_PROXY: '1' }), /not an http\(s\) address/)
    fails(
      () => loadConfig(dir('fp-server-port'), { ...web, LD_FRAMING_PROXY: '1', LD_FRAMING_PROXY_PORT: String(SERVER_PORT) }),
      /also the server port/,
    )
    fails(
      () =>
        loadConfig(dir('fp-target-port'), {
          LD_TARGET_URL: 'http://127.0.0.1:6300/',
          LD_FRAMING_PROXY: '1',
          LD_FRAMING_PROXY_PORT: '6300',
        }),
      /the target's own port/,
    )
  })
})
