/**
 * `layout-debug-mcp/babel`: Babel plugin for Next.js (webpack or Turbopack with a
 * Babel config) and other Babel builds. Active only when Babel's env is
 * `development`; see sourceLoc.ts.
 */
import { sourceLocBabelPlugin } from './sourceLoc.ts'

export { SOURCE_LOC_ATTR, isHostTag, sourceLocValue } from './sourceLoc.ts'
export type { SourceLocBabelOptions } from './sourceLoc.ts'
export default sourceLocBabelPlugin
