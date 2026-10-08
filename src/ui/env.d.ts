/// <reference types="vite/client" />

/**
 * Server port baked in by vite.config.ts `define` from LD_SERVER_PORT (src/shared/ports.ts).
 * Right only in dev: a built window is served by the server on whatever port it runs, so
 * read the port through `serverOrigin` (origins.ts), not from here.
 */
declare const __LD_SERVER_PORT__: number

interface Window {
  /** Boot-failure panel from index.html; absent if that inline script did not run. */
  __ldBootFailed?: (cause: string, force: boolean) => void
}
