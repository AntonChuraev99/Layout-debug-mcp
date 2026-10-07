import { DEFAULT_LOCALE, type Locale } from '../shared/protocol.ts'

/**
 * Text the server sends into the window. Everything else the server produces —
 * console logs, MCP responses, the agent prompt, HTTP API errors — is English
 * only; this dictionary covers just what a person reads in the window.
 */

type Params = Record<string, string | number>

const en = {
  badUiMessage:
    'The server refused a message from the window ({reason}). Reload the window; if it repeats, the window and ' +
    'the server are from different builds — restart `npm run dev`.',
  nothingToSubmit: 'Nothing to send: select an element on the page first',
  queuedNoProject:
    'projectDir is not set, so the edit went to the queue. Pick it up from Claude Code with the pending_requests tool.',
  agentFailed: 'The agent finished with an error',
  agentAuth:
    'The agent cannot sign in to the Anthropic API ({reason}). Set ANTHROPIC_API_KEY in the environment of ' +
    '`npm run dev` or run `claude login`, then restart the server and send the edit again. ' +
    'Or handle it from a Claude Code session: the pending_requests MCP tool picks the edit up.',
  agentRetrying:
    'The Anthropic API did not answer ({reason}), the agent is retrying (attempt {attempt} of {max}). The edit is still in progress.',
  deviceError: 'Device: {reason}',
  overrideError: 'Live edit: {reason}',
  clearOverridesError: 'Resetting edits: {reason}',
  deviceAgentError: 'agent on the device: {reason}',
  deviceScreenshotError: 'screenshot: HTTP {status}',
} as const

export type MessageKey = keyof typeof en

const ru: Record<MessageKey, string> = {
  badUiMessage:
    'Сервер отклонил сообщение от окна ({reason}). Перезагрузи окно; если повторится — окно и сервер из разных ' +
    'сборок, перезапусти `npm run dev`.',
  nothingToSubmit: 'Нечего отправлять: выдели элемент на странице',
  queuedNoProject:
    'projectDir не задан — правка положена в очередь. Забери её из Claude Code инструментом pending_requests.',
  agentFailed: 'Агент завершился с ошибкой',
  agentAuth:
    'Агент не может авторизоваться в Anthropic API ({reason}). Задай ANTHROPIC_API_KEY в окружении ' +
    '`npm run dev` или выполни `claude login`, перезапусти сервер и отправь правку заново. ' +
    'Либо обработай её из сессии Claude Code: MCP-инструмент pending_requests заберёт правку.',
  agentRetrying:
    'Anthropic API не ответил ({reason}), агент повторяет запрос (попытка {attempt} из {max}). Правка ещё в работе.',
  deviceError: 'Устройство: {reason}',
  overrideError: 'Живая правка: {reason}',
  clearOverridesError: 'Сброс правок: {reason}',
  deviceAgentError: 'агент на устройстве: {reason}',
  deviceScreenshotError: 'скриншот: HTTP {status}',
}

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { en, ru }

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(DICTIONARIES, value)
}

/**
 * The locale that results from a window reporting `requested`. An unknown value
 * keeps `current` and is logged — a bad message must not switch the language or
 * crash the server.
 */
export function resolveLocale(current: Locale, requested: unknown): Locale {
  if (isLocale(requested)) return requested
  console.warn(`[layout-debug] ignoring unknown locale ${JSON.stringify(requested)}, keeping "${current}"`)
  return current
}

export function t(locale: Locale, key: MessageKey, params: Params = {}): string {
  const template = (DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE])[key]
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  )
}

/**
 * An error whose message is rendered at the moment it reaches a window, in that
 * window's language. `message` holds the English text for logs and stack traces.
 */
export class LocalizedError extends Error {
  constructor(
    readonly key: MessageKey,
    readonly params: Params = {},
  ) {
    super(t('en', key, params))
    this.name = 'LocalizedError'
  }
}

/** Message of any thrown value, localized when it carries a dictionary key. */
export function errorText(locale: Locale, err: unknown): string {
  if (err instanceof LocalizedError) return t(locale, err.key, err.params)
  return err instanceof Error ? err.message : String(err)
}
