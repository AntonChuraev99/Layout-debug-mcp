import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import * as babel from '@babel/core'
import {
  NO_ENV_WARNING,
  envGatedPlugin,
  explicitEnv,
  isHostTag,
  resetNoEnvWarning,
  resolveRoot,
  sourceLocValue,
  type BabelApi,
} from './sourceLoc.ts'
import layoutDebugSourceLoc, { transformSourceLoc, type BabelCore } from './vite.ts'

// Babel resolves the file name with the OS path module (on Windows `/work` turns
// into `C:\work`), so the transform-level tests use native paths. Literal Windows
// and posix paths are tested on sourceLocValue, which is plain string work.
const ROOT = resolve('/work/app')
const FILE = join(ROOT, 'src', 'App.tsx')

const core = babel as unknown as BabelCore

async function run(code: string, filename = FILE, root = ROOT): Promise<string> {
  const warnings: string[] = []
  const out = await transformSourceLoc(core, code, filename, root, (m) => warnings.push(m))
  assert.deepEqual(warnings, [])
  assert.ok(out, 'expected the transform to return code')
  return out.code
}

const locs = (code: string) => [...code.matchAll(/data-source-loc="([^"]*)"/g)].map((m) => m[1])

test('nested host elements each get their own file:line', async () => {
  const out = await run(['export const A = () => (', '  <div>', '    <span>hi</span>', '  </div>', ')'].join('\n'))
  assert.deepEqual(locs(out), ['src/App.tsx:2', 'src/App.tsx:3'])
})

test('fragments and Capitalized / member components are skipped', async () => {
  const out = await run(
    ['const A = () => (', '  <>', '    <Card>', '      <ui.Button />', '      <React.Fragment><p /></React.Fragment>', '    </Card>', '  </>', ')'].join('\n'),
  )
  assert.deepEqual(locs(out), ['src/App.tsx:5'])
  assert.match(out, /<p data-source-loc="src\/App\.tsx:5" \/>/)
})

test('an existing data-source-loc is kept, not overwritten or duplicated', async () => {
  const out = await run('const a = <div data-source-loc="lib/Real.tsx:9" className="x" />')
  assert.deepEqual(locs(out), ['lib/Real.tsx:9'])
})

test('the attribute goes first, so an explicit spread still overrides it', async () => {
  const out = await run('const a = <div {...props} id="x" />')
  assert.match(out, /<div data-source-loc="src\/App\.tsx:1" \{\.\.\.props\} id="x" \/>/)
})

test('TypeScript syntax in .tsx survives, and custom elements count as host tags', async () => {
  const out = await run('const f = <T,>(x: T): T => x\nexport const A = (): JSX.Element => <my-el as="b" />')
  assert.match(out, /x: T/)
  assert.deepEqual(locs(out), ['src/App.tsx:2'])
})

test('nested folders come out relative with forward slashes on every OS', async () => {
  const out = await run('const a = <div />', join(ROOT, 'src', 'ui', 'Card.tsx'))
  assert.deepEqual(locs(out), ['src/ui/Card.tsx:1'])
})

test('Windows path separators and drive letter case are normalized', () => {
  assert.equal(sourceLocValue('C:\\Users\\dev\\app\\src\\ui\\Card.tsx', 'c:\\Users\\dev\\app', 7), 'src/ui/Card.tsx:7')
  assert.equal(sourceLocValue('C:/Users/dev/app/src/A.tsx', 'C:\\Users\\dev\\app\\', 8), 'src/A.tsx:8')
})

test('a file without JSX is left alone', async () => {
  assert.equal(await transformSourceLoc(core, 'export const a = 1', FILE, ROOT, assert.fail), null)
})

test('decorated classes (TS-style, MobX, standard `export @dec`) still get the attribute', async () => {
  const legacy = await run(
    ['@observer', 'export class A extends Component {', '  @observable x = 1', '  constructor(@Inject() s: S) { super() }', '  render() { return <div /> }', '}'].join('\n'),
  )
  assert.deepEqual(locs(legacy), ['src/App.tsx:5'])
  const standard = await run('export @observer class B { render() { return <span /> } }')
  assert.deepEqual(locs(standard), ['src/App.tsx:1'])
  const jsx = await run('@observer\nclass C { render() { return <p /> } }', join(ROOT, 'src', 'C.jsx'))
  assert.deepEqual(locs(jsx), ['src/C.jsx:2'])
})

test('a file Babel cannot parse is served unchanged (null) with one warning naming the file and the error', async () => {
  const warnings: string[] = []
  const out = await transformSourceLoc(core, 'const a = <div>{</div>', FILE, ROOT, (m) => warnings.push(m))
  assert.equal(out, null)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0]!.includes(FILE), warnings[0])
  assert.match(warnings[0]!, /Babel could not parse it \(.+\)\. The file is served unchanged\./)
})

test('the Vite plugin warns once per unparsable file and returns null instead of failing the module', async () => {
  const plugin = layoutDebugSourceLoc()
  const warnings: string[] = []
  const ctx = { warn: (m: string) => warnings.push(m) }
  ;(plugin.configResolved as (c: { root: string }) => void)({ root: ROOT })
  const transform = plugin.transform as unknown as (this: typeof ctx, code: string, id: string) => Promise<unknown>
  const bad = FILE.replace(/\\/g, '/')
  assert.equal(await transform.call(ctx, 'const a = <div>{</div>', bad), null)
  assert.equal(await transform.call(ctx, 'const a = <div>{</div>', `${bad}?t=1`), null)
  assert.equal(warnings.length, 1)
})

