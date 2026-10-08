/**
 * Where the package lives on disk. The same code runs from `src/**` (tsx, in a
 * checkout) and bundled into `dist/**` (the npm package), at different depths, so
 * the root is found by walking up to our own package.json instead of counting `..`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'layout-debug-mcp'

/** Nearest ancestor of `fromFile` whose package.json is named layout-debug-mcp. */
export function findPackageRoot(fromFile: string): string {
  let dir = dirname(fromFile)
  for (;;) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name === PACKAGE_NAME) return dir
      } catch {
        // A broken package.json on the way up is not ours; keep walking.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`[layout-debug] cannot find the ${PACKAGE_NAME} package root above ${fromFile}`)
    }
    dir = parent
  }
}

export const PACKAGE_ROOT = findPackageRoot(fileURLToPath(import.meta.url))

export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }
).version

/** True when this code runs from TypeScript sources (a checkout via tsx), not from dist. */
export const RUNNING_FROM_SOURCE = fileURLToPath(import.meta.url).endsWith('.ts')

/** Built window, inspector bundle and the demo page. */
export const UI_DIST_DIR = join(PACKAGE_ROOT, 'dist', 'ui')
export const INSPECTOR_BUNDLE = join(PACKAGE_ROOT, 'dist', 'inspector', 'inspector.js')
export const DEMO_DIR = join(PACKAGE_ROOT, 'demo')
