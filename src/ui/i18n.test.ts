import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { DICTS, formatAgo, LOCALES, readStoredLocale, STORAGE_KEY, translate, translateRich } from './i18n.ts'

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
const forms = (msg: unknown): string[] => (typeof msg === 'string' ? [msg] : Object.values(msg as Record<string, string>))

describe('dictionary', () => {
  test('ru has exactly the keys of en', () => {
    const en = Object.keys(DICTS.en).sort()
    const ru = Object.keys(DICTS.ru).sort()
    assert.deepEqual(ru.filter((k) => !en.includes(k)), [], 'extra keys in ru')
    assert.deepEqual(en.filter((k) => !ru.includes(k)), [], 'keys missing from ru')
  })

  test('a key is a plural in both languages or in neither, with the same placeholders', () => {
    for (const key of Object.keys(DICTS.en) as Array<keyof typeof DICTS.en>) {
      const a = DICTS.en[key]
      const b = DICTS.ru[key]
      assert.equal(typeof a, typeof b, `${key}: plural in one language only`)
      const want = placeholders(forms(a)[0]!)
      for (const l of LOCALES) {
        for (const f of forms(DICTS[l][key])) assert.deepEqual(placeholders(f), want, `${l} ${key}: "${f}"`)
      }
    }
  })

  test('no empty strings', () => {
    for (const l of LOCALES) {
      for (const [key, msg] of Object.entries(DICTS[l])) for (const f of forms(msg)) assert.ok(f.trim(), `${l} ${key}`)
    }
  })

  test('en has no Cyrillic', () => {
    for (const [key, msg] of Object.entries(DICTS.en)) for (const f of forms(msg)) assert.doesNotMatch(f, /[А-Яа-яЁё]/, key)
  })
})

describe('plurals', () => {
  const at = (locale: 'en' | 'ru', key: 'meta.layers' | 'palette.edits') => [1, 3, 5, 21].map((count) => translate(locale, key, { count }))

  test('en: 1 / 3 / 5 / 21', () => {
    assert.deepEqual(at('en', 'meta.layers'), ['1 layer', '3 layers', '5 layers', '21 layers'])
    assert.deepEqual(at('en', 'palette.edits'), ['1 edit', '3 edits', '5 edits', '21 edits'])
  })

  test('ru: 1 / 3 / 5 / 21', () => {
    assert.deepEqual(at('ru', 'meta.layers'), ['1 слой', '3 слоя', '5 слоёв', '21 слой'])
    assert.deepEqual(at('ru', 'palette.edits'), ['1 правка', '3 правки', '5 правок', '21 правка'])
  })

  // Same expectations the former pluralRu test held.
  test('ru: teens and hundreds', () => {
    const got = [1, 2, 5, 11, 12, 21, 22, 25, 111].map((count) => translate('ru', 'meta.layers', { count }))
    assert.deepEqual(got, ['1 слой', '2 слоя', '5 слоёв', '11 слоёв', '12 слоёв', '21 слой', '22 слоя', '25 слоёв', '111 слоёв'])
  })
})

describe('interpolation', () => {
  test('params fill in, unknown placeholders stay visible', () => {
    assert.equal(translate('en', 'palette.label', { name: 'h2 Title' }), 'Actions: h2 Title')
    assert.equal(translate('en', 'palette.label'), 'Actions: {name}')
  })

  test('rich puts a node in place of a placeholder', () => {
    const parts = translateRich('en', 'android.step2', { cmd: 'NODE' })
    assert.equal(parts.length, 3)
    assert.equal(parts[0], 'Check: ')
    assert.equal((parts[1] as { props: { children: unknown } }).props.children, 'NODE')
  })
})

describe('formatAgo', () => {
  test('ru keeps the former wording', () => {
    assert.equal(formatAgo(10_000, 'ru'), 'только что')
    assert.equal(formatAgo(120_000, 'ru'), '2 мин')
    assert.equal(formatAgo(3 * 3600_000, 'ru'), '3 ч')
  })
  test('en', () => {
    assert.equal(formatAgo(10_000, 'en'), 'just now')
    assert.equal(formatAgo(120_000, 'en'), '2 min')
    assert.equal(formatAgo(3 * 3600_000, 'en'), '3 h')
    assert.equal(formatAgo(50 * 3600_000, 'en'), '2 d')
  })
})

// The built-in agent and its sign-in hint are gone; what replaced them is the connect hint.
describe('agent connect copy', () => {
  test('the phrase to tell the agent names the window in both languages', () => {
    for (const l of LOCALES) assert.match(translate(l, 'agent.phrase'), /layout-debug/, l)
  })
})

describe('stored locale', () => {
  test('without localStorage the window is English', () => {
    assert.equal(readStoredLocale(), 'en')
  })
})

describe('stored locale key', () => {
  test('index.html boot panel reads the same key as the app', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    const keys = [...html.matchAll(/localStorage\.getItem\('([^']+)'\)/g)].map((m) => m[1])
    assert.deepEqual(keys, [STORAGE_KEY])
  })
})
