import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { SERVER_PORT, UI_PORT } from '../shared/ports.ts'
import { checkApiRequest, checkStaticRequest, checkWritePath, checkWsUpgrade, type Verdict } from './security.ts'

const ok = (v: Verdict) => assert.deepEqual(v, { ok: true })
const denied = (v: Verdict, pattern?: RegExp) => {
  assert.equal(v.ok, false, 'ожидался отказ')
  if (pattern && !v.ok) assert.match(v.reason, pattern)
}

const serverHost = `127.0.0.1:${SERVER_PORT}`
const uiOrigin = `http://localhost:${UI_PORT}`

describe('WebSocket upgrade', () => {
  test('окно через Vite-прокси (Host сохраняется, Origin UI) пропускается', () => {
    ok(checkWsUpgrade({ host: `localhost:${UI_PORT}`, origin: uiOrigin }))
    ok(checkWsUpgrade({ host: `127.0.0.1:${UI_PORT}`, origin: `http://127.0.0.1:${UI_PORT}` }))
  })
  test('прямое подключение из окна пропускается', () => {
    ok(checkWsUpgrade({ host: `localhost:${SERVER_PORT}`, origin: uiOrigin }))
  })
  test('чужой origin отклоняется', () => {
    denied(checkWsUpgrade({ host: serverHost, origin: 'https://evil.example' }), /Origin/)
  })
  test('origin другого локального порта отклоняется', () => {
    denied(checkWsUpgrade({ host: serverHost, origin: 'http://localhost:3000' }), /Origin/)
  })
  test('origin "null" (sandbox iframe, file://) отклоняется', () => {
    denied(checkWsUpgrade({ host: serverHost, origin: 'null' }), /Origin/)
  })
  test('rebinding-Host отклоняется даже с разрешённым origin', () => {
    denied(checkWsUpgrade({ host: `evil.com:${SERVER_PORT}`, origin: uiOrigin }), /Host/)
  })
  test('без Host отклоняется', () => {
    denied(checkWsUpgrade({ origin: uiOrigin }), /Host/)
  })
})

describe('HTTP /api', () => {
  test('без Origin с loopback-Host (MCP, curl) пропускается', () => {
    ok(checkApiRequest({ host: serverHost }))
    ok(checkApiRequest({ host: `localhost:${SERVER_PORT}` }))
  })
  test('окно через Vite-прокси (changeOrigin: Host сервера) пропускается', () => {
    ok(checkApiRequest({ host: serverHost, 'sec-fetch-site': 'same-origin' }))
    ok(checkApiRequest({ host: serverHost, origin: uiOrigin, 'sec-fetch-site': 'same-origin' }))
  })
  test('чужой origin отклоняется (POST text/plain без preflight)', () => {
    denied(checkApiRequest({ host: serverHost, origin: 'https://evil.example' }), /Origin/)
  })
  test('origin "null" отклоняется', () => {
    denied(checkApiRequest({ host: serverHost, origin: 'null' }), /Origin/)
  })
  test('rebinding-Host отклоняется', () => {
    denied(checkApiRequest({ host: `evil.com:${SERVER_PORT}` }), /Host/)
    denied(checkApiRequest({ host: 'evil.example' }), /Host/)
  })
  test('межсайтовый GET без Origin (<img src>) отклоняется по Sec-Fetch-Site', () => {
    denied(checkApiRequest({ host: serverHost, 'sec-fetch-site': 'cross-site' }), /Sec-Fetch-Site/)
    denied(checkApiRequest({ host: serverHost, 'sec-fetch-site': 'same-site' }), /Sec-Fetch-Site/)
  })
})

describe('статика (inspector.js, demo)', () => {
  test('грузится с любой страницы', () => {
    ok(checkStaticRequest({ host: `localhost:${SERVER_PORT}`, 'sec-fetch-site': 'cross-site' }))
    ok(checkStaticRequest({ host: serverHost, origin: 'http://localhost:3000' }))
  })
  test('rebinding-Host отклоняется', () => {
    denied(checkStaticRequest({ host: `evil.com:${SERVER_PORT}` }), /Host/)
  })
})

