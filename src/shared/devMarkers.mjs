/**
 * The log lines the server prints for scripts/dev.mjs. `tsx watch` does not exit when
 * the server does (it waits for the next file change), so these lines are the only way
 * the runner learns that the server is up, or that it could not start.
 *
 * Plain .mjs on purpose: the server imports it through tsx, and the runner imports it
 * with bare `node`, which cannot load .ts on every supported Node version.
 * Types: devMarkers.d.mts. Contract test: devMarkers.test.ts.
 */

export const SERVER_READY_PREFIX = '[layout-debug] server http://'
export const SERVER_FAILED_PREFIX = '[layout-debug] server failed to start:'

/** Printed by the server once it listens. */
export function serverReadyLine(host, port) {
  return `${SERVER_READY_PREFIX}${host}:${port}`
}

/** Printed by the server when it cannot listen (port taken, no permission). */
export function serverFailedLine(why) {
  return `${SERVER_FAILED_PREFIX} ${why}`
}

/** Runner side: the line says the server is listening. */
export function isServerReadyLine(line) {
  return line.includes(SERVER_READY_PREFIX)
}

/** Runner side: the reason from a "failed to start" line, or null for any other line. */
export function serverFailureReason(line) {
  const at = line.indexOf(SERVER_FAILED_PREFIX)
  return at === -1 ? null : line.slice(at + SERVER_FAILED_PREFIX.length).trim()
}
