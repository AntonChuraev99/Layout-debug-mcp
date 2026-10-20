import { DEFAULT_LOCALE, type Locale } from '../shared/protocol.ts'

/**
 * Text the server sends into the window. Everything else the server produces —
 * console logs, MCP responses, HTTP API errors — is English
 * only; this dictionary covers just what a person reads in the window.
 */

type Params = Record<string, string | number>

const en = {
  badUiMessage:
    'The server refused a message from the window ({reason}). Reload the window; if it repeats, the window and ' +
    'the server are from different builds — restart the layout-debug server.',
  nothingToSubmit: 'Nothing to send: select an element on the page first',
  queuedNoAgent:
    'No agent is listening, so the edit waits in the Inbox. Ask your agent to open the layout-debug window ' +
    '(MCP server: npx -y layout-debug-mcp); it picks the edit up from here.',
  deviceError: 'Device: {reason}',
  overrideError: 'Live edit: {reason}',
  clearOverridesError: 'Resetting edits: {reason}',
  deviceAgentError: 'agent on the device: {reason}',
  deviceScreenshotError: 'screenshot: HTTP {status}',
  deviceScreenshotAgentError: 'screenshot: the agent on the device answered HTTP {status}{reason}',
  deviceUnresponsive:
    'adb lists {serial}, but the device does not answer over adb (adb shell timed out). The app is not at fault, ' +
    'so restarting it will not help: the adb connection has stalled. Reconnect it: turn Wireless debugging off and ' +
    'on in Developer options, or run adb disconnect {serial} and then adb connect <ip:port> (or pair again), or ' +
    'replug the USB cable. The window picks the device up by itself once it answers.',
  deviceAgentHttp:
    'the agent on the device answered {path} with HTTP {status}{reason}. Restart the debug build of the app; if it ' +
    'repeats, the on-device agent and layout-debug-mcp may be from different versions.',
  deviceAgentBadReply:
    'the agent on the device sent a reply to {path} that is not JSON ({reason}). Restart the debug build of the app; ' +
    'if it repeats, the on-device agent and layout-debug-mcp may be from different versions.',
  deviceWrongApp:
    'the agent on port {port} belongs to {actual}, not to {expected} (LD_ANDROID_PACKAGE). Close {actual} and start ' +
    '{expected} in a debug build, or fix LD_ANDROID_PACKAGE / "androidPackage" in layout-debug.config.json.',
  deviceAppNotRunning:
    '{expected} (LD_ANDROID_PACKAGE) is not running on the device, and the agent on port {port} did not report ' +
    'which app it belongs to. Start {expected} in a debug build, or fix LD_ANDROID_PACKAGE / "androidPackage" in ' +
    'layout-debug.config.json.',
  framingProxyUnreachable:
    'The layout-debug framing proxy could not reach {target} ({reason}). Start your dev server there, or point ' +
    'LD_TARGET_URL / "targetUrl" at the address it runs on and restart the layout-debug server.',
} as const

export type MessageKey = keyof typeof en

const ru: Record<MessageKey, string> = {
  badUiMessage:
    'Сервер отклонил сообщение от окна ({reason}). Перезагрузи окно; если повторится — окно и сервер из разных ' +
    'сборок, перезапусти сервер layout-debug.',
  nothingToSubmit: 'Нечего отправлять: выдели элемент на странице',
  queuedNoAgent:
    'Агент не слушает — правка ждёт во «Входящих». Попроси агента открыть окно layout-debug ' +
    '(MCP-сервер: npx -y layout-debug-mcp); он заберёт правку отсюда.',
  deviceError: 'Устройство: {reason}',
  overrideError: 'Живая правка: {reason}',
  clearOverridesError: 'Сброс правок: {reason}',
  deviceAgentError: 'агент на устройстве: {reason}',
  deviceScreenshotError: 'скриншот: HTTP {status}',
  deviceScreenshotAgentError: 'скриншот: агент на устройстве ответил HTTP {status}{reason}',
  deviceUnresponsive:
    'adb видит {serial}, но устройство не отвечает по adb (adb shell не ответил вовремя). Приложение ни при чём, ' +
    'его перезапуск не поможет: зависло само adb-соединение. Переподключи его: выключи и включи «Отладку по Wi-Fi» ' +
    'в параметрах разработчика, или выполни adb disconnect {serial}, а затем adb connect <ip:порт> (или заново ' +
    'pair), или переподключи USB-кабель. Окно само подхватит устройство, как только оно ответит.',
  deviceAgentHttp:
    'агент на устройстве ответил на {path} кодом HTTP {status}{reason}. Перезапусти debug-сборку приложения; если ' +
    'повторится — агент на устройстве и layout-debug-mcp, возможно, разных версий.',
  deviceAgentBadReply:
    'агент на устройстве прислал на {path} ответ не в JSON ({reason}). Перезапусти debug-сборку приложения; если ' +
    'повторится — агент на устройстве и layout-debug-mcp, возможно, разных версий.',
  deviceWrongApp:
    'агент на порту {port} принадлежит {actual}, а не {expected} (LD_ANDROID_PACKAGE). Закрой {actual} и запусти ' +
    '{expected} в debug-сборке или исправь LD_ANDROID_PACKAGE / "androidPackage" в layout-debug.config.json.',
  deviceAppNotRunning:
    '{expected} (LD_ANDROID_PACKAGE) не запущено на устройстве, а агент на порту {port} не сообщил, чьё он. ' +
    'Запусти {expected} в debug-сборке или исправь LD_ANDROID_PACKAGE / "androidPackage" в layout-debug.config.json.',
  framingProxyUnreachable:
    'Прокси layout-debug для встраивания не достучался до {target} ({reason}). Запусти там dev-сервер или укажи ' +
    'в LD_TARGET_URL / "targetUrl" адрес, на котором он работает, и перезапусти сервер layout-debug.',
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
