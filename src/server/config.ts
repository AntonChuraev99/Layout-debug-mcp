import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parsePort, SERVER_PORT } from '../shared/ports.ts'
import type { TargetKind } from '../shared/protocol.ts'

export interface Config {
  /** Which adapter drives the frame. */
  target: TargetKind
  /** Web target: page to inspect. Defaults to the bundled demo so the tool runs out of the box. */
  targetUrl: string
  /**
   * Absolute path of the project being debugged. Display only: the window shortens
   * file paths against it. Defaults to the directory the server was started from
   * (`open_window` starts it from the MCP client's working directory).
   */
  projectDir: string
  /** Android target: port the on-device agent listens on, forwarded via adb. */
  androidPort: number
  /** Android target: `adb -s <serial>`. Null lets adb pick when exactly one device is attached. */
  device: string | null
  /** The config file that was read, or null when there is none. */
  configFile: string | null
  /** Exit after this long with no window and no waiting agent; 0 keeps running. */
  idleExitMs: number
}

type Env = Record<string, string | undefined>

export const CONFIG_FILE_NAME = 'layout-debug.config.json'
const DEFAULT_ANDROID_PORT = 8790

/** Every config problem is fatal at start: a typo must not silently become a default. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`[layout-debug] ${message}`)
    this.name = 'ConfigError'
  }
}

/** An env var set to an empty string means "not set", not "set to nothing". */
function value(raw: string | undefined): string | undefined {
  return raw && raw.trim() ? raw.trim() : undefined
}

interface FileConfig {
  target?: unknown
  targetUrl?: unknown
  projectDir?: unknown
  androidPort?: unknown
  device?: unknown
}

/**
 * Config for the server: `layout-debug.config.json` from `cwd` (or the file named by
 * LD_CONFIG), then LD_* variables on top. Throws ConfigError on anything invalid.
 */
export function loadConfig(cwd: string = process.cwd(), env: Env = process.env): Config {
  const explicit = value(env.LD_CONFIG)
  const path = resolve(cwd, explicit ?? CONFIG_FILE_NAME)
  const file = readConfigFile(path, Boolean(explicit))
  const from = (key: string) => `"${key}" in ${path}`

  const target = value(env.LD_TARGET) ?? optionalString(file.data.target, from('target')) ?? 'web'
  if (target !== 'web' && target !== 'android') {
    const source = value(env.LD_TARGET) ? 'LD_TARGET' : from('target')
    throw new ConfigError(`${source} is "${target}"; expected "web" or "android"`)
  }

  const fileProjectDir = optionalString(file.data.projectDir, from('projectDir'))
  const projectDir = value(env.LD_PROJECT_DIR)
    ? resolve(cwd, value(env.LD_PROJECT_DIR)!)
    : fileProjectDir
      ? resolve(dirname(path), fileProjectDir)
      : resolve(cwd)

  let fileAndroidPort: number | undefined
  if (file.data.androidPort !== undefined) {
    const p = file.data.androidPort
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) {
      throw new ConfigError(`${from('androidPort')} is ${JSON.stringify(p)}; expected an integer port number from 1 to 65535`)
    }
    fileAndroidPort = p
  }
  let androidPort: number
  try {
    androidPort = parsePort(env.LD_ANDROID_PORT, 'LD_ANDROID_PORT', fileAndroidPort ?? DEFAULT_ANDROID_PORT)
  } catch (err) {
    throw new ConfigError((err as Error).message.replace(/^\[layout-debug\] /, ''))
  }

  return {
    target,
    targetUrl:
      value(env.LD_TARGET_URL) ??
      optionalString(file.data.targetUrl, from('targetUrl')) ??
      `http://127.0.0.1:${SERVER_PORT}/demo/`,
    projectDir,
    androidPort,
    device: value(env.LD_DEVICE) ?? optionalString(file.data.device, from('device')) ?? null,
    configFile: file.found ? path : null,
    idleExitMs: parseIdleMinutes(env.LD_IDLE_EXIT_MINUTES) * 60_000,
  }
}

function optionalString(v: unknown, where: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ConfigError(`${where} is ${JSON.stringify(v)}; expected a string`)
  return v.trim() || undefined
}

/** LD_IDLE_EXIT_MINUTES: unset → 0 (keep running); otherwise a whole number of minutes. */
export function parseIdleMinutes(raw: string | undefined): number {
  const v = value(raw)
  if (!v) return 0
  if (!/^\d+$/.test(v)) {
    throw new ConfigError(`LD_IDLE_EXIT_MINUTES="${raw}"; expected a whole number of minutes (0 keeps the server running)`)
  }
  return Number(v)
}

function readConfigFile(path: string, required: boolean): { found: boolean; data: FileConfig } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && !required) return { found: false, data: {} }
    if (code === 'ENOENT') throw new ConfigError(`LD_CONFIG points at ${path}, which does not exist`)
    throw new ConfigError(`could not read ${path}: ${(err as Error).message}`)
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ConfigError(`${path} must contain a JSON object`)
  }
  return { found: true, data: data as FileConfig }
}
