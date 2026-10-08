import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  AMPLITUDE_URL,
  countBucket,
  crashEvent,
  DEBUG_PREFIX,
  durationBucket,
  loadState,
  minutesBucket,
  parseClient,
  readState,
  resolveTelemetry,
  sanitizeProps,
  Telemetry,
  TELEMETRY_NOTICE,
  telemetryCommand,
  telemetryDir,
  type AmplitudeEvent,
  type TelemetryOptions,
} from './telemetry.ts'

const KEY = 'test-key'
const tmpRoot = mkdtempSync(join(tmpdir(), 'ld-telemetry-test-'))
after(() => rmSync(tmpRoot, { recursive: true, force: true }))
let dirs = 0
const freshDir = () => join(tmpRoot, `d${dirs++}`)

interface Sent {
  url: string
  body: { api_key: string; events: AmplitudeEvent[]; options: unknown }
}

/** A Telemetry with a temp state dir, a recording fetch and captured stderr. */
function make(
  opts: Partial<TelemetryOptions> & { statuses?: number[]; reject?: boolean; env?: Record<string, string> } = {},
) {
  const sent: Sent[] = []
  const lines: string[] = []
  const statuses = [...(opts.statuses ?? [])]
  const dir = opts.env?.LD_TELEMETRY_DIR ?? freshDir()
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) })
    if (opts.reject) throw new TypeError('fetch failed')
    return new Response('{}', { status: statuses.shift() ?? 200 })
  }) as unknown as typeof fetch
  const t = new Telemetry({
    process: 'mcp',
    apiKey: KEY,
    flushIntervalMs: 0,
    fetchImpl,
    stderr: (line) => lines.push(line),
    ...opts,
    env: { LD_TELEMETRY_DIR: dir, ...opts.env },
  })
  return { t, sent, lines, dir }
}

describe('resolveTelemetry (opt-out)', () => {
  const on = (env: Record<string, string>, persisted?: boolean, key = KEY) => resolveTelemetry(env, key, persisted).enabled

  test('on by default with a key', () => {
    assert.equal(on({}), true)
  })
  test('empty key: off, unless debug (prints only)', () => {
    assert.equal(on({}, undefined, ''), false)
    assert.match(resolveTelemetry({}, '').reason, /no telemetry key/)
    assert.equal(on({ LD_TELEMETRY_DEBUG: '1' }, undefined, ''), true)
    assert.equal(resolveTelemetry({ LD_TELEMETRY_DEBUG: '1' }, '').debug, true)
  })
  test('LD_TELEMETRY off values, any case', () => {
    for (const v of ['0', 'false', 'OFF', 'No', ' off ']) assert.equal(on({ LD_TELEMETRY: v }), false, v)
    assert.equal(on({ LD_TELEMETRY: '1' }), true)
    assert.equal(on({ LD_TELEMETRY: '' }), true)
  })
  test('DO_NOT_TRACK set and not empty/0/false', () => {
    for (const v of ['1', 'true', 'yes']) assert.equal(on({ DO_NOT_TRACK: v }), false, v)
    for (const v of ['', '0', 'false', 'FALSE']) assert.equal(on({ DO_NOT_TRACK: v }), true, v)
  })
  test('CI turns it off; LD_TELEMETRY=1 turns it back on there only', () => {
    assert.equal(on({ CI: 'true' }), false)
    assert.equal(on({ CI: '0' }), true)
    assert.equal(on({ CI: 'true', LD_TELEMETRY: '1' }), true)
    assert.equal(on({ DO_NOT_TRACK: '1', LD_TELEMETRY: '1' }), false)
    assert.equal(on({ LD_TELEMETRY: '1' }, false), false)
  })
  test('persisted off wins over the default, and the reason says so', () => {
    assert.equal(on({}, false), false)
    assert.match(resolveTelemetry({}, KEY, false).reason, /telemetry off/)
    assert.equal(on({}, true), true)
  })
})

