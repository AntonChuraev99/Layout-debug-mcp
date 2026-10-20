import type { Plugin } from 'vite'

export interface SourceLocOptions {
  /** Paths in `data-source-loc` are relative to this folder (absolute, or relative to Vite's `root`). Default: Vite's `root`. */
  root?: string
}

export declare const SOURCE_LOC_ATTR: 'data-source-loc'
export declare function isHostTag(name: string): boolean
export declare function sourceLocValue(filename: string, root: string, line: number): string

/** Dev-only (`apply: 'serve'`): adds `data-source-loc="src/App.tsx:42"` to host JSX elements. Needs `@babel/core`. */
export default function layoutDebugSourceLoc(options?: SourceLocOptions): Plugin