test('relative `root` is resolved against the bundler root, posix and Windows style', async () => {
  assert.equal(resolveRoot('../..', '/work/repo/apps/web'), '/work/repo')
  assert.equal(resolveRoot(undefined, '/work/app'), '/work/app')
  assert.equal(resolveRoot('/abs/root', '/work/app'), '/abs/root')
  assert.equal(resolveRoot('..\\..', 'C:\\work\\repo\\apps\\web'), '/c:/work/repo')
  assert.equal(resolveRoot('D:\\other', 'C:\\work'), '/d:/other')
  assert.equal(sourceLocValue('C:\\work\\repo\\apps\\web\\src\\A.tsx', resolveRoot('..\\..', 'C:\\work\\repo\\apps\\web'), 2), 'apps/web/src/A.tsx:2')
  assert.equal(sourceLocValue('/work/repo/apps/web/src/A.tsx', resolveRoot('../..', '/work/repo/apps/web'), 2), 'apps/web/src/A.tsx:2')

  // End to end through the Vite plugin: `{ root: '..' }` from the app folder.
  const plugin = layoutDebugSourceLoc({ root: '..' })
  ;(plugin.configResolved as (c: { root: string }) => void)({ root: ROOT })
  const transform = plugin.transform as unknown as (this: { warn: typeof assert.fail }, code: string, id: string) => Promise<{ code: string } | null>
  const out = await transform.call({ warn: assert.fail }, 'const a = <div />', FILE)
  assert.deepEqual(locs(out!.code), ['app/src/App.tsx:1'])
})

test('sourceLocValue never returns an absolute path', () => {
  assert.equal(sourceLocValue('/work/app/src/A.tsx', '/work/app', 3), 'src/A.tsx:3')
  assert.equal(sourceLocValue('/work/shared/B.tsx', '/work/app', 4), '../shared/B.tsx:4')
  assert.equal(sourceLocValue('D:\\other\\C.tsx', 'C:\\work\\app', 5), 'C.tsx:5')
  assert.equal(sourceLocValue('src/D.tsx', '/work/app', 6), 'D.tsx:6')
})

test('isHostTag: lowercase intrinsic tags only', () => {
  assert.equal(isHostTag('div'), true)
  assert.equal(isHostTag('my-element'), true)
  assert.equal(isHostTag('Card'), false)
  assert.equal(isHostTag('_x'), false)
})

function babelWithEnv(env: Record<string, string | undefined>, warn: (m: string) => void, root?: string): string {
  return (
    babel.transformSync('const a = <div />', {
      filename: FILE,
      cwd: ROOT,
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: ['jsx'] },
      plugins: [(api: BabelApi) => envGatedPlugin(api, { root }, env, warn)],
    })?.code ?? ''
  )
}

test('the Babel plugin is on only when BABEL_ENV / NODE_ENV is explicitly development', () => {
  assert.deepEqual(locs(babelWithEnv({ NODE_ENV: 'development' }, assert.fail)), ['src/App.tsx:1'])
  assert.deepEqual(locs(babelWithEnv({ BABEL_ENV: 'development', NODE_ENV: 'production' }, assert.fail)), ['src/App.tsx:1'])
  assert.deepEqual(locs(babelWithEnv({ NODE_ENV: 'production' }, assert.fail)), [])
  assert.deepEqual(locs(babelWithEnv({ BABEL_ENV: 'production', NODE_ENV: 'development' }, assert.fail)), [])
  assert.deepEqual(locs(babelWithEnv({ NODE_ENV: 'test' }, assert.fail)), [])
})

test('no env at all (webpack --mode production) -> off, with one warning saying how to turn it on', () => {
  resetNoEnvWarning()
  const warnings: string[] = []
  assert.deepEqual(locs(babelWithEnv({}, (m) => warnings.push(m))), [])
  assert.deepEqual(locs(babelWithEnv({ NODE_ENV: '' }, (m) => warnings.push(m))), [])
  assert.deepEqual(warnings, [NO_ENV_WARNING])
  assert.match(NO_ENV_WARNING, /NODE_ENV=development/)
  assert.equal(explicitEnv({}), undefined)
  assert.equal(explicitEnv({ NODE_ENV: '', BABEL_ENV: '' }), undefined)
})

test('the Babel plugin resolves a relative root against Babel\'s root', () => {
  assert.deepEqual(locs(babelWithEnv({ NODE_ENV: 'development' }, assert.fail, '..')), ['app/src/App.tsx:1'])
})

test('the public Babel plugin takes no "always" switch', async () => {
  const mod = await import('./babel.ts')
  assert.equal(mod.default.length <= 2, true)
  assert.equal('createSourceLocPlugin' in mod, false)
  assert.equal('envGatedPlugin' in mod, false)
})

test('the Vite plugin runs only in dev serve, before other transforms', () => {
  const plugin = layoutDebugSourceLoc()
  assert.equal(plugin.apply, 'serve')
  assert.equal(plugin.enforce, 'pre')
})