describe('buckets', () => {
  test('duration', () => {
    assert.deepEqual([0, 999, 1000, 4999, 5000, 29_999, 30_000, 59_999, 60_000, -5].map(durationBucket), [
      '<1s', '<1s', '1-5s', '1-5s', '5-30s', '5-30s', '30-60s', '30-60s', '>60s', '<1s',
    ])
  })
  test('count', () => {
    assert.deepEqual([0, 1, 2, 5, 6, 20, 21, 100, 101, 1000, 1001].map(countBucket), [
      '0', '1', '2-5', '2-5', '6-20', '6-20', '21-100', '21-100', '101-1000', '101-1000', '>1000',
    ])
  })
  test('minutes', () => {
    const m = 60_000
    assert.deepEqual([0, m, 5 * m, 15 * m, 60 * m, 240 * m].map(minutesBucket), ['<1m', '1-5m', '5-15m', '15-60m', '1-4h', '>4h'])
  })
})

describe('sanitizeProps and the payload', () => {
  test('only allow-listed properties survive, strings capped at 64, numbers and objects dropped', () => {
    const out = sanitizeProps('tool_called', {
      tool: 'layout_snapshot',
      outcome: 'ok',
      url: 'http://secret.example/page',
      path: 'C:/Users/someone/project',
      message: 'boom',
      client_name: 'x'.repeat(200),
      node_major: 22,
      nested: { a: 1 },
    })
    assert.deepEqual(Object.keys(out).sort(), ['client_name', 'outcome', 'tool'])
    assert.equal((out.client_name as string).length, 64)
  })
  test('an unknown event type keeps only the common properties', () => {
    assert.deepEqual(sanitizeProps('nope', { tool: 'x', os: 'linux' }), { os: 'linux' })
  })

  test('events carry ids and the context, no ip, at most 10 per request', async () => {
    const { t, sent } = make({ env: { LD_TELEMETRY_CLIENT: 'claude-code@2.1.0' } })
    for (let i = 0; i < 23; i++) t.track({ type: 'window_open', server: 'started', browser: 'opened' })
    await t.flush()
    assert.ok(sent.length >= 3)
    const events = sent.flatMap((s) => s.body.events)
    assert.equal(events.length, 21) // 20 + one telemetry_capped
    for (const s of sent) {
      assert.equal(s.url, AMPLITUDE_URL)
      assert.equal(s.body.api_key, KEY)
      assert.ok(s.body.events.length <= 10)
      assert.deepEqual(s.body.options, { min_id_length: 1 })
    }
    const e = events[0]!
    assert.equal(e.event_type, 'window_open')
    assert.equal('ip' in e, false)
    assert.match(e.insert_id, /^[0-9a-f-]{36}$/)
    assert.equal(e.device_id, t.deviceId)
    assert.equal(typeof e.session_id, 'number')
    assert.equal(e.event_properties.client_name, 'claude-code')
    assert.equal(e.event_properties.client_version, '2.1.0')
    assert.equal(e.event_properties.process, 'mcp')
    assert.equal(new Set(events.map((x) => x.insert_id)).size, events.length)
    t.close()
  })

  test('rate guard: repeats past the limit are dropped, one telemetry_capped is sent', async () => {
    const { t, sent } = make()
    for (let i = 0; i < 5; i++) t.track({ type: 'error_shown', code: 'device', target: 'android' })
    for (let i = 0; i < 5; i++) t.track({ type: 'error_shown', code: 'live_edit', target: 'android' })
    await t.flush()
    const events = sent.flatMap((s) => s.body.events)
    assert.equal(events.filter((e) => e.event_type === 'error_shown').length, 6)
    assert.equal(events.filter((e) => e.event_type === 'telemetry_capped').length, 1)
    t.close()
  })
})

