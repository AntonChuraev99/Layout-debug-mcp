/**
 * Command line of the `layout-debug-mcp` bin. Pure, so it is unit-tested apart from
 * src/cli.ts, which acts on the result.
 */

export type CliCommand =
  | { cmd: 'mcp' }
  | { cmd: 'window' }
  | { cmd: 'version' }
  | { cmd: 'help' }
  | { cmd: 'telemetry'; action: 'on' | 'off' | 'status' }
  | { cmd: 'error'; message: string }

export const USAGE = `Usage: layout-debug-mcp [command]

Commands:
  (none)       Run the MCP server over stdio. This is what an MCP client starts:
               {"command": "npx", "args": ["-y", "layout-debug-mcp"]}
  window       Run the layout-debug server in the foreground and open the window.
  telemetry [on|off|status]
               Turn anonymous usage telemetry on or off, or show whether it is on
               and why (default: status).

Options:
  -v, --version  Print the version and exit.
  -h, --help     Print this help and exit.

Environment: LD_SERVER_PORT, LD_TARGET, LD_TARGET_URL, LD_PROJECT_DIR, LD_CONFIG,
LD_ANDROID_PORT, LD_DEVICE, LD_NO_BROWSER=1, LD_WAIT_SECONDS,
LD_TELEMETRY=0 (telemetry off), LD_TELEMETRY_DEBUG=1 (print events, send nothing),
DO_NOT_TRACK=1 (telemetry off).`

const TELEMETRY_ACTIONS = ['on', 'off', 'status'] as const

/**
 * `window` found a layout-debug server answering on its port: the line to print when
 * that server is another process (this one then only opens the browser and exits), or
 * null when it is this process's own server.
 */
export function otherServerLine(health: { pid: number; version: string; windowUrl: string }, ownPid: number): string | null {
  if (health.pid === ownPid) return null
  return (
    `[layout-debug] the window is already served by layout-debug-mcp ${health.version} (pid ${health.pid}) ` +
    `at ${health.windowUrl}; opening it there. Stop that process to restart the server.`
  )
}

/** `argv` is what follows the script path (process.argv.slice(2)). */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  const args = argv.filter((a) => a !== '')
  if (args.includes('-h') || args.includes('--help')) return { cmd: 'help' }
  if (args.includes('-v') || args.includes('--version')) return { cmd: 'version' }
  if (args.length === 0) return { cmd: 'mcp' }
  if (args.length === 1 && args[0] === 'window') return { cmd: 'window' }
  if (args[0] === 'telemetry') {
    const action = args[1] ?? 'status'
    if (!(TELEMETRY_ACTIONS as readonly string[]).includes(action)) {
      return { cmd: 'error', message: `unknown telemetry action "${action}"; expected on, off or status` }
    }
    if (args.length > 2) return { cmd: 'error', message: `unexpected argument "${args[2]}" after "telemetry ${action}"` }
    return { cmd: 'telemetry', action: action as (typeof TELEMETRY_ACTIONS)[number] }
  }
  if (args[0] !== 'window') return { cmd: 'error', message: `unknown argument "${args[0]}"` }
  return { cmd: 'error', message: `unexpected argument "${args[1]}" after "window"` }
}
