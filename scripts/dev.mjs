import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolved from this file, so the runner works no matter where it was invoked from. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Three processes, one terminal: inspector bundle (watched), Node server, UI dev
 * server. No extra dependency for this — a runner is not worth a package.
 */
const tasks = [
  { name: 'inspector', cmd: 'npx vite build --config vite.inspector.config.ts --watch --logLevel warn' },
  { name: 'server', cmd: 'npx tsx watch src/server/index.ts' },
  { name: 'ui', cmd: 'npx vite' },
]

const children = tasks.map(({ name, cmd }) => {
  const child = spawn(cmd, { shell: true, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  const prefix = `[${name}] `
  const pipe = (stream, out) => {
    stream.setEncoding('utf8')
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) out.write(prefix + line + '\n')
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`${prefix}упал с кодом ${code}`)
  })
  return child
})

const shutdown = () => {
  for (const child of children) child.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
