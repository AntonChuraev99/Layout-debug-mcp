/**
 * Opens a URL in the default browser, best effort. No shell: `cmd /c start` on
 * Windows (the empty first argument is the window title `start` expects), `open`
 * on macOS, `xdg-open` elsewhere. Never writes to stdout: the MCP process calls it,
 * and its stdout carries only MCP frames.
 */
import { spawn } from 'node:child_process'

export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]]
  if (platform === 'darwin') return ['open', [url]]
  return ['xdg-open', [url]]
}

/** Resolves to null once the opener started, or to the reason it could not. */
export function openBrowser(url: string): Promise<string | null> {
  if (process.env.LD_NO_BROWSER?.trim() === '1') return Promise.resolve('LD_NO_BROWSER=1 is set')
  const [command, args] = browserCommand(url)
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
      child.once('error', (err) => resolve(`${command} could not start: ${err.message}`))
      child.once('spawn', () => {
        child.unref()
        resolve(null)
      })
    } catch (err) {
      resolve(`${command} could not start: ${(err as Error).message}`)
    }
  })
}
