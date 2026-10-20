import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { parsePort, uiOriginsFor } from './ports.ts'

describe('parsePort', () => {
  test('unset or empty — the default', () => {
    assert.equal(parsePort(undefined, 'LD_X', 5175), 5175)
    assert.equal(parsePort('', 'LD_X', 5175), 5175)
    assert.equal(parsePort('   ', 'LD_X', 5175), 5175)
  })
  test('a valid port is accepted, surrounding spaces are trimmed', () => {
    assert.equal(parsePort('5185', 'LD_X', 5175), 5185)
    assert.equal(parsePort(' 1 ', 'LD_X', 5175), 1)
    assert.equal(parsePort('65535', 'LD_X', 5175), 65535)
  })
  for (const bad of ['0', '65536', '-1', '51.5', '5e3', 'abc', '5175abc', '0x1F90', '+5175']) {
    test(`"${bad}" — an error naming the variable, not a silent default`, () => {
      assert.throws(() => parsePort(bad, 'LD_SERVER_PORT', 5175), /LD_SERVER_PORT="[^"]*" — expected an integer port number/)
    })
  }
})

test('uiOriginsFor gives both loopback names for the window port', () => {
  assert.deepEqual(uiOriginsFor(5184), ['http://localhost:5184', 'http://127.0.0.1:5184'])
})

/**
 * Ports resolve once at module load, so the overridden case runs in a child
 * process with its own env: the same strict Host/Origin checks, but on the new
 * ports — and the defaults are no longer let in.
 */
describe('Host/Origin checks on ports from env', () => {
  const securityUrl = new URL('../server/security.ts', import.meta.url).href
  const portsUrl = new URL('./ports.ts', import.meta.url).href
  const run = (env: Record<string, string>, script: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, LD_UI_PORT: '', LD_SERVER_PORT: '', ...env },
      encoding: 'utf8',
    })

  test('LD_SERVER_PORT=5185 LD_UI_PORT=5184: the new ports are let in, the defaults are not', () => {
    const script = `
      import { checkWsUpgrade, checkStaticRequest } from ${JSON.stringify(securityUrl)}
      const v = (x) => x.ok
      console.log(JSON.stringify({
        newServer: v(checkStaticRequest({ host: '127.0.0.1:5185' })),
        newUiProxy: v(checkWsUpgrade({ host: 'localhost:5184', origin: 'http://localhost:5184' })),
        oldServerHost: v(checkStaticRequest({ host: '127.0.0.1:5175' })),
        oldUiHost: v(checkStaticRequest({ host: 'localhost:5174' })),
        oldUiOrigin: v(checkWsUpgrade({ host: '127.0.0.1:5185', origin: 'http://localhost:5174' })),
        evilOrigin: v(checkWsUpgrade({ host: '127.0.0.1:5185', origin: 'https://evil.example' })),
      }))`
    const r = run({ LD_SERVER_PORT: '5185', LD_UI_PORT: '5184' }, script)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), {
      newServer: true,
      newUiProxy: true,
      oldServerHost: false,
      oldUiHost: false,
      oldUiOrigin: false,
      evilOrigin: false,
    })
  })

  test('an invalid LD_SERVER_PORT fails the module load with a clear error', () => {
    const r = run({ LD_SERVER_PORT: 'abc' }, `import ${JSON.stringify(portsUrl)}`)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /LD_SERVER_PORT="abc" — expected an integer port number from 1 to 65535/)
  })

  test('the same LD_UI_PORT and LD_SERVER_PORT — an error', () => {
    const r = run({ LD_SERVER_PORT: '5190', LD_UI_PORT: '5190' }, `import ${JSON.stringify(portsUrl)}`)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /are the same \(5190\)/)
  })
})
