/**
 * `layout-debug-mcp/vite`: `apply: 'serve'`, so `vite build` never sees it. It runs
 * the Babel plugin from sourceLoc.ts on .jsx/.tsx before any other transform,
 * through the project's own @babel/core (optional peer dependency).
 */
import type { Plugin, Rollup } from 'vite'
import { createSourceLocPlugin, resolveRoot, type BabelApi, type SourceLocOptions } from './sourceLoc.ts'

export { SOURCE_LOC_ATTR, isHostTag, sourceLocValue } from './sourceLoc.ts'
export type { SourceLocOptions } from './sourceLoc.ts'

/** The part of @babel/core the plugin calls; Babel 7 and 8 share it. */
export interface BabelCore {
  transformAsync(
    code: string,
    options: Record<string, unknown>,
  ): Promise<{ code?: string | null; map?: unknown } | null>
}

const JSX_FILE = /\.[jt]sx$/

export const MISSING_BABEL =
  'layout-debug-mcp/vite needs @babel/core to read JSX, and it is not installed in this project. ' +
  'Install it as a dev dependency: npm i -D @babel/core'

async function loadBabel(): Promise<BabelCore> {
  let mod: Partial<BabelCore> & { default?: Partial<BabelCore> }
  try {
    mod = await import('@babel/core' as string)
  } catch (err) {
    throw new Error(`${MISSING_BABEL} (${(err as Error).message.split('\n')[0]})`)
  }
  const babel = typeof mod.transformAsync === 'function' ? mod : mod.default
  if (typeof babel?.transformAsync !== 'function') throw new Error(`${MISSING_BABEL} (no transformAsync export)`)
  return babel as BabelCore
}

/**
 * Pure source in -> source out (plus a source map). `null` when the file has no
 * JSX to touch, or when Babel can't parse it: then `warn` gets the file and the
 * Babel error, and the module is served unchanged instead of failing in dev.
 * Only Babel's syntax plugins are used: TS and JSX stay as they are for the
 * transforms after this one.
 */
export async function transformSourceLoc(
  babel: BabelCore,
  code: string,
  filename: string,
  root: string,
  warn: (message: string) => void,
): Promise<{ code: string; map: unknown } | null> {
  if (!code.includes('<')) return null
  const base = filename.endsWith('.tsx') ? ['jsx', 'typescript'] : ['jsx']
  // TS-style decorators first (MobX, parameter decorators), then the standard
  // ones, which also allow `export @dec class`. Each rejects what the other takes.
  const variants: unknown[][] = code.includes('@') ? [[...base, 'decorators-legacy'], [...base, 'decorators']] : [base]
  let error: unknown
  for (const plugins of variants) {
    try {
      const result = await babel.transformAsync(code, {
        filename,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        parserOpts: { plugins },
        plugins: [(api: BabelApi) => createSourceLocPlugin(api, { root }, true)],
      })
      if (!result?.code) return null
      return { code: result.code, map: result.map ?? null }
    } catch (err) {
      error = err
    }
  }
  const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
  warn(`[layout-debug-mcp/vite] no data-source-loc in ${filename}: Babel could not parse it (${reason}). The file is served unchanged.`)
  return null
}

export default function layoutDebugSourceLoc(options: SourceLocOptions = {}): Plugin {
  let root = resolveRoot(options.root, process.cwd())
  let babel: BabelCore | undefined
  const warned = new Set<string>()
  return {
    name: 'layout-debug-mcp:source-loc',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      root = resolveRoot(options.root, config.root)
    },
    async buildStart() {
      // Fails the dev server start with the install command instead of serving
      // pages without the attribute.
      babel = await loadBabel()
    },
    async transform(code, id) {
      const file = id.split('?', 1)[0]!
      if (!JSX_FILE.test(file) || file.includes('/node_modules/') || file.startsWith('\0')) return null
      babel ??= await loadBabel()
      // Once per file, not on every edit of a file that keeps failing.
      const out = await transformSourceLoc(babel, code, file, root, (message) => {
        if (warned.has(file)) return
        warned.add(file)
        this.warn(message)
      })
      return out && { code: out.code, map: out.map as Rollup.SourceMapInput }
    },
  }
}
