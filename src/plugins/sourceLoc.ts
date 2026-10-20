import { posix, resolve } from 'node:path'

/**
 * Dev-only `data-source-loc="src/App.tsx:42"` on host JSX elements, so the web
 * inspector (src/inspector/index.ts) can hand the agent a `file:line` anchor.
 * React 19 dropped `_debugSource`, so the page has to carry it itself.
 *
 * The transform is a Babel plugin. The Next.js / webpack entry (babel.ts) is that
 * plugin as is; the Vite entry (vite.ts) runs it through the project's own
 * `@babel/core`, an optional peer dependency, so the MCP install never pulls Babel.
 */
export const SOURCE_LOC_ATTR = 'data-source-loc'

export interface SourceLocOptions {
  /** Paths in the attribute are relative to this folder. Default: Vite's root / Babel's root (cwd). */
  root?: string
}

/** `<div>`, `<svg>`, `<my-element>`: what React renders as a DOM node. Not `<App>`, `<ui.Button>`, `<svg:rect>`. */
export function isHostTag(name: string): boolean {
  return /^[a-z]/.test(name)
}

/** `C:\proj\src\A.tsx` -> `/c:/proj/src/A.tsx`, `/home/x/a.tsx` stays: one posix form for both OSes. */
function toPosix(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const drive = /^([a-zA-Z]):\//.exec(slashed)
  return drive ? `/${drive[1]!.toLowerCase()}:${slashed.slice(2)}` : slashed
}

/**
 * `relative/path.tsx:line`, always with `/`. Never an absolute path (it would leak
 * the user name into the DOM): a file on another drive than the root gets its bare
 * file name instead.
 */
export function sourceLocValue(filename: string, root: string, line: number): string {
  // A relative root here would never match the absolute file: callers pass resolveRoot().
  const file = toPosix(filename)
  const base = toPosix(root)
  let rel = file.startsWith('/') && base.startsWith('/') ? posix.relative(base, file) : posix.basename(file)
  if (!rel || rel.includes(':')) rel = posix.basename(file)
  return `${rel}:${line}`
}

/**
 * The user's `{ root }` against the bundler's own root: `'../..'` or `'packages\\web'`
 * become absolute (posix form), an absolute one stays. `base` is absolute already
 * (Vite's root, Babel's cwd); a relative one is resolved against the process cwd.
 */
export function resolveRoot(root: string | undefined, base: string): string {
  let b = toPosix(base)
  if (!b.startsWith('/')) b = toPosix(resolve(base))
  return root === undefined ? b : posix.resolve(b, toPosix(root))
}

/** Babel's own rule (`BABEL_ENV || NODE_ENV`), minus its `development` fallback when both are unset. */
export function explicitEnv(env: Record<string, string | undefined>): string | undefined {
  return env.BABEL_ENV || env.NODE_ENV || undefined
}

export const NO_ENV_WARNING =
  '[layout-debug-mcp/babel] data-source-loc is off: neither NODE_ENV nor BABEL_ENV is set, so this may be a ' +
  'production build (e.g. `webpack --mode production` does not set NODE_ENV for Babel). ' +
  'To get file:line in dev, run the dev server with NODE_ENV=development.'

// The few Babel shapes the plugin touches. Typed here so the package needs no
// @babel/* types; the real objects come from the user's Babel 7 or 8.
interface JsxName {
  type: string
  name?: unknown
}
interface JsxOpeningElement {
  name: JsxName
  attributes: Array<{ type: string; name?: JsxName }>
  loc?: { start: { line: number } } | null
}
interface BabelTypes {
  jsxAttribute(name: unknown, value: unknown): JsxOpeningElement['attributes'][number]
  jsxIdentifier(name: string): unknown
  stringLiteral(value: string): unknown
}
export interface BabelApi {
  types: BabelTypes
  cache?: { using?(fn: () => string): unknown }
}
interface PluginState {
  filename?: string
  cwd?: string
  file?: { opts?: { root?: string } }
}

export type SourceLocBabelOptions = SourceLocOptions

let warnedNoEnv = false

/**
 * The public Babel plugin (`layout-debug-mcp/babel`). Active only when the env is
 * explicitly `development`: Babel's `api.env()` falls back to `development` when
 * NODE_ENV and BABEL_ENV are unset, which is the case in `webpack --mode
 * production` with babel-loader, so the attribute would ship. Unset -> off, and
 * one warning that says how to turn it on.
 */
export function sourceLocBabelPlugin(api: BabelApi, options: SourceLocBabelOptions = {}) {
  // Babel passes (api, options, dirname): the env and the warn sink can't be extra params.
  return envGatedPlugin(api, options, process.env, console.warn)
}

/** sourceLocBabelPlugin with the env and warn sink passed in (unit tests). */
export function envGatedPlugin(
  api: BabelApi,
  options: SourceLocBabelOptions,
  env: Record<string, string | undefined>,
  warn: (message: string) => void,
) {
  const name = explicitEnv(env)
  api.cache?.using?.(() => name ?? '')
  if (name === undefined && !warnedNoEnv) {
    warnedNoEnv = true
    warn(NO_ENV_WARNING)
  }
  return createSourceLocPlugin(api, options, name === 'development')
}

/** For tests: lets the "warn once" path run again. */
export function resetNoEnvWarning(): void {
  warnedNoEnv = false
}

/**
 * Internal: the Vite entry calls this with `active = true`, since `apply: 'serve'`
 * already keeps it out of builds. Not part of the published API.
 */
export function createSourceLocPlugin(api: Pick<BabelApi, 'types'>, options: SourceLocOptions, active: boolean) {
  const t = api.types
  return {
    name: 'layout-debug-mcp-source-loc',
    visitor: !active
      ? {}
      : {
          JSXOpeningElement(path: { node: JsxOpeningElement }, state: PluginState) {
            const node = path.node
            if (node.name.type !== 'JSXIdentifier' || typeof node.name.name !== 'string') return
            if (!isHostTag(node.name.name)) return
            const has = node.attributes.some(
              (a) => a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === SOURCE_LOC_ATTR,
            )
            const line = node.loc?.start.line
            // Generated JSX has no line and an in-memory transform no file name:
            // nothing true to write, so the element keeps the other anchors.
            if (has || !line || !state.filename) return
            const root = resolveRoot(options.root, state.file?.opts?.root ?? state.cwd ?? process.cwd())
            // First, so a later explicit attribute or `{...props}` still wins.
            node.attributes.unshift(
              t.jsxAttribute(t.jsxIdentifier(SOURCE_LOC_ATTR), t.stringLiteral(sourceLocValue(state.filename, root, line))),
            )
          },
        },
  }
}
