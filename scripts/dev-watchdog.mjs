import { spawnSync } from 'node:child_process'

/**
 * Started detached by scripts/dev.mjs: `node dev-watchdog.mjs <runnerPid> <parentPid> <childPid...>`.
 * Stops everything when either of these disappears without a normal stop:
 * - the runner (killed outright, so its own handlers never ran);
 * - the runner's parent (`npm` or its `cmd`/`sh`, killed on its own — Task Manager
 *   "End task" on npm, a tool that kills only the pid it spawned). The runner itself
 *   would keep running then, and so would its children.
 * It takes the runner and the children's process trees down and exits.
 * `parentPid` 0 means "no parent to watch". A normal stop kills this watchdog first,
 * so it never touches pids after a clean exit.
 */
const [runnerPid, parentPid, ...childPids] = process.argv.slice(2).map(Number)
const POLL_MS = 500
const IS_WIN = process.platform === 'win32'

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM' // exists, just not ours to signal
  }
}

function signal(pid, sig) {
  try {
    process.kill(pid, sig)
  } catch {
    // already gone
  }
}

if (
  !Number.isInteger(runnerPid) ||
  !Number.isInteger(parentPid) ||
  !childPids.length ||
  childPids.some((p) => !Number.isInteger(p))
) {
  // Nothing sensible to guard; dev.mjs always passes valid pids, so this is a misuse.
  process.exit(2)
}

const timer = setInterval(() => {
  const runnerGone = !alive(runnerPid)
  const parentGone = parentPid > 0 && !alive(parentPid)
  if (!runnerGone && !parentGone) return
  clearInterval(timer)
  const targets = [...(runnerGone ? [] : [runnerPid]), ...childPids].filter(alive)
  if (IS_WIN) {
    for (const pid of targets) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }
    process.exit(0)
  }
  // POSIX: the runner gets a plain SIGTERM (its handler stops the children cleanly);
  // dev.mjs starts each child in its own process group, so those are signalled as groups.
  if (!runnerGone) signal(runnerPid, 'SIGTERM')
  for (const pid of childPids) signal(-pid, 'SIGTERM')
  setTimeout(() => {
    if (!runnerGone) signal(runnerPid, 'SIGKILL')
    for (const pid of childPids) signal(-pid, 'SIGKILL')
    process.exit(0)
  }, 1500)
}, POLL_MS)
