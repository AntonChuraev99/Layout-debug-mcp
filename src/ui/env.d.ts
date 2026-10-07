/** Server port baked in by vite.config.ts `define` from LD_SERVER_PORT (src/shared/ports.ts). */
declare const __LD_SERVER_PORT__: number

interface Window {
  /** Boot-failure panel from index.html; absent if that inline script did not run. */
  __ldBootFailed?: (cause: string, force: boolean) => void
}