describe('запись агента', () => {
  let base: string
  let project: string
  let outside: string

  before(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ld-sec-')))
    project = join(base, 'project')
    outside = join(base, 'outside')
    mkdirSync(join(project, 'src'), { recursive: true })
    mkdirSync(join(project, '.git'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(project, 'src', 'App.tsx'), '')
    writeFileSync(join(project, '.git', 'config'), '')
    writeFileSync(join(outside, 'secret.txt'), '')
  })
  after(() => rmSync(base, { recursive: true, force: true }))

  test('существующий файл внутри проекта — можно', () => {
    ok(checkWritePath(project, join(project, 'src', 'App.tsx')))
    ok(checkWritePath(project, 'src/App.tsx'))
  })
  test('новый файл в новом каталоге внутри проекта — можно', () => {
    ok(checkWritePath(project, join(project, 'src', 'new', 'Card.tsx')))
  })
  test('имя, начинающееся с "..", но внутри проекта — можно', () => {
    ok(checkWritePath(project, join(project, 'src', '..notes.md')))
  })
  test('путь в другом регистре на Windows — можно', { skip: process.platform !== 'win32' }, () => {
    ok(checkWritePath(project, join(project.toUpperCase(), 'src', 'App.tsx')))
  })
  test('../ наружу — нельзя', () => {
    denied(checkWritePath(project, '../outside/secret.txt'), /\.\./)
    denied(checkWritePath(project, `${project}/../outside/secret.txt`), /\.\./)
  })
  test('абсолютный путь вне проекта — нельзя', () => {
    denied(checkWritePath(project, join(outside, 'secret.txt')), /вне проекта/)
  })
  test('каталог-ссылка (junction) наружу — нельзя', () => {
    symlinkSync(outside, join(project, 'linkdir'), 'junction')
    denied(checkWritePath(project, join(project, 'linkdir', 'secret.txt')), /вне проекта/)
    denied(checkWritePath(project, join(project, 'linkdir', 'new.txt')), /вне проекта/)
  })
  test('висячая ссылка наружу — нельзя', () => {
    symlinkSync(join(outside, 'not-yet'), join(project, 'dangling'), 'junction')
    denied(checkWritePath(project, join(project, 'dangling', 'new.txt')), /вне проекта/)
  })
  test('файловый симлинк наружу — нельзя', (t) => {
    try {
      symlinkSync(join(outside, 'secret.txt'), join(project, 'src', 'link.txt'), 'file')
    } catch (err) {
      // Windows without Developer Mode / admin cannot create file symlinks.
      t.skip(`симлинк не создать: ${(err as NodeJS.ErrnoException).code}`)
      return
    }
    denied(checkWritePath(project, join(project, 'src', 'link.txt')), /вне проекта/)
  })
  test('.git/ — нельзя, в том числе обходными написаниями', () => {
    denied(checkWritePath(project, join(project, '.git', 'config')), /\.git/)
    denied(checkWritePath(project, '.git/hooks/pre-commit'), /\.git/)
    denied(checkWritePath(project, '.GIT/config'), /\.git/)
    denied(checkWritePath(project, '.git./config'), /\.git/)
  })
  test('.claude/ — нельзя, в любом месте и в любом написании', () => {
    denied(checkWritePath(project, '.claude/settings.json'), /\.claude/)
    denied(checkWritePath(project, '.claude/settings.local.json'), /\.claude/)
    denied(checkWritePath(project, 'sub/.claude/x'), /\.claude/)
    denied(checkWritePath(project, '.CLAUDE./settings.json'), /\.claude/)
  })
  test('.mcp.json — нельзя, в любом месте', () => {
    denied(checkWritePath(project, '.mcp.json'), /\.mcp\.json/)
    denied(checkWritePath(project, 'sub/.mcp.json'), /\.mcp\.json/)
  })
  test('CLAUDE.md и файлы с "claude" в имени — можно', () => {
    ok(checkWritePath(project, 'CLAUDE.md'))
    ok(checkWritePath(project, 'src/claude.ts'))
  })
  test('.env* — нельзя', () => {
    denied(checkWritePath(project, '.env.local'), /\.env/)
    denied(checkWritePath(project, '.env'), /\.env/)
    denied(checkWritePath(project, join(project, 'src', '.env.production')), /\.env/)
  })
  test('пустой путь и сам каталог проекта — нельзя', () => {
    denied(checkWritePath(project, ''))
    denied(checkWritePath(project, undefined))
    denied(checkWritePath(project, project))
  })
})
