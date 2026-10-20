import type { Page, WebSocketRoute } from '@playwright/test'
import type { LayoutNode, ServerToUi, Snapshot, UiToServer } from '../../src/shared/protocol.ts'
import type { StreamToUi } from '../../src/shared/stream.ts'
import { expect, palette } from './helpers'

/**
 * The window in Android mode, without a device: the socket to the server is answered here
 * (page.routeWebSocket), and every `androidCapture` gets a fresh snapshot of the same screen
 * with new node ids — what a real device recapture looks like every ~0.8 s.
 */

/** A 1×1 PNG: the device picture only has to decode. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

export const VIEWPORT = { w: 1080, h: 2160 }

export function deviceSnapshot(frame: number): Snapshot {
  const id = (name: string) => `f${frame}-${name}`
  const node = (
    name: string,
    parent: string | null,
    kids: string[],
    depth: number,
    kind: string,
    bounds: LayoutNode['bounds'],
    path: string,
    text?: string,
  ): LayoutNode => ({
    id: id(name),
    parentId: parent ? id(parent) : null,
    childIds: kids.map(id),
    depth,
    kind,
    // What normalize() in src/server/android.ts makes of a node the agent reports text for.
    label: text ? `${kind} "${text}"` : name,
    bounds,
    anchors: { path, sourceLoc: `MainScreen.kt:${10 + depth}`, ...(text ? { text } : {}) },
    styles: {},
  })
  const nodes = [
    node('root', null, ['card', 'footer'], 0, 'Column', { x: 0, y: 0, ...VIEWPORT }, 'Column'),
    node('card', 'root', ['title'], 1, 'Card', { x: 120, y: 400, w: 840, h: 600 }, 'Column/Card[0]'),
    node('title', 'card', [], 2, 'Text', { x: 180, y: 460, w: 500, h: 90 }, 'Column/Card[0]/Text[0]', 'Welcome back'),
    node('footer', 'root', [], 1, 'Button', { x: 120, y: 1800, w: 840, h: 160 }, 'Column/Button[1]'),
  ]
  return {
    id: `snap-${frame}`,
    target: 'android',
    createdAt: Date.now(),
    unit: 'dp',
    pxPerUnit: 2.625,
    viewport: VIEWPORT,
    rootId: id('root'),
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    app: { package: 'com.example.app', pid: 4242, source: 'agent' },
  }
}

export interface FakeDevice {
  frames: () => number
  /** The `picture` flag of every `androidCapture` so far (undefined: not sent). */
  pictureFlags: () => Array<boolean | undefined>
  /** How many live video sockets the window opened. */
  streams: () => number
}

/**
 * The live video socket (`/ws/stream`) of a machine without scrcpy: the server says so and
 * closes, as src/server/index.ts openStream does. Never the real server: it is in web mode.
 */
function noScrcpy(ws: WebSocketRoute) {
  const msg: StreamToUi = { t: 'error', code: 'scrcpy_not_found', detail: 'no scrcpy on PATH, and LD_SCRCPY_SERVER is not set' }
  ws.send(JSON.stringify(msg))
  void ws.close({ code: 1000 })
}

export async function openAndroidWindow(page: Page): Promise<FakeDevice> {
  let frame = 0
  let streams = 0
  const pictureFlags: Array<boolean | undefined> = []
  await page.routeWebSocket(/\/ws\/stream$/, (ws: WebSocketRoute) => {
    streams++
    noScrcpy(ws)
  })
  await page.addInitScript(() => {
    try {
      localStorage.setItem('layout-debug.coachSeen', '1')
    } catch {
      // No storage: nothing to hide on Android anyway.
    }
  })
  await page.route('**/api/android/screenshot**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }))
  await page.routeWebSocket(/\/ws$/, (ws: WebSocketRoute) => {
    const out = (msg: ServerToUi) => ws.send(JSON.stringify(msg))
    out({
      t: 'ready',
      target: 'android',
      projectDir: null,
      targetUrl: '',
      device: 'emulator-5554',
      deviceModel: 'Pixel 8',
      listening: false,
      telemetry: { enabled: false, showNotice: false },
    })
    out({ t: 'requests', requests: [] })
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as UiToServer
      if (msg.t !== 'androidCapture') return
      pictureFlags.push(msg.picture)
      frame++
      const n = frame
      setTimeout(() => out({ t: 'androidSnapshot', snapshot: deviceSnapshot(n), frame: n }), 30)
    })
  })
  await page.goto('/')
  await expect(page.getByRole('main', { name: 'Device frame. Click to select a layer' })).toBeVisible()
  await expect(page.locator('img.device')).toBeVisible()
  return { frames: () => frame, pictureFlags: () => [...pictureFlags], streams: () => streams }
}

/** The card node's box on screen (the overlay draws every layer as a box with its label). */
export async function clickCard(page: Page) {
  const img = (await page.locator('img.device').boundingBox())!
  const scale = img.width / VIEWPORT.w
  // Inside the Card, outside its Text: the tightest layer there is the Card.
  await page.mouse.click(img.x + 800 * scale, img.y + 900 * scale)
  await expect(palette(page)).toBeVisible()
  await expect(palette(page)).toHaveAccessibleName(/Card/)
}

