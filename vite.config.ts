import { createLogger, defineConfig, type Logger, type LogLevel } from 'vite'
import react from '@vitejs/plugin-react'
import { UI_PORT, SERVER_PORT } from './src/shared/ports.ts'

/**
 * A window that closes or reloads tears down its /ws socket while the proxy is still
 * writing to it. Vite then prints "ws proxy error" / "ws proxy socket error" with a full
 * stack for what is a normal hang-up (dozens per e2e run), and a real error drowns in
 * them. Only that pair of messages with a peer-closed code is dropped; the proxy itself
 * is untouched (it still ends both sides), and every other error is logged as before.
 */
const HANG_UP_CODES = new Set(['ECONNABORTED', 'ECONNRESET', 'EPIPE'])
const WS_PROXY_ERROR = /ws proxy (socket )?error/

function quietWsHangUps(logger: Logger): Logger {
  const error = logger.error.bind(logger)
  logger.error = (msg, options) => {
    const code = (options?.error as NodeJS.ErrnoException | null | undefined)?.code
    if (code && HANG_UP_CODES.has(code) && WS_PROXY_ERROR.test(msg)) return
    error(msg, options)
  }
  return logger
}

/** A custom logger replaces Vite's own, so the CLI's `--logLevel` / `-l` has to reach it here. */
function cliLogLevel(): LogLevel | undefined {
  const argv = process.argv
  const i = argv.findIndex((a) => a === '--logLevel' || a === '-l')
  const v = i === -1 ? argv.find((a) => a.startsWith('--logLevel='))?.split('=')[1] : argv[i + 1]
  return v === 'info' || v === 'warn' || v === 'error' || v === 'silent' ? v : undefined
}

export default defineConfig({
  customLogger: quietWsHangUps(createLogger(cliLogLevel())),
  plugins: [react()],
  root: '.',
  // The window's hints show the real server address (src/ui/env.d.ts).
  define: { __LD_SERVER_PORT__: JSON.stringify(SERVER_PORT) },
  server: {
    // An IPv4 literal, never `localhost`: Vite would listen on the first address Node
    // resolves for it (`::1` on Windows) and on that one only, while Chrome may open any
    // single connection to `localhost` via 127.0.0.1 — one refused module and the window
    // stays white. `localhost:<port>` still works through the browser's fallback.
    host: '127.0.0.1',
    port: UI_PORT,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${SERVER_PORT}`,
      '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
    },
  },
  build: { outDir: 'dist/ui', emptyOutDir: true },
})
