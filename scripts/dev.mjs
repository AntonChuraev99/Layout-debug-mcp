import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isServerReadyLine, serverFailureReason } from '../src/shared/devMarkers.mjs'

/** Resolved from this file, so the runner works no matter where it was invoked from. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WIN = process.platform === 'win32'

/**
 * `tsx watch` does not exit when the server does — it waits for a file change — so a
 * server that could not start would leave the runner half alive. The server prints a
 * ready / failed line (src/shared/devMarkers.mjs), and Node itself ends an uncaught
 * exception with a `Node.js v24.19.0` trailer on stderr: tsx watch adds no line of its
 * own when its child dies (checked with tsx 4.23 by running a throwing script).
 * Before the first ready, either failure ends the session. After it, the failure is a
 * restart after a save gone wrong: say so and keep running, tsx retries on the next save.
 */
const NODE_CRASH_TRAILER = /^Node\.js v\d+\.\d+\.\d+$/
/** The message line of an uncaught throw ("Error: …", "TypeError: …", "Error [ERR_X]: …"). */
const CRASH_MESSAGE = /^(?:[A-Z]\w*)?(?:Error|Exception)\b[^:]*:\s/
/** tsx watch starting the script again after a save. */
const TSX_RERUN = /\[tsx\].*(?:Rerunning|Restarting)/
/**
 * A server that has printed nothing definite by now is slow, not necessarily dead: a cold
 * first start on Windows (antivirus scanning node_modules) can take this long. Warn, keep going.
 */
const SERVER_READY_WARN_MS = 60_000
const ANSI = /\x1b\[[0-9;]*m/g
const ERROR_LINE = /error|failed|cannot/i
const STRONG_ERROR_LINE = /in use|EADDRINUSE|EACCES|permission denied/i

/** Entry script of a package's bin, run with this same `node` — no shell, no npx. */
function bin(pkg, name = pkg) {
  const manifest = join(ROOT, 'node_modules', pkg, 'package.json')
  if (!existsSync(manifest)) {
    console.error(`[dev] ${pkg} is not installed (${manifest} is missing). Run npm install in ${ROOT}.`)
    process.exit(1)
  }
  const field = JSON.parse(readFileSync(manifest, 'utf8')).bin
  const rel = typeof field === 'string' ? field : field?.[name]
  if (!rel) {
    console.error(`[dev] ${pkg} has no "${name}" bin in its package.json; reinstall it: npm install`)
    process.exit(1)
  }
  return join(ROOT, 'node_modules', pkg, rel)
}

const VITE = bin('vite')
const TSX = bin('tsx')

/**
 * Three processes, one terminal: inspector bundle (watched), Node server, UI dev
 * server. No extra dependency for this — a runner is not worth a package.
 * Spawned as `node <bin>` without a shell: on Windows a shell (or npx.cmd) sits
 * between us and node, and killing it leaves node holding the ports.
 */
const tasks = [
  { name: 'inspector', args: [VITE, 'build', '--config', 'vite.inspector.config.ts', '--watch', '--logLevel', 'warn'] },
  // LD_DEV=1: the window lives on Vite (LD_UI_PORT), not on the server's own port.
  { name: 'server', args: [TSX, 'watch', 'src/server/index.ts'], watched: true, env: { LD_DEV: '1' } },
  { name: 'ui', args: [VITE] },
]

let stopping = false
/** Assigned once the children run; stop() may fire before that. */
let watchdog = null
const running = new Set()

/** The whole tree: tsx watch runs the server as its own child, Vite runs esbuild. */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  if (IS_WIN) {
    const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
    // 128 = "process not found": it exited between the check and the call.
    if (r.status !== 0 && r.status !== 128) {
      console.error(`[dev] could not stop pid ${child.pid}: ${(r.stderr || r.error?.message || '').trim()}`)
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM') // detached → its own process group
    } catch (err) {
      if (err.code !== 'ESRCH') console.error(`[dev] could not stop pid ${child.pid}: ${err.message}`)
    }
  }
}

