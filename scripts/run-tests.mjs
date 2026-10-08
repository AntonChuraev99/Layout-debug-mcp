import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `npm test`: every src/**\/*.test.ts under `node --test`. The files are listed here
 * instead of passing a glob, because `node --test` expands globs only since Node 21
 * and package.json still supports Node ^20.19 (and npm on Windows runs scripts
 * through cmd, which does not expand them either). Extra args go to `node --test`
 * (e.g. `npm test -- --test-name-pattern=session`).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function find(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : find(path)
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
  })
}

const files = find(join(ROOT, 'src'))
  .map((f) => relative(ROOT, f))
  .sort()
if (!files.length) {
  console.error(`[test] no *.test.ts files under ${join(ROOT, 'src')}`)
  process.exit(1)
}

const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files], {
  cwd: ROOT,
  stdio: 'inherit',
  // Tests never send telemetry; the servers and bins they spawn inherit this.
  env: { ...process.env, LD_TELEMETRY: '0', LD_TELEMETRY_DEBUG: '' },
})
if (r.error) {
  console.error(`[test] could not start node --test: ${r.error.message}`)
  process.exit(1)
}
process.exit(r.status ?? 1)
