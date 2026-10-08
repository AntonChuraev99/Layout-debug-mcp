import { createContext, createElement, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { DEFAULT_LOCALE, type Locale } from '../shared/protocol.ts'

/**
 * Window copy in both languages. English is the source of truth: `ru` is typed
 * against it, so a missing or extra key is a compile error (and a test failure).
 *
 * - `{name}` is replaced by a param; `rich()` can put a React node there instead.
 * - An object entry is a plural: the form is picked by `Intl.PluralRules` from `count`.
 */
type Plural = { one: string; other: string }
type RuPlural = { one: string; few: string; many: string; other: string }
type Msg = string | Plural

const en = {
  // --- header ---
  'pick.button': 'Pick a layer — or hold {alt}',
  'pick.hint': 'hover to inspect · click to select',
  'pick.hintPipette': 'to cancel · click a layer',
  'pick.kapTitle': 'Hold {alt}: hover to inspect, click to select, scroll for the parent layer',
  'pick.kapTitleAndroid': 'Hover to inspect, click to select, scroll with {alt} for the parent layer',
  'pick.top': 'Top layer',
  'coach.title': 'The page works as usual',
  'coach.text': 'Click, scroll and type right in it. To select a layer, hold {alt} and click it — or use the pipette.',
  'coach.ok': 'Got it',
  'url.label': 'Page address',
  'url.open': 'Open',
  'device.none': 'No device',
  'device.generic': 'Android device',
  'inbox.title': 'Inbox',
  'inbox.openCount': { one: '{count} open', other: '{count} open' },
  'inbox.newReplies': 'new replies',
  'lang.label': 'Language',
  'meta.layers': { one: '{count} layer', other: '{count} layers' },

  // --- agent indicator and its popover ---
  'agent.listening': 'Agent listening',
  'agent.none': 'No agent listening',
  'agent.listeningText': "Edits you send go to it right away. Its replies appear in the element's chat.",
  'agent.noneTitle': 'No agent is listening',
  'agent.noneText': 'Edits you send wait in the Inbox. An agent picks them up as soon as it connects.',
  'agent.step1': 'Add this MCP server to your agent',
  'agent.step2': 'Then tell the agent',
  'agent.phrase': 'Open the layout-debug window and listen for my edits.',
  'agent.clients': 'Any MCP client works: Claude Code, Cursor, Codex CLI, VS Code and others.',
  'agent.connect': 'How to connect',

  // --- why a tool or action is off ---
  'blocked.offlineMove': "The server isn't responding, so elements on the device can't be moved",
  'blocked.hideAndroid': "Hiding isn't available on Android yet: the device agent can't change visibility",
  'blocked.needDevice': 'Take a device snapshot first',
  'blocked.needPage': 'Open a page first',

  // --- status pill and its popovers ---
  'status.offline': 'Server not responding',
  'status.noAgent': 'No agent in the app',
  'status.connectingDevice': 'Connecting device…',
  'status.stale': 'Device snapshot not updating',
  'status.inspectorSilent': 'Inspector not responding',
  'status.inspectorError': 'Inspector error',
  'status.connectingInspector': 'Connecting inspector…',
  'offline.title': "The local server isn't responding",
  'offline.text':
    "The window lost its connection to the backend. You can still select layers, but sending edits and moving elements on the device won't work until the server is back.",
  'offline.note': 'Reconnecting every {seconds} s.',
  'noAgent.title': 'The device is there, but the app is silent',
  'noAgent.step1': 'Launch the app on the device: a debug build with the layout-debug agent.',
  'noAgent.step2': 'Check that the agent listens on the port forwarded with adb forward.',
  'noAgent.step3': 'The window retries on its own, no reload needed.',
  'status.deviceError': "Can't capture the device",
  'deviceError.title': "adb couldn't capture the device",
  'deviceError.text': 'This is not the app agent: adb itself failed. What it said:',
  'deviceError.noDetails': 'adb gave no details.',
  'deviceError.step1': 'Check: {cmd} lists exactly one device with the status device',
  'deviceError.step2': 'Several devices connected? Set {env} to the serial of the one to inspect and restart the server',
  'status.frameError': 'Device frame not loading',
  'status.ghostFailed': 'Old place not shown',
  'ghost.title': 'The moved element has no copy on its old place',
  'ghost.noFrame': "The device picture hasn't loaded yet, so there was nothing to copy the element from. The move itself worked.",
  'ghost.frameChanged': 'A newer device picture arrived before the copy was taken and may already show the element moved. The move itself worked.',
  'ghost.noCanvas': "This browser can't draw on a canvas, so the copy can't be cut out. The move itself worked.",
  'ghost.offFrame': 'The element lies outside the device picture, so there is nothing to copy. The move itself worked.',
  'frameError.title': "The device didn't return a picture",
  'frameError.textStale': 'The layer tree is fresh, but the frame shows the last picture that loaded. Boxes may not match what you see.',
  'frameError.textNone': 'The layer tree is in, but the device returned no picture for it, so only the boxes are shown.',
  'frameError.noDetails': 'The server gave no reason.',
  'stale.title': "The device snapshot isn't updating",
  'stale.text':
    'The last capture attempts failed ({count}). The frame shows the last good snapshot; the window retries less and less often.',
  'stale.capturing': 'Capturing…',
  'stale.refresh': 'Refresh snapshot',
  'error.title': 'Error',
  'error.dismiss': 'Dismiss',
  'inspectorError.title': 'The inspector reported an error',

  // --- canvas ---
  'canvas.label': 'Frame. Hold {alt} and click to select a layer',
  'canvas.labelAndroid': 'Device frame. Click to select a layer',
  'canvas.deviceAlt': 'Device screen',
  'canvas.frameTitle': 'Page being edited',
  'android.noAdbTitle': 'adb not found',
  'android.noDeviceTitle': 'No device connected',
  'android.noAdbText': 'The window needs adb to see the device. Install Android platform-tools and add adb to PATH.',
  'android.noDeviceText': "adb doesn't see any device. The window picks it up as soon as one appears.",
  'android.step1': 'Connect a phone over USB or start an emulator',
  'android.step2': 'Check: {cmd} lists it with the status device',
  'android.step3': 'Run a debug build of the app with the layout-debug agent',
  'android.checking': 'Checking…',
  'android.checkAgain': 'Check again',
  'android.waitingTitle': 'Waiting for the app',
  'android.connectingTitle': 'Connecting device',
  'android.waitingText': 'The app has to run as a debug build with the layout-debug agent.',
  'android.connectingText': 'Capturing the screen and the layer tree over adb.',
  'empty.title': 'Open the page you want to edit',
  'empty.text':
    'Paste the dev server address into the field above. The page opens here, and you can select any of its layers, move it and hand it to the agent. Then hold {alt} and click any element to select it.',
  'banner.title': "The inspector didn't respond",
  'banner.text':
    "The page opened, but its layers aren't visible: the inspector script isn't in it. Add it to index.html and reload the page.",

  // --- shared ---
  'common.close': 'Close',
  'common.more': '{count} more',
  'copy.action': 'Copy',
  'copy.done': 'Copied',
  'copy.failed': 'Copy failed: {reason}',
  'copy.noClipboard': "the clipboard isn't available in this window",
  'send.offline': "server isn't responding",

  // --- action palette ---
  'palette.label': 'Actions: {name}',
  'palette.parents': 'Parents',
  'palette.allParents': 'All parents',
  'palette.liveEdit': 'Has a live edit',
  'palette.edits': { one: '{count} edit', other: '{count} edits' },
  'cursor.select': 'Select to chat',
  'palette.chat': 'Chat with AI',
  'palette.chatHint': "Open the element's chat: earlier edits and the agent's replies",
  'palette.focusField': 'C: type here',
  'palette.move': 'Move',
  'palette.moveHint': 'Drag the element in the frame, or click here to nudge with arrow keys',
  'palette.resize': 'Resize',
  'palette.resizeHint': 'Drag a corner of the element, or click here to resize with arrow keys',
  'palette.deselect': 'Deselect (Esc)',
  'palette.largeGrip': 'This layer covers the page: drag it by this label, the page under it stays clickable',
  'nudge.shift': 'Shift ×8',
  'nudge.title': 'Arrow keys move by 1 {unit}, with Shift by 8',
  'nudge.group': 'Nudge with arrow keys',
  'nudge.left': 'Move left by 1 {unit}',
  'nudge.up': 'Move up by 1 {unit}',
  'nudge.down': 'Move down by 1 {unit}',
  'nudge.right': 'Move right by 1 {unit}',
  'nudge.narrower': 'Narrower by 1 {unit}',
  'nudge.shorter': 'Shorter by 1 {unit}',
  'nudge.taller': 'Taller by 1 {unit}',
  'nudge.wider': 'Wider by 1 {unit}',
  'palette.hide': 'Hide',
  'palette.show': 'Show',
  'palette.hideHint': 'Hide it; its space stays reserved',
  'palette.showHint': 'Bring the element back',
  'palette.reset': 'Reset edits',
  'palette.resetHint': 'Restore the element as it is in code',
  'palette.stopWaiting': 'Stop waiting',
  'palette.stopWaitingHint': 'Remove the “agent is editing” mark from the element',
  'palette.copyAnchor': 'Copy anchor',
  'palette.copied': 'Copied',
  'palette.copyFailed': 'Copy failed',
  'palette.details': 'Details',

  // --- node details ---
  'details.box': 'Box',
  'details.edit': 'Edit',
  'details.source': 'Source',
  'details.classes': 'Classes',
  'details.path': 'Path',
  'details.inside': 'Inside: {count}',
  'override.offset': 'offset {dx}, {dy}',
  'override.size': 'size {w} × {h}',
  'override.hidden': 'hidden',

  // --- chat ---
  'chat.label': 'Chat: {name}',
  'chat.back': 'Back to actions',
  'chat.offline': "Server isn't responding, so sending is unavailable",
  'chat.missingBlocked': "The element isn't on the page. Select it again to write",
  'chat.describeFirst': 'Describe the edit first',
  'chat.missing': "Element not found on the page. The thread is tied to its anchor and comes back when the element reappears.",
  'chat.noAgent': 'No agent is listening. Messages wait in the Inbox until one connects.',
  'chat.emptyTitle': 'What should change in this layer?',
  'chat.emptySub': 'The agent gets your text along with measurements, the source anchor and the parent chain.',
  'chat.notSent': 'Not sent: {reason}',
  'chat.working': 'Agent is working on the layer',
  'chat.attachNote': 'goes with the message',
  'chat.placeholder': 'What should change?',
  'chat.inputLabel': 'Message to the agent',
  'chat.keys': '{enter} to send {shiftEnter} new line',
  'chat.send': 'Send',
  'chat.withEdit': 'with edit: {tweak}',
  'chat.waiting': 'Waiting for an agent. It gets this edit as soon as one listens.',
  'chat.noReply': 'The agent finished without a reply.',
  'chat.failed': 'The agent stopped with an error.',
  'refresh.failed': 'Could not refresh the page — reload it manually',
  'refresh.failedDevice': 'Could not get a fresh frame from the device — refresh the snapshot manually',
  'refresh.lostEdits': {
    one: "{count} live edit couldn't be restored after the reload: its element is gone",
    other: "{count} live edits couldn't be restored after the reload: their elements are gone",
  },

  // --- inbox ---
  'inbox.requests': 'Requests',
  'inbox.filter': 'Which requests to show',
  'inbox.active': 'Active',
  'inbox.all': 'All',
  'inbox.emptyTitle': 'No requests yet',
  'inbox.emptySub': 'Select a layer and open the chat to send an edit.',
  'inbox.now': 'Now',
  'inbox.idle': 'The agent is free: no open requests.',
  'inbox.loose': 'Not tied to an element',
  'inbox.done': 'Done',
  'inbox.showDone': 'Show done ({count})',
  'inbox.newReply': 'New reply',
  'inbox.noAgent': 'No agent is listening. Queued edits go out when one connects.',
  'tag.work': 'Agent editing',
  'tag.queued': 'Queued',
  'tag.waiting': 'Waiting for agent',
  'tag.done': 'Done',
  'tag.error': 'Error',
  'tag.dismissed': 'Not waiting',
  'tag.stale': 'No reply',

  // --- relative time ---
  'ago.now': 'just now',
  'ago.min': '{count} min',
  'ago.hour': '{count} h',
  'ago.day': '{count} d',
} satisfies Record<string, Msg>

export type MsgKey = keyof typeof en
type Shape<T> = { [K in keyof T]: T[K] extends string ? string : RuPlural }

const ru: Shape<typeof en> = {
  'pick.button': 'Выбрать слой — или зажми {alt}',
  'pick.hint': 'наведи — подсветка · клик — выделить',
  'pick.hintPipette': 'отмена · кликни по слою',
  'pick.kapTitle': 'Зажми {alt}: наведи — подсветка, клик — выделить, колесо — слой-родитель',
  'pick.kapTitleAndroid': 'Наведи — подсветка, клик — выделить, {alt} + колесо — слой-родитель',
  'pick.top': 'Самый верхний слой',
  'coach.title': 'Страница работает как обычно',
  'coach.text': 'Кликай, прокручивай и вводи текст прямо в ней. Чтобы выделить слой, зажми {alt} и кликни по нему — или возьми пипетку.',
  'coach.ok': 'Понятно',
  'url.label': 'Адрес страницы',
  'url.open': 'Открыть',
  'device.none': 'Нет устройства',
  'device.generic': 'Android-устройство',
  'inbox.title': 'Входящие',
  'inbox.openCount': { one: '{count} открытый', few: '{count} открытых', many: '{count} открытых', other: '{count} открытых' },
  'inbox.newReplies': 'есть новые ответы',
  'lang.label': 'Язык',
  'meta.layers': { one: '{count} слой', few: '{count} слоя', many: '{count} слоёв', other: '{count} слоя' },

  'agent.listening': 'Агент слушает',
  'agent.none': 'Агент не слушает',
  'agent.listeningText': 'Правки уходят ему сразу. Ответы появятся в чате элемента.',
  'agent.noneTitle': 'Агент не слушает',
  'agent.noneText': 'Отправленные правки ждут во «Входящих». Агент заберёт их, как только подключится.',
  'agent.step1': 'Добавь агенту этот MCP-сервер',
  'agent.step2': 'Потом скажи агенту',
  'agent.phrase': 'Открой окно layout-debug и слушай мои правки.',
  'agent.clients': 'Подойдёт любой MCP-клиент: Claude Code, Cursor, Codex CLI, VS Code и другие.',
  'agent.connect': 'Как подключить',

  'blocked.offlineMove': 'Сервер не отвечает — двигать элементы на устройстве нельзя',
  'blocked.hideAndroid': 'На Android скрытие пока недоступно: агент на устройстве не умеет менять видимость',
  'blocked.needDevice': 'Сначала нужен снимок устройства',
  'blocked.needPage': 'Сначала открой страницу',

  'status.offline': 'Сервер не отвечает',
  'status.noAgent': 'Нет агента в приложении',
  'status.connectingDevice': 'Подключаю устройство…',
  'status.stale': 'Снимок устройства не обновляется',
  'status.inspectorSilent': 'Инспектор не отвечает',
  'status.inspectorError': 'Ошибка инспектора',
  'status.connectingInspector': 'Подключаю инспектор…',
  'offline.title': 'Локальный сервер не отвечает',
  'offline.text':
    'Окно потеряло связь с backend. Выделять слои можно, а отправлять правки и двигать элементы на устройстве — нет, пока сервер не вернётся.',
  'offline.note': 'Переподключаюсь каждые {seconds} с.',
  'noAgent.title': 'Устройство есть, приложение молчит',
  'noAgent.step1': 'Запусти приложение на устройстве — debug-сборку с агентом layout-debug.',
  'noAgent.step2': 'Проверь, что агент слушает порт, который проброшен через adb forward.',
  'noAgent.step3': 'Окно повторит попытку само, без перезагрузки.',
  'status.deviceError': 'Не снимается устройство',
  'deviceError.title': 'adb не смог снять устройство',
  'deviceError.text': 'Дело не в агенте приложения: ошибся сам adb. Что он ответил:',
  'deviceError.noDetails': 'adb не сообщил подробностей.',
  'deviceError.step1': 'Проверь: {cmd} показывает ровно одно устройство со статусом device',
  'deviceError.step2': 'Подключено несколько устройств? Задай {env} — серийник нужного — и перезапусти сервер',
  'status.frameError': 'Кадр устройства не грузится',
  'status.ghostFailed': 'Прошлое место не показано',
  'ghost.title': 'У сдвинутого элемента нет копии на прошлом месте',
  'ghost.noFrame': 'Кадр устройства ещё не загрузился — копировать элемент было не с чего. Сам сдвиг применён.',
  'ghost.frameChanged': 'Пока снималась копия, пришёл новый кадр устройства — на нём элемент мог быть уже сдвинут. Сам сдвиг применён.',
  'ghost.noCanvas': 'Браузер не умеет рисовать на canvas — копию не вырезать. Сам сдвиг применён.',
  'ghost.offFrame': 'Элемент за пределами кадра устройства — копировать нечего. Сам сдвиг применён.',
  'frameError.title': 'Устройство не отдало картинку',
  'frameError.textStale': 'Дерево слоёв свежее, а в кадре — последняя картинка, которая загрузилась. Рамки могут не совпадать с видимым.',
  'frameError.textNone': 'Дерево слоёв пришло, а картинку к нему устройство не отдало — видны только рамки.',
  'frameError.noDetails': 'Сервер не назвал причину.',
  'stale.title': 'Снимок устройства не обновляется',
  'stale.text':
    'Последние попытки снять экран не удались ({count}). В кадре — последний удачный снимок; окно повторяет попытки всё реже.',
  'stale.capturing': 'Снимаю…',
  'stale.refresh': 'Обновить снимок',
  'error.title': 'Ошибка',
  'error.dismiss': 'Скрыть',
  'inspectorError.title': 'Инспектор сообщил об ошибке',

  'canvas.label': 'Кадр. Зажми {alt} и кликни, чтобы выделить слой',
  'canvas.labelAndroid': 'Кадр устройства. Кликни, чтобы выделить слой',
  'canvas.deviceAlt': 'Экран устройства',
  'canvas.frameTitle': 'Страница, которую правим',
  'android.noAdbTitle': 'adb не найден',
  'android.noDeviceTitle': 'Устройство не подключено',
  'android.noAdbText': 'Окну нужен adb, чтобы видеть устройство. Установи Android platform-tools и добавь adb в PATH.',
  'android.noDeviceText': 'adb не видит ни одного устройства. Окно подхватит его само, как только оно появится.',
  'android.step1': 'Подключи телефон по USB или запусти эмулятор',
  'android.step2': 'Проверь: {cmd} показывает его со статусом device',
  'android.step3': 'Запусти debug-сборку приложения с агентом layout-debug',
  'android.checking': 'Проверяю…',
  'android.checkAgain': 'Проверить снова',
  'android.waitingTitle': 'Жду приложение',
  'android.connectingTitle': 'Подключаю устройство',
  'android.waitingText': 'Приложение должно быть запущено в debug-сборке с агентом layout-debug.',
  'android.connectingText': 'Снимаю экран и дерево слоёв через adb.',
  'empty.title': 'Открой страницу, которую будем править',
  'empty.text':
    'Вставь адрес dev-сервера в поле сверху. Страница откроется здесь, и любой её слой можно будет выделить, подвинуть и отдать агенту. Потом зажми {alt} и кликни по любому элементу, чтобы выделить его.',
  'banner.title': 'Инспектор не отозвался',
  'banner.text':
    'Страница открылась, но слои не видны: в неё не встроен скрипт инспектора. Добавь его в index.html и обнови страницу.',

  'common.close': 'Закрыть',
  'common.more': 'Ещё {count}',
  'copy.action': 'Скопировать',
  'copy.done': 'Скопировано',
  'copy.failed': 'Не скопировалось: {reason}',
  'copy.noClipboard': 'буфер обмена недоступен в этом окне',
  'send.offline': 'сервер не отвечает',

  'palette.label': 'Действия: {name}',
  'palette.parents': 'Родители',
  'palette.allParents': 'Все родители',
  'palette.liveEdit': 'Есть живая правка',
  'palette.edits': { one: '{count} правка', few: '{count} правки', many: '{count} правок', other: '{count} правки' },
  'cursor.select': 'Выбрать для чата',
  'palette.chat': 'Чат с ИИ',
  'palette.chatHint': 'Открыть чат элемента: прошлые правки и ответы агента',
  'palette.focusField': 'C — писать сюда',
  'palette.move': 'Передвинуть',
  'palette.moveHint': 'Тащи элемент в кадре — или нажми здесь и двигай стрелками',
  'palette.resize': 'Изменить размер',
  'palette.resizeHint': 'Тяни за угол элемента — или нажми здесь и меняй стрелками',
  'palette.deselect': 'Снять выделение (Esc)',
  'palette.largeGrip': 'Слой закрывает страницу: тащи его за этот ярлык, страница под ним остаётся кликабельной',
  'nudge.shift': 'Shift ×8',
  'nudge.title': 'Стрелки — на 1 {unit}, с Shift — на 8',
  'nudge.group': 'Сдвиг стрелками',
  'nudge.left': 'Сдвинуть влево на 1 {unit}',
  'nudge.up': 'Сдвинуть вверх на 1 {unit}',
  'nudge.down': 'Сдвинуть вниз на 1 {unit}',
  'nudge.right': 'Сдвинуть вправо на 1 {unit}',
  'nudge.narrower': 'Уже на 1 {unit}',
  'nudge.shorter': 'Ниже на 1 {unit}',
  'nudge.taller': 'Выше на 1 {unit}',
  'nudge.wider': 'Шире на 1 {unit}',
  'palette.hide': 'Скрыть',
  'palette.show': 'Показать',
  'palette.hideHint': 'Спрятать, место остаётся за ним',
  'palette.showHint': 'Вернуть элемент',
  'palette.reset': 'Сбросить правки',
  'palette.resetHint': 'Вернуть элемент как в коде',
  'palette.stopWaiting': 'Не ждать агента',
  'palette.stopWaitingHint': 'Снять отметку «агент правит» с элемента',
  'palette.copyAnchor': 'Копировать якорь',
  'palette.copied': 'Скопировано',
  'palette.copyFailed': 'Не скопировалось',
  'palette.details': 'Подробнее',

  'details.box': 'Бокс',
  'details.edit': 'Правка',
  'details.source': 'Исходник',
  'details.classes': 'Классы',
  'details.path': 'Путь',
  'details.inside': 'Внутри: {count}',
  'override.offset': 'сдвиг {dx}, {dy}',
  'override.size': 'размер {w} × {h}',
  'override.hidden': 'скрыт',

  'chat.label': 'Чат: {name}',
  'chat.back': 'К действиям',
  'chat.offline': 'Сервер не отвечает — отправка недоступна',
  'chat.missingBlocked': 'Элемента нет на странице — выдели его заново, чтобы написать',
  'chat.describeFirst': 'Сначала опиши правку',
  'chat.missing': 'Элемент не найден на странице. Тред привязан к якорю — он вернётся, когда элемент снова появится.',
  'chat.noAgent': 'Агент не слушает. Сообщения ждут во «Входящих», пока он не подключится.',
  'chat.emptyTitle': 'Что поправить в этом слое?',
  'chat.emptySub': 'Агент получит текст вместе с замерами, якорем в коде и цепочкой родителей.',
  'chat.notSent': 'Не отправилось: {reason}',
  'chat.working': 'Агент работает над слоем',
  'chat.attachNote': 'приложится к сообщению',
  'chat.placeholder': 'Что поправить?',
  'chat.inputLabel': 'Сообщение агенту',
  'chat.keys': '{enter} отправить {shiftEnter} перенос',
  'chat.send': 'Отправить',
  'chat.withEdit': 'с правкой: {tweak}',
  'chat.waiting': 'Ждёт агента. Он получит правку, как только начнёт слушать.',
  'chat.noReply': 'Агент закончил без текста ответа.',
  'chat.failed': 'Агент остановился с ошибкой.',
  'refresh.failed': 'Не удалось обновить страницу — перезагрузи её вручную',
  'refresh.failedDevice': 'Не удалось получить свежий кадр с устройства — обнови снимок вручную',
  'refresh.lostEdits': {
    one: 'После перезагрузки не восстановилась {count} живая правка: её элемента больше нет',
    few: 'После перезагрузки не восстановились {count} живые правки: их элементов больше нет',
    many: 'После перезагрузки не восстановились {count} живых правок: их элементов больше нет',
    other: 'После перезагрузки не восстановились {count} живой правки: их элементов больше нет',
  },

  'inbox.requests': 'Запросы',
  'inbox.filter': 'Какие запросы показать',
  'inbox.active': 'Активные',
  'inbox.all': 'Все',
  'inbox.emptyTitle': 'Запросов пока нет',
  'inbox.emptySub': 'Выдели слой и открой чат, чтобы отправить правку.',
  'inbox.now': 'Сейчас',
  'inbox.idle': 'Агент свободен — открытых запросов нет.',
  'inbox.loose': 'Без элемента',
  'inbox.done': 'Готово',
  'inbox.showDone': 'Показать готовые ({count})',
  'inbox.newReply': 'Новый ответ',
  'inbox.noAgent': 'Агент не слушает. Правки из очереди уйдут, когда он подключится.',
  'tag.work': 'Агент правит',
  'tag.queued': 'В очереди',
  'tag.waiting': 'Ждёт агента',
  'tag.done': 'Готово',
  'tag.error': 'Ошибка',
  'tag.dismissed': 'Не ждём',
  'tag.stale': 'Без ответа',

  'ago.now': 'только что',
  'ago.min': '{count} мин',
  'ago.hour': '{count} ч',
  'ago.day': '{count} д',
}

export const DICTS: Record<Locale, Record<MsgKey, Msg>> = { en, ru }
export const LOCALES: readonly Locale[] = ['en', 'ru']
/** Each language named in itself: the switcher reads the same whatever the window language is. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', ru: 'Русский' }
export const QUOTES: Record<Locale, readonly [string, string]> = { en: ['“', '”'], ru: ['«', '»'] }

export type Params = Record<string, string | number>
export type Translate = (key: MsgKey, params?: Params) => string

const pluralRules = new Map<Locale, Intl.PluralRules>()
function rulesFor(locale: Locale): Intl.PluralRules {
  let r = pluralRules.get(locale)
  if (!r) pluralRules.set(locale, (r = new Intl.PluralRules(locale)))
  return r
}

function template(locale: Locale, key: MsgKey, params?: Params): string {
  const msg = DICTS[locale][key] ?? DICTS[DEFAULT_LOCALE][key]
  if (typeof msg === 'string') return msg
  const form = rulesFor(locale).select(Number(params?.count ?? 0)) as keyof RuPlural
  return (msg as Partial<RuPlural>)[form] ?? msg.other
}

export function translate(locale: Locale, key: MsgKey, params?: Params): string {
  return template(locale, key, params).replace(/\{(\w+)\}/g, (whole, name: string) =>
    params && name in params ? String(params[name]) : whole,
  )
}

/** Like `translate`, but a `{name}` can be filled with a React node (`<code>`, `<kbd>`). */
export function translateRich(locale: Locale, key: MsgKey, nodes: Record<string, ReactNode>, params?: Params): ReactNode[] {
  const parts = template(locale, key, params).split(/\{(\w+)\}/)
  return parts.map((part, i) => {
    if (i % 2 === 0) return part
    if (part in nodes) return createElement(Fragment, { key: i }, nodes[part])
    return params && part in params ? String(params[part]) : `{${part}}`
  })
}

/** "just now", "2 min", "3 h", "1 d". */
export function formatAgo(ms: number, locale: Locale): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 45) return translate(locale, 'ago.now')
  const min = Math.round(s / 60)
  if (min < 60) return translate(locale, 'ago.min', { count: min })
  const h = Math.round(min / 60)
  if (h < 24) return translate(locale, 'ago.hour', { count: h })
  return translate(locale, 'ago.day', { count: Math.round(h / 24) })
}

// --- React side -------------------------------------------------------------

/** index.html reads the same key for its boot-failure panel (checked by i18n.test.ts). */
export const STORAGE_KEY = 'layout-debug.locale'

function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v)
}

/** The stored choice, or English. The browser language is not consulted on purpose. */
export function readStoredLocale(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isLocale(v) ? v : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

export interface I18n {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Translate
  rich: (key: MsgKey, nodes: Record<string, ReactNode>, params?: Params) => ReactNode[]
  quotes: readonly [string, string]
}

function makeI18n(locale: Locale, setLocale: (l: Locale) => void): I18n {
  return {
    locale,
    setLocale,
    t: (key, params) => translate(locale, key, params),
    rich: (key, nodes, params) => translateRich(locale, key, nodes, params),
    quotes: QUOTES[locale],
  }
}

const I18nContext = createContext<I18n>(makeI18n(DEFAULT_LOCALE, () => {}))

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Private window or blocked storage: the choice holds until the tab closes.
    }
  }, [])

  const value = useMemo(() => makeI18n(locale, setLocale), [locale, setLocale])
  return createElement(I18nContext.Provider, { value }, children)
}

export function useT(): I18n {
  return useContext(I18nContext)
}
