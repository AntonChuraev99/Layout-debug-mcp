import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SERVER_PORT } from '../shared/ports.ts'
import type { TargetKind } from '../shared/protocol.ts'

export interface Config {
  /** Which adapter drives the frame. */
  target: TargetKind
  /** Web target: page to inspect. Defaults to the bundled demo so the tool runs out of the box. */
  targetUrl: string
  /** Repo the agent is allowed to edit. Without it the chat is disabled and requests only queue up. */
  projectDir: string | null
  /** Android target: port the on-device agent listens on, forwarded via adb. */
  androidPort: number
  /** Android target: `adb -s <serial>`. Null lets adb pick when exactly one device is attached. */
  device: string | null
}

const DEFAULTS: Config = {
  target: 'web',
  targetUrl: `http://localhost:${SERVER_PORT}/demo/`,
  projectDir: null,
  androidPort: 8790,
  device: null,
}

/** An env var set to an empty string means "not set", not "set to nothing". */
function env(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined
}

export function loadConfig(cwd = process.cwd()): Config {
  const fromFile = readConfigFile(resolve(cwd, 'layout-debug.config.json'))
  const target = env(process.env.LD_TARGET) ?? fromFile.target ?? DEFAULTS.target
  return {
    target: target === 'android' ? 'android' : 'web',
    targetUrl: env(process.env.LD_TARGET_URL) ?? fromFile.targetUrl ?? DEFAULTS.targetUrl,
    projectDir: env(process.env.LD_PROJECT_DIR) ?? fromFile.projectDir ?? DEFAULTS.projectDir,
    androidPort:
      Number(env(process.env.LD_ANDROID_PORT)) || fromFile.androidPort || DEFAULTS.androidPort,
    device: env(process.env.LD_DEVICE) ?? fromFile.device ?? DEFAULTS.device,
  }
}

function readConfigFile(path: string): Partial<Config> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    // A malformed config is worth shouting about — silently falling back to
    // defaults would look like the file was ignored.
    console.error(`[layout-debug] не смог прочитать ${path}: ${(err as Error).message}`)
    return {}
  }
}