describe('sending never throws', () => {
  const track = (t: Telemetry) => t.track({ type: 'mcp_started', external_server: false })

  test('fetch rejects', async () => {
    const { t, sent } = make({ reject: true })
    track(t)
    await t.flush()
    assert.equal(sent.length, 1)
    t.close()
  })
  test('429 is dropped, not retried', async () => {
    const { t, sent } = make({ statuses: [429] })
    track(t)
    await t.flush()
    assert.equal(sent.length, 1)
    t.close()
  })
  test('5xx is retried once with the same insert_id, then dropped', async () => {
    const { t, sent } = make({ statuses: [500, 503, 503] })
    track(t)
    await t.flush()
    assert.equal(sent.length, 2)
    assert.equal(sent[0]!.body.events[0]!.insert_id, sent[1]!.body.events[0]!.insert_id)
    t.close()
  })
  test('flush resolves by its deadline even when fetch hangs', async () => {
    const hang = (() => new Promise(() => {})) as unknown as typeof fetch
    const { t } = make({ fetchImpl: hang })
    track(t)
    // flush's deadline timer is unref'd so it never holds an exit; a hung fake fetch holds nothing,
    // so keep the loop alive here, as the open socket of a real hung fetch would.
    const keepAlive = setInterval(() => {}, 1_000)
    const started = Date.now()
    await t.flush(200)
    clearInterval(keepAlive)
    assert.ok(Date.now() - started < 1_000)
    t.close()
  })
})

describe('debug mode', () => {
  test('prints each event to stderr and never calls fetch, even with no key', async () => {
    const { t, sent, lines } = make({ apiKey: '', env: { LD_TELEMETRY_DEBUG: '1' } })
    assert.equal(t.enabled, true)
    t.track({ type: 'tool_called', tool: 'layout_snapshot', outcome: 'empty', duration: '<1s' })
    await t.flush()
    assert.equal(sent.length, 0)
    const line = lines.find((l) => l.startsWith(DEBUG_PREFIX))!
    const event = JSON.parse(line.slice(DEBUG_PREFIX.length)) as AmplitudeEvent
    assert.equal(event.event_type, 'tool_called')
    assert.equal(event.event_properties.outcome, 'empty')
  })
})

describe('opted out', () => {
  test('LD_TELEMETRY=0: nothing sent, no state file written, no notice', async () => {
    const { t, sent, lines, dir } = make({ env: { LD_TELEMETRY: '0' } })
    t.track({ type: 'mcp_started', external_server: false })
    await t.flush()
    assert.equal(t.enabled, false)
    assert.equal(sent.length, 0)
    assert.equal(lines.length, 0)
    assert.equal(readState(join(dir, 'telemetry.json')).status, 'missing')
  })
  test('empty key: nothing written', () => {
    const { t, dir } = make({ apiKey: '' })
    assert.equal(t.enabled, false)
    assert.equal(readState(join(dir, 'telemetry.json')).status, 'missing')
  })
  test('persisted off: disabled, and no device id is added to the file', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'telemetry.json'), '{"enabled": false}')
    const { t } = make({ env: { LD_TELEMETRY_DIR: dir } })
    assert.equal(t.enabled, false)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'telemetry.json'), 'utf8')), { enabled: false })
  })
})

describe('state file', () => {
  test('first run creates it with a uuid, prints the notice once and records it', () => {
    const first = make()
    const file = join(first.dir, 'telemetry.json')
    const state = readState(file)
    assert.equal(state.status, 'ok')
    assert.match(state.state.deviceId!, /^[0-9a-f-]{36}$/)
    assert.equal(first.t.deviceId, state.state.deviceId)
    assert.ok(state.state.noticeShownAt)
    assert.deepEqual(first.lines, [TELEMETRY_NOTICE])
    first.t.close()

    const second = make({ env: { LD_TELEMETRY_DIR: first.dir } })
    assert.equal(second.t.deviceId, first.t.deviceId)
    assert.deepEqual(second.lines, [])
    second.t.close()
  })
  test('a corrupt file: in-memory id, the file is left alone, no throw', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'telemetry.json'), '{not json')
    const { t } = make({ env: { LD_TELEMETRY_DIR: dir } })
    assert.equal(t.enabled, true)
    assert.match(t.deviceId, /^[0-9a-f-]{36}$/)
    assert.equal(readFileSync(join(dir, 'telemetry.json'), 'utf8'), '{not json')
    assert.equal(t.windowNoticePending(), false)
    t.close()
  })
  test('an unwritable location: in-memory id, no throw', () => {
    const blocker = join(freshDir())
    mkdirSync(tmpRoot, { recursive: true })
    writeFileSync(blocker, 'a file where the directory should be')
    const loaded = loadState(join(blocker, 'telemetry.json'))
    assert.equal(loaded.persisted, false)
    assert.match(loaded.state.deviceId!, /^[0-9a-f-]{36}$/)
  })
  test('loadState keeps the id another process wrote first', () => {
    const dir = freshDir()
    const file = join(dir, 'telemetry.json')
    const a = loadState(file, () => '11111111-1111-4111-8111-111111111111')
    const b = loadState(file, () => '22222222-2222-4222-8222-222222222222')
    assert.equal(a.state.deviceId, '11111111-1111-4111-8111-111111111111')
    assert.equal(b.state.deviceId, a.state.deviceId)
  })
  test('window notice: pending until dismissed', () => {
    const { t } = make()
    assert.equal(t.windowNoticePending(), true)
    t.dismissWindowNotice()
    assert.equal(t.windowNoticePending(), false)
    t.close()
  })
  test('telemetryDir per platform and the override', () => {
    assert.equal(telemetryDir({ LD_TELEMETRY_DIR: '/x' }, 'linux', '/home/u'), '/x')
    assert.equal(telemetryDir({ APPDATA: 'C:\\AppData' }, 'win32', 'C:\\u'), join('C:\\AppData', 'layout-debug-mcp'))
    assert.equal(telemetryDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/u'), join('/cfg', 'layout-debug-mcp'))
    assert.equal(telemetryDir({}, 'darwin', '/home/u'), join('/home/u', '.config', 'layout-debug-mcp'))
  })
})

