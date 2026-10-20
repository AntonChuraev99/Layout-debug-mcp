export interface SourceLocBabelOptions {
  /** Paths in `data-source-loc` are relative to this folder (absolute, or relative to Babel's root). Default: Babel's root (the cwd). */
  root?: string
}

export declare const SOURCE_LOC_ATTR: 'data-source-loc'
export declare function isHostTag(name: string): boolean
export declare function sourceLocValue(filename: string, root: string, line: number): string

/**
 * Babel plugin: adds `data-source-loc="src/App.tsx:42"` to host JSX elements, only
 * when `BABEL_ENV` (else `NODE_ENV`) is explicitly `development`. Neither set: off, with one warning.
 */
declare function sourceLocBabelPlugin(api: { types: unknown }, options?: SourceLocBabelOptions): { name: string; visitor: object }
export default sourceLocBabelPlugin
