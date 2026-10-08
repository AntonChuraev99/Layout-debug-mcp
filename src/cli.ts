/**
 * The `layout-debug-mcp` bin. No arguments: the stdio MCP server (what an MCP
 * client starts). `window`: the layout-debug server in the foreground, plus the
 * window in the browser. `telemetry on|off|status`: the telemetry switch (sends
 * nothing). The entries load lazily, after the arguments are checked,
 * so `--version` and `--help` work even with a broken environment (a bad LD_* port).
 *
 * The entries are separate bundles in dist (dist/mcp/index.js, dist/server/index.js)
 * and .ts sources in a checkout; the path is built at run time so the bundler leaves
 * them as they are.
 */
import { openBrowser } from './shared/browser.ts'
import { otherServerLine, parseCliArgs, USAGE } from './shared/cli.ts'
import { PACKAGE_VERSION } from './shared/paths.ts'
import { probe } from './mcp/launch.ts'

const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
const loadEntry = (dir: 'mcp' | 'server') => import(new URL(`./${dir}/index${ext}`, import.meta.url).href)

const command = parseCliArgs(process.argv.slice(2))

switch (command.cmd) {
  case 'help':
    console.log(USAGE)
    break
  case 'version':
    console.log(PACKAGE_VERSION)
    break
  case 'error':
    console.error(`layout-debug-mcp: ${command.message}\n\n${USAGE}`)
    process.exitCode = 1
    break
  case 'telemetry': {
    const { telemetryCommand } = await import('./shared/telemetry.ts')
    const result = telemetryCommand(command.action, process.env)
    if (result.code) console.error(`layout-debug-mcp: ${result.text}`)
    else console.log(result.text)
    process.exitCode = result.code
    break
  }
  case 'mcp':
    // stdout belongs to MCP frames from here on.
    await loadEntry('mcp')
    break
  case 'window': {
    const { SERVER_PORT } = await import('./shared/ports.ts')
    const base = `http://127.0.0.1:${SERVER_PORT}`
    const openIn = async (url: string) => {
      const failure = await openBrowser(url)
      if (failure) console.log(`[layout-debug] browser not opened: ${failure}`)
    }
    // Another copy already serves the port: open its window and leave it running.
    // Checked before this process starts a server, so nothing here races its exit.
    const before = await probe(base, 1_000)
    if (before.kind === 'ours') {
      console.log(otherServerLine(before.health, process.pid))
      await openIn(before.health.windowUrl)
      break
    }
    await loadEntry('server')
    // Open the browser only once this process's server answers (a port held by another
    // program ends the process with a message instead).
    let answered = false
    for (let i = 0; i < 50 && !answered; i++) {
      const p = await probe(base, 500)
      if (p.kind === 'ours') {
        answered = true
        const other = otherServerLine(p.health, process.pid)
        if (other) {
          // Lost a start race to another copy: this server is exiting, that one serves.
          console.log(other)
        } else {
          console.log(`[layout-debug] open ${p.health.windowUrl} (Ctrl+C stops the server)`)
          await openIn(p.health.windowUrl)
        }
      } else {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    if (!answered) console.warn(`[layout-debug] the server did not answer at ${base} yet; the browser was not opened`)
    break
  }
}