function stop(code, reason) {
  if (stopping) return
  stopping = true
  if (reason) console.error(`[dev] ${reason}`)
  watchdog?.kill()
  for (const child of running) killTree(child)
  if (!running.size) process.exit(code)
  const done = () => {
    if (!running.size) process.exit(code)
  }
  for (const child of running) child.once('exit', done)
  // POSIX: whatever ignored SIGTERM gets SIGKILL; Windows taskkill /F is already final.
  setTimeout(() => {
    if (!IS_WIN) {
      for (const child of running) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
    process.exit(code)
  }, 3000).unref()
}

const children = tasks.map((task) => {
  const prefix = `[${task.name}] `
  const child = spawn(process.execPath, task.args, {
    cwd: ROOT,
    env: { ...process.env, ...task.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX: own process group, so the whole tree can be signalled at once.
    detached: !IS_WIN,
    windowsHide: true,
  })
  running.add(child)
  let lastError = ''
  let ready = !task.watched
  let warnedSlow = false
  const readyTimer = task.watched
    ? setTimeout(() => {
        if (ready || stopping) return
        warnedSlow = true
        console.error(
          `[dev] ${task.name} has not reported ready in ${SERVER_READY_WARN_MS / 1000} s. Still waiting: a cold first ` +
            'start on Windows can take this long. If the ' +
            `${prefix.trim()} lines above show an error, fix it and save the file (tsx watch starts it again), ` +
            'or stop with Ctrl+C.',
        )
      }, SERVER_READY_WARN_MS)
    : null

  // The reason quoted when the task dies: the first error-looking stderr line
  // ("Port 5174 is already in use"), not the last stack frame.
  let firstError = ''
  let strongError = ''
  let crashMessage = ''
  const reason = () => strongError || crashMessage || firstError || lastError
  const resetReason = () => {
    firstError = strongError = crashMessage = lastError = ''
  }
  /** A definite failure of a watched task: fatal before its first ready, reported after. */
  const failed = (why) => {
    if (!ready) {
      stop(1, `${task.name} failed to start: ${why}\n[dev] stopped the other processes; run npm run dev again once that is fixed.`)
      return
    }
    console.error(
      `[dev] ${task.name} stopped after a restart: ${why}\n` +
        `[dev] the window and the inspector keep running; fix the error and save, tsx watch starts the ${task.name} again.`,
    )
    resetReason()
  }
  const onLine = (raw, isErr) => {
    const line = raw.replace(ANSI, '')
    const trimmed = line.trim()
    if (isErr) {
      lastError = trimmed
      if (!strongError && STRONG_ERROR_LINE.test(line)) strongError = trimmed
      if (!firstError && ERROR_LINE.test(line)) firstError = trimmed
      if (CRASH_MESSAGE.test(trimmed)) crashMessage = trimmed
    }
    if (!task.watched) return
    if (TSX_RERUN.test(line)) {
      resetReason()
      return
    }
    if (isServerReadyLine(line)) {
      if (!ready && warnedSlow) console.error(`[dev] ${task.name} is ready after all.`)
      ready = true
      if (readyTimer) clearTimeout(readyTimer)
      return
    }
    const failure = serverFailureReason(line)
    if (failure !== null) {
      failed(failure || reason())
      return
    }
    if (isErr && NODE_CRASH_TRAILER.test(trimmed)) failed(`crashed: ${reason() || 'see the lines above'}`)
  }
  const pipe = (stream, out, isErr) => {
    stream.setEncoding('utf8')
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        if (!line.trim()) continue
        out.write(prefix + line + '\n')
        onLine(line, isErr)
      }
    })
  }
  pipe(child.stdout, process.stdout, false)
  pipe(child.stderr, process.stderr, true)

  child.on('error', (err) => {
    running.delete(child)
    stop(1, `${task.name} could not be started: ${err.message}`)
  })
  child.on('exit', (code, signal) => {
    running.delete(child)
    if (readyTimer) clearTimeout(readyTimer)
    if (stopping) return
    // Let the last stderr chunk reach onLine before quoting it.
    setTimeout(() => {
      const how = signal ? `was killed (${signal})` : `exited with code ${code}`
      stop(
        1,
        `${task.name} ${how}${reason() ? `: ${reason()}` : ''}\n` +
          '[dev] stopped the other processes; run npm run dev again once that is fixed.',
      )
    }, 100)
  })
  return child
})

/**
 * If this runner is killed outright (TerminateProcess on Windows, SIGKILL), no
 * handler below runs and the children would keep the ports. If only its parent
 * (`npm run dev` → npm, cmd/sh) is killed, this runner gets no signal at all and
 * keeps running. A detached watchdog notices either and takes everything down.
 * The parent is captured now: on POSIX `process.ppid` changes once it is gone.
 */
function parentToWatch() {
  const ppid = process.ppid
  // Already gone, or init/launchd (POSIX re-parenting): nothing meaningful to watch.
  if (!ppid || ppid === 1) return 0
  try {
    process.kill(ppid, 0)
    return ppid
  } catch (err) {
    return err.code === 'EPERM' ? ppid : 0
  }
}

const WATCHDOG_OFF = 'if this runner or its npm parent is killed outright, end its node processes by hand.'
const childPids = children.map((c) => c.pid)
// A child without a pid failed to spawn: its 'error' handler is already stopping the
// runner, and the watchdog would only reject an "undefined" argument.
if (childPids.every((pid) => Number.isInteger(pid))) {
  watchdog = spawn(
    process.execPath,
    [join(ROOT, 'scripts', 'dev-watchdog.mjs'), String(process.pid), String(parentToWatch()), ...childPids.map(String)],
    { detached: true, stdio: 'ignore', windowsHide: true },
  )
  watchdog.on('error', (err) => console.error(`[dev] watchdog did not start (${err.message}); ${WATCHDOG_OFF}`))
  watchdog.on('exit', (code, signal) => {
    // stop() kills it on purpose; exit 0 means it noticed the runner or its parent die
    // and is taking the tree down, so this runner is on its way out anyway.
    if (stopping || code === 0) return
    const how = signal ? `was killed (${signal})` : code === 2 ? 'rejected its arguments (exit 2)' : `exited with code ${code}`
    console.error(`[dev] watchdog ${how}; the dev session keeps running, but ${WATCHDOG_OFF}`)
  })
  watchdog.unref()
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
process.on('SIGHUP', () => stop(0)) // terminal closed (on Windows: console window closed)
if (IS_WIN) process.on('SIGBREAK', () => stop(0))
process.on('uncaughtException', (err) => stop(1, `runner crashed: ${err.stack ?? err.message}`))
// Last resort for any path that exits without stop().
process.on('exit', () => {
  for (const child of running) killTree(child)
})
