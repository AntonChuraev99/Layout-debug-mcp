export const UI_PORT = 5174
export const SERVER_PORT = 5175

/**
 * Origins the layout-debug window is served from (Vite dev server). The only
 * browser pages allowed to drive the server, and the only parent the inspector
 * talks to.
 */
export const UI_ORIGINS: readonly string[] = [`http://localhost:${UI_PORT}`, `http://127.0.0.1:${UI_PORT}`]