describe('telemetryCommand (layout-debug-mcp telemetry)', () => {
  test('off writes enabled:false, on removes it, status reports reason, file and id', () => {
    const env = { LD_TELEMETRY_DIR: freshDir() }
    const file = join(env.LD_TELEMETRY_DIR, 'telemetry.json')
    const status0 = telemetryCommand('status', env, KEY)
    assert.match(status0.text, /Telemetry: enabled/)
    assert.match(status0.text, /not created yet/)
    assert.match(status0.text, /Device id: none yet/)

    assert.equal(telemetryCommand('off', env, KEY).code, 0)
    assert.equal(readState(file).state.enabled, false)
    assert.match(telemetryCommand('status', env, KEY).text, /Telemetry: disabled \(turned off with/)

    assert.equal(telemetryCommand('on', env, KEY).code, 0)
    assert.equal(readState(file).state.enabled, undefined)
    assert.match(telemetryCommand('status', env, KEY).text, /Telemetry: enabled/)
  })
  test('status names the env variable that turns it off', () => {
    const r = telemetryCommand('status', { LD_TELEMETRY_DIR: freshDir(), DO_NOT_TRACK: '1' }, KEY)
    assert.match(r.text, /disabled \(DO_NOT_TRACK is set\)/)
  })
  test('a corrupt state file is reported, not overwritten', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'telemetry.json'), 'nope')
    const r = telemetryCommand('off', { LD_TELEMETRY_DIR: dir }, KEY)
    assert.equal(r.code, 1)
    assert.match(r.text, /Could not write/)
  })
})

describe('helpers', () => {
  test('crashEvent keeps the class name and a short code, never the message', () => {
    const err = Object.assign(new RangeError('secret path C:/x'), { code: 'ERR_OUT_OF_RANGE' })
    assert.deepEqual(crashEvent(err), { type: 'crash', error_name: 'RangeError', error_code: 'ERR_OUT_OF_RANGE' })
    assert.deepEqual(crashEvent(Object.assign(new Error('x'), { code: 'not a code' })), { type: 'crash', error_name: 'Error' })
    assert.deepEqual(crashEvent('str'), { type: 'crash', error_name: 'string' })
  })
  test('parseClient splits name@version and caps both', () => {
    assert.deepEqual(parseClient('claude-code@2.1.0'), { client_name: 'claude-code', client_version: '2.1.0' })
    assert.deepEqual(parseClient('@scope/client@1.0'), { client_name: '@scope/client', client_version: '1.0' })
    assert.deepEqual(parseClient('cursor'), { client_name: 'cursor' })
    assert.equal(parseClient(''), null)
    assert.equal(parseClient(`${'n'.repeat(100)}@1`)!.client_name!.length, 64)
  })
})
