import { chmodSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Node side of the package: the bin, the HTTP server and the MCP server, one ESM
 * bundle per entry. Dependencies stay external (installed with the package), our
 * own sources (src/shared, .ts imports, devMarkers.mjs) are bundled in.
 * The window (dist/ui) and the inspector (dist/inspector) are Vite builds.
 * The dev-only source-location plugins (package subpaths `./vite`, `./babel`) are
 * built here too, with hand-written .d.ts: Babel configs are often CommonJS, so
 * the Babel plugin also gets a .cjs build.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const entries = [
  { in: 'src/cli.ts', out: 'dist/cli.js', banner: '#!/usr/bin/env node' },
  { in: 'src/server/index.ts', out: 'dist/server/index.js' },
  { in: 'src/mcp/index.ts', out: 'dist/mcp/index.js' },
  { in: 'src/plugins/vite.ts', out: 'dist/plugins/vite.js' },
  { in: 'src/plugins/babel.ts', out: 'dist/plugins/babel.js' },
  { in: 'src/plugins/babel.ts', out: 'dist/plugins/babel.cjs', format: 'cjs' },
]
const typings = [
  { in: 'src/plugins/types/vite.d.ts', out: 'dist/plugins/vite.d.ts' },
  { in: 'src/plugins/types/babel.d.ts', out: 'dist/plugins/babel.d.ts' },
]

for (const dir of ['dist/server', 'dist/mcp', 'dist/plugins', 'dist/cli.js']) {
  rmSync(join(ROOT, dir), { recursive: true, force: true })
}

try {
  for (const entry of entries) {
    await build({
      absWorkingDir: ROOT,
      entryPoints: [entry.in],
      outfile: entry.out,
      bundle: true,
      format: entry.format ?? 'esm',
      platform: 'node',
      target: 'node20',
      packages: 'external',
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'warning',
      banner: entry.banner ? { js: entry.banner } : undefined,
    })
  }
  // The bin must be executable on Linux/macOS when installed from the tarball.
  chmodSync(join(ROOT, 'dist/cli.js'), 0o755)
  for (const t of typings) copyFileSync(join(ROOT, t.in), join(ROOT, t.out))
  console.log(`[build] ${[...entries, ...typings].map((e) => e.out).join(', ')}`)
} catch (err) {
  // esbuild has already printed the errors with file:line.
  console.error(`[build] node bundles failed: ${err.message.split('\n')[0]}`)
  process.exit(1)
}
