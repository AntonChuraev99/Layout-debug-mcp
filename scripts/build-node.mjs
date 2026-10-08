import { chmodSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Node side of the package: the bin, the HTTP server and the MCP server, one ESM
 * bundle per entry. Dependencies stay external (installed with the package), our
 * own sources (src/shared, .ts imports, devMarkers.mjs) are bundled in.
 * The window (dist/ui) and the inspector (dist/inspector) are Vite builds.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const entries = [
  { in: 'src/cli.ts', out: 'dist/cli.js', banner: '#!/usr/bin/env node' },
  { in: 'src/server/index.ts', out: 'dist/server/index.js' },
  { in: 'src/mcp/index.ts', out: 'dist/mcp/index.js' },
]

for (const dir of ['dist/server', 'dist/mcp', 'dist/cli.js']) rmSync(join(ROOT, dir), { recursive: true, force: true })

try {
  for (const entry of entries) {
    await build({
      absWorkingDir: ROOT,
      entryPoints: [entry.in],
      outfile: entry.out,
      bundle: true,
      format: 'esm',
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
  console.log(`[build] ${entries.map((e) => e.out).join(', ')}`)
} catch (err) {
  // esbuild has already printed the errors with file:line.
  console.error(`[build] node bundles failed: ${err.message.split('\n')[0]}`)
  process.exit(1)
}
