import * as assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, mock, test } from 'node:test'
import type * as vscode from 'vscode'
import type { CompileResult } from '../../src/compile/compiler'
import {
  CURSOR_DELAY_MS,
  PreviewManager,
  PreviewPanel,
  previewHtml,
  type HostMessage,
  type WebviewMessage,
} from '../../src/preview/panel'
import type { SourceLocation } from '../../src/preview/pointAndClick'

// Runs without an extension host (DECISIONS D13): the panel only uses `vscode`
// types, so a fake WebviewPanel is enough.

const uri = (value: string) => ({ toString: () => value }) as vscode.Uri

const assets = {
  root: uri('file:///ext/media'),
  script: uri('file:///ext/media/preview.js'),
  style: uri('file:///ext/media/preview.css'),
}

class FakePanel {
  readonly posted: HostMessage[] = []
  readonly reveals: unknown[][] = []
  disposals = 0
  private receive: (message: WebviewMessage) => void = () => {}
  private readonly disposeListeners: Array<() => void> = []

  readonly webview = {
    cspSource: 'https://webview.test',
    html: '',
    options: {} as vscode.WebviewOptions,
    asWebviewUri: (resource: vscode.Uri) =>
      uri(resource.toString().replace('file://', 'https://webview.test')),
    postMessage: async (message: HostMessage) => {
      this.posted.push(message)
      return true
    },
    onDidReceiveMessage: (listener: (message: WebviewMessage) => void) => {
      this.receive = listener
      return { dispose: () => (this.receive = () => {}) }
    },
  }

  onDidDispose(listener: () => void) {
    this.disposeListeners.push(listener)
    return { dispose: () => {} }
  }

  reveal(...args: unknown[]) {
    this.reveals.push(args)
  }

  /** Both the API call and the user closing the tab end up here. */
  dispose() {
    this.disposals++
    for (const listener of this.disposeListeners.splice(0)) listener()
  }

  fromWebview(message: WebviewMessage) {
    this.receive(message)
  }

  take(): HostMessage[] {
    return this.posted.splice(0)
  }

  get asPanel() {
    return this as unknown as vscode.WebviewPanel
  }
}

function result(partial: Partial<CompileResult>): CompileResult {
  return {
    rootFile: '/scores/song.ly',
    ok: true,
    cancelled: false,
    exitCode: 0,
    pages: [],
    midi: [],
    stdout: '',
    stderr: '',
    outputDir: undefined,
    durationMs: 1,
    ...partial,
  }
}

describe('previewHtml', () => {
  const html = previewHtml({
    cspSource: 'https://webview.test',
    nonce: 'N0nce+/=',
    scriptUri: 'https://webview.test/media/preview.js?a=1&b="2"',
    styleUri: 'https://webview.test/media/preview.css',
    colors: 'paper',
  })
  const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? ''

  test('the policy denies by default and allows nothing inline', () => {
    assert.deepStrictEqual(csp.split('; '), [
      "default-src 'none'",
      'img-src data:',
      'style-src https://webview.test',
      "script-src 'nonce-N0nce+/='",
    ])
    assert.doesNotMatch(csp, /unsafe|\*/)
  })

  test('the only script carries the nonce and nothing is inline', () => {
    const scripts = html.match(/<script\b[^>]*>/g)
    assert.deepStrictEqual(scripts, [
      '<script nonce="N0nce+/=" src="https://webview.test/media/preview.js?a=1&amp;b=&quot;2&quot;">',
    ])
    assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=/i)
  })

  test('the initial colours are in the markup, so the first paint is right', () => {
    assert.match(html, /<body data-colors="paper">/)
  })
})

describe('PreviewPanel', () => {
  let dir: string
  let pageFiles: string[]

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-preview-test-'))
    pageFiles = ['song-1.svg', 'song-2.svg'].map((name) => path.join(dir, name))
    await fs.writeFile(pageFiles[0], '<svg>one</svg>')
    await fs.writeFile(pageFiles[1], '<svg>two</svg>')
  })

  after(() => fs.rm(dir, { recursive: true, force: true }))

  const create = (colors: 'theme' | 'paper' = 'theme') => {
    const fake = new FakePanel()
    let closed = 0
    const clicked: SourceLocation[] = []
    const preview = new PreviewPanel('/scores/song.ly', fake.asPanel, {
      assets,
      colors,
      onDidDispose: () => closed++,
      onDidClickSource: (location) => clicked.push(location),
    })
    return { fake, preview, clicked, closed: () => closed }
  }

  test('scripts are enabled and only media/ can be loaded', () => {
    const { fake } = create()
    assert.deepStrictEqual(fake.webview.options, {
      enableScripts: true,
      localResourceRoots: [assets.root],
    })
    assert.match(fake.webview.html, /src="https:\/\/webview\.test\/ext\/media\/preview\.js"/)
    assert.match(fake.webview.html, /href="https:\/\/webview\.test\/ext\/media\/preview\.css"/)
  })

  test('every panel gets its own nonce', () => {
    const nonce = (html: string) => /nonce="([^"]+)"/.exec(html)?.[1]
    const [a, b] = [create().fake.webview.html, create().fake.webview.html].map(nonce)
    assert.ok(a && b && a !== b)
  })

  test('a followed run is busy, then renders the page text in order', async () => {
    const { fake, preview } = create()
    let finish!: (value: CompileResult) => void
    const following = preview.follow(new Promise((resolve) => (finish = resolve)))
    assert.deepStrictEqual(fake.take(), [{ type: 'status', busy: true, note: undefined }])

    finish(result({ pages: pageFiles }))
    await following
    assert.deepStrictEqual(fake.take(), [
      { type: 'render', revision: 1, pages: ['<svg>one</svg>', '<svg>two</svg>'] },
      { type: 'status', busy: false, note: undefined },
    ])
    assert.strictEqual(preview.hasPages, true)
  })

  test('a reloaded webview is sent the colours, the pages and the status again', async () => {
    const { fake, preview } = create('paper')
    await preview.follow(Promise.resolve(result({ pages: [pageFiles[0]] })))
    fake.take()

    fake.fromWebview({ type: 'ready' })
    assert.deepStrictEqual(fake.take(), [
      { type: 'colors', colors: 'paper' },
      { type: 'render', revision: 1, pages: ['<svg>one</svg>'] },
      { type: 'status', busy: false, note: undefined },
    ])
  })

  test('a failed run without pages keeps the previous render', async () => {
    const { fake, preview } = create()
    await preview.follow(Promise.resolve(result({ pages: pageFiles })))
    fake.take()

    await preview.follow(Promise.resolve(result({ ok: false, exitCode: 1 })))
    const posted = fake.take()
    assert.ok(!posted.some((message) => message.type === 'render'))
    assert.deepStrictEqual(posted.at(-1), {
      type: 'status',
      busy: false,
      note: 'Compile failed. Showing the last successful render.',
    })

    fake.fromWebview({ type: 'ready' })
    assert.strictEqual(fake.take().find((m) => m.type === 'render')?.revision, 1)
  })

  test('a failed run that still wrote pages shows them, with a note', async () => {
    const { fake, preview } = create()
    await preview.follow(Promise.resolve(result({ ok: false, exitCode: 1, pages: [pageFiles[1]] })))
    assert.deepStrictEqual(fake.take().slice(1), [
      { type: 'render', revision: 1, pages: ['<svg>two</svg>'] },
      { type: 'status', busy: false, note: 'Compiled with errors. See the Problems panel.' },
    ])
  })

  test('the first failure and a run that could not start explain the empty panel', async () => {
    const { fake, preview } = create()
    await preview.follow(Promise.resolve(result({ ok: false, exitCode: 1 })))
    assert.deepStrictEqual(fake.take().at(-1), {
      type: 'status',
      busy: false,
      note: 'Compile failed. See the Problems panel.',
    })
    await preview.follow(Promise.resolve(undefined))
    assert.deepStrictEqual(fake.take().at(-1), {
      type: 'status',
      busy: false,
      note: 'LilyPond could not be run. See the LilyPond output.',
    })
    assert.strictEqual(preview.hasPages, false)
  })

  test('a cancelled run changes nothing; busy lasts until its successor ends', async () => {
    const { fake, preview } = create()
    let finish!: (value: CompileResult) => void
    const successor = preview.follow(new Promise((resolve) => (finish = resolve)))
    await preview.follow(Promise.resolve(result({ cancelled: true, pages: pageFiles })))
    assert.deepStrictEqual(fake.take().at(-1), { type: 'status', busy: true, note: undefined })

    finish(result({ pages: [pageFiles[0]] }))
    await successor
    assert.deepStrictEqual(fake.take(), [
      { type: 'render', revision: 1, pages: ['<svg>one</svg>'] },
      { type: 'status', busy: false, note: undefined },
    ])
  })

  test('pages deleted by a newer run are skipped, not an error', async () => {
    const { fake, preview } = create()
    await preview.follow(Promise.resolve(result({ pages: [path.join(dir, 'gone.svg')] })))
    assert.deepStrictEqual(fake.take().at(-1), { type: 'status', busy: false, note: undefined })
    assert.strictEqual(preview.hasPages, false)
  })

  test('whenRendered waits for the webview to draw the latest revision', async () => {
    const { fake, preview } = create()
    await preview.follow(Promise.resolve(result({ pages: [pageFiles[0]] })))
    await preview.follow(Promise.resolve(result({ pages: pageFiles })))
    let drawn: number | undefined
    const waiting = preview.whenRendered().then((pages) => (drawn = pages))

    fake.fromWebview({ type: 'rendered', revision: 1, pages: 1 })
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(drawn, undefined, 'revision 1 is not the latest')

    fake.fromWebview({ type: 'rendered', revision: 2, pages: 2 })
    assert.strictEqual(await waiting, 2)
    assert.strictEqual(await preview.whenRendered(), 2)
  })

  test('zoom and colours are forwarded to the webview', () => {
    const { fake, preview } = create()
    preview.zoom('in')
    preview.zoom('fit')
    preview.setColors('paper')
    assert.deepStrictEqual(fake.take(), [
      { type: 'zoom', action: 'in' },
      { type: 'zoom', action: 'fit' },
      { type: 'colors', colors: 'paper' },
    ])
  })

  describe('point-and-click', () => {
    const song = '/scores/song.ly'
    const href = (char: number) => `textedit://${song}:2:${char}:${char + 1}`
    let linked: string

    before(async () => {
      linked = path.join(dir, 'linked.svg')
      await fs.writeFile(linked, `<svg><a xlink:href="${href(2)}"/><a xlink:href="${href(6)}"/></svg>`)
    })

    const rendered = async () => {
      const created = create()
      await created.preview.follow(Promise.resolve(result({ pages: [linked] })))
      created.fake.take()
      return created
    }

    test('a clicked textedit link is parsed on the host and reported as a location', async () => {
      const { fake, clicked } = await rendered()
      fake.fromWebview({ type: 'reveal', href: href(6) })
      fake.fromWebview({ type: 'reveal', href: 'https://lilypond.org' })
      fake.fromWebview({ type: 'reveal', href: 'textedit://song.ly:1:2:3' })
      fake.fromWebview({ type: 'reveal', href: 7 as unknown as string })
      assert.deepStrictEqual(clicked, [{ file: path.normalize(song), line: 2, char: 6 }])
    })

    test('the cursor marks its link and scrolls to it; off the score it clears once', async () => {
      const { fake, preview } = await rendered()
      preview.showCursor({ file: song, line: 2, char: 7 })
      assert.deepStrictEqual(fake.take(), [{ type: 'highlight', hrefs: [href(6)], reveal: true }])
      fake.fromWebview({ type: 'highlighted', elements: 1 })
      assert.strictEqual(preview.highlighted, 1)

      preview.showCursor({ file: song, line: 9, char: 0 })
      preview.showCursor({ file: '/scores/other.ly', line: 2, char: 7 })
      preview.showCursor(undefined)
      assert.deepStrictEqual(fake.take(), [{ type: 'highlight', hrefs: [], reveal: true }])
    })

    test('the cursor that a click placed marks the note without scrolling it away', async () => {
      const { fake, preview } = await rendered()
      fake.fromWebview({ type: 'reveal', href: href(6) })
      preview.showCursor({ file: song, line: 2, char: 6 })
      preview.showCursor({ file: song, line: 2, char: 6 })
      assert.deepStrictEqual(fake.take(), [
        { type: 'highlight', hrefs: [href(6)], reveal: false },
        { type: 'highlight', hrefs: [href(6)], reveal: true },
      ])
    })

    test('a refresh and a reloaded webview mark the cursor again, without scrolling', async () => {
      const { fake, preview } = await rendered()
      preview.showCursor({ file: song, line: 2, char: 2 })
      fake.take()

      await preview.follow(Promise.resolve(result({ pages: [linked] })))
      const again = { type: 'highlight', hrefs: [href(2)], reveal: false }
      assert.deepStrictEqual(fake.take().slice(1, 3), [
        { type: 'render', revision: 2, pages: [await fs.readFile(linked, 'utf8')] },
        again,
      ])

      fake.fromWebview({ type: 'ready' })
      assert.deepStrictEqual(fake.take().at(-1), again)
    })

    test('a cursor placed before the first render is marked by that render', async () => {
      const { fake, preview } = create()
      preview.showCursor({ file: song, line: 2, char: 2 })
      assert.deepStrictEqual(fake.take(), [])
      await preview.follow(Promise.resolve(result({ pages: [linked] })))
      assert.deepStrictEqual(
        fake.take().filter((message) => message.type === 'highlight'),
        [{ type: 'highlight', hrefs: [href(2)], reveal: false }],
      )
    })
  })

  test('closing the tab disposes once and later results are dropped', async () => {
    const { fake, preview, closed } = create()
    fake.dispose()
    preview.dispose()
    assert.strictEqual(closed(), 1)
    await preview.follow(Promise.resolve(result({ pages: pageFiles })))
    assert.deepStrictEqual(fake.take(), [])
  })
})

describe('PreviewManager', () => {
  const create = () => {
    const fakes: FakePanel[] = []
    const titles: string[] = []
    const closed: string[] = []
    const revealed: Array<[SourceLocation, string]> = []
    const manager = new PreviewManager({
      assets,
      colors: () => 'theme',
      createPanel: (title) => {
        titles.push(title)
        fakes.push(new FakePanel())
        return fakes.at(-1)!.asPanel
      },
      onDidClose: (rootFile) => closed.push(rootFile),
      revealSource: (location, preview) => revealed.push([location, preview.rootFile]),
    })
    return { manager, fakes, titles, closed, revealed }
  }
  const song = path.resolve('/scores/song.ly')

  test('one panel per root file; opening again reveals it without taking the focus', () => {
    const { manager, fakes, titles } = create()
    const first = manager.open(song)
    const again = manager.open(path.join(path.dirname(song), '.', 'song.ly'))
    assert.strictEqual(first.created, true)
    assert.strictEqual(again.created, false)
    assert.strictEqual(again.preview, first.preview)
    assert.deepStrictEqual(titles, ['Preview song.ly'])
    assert.deepStrictEqual(fakes[0].reveals, [[undefined, true]])

    assert.strictEqual(manager.open(path.resolve('/scores/other.ly')).created, true)
    assert.strictEqual(fakes.length, 2)
  })

  test('a closed panel is forgotten and its root is released', () => {
    const { manager, fakes, closed } = create()
    manager.open(song)
    fakes[0].dispose()
    assert.strictEqual(manager.get(song), undefined)
    assert.deepStrictEqual(closed, [song])
    assert.strictEqual(manager.open(song).created, true)
  })

  describe('point-and-click', () => {
    let dir: string
    let page: string
    const at = (file: string, char: number) => `textedit://${file}:1:${char}:${char + 1}`

    before(async () => {
      dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-manager-test-')))
      page = path.join(dir, 'song.svg')
      // `{ 𝄞𝄞 c d }`: the c is CHAR 5 and character 7.
      await fs.writeFile(page, `<svg><a xlink:href="${at(song, 5)}"/><a xlink:href="${at(song, 7)}"/></svg>`)
    })

    after(() => fs.rm(dir, { recursive: true, force: true }))

    const open = async () => {
      const created = create()
      const { preview } = created.manager.open(song)
      created.manager.open(path.resolve('/scores/other.ly'))
      await preview.follow(Promise.resolve(result({ pages: [page] })))
      for (const fake of created.fakes) fake.take()
      return created
    }
    const cursor = (character: number) => ({ file: song, line: 0, character, lineText: '{ 𝄞𝄞 c d }' })

    test('a click is handed to the host with the preview it happened in', async () => {
      const { fakes, revealed } = await open()
      fakes[0].fromWebview({ type: 'reveal', href: at(song, 7) })
      assert.deepStrictEqual(revealed, [[{ file: song, line: 1, char: 7 }, song]])
    })

    test('the editor cursor is converted to a line and CHAR for the previews that know the file', async () => {
      const { manager, fakes } = await open()
      await manager.showCursor(cursor(8))
      assert.deepStrictEqual(fakes[0].take(), [{ type: 'highlight', hrefs: [at(song, 5)], reveal: true }])
      assert.deepStrictEqual(fakes[1].take(), [])

      await manager.showCursor(undefined)
      assert.deepStrictEqual(fakes[0].take(), [{ type: 'highlight', hrefs: [], reveal: true }])
    })

    test('a moving cursor is followed once it rests', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const { manager, fakes } = await open()
      const shown = mock.method(manager, 'showCursor')
      manager.followCursor(cursor(7))
      t.mock.timers.tick(CURSOR_DELAY_MS - 1)
      manager.followCursor(cursor(9))
      t.mock.timers.tick(CURSOR_DELAY_MS - 1)
      assert.strictEqual(shown.mock.callCount(), 0)
      t.mock.timers.tick(1)
      assert.strictEqual(shown.mock.callCount(), 1)
      await shown.mock.calls[0].result
      assert.deepStrictEqual(fakes[0].take(), [{ type: 'highlight', hrefs: [at(song, 7)], reveal: true }])

      manager.followCursor(cursor(7))
      manager.dispose()
      t.mock.timers.tick(CURSOR_DELAY_MS)
      assert.strictEqual(shown.mock.callCount(), 1, 'nothing fires after dispose')
    })
  })

  test('dispose closes every panel', () => {
    const { manager, fakes } = create()
    manager.open(song)
    manager.open(path.resolve('/scores/other.ly'))
    manager.dispose()
    assert.deepStrictEqual(fakes.map((fake) => fake.disposals), [1, 1])
    assert.strictEqual(manager.get(song), undefined)
  })
})

describe('media/preview.js', () => {
  interface Rect {
    top: number
    height: number
  }
  interface Anchor {
    page: number
    offset: number
  }
  // Plain JS shared with the webview; outside one it only exports its pure half.
  // `npm run test:unit` runs from the repository root.
  const script = require(path.resolve('media/preview.js')) as {
    clampZoom(zoom: number): number
    stepZoom(zoom: number, direction: number): number
    zoomLabel(zoom: number): string
    captureAnchor(pages: Rect[], y: number): Anchor | null
    resolveAnchor(anchor: Anchor | null, pages: Rect[]): number
    allowedElement(name: string): boolean
    allowedAttribute(element: string, name: string, value: string): boolean
    isSourceLink(href: string): boolean
    scrollToShow(start: number, size: number, viewport: number): number
  }

  /** Pages of `height` stacked with the 16px padding and gap of preview.css. */
  const stack = (count: number, height: number): Rect[] =>
    Array.from({ length: count }, (_, i) => ({ top: 16 + i * (height + 16), height }))

  test('zoom steps pass through fit-width and stop at the limits', () => {
    assert.strictEqual(script.stepZoom(1, 1), 1.1)
    assert.strictEqual(script.stepZoom(1, -1), 0.9)
    assert.strictEqual(script.stepZoom(0.95, 1), 1)
    assert.strictEqual(script.stepZoom(1.18, -1), 1.1)
    assert.strictEqual(script.stepZoom(4, 1), 4)
    assert.strictEqual(script.stepZoom(0.25, -1), 0.25)
    assert.strictEqual(script.clampZoom(9), 4)
    assert.strictEqual(script.clampZoom(0), 0.25)
    assert.strictEqual(script.clampZoom(Number.NaN), 1)
    assert.deepStrictEqual([1, 1.25, 0.333].map(script.zoomLabel), ['Fit', '125%', '33%'])
  })

  test('a refresh with the same layout returns to the same pixel', () => {
    const pages = stack(3, 1000)
    for (const y of [0, 16, 700, 1020, 1500, 3047]) {
      assert.strictEqual(script.resolveAnchor(script.captureAnchor(pages, y), pages), y)
    }
  })

  test('the anchor follows its page through a zoom', () => {
    // Half way down page 2, then every page twice as tall.
    const anchor = script.captureAnchor(stack(3, 1000), 16 + 1016 + 500)
    assert.deepStrictEqual(anchor, { page: 1, offset: 0.5 })
    assert.strictEqual(script.resolveAnchor(anchor, stack(3, 2000)), 16 + 2016 + 1000)
  })

  test('a score that got shorter lands at the end of its last page', () => {
    const anchor = script.captureAnchor(stack(3, 1000), 2500)
    assert.strictEqual(script.resolveAnchor(anchor, stack(1, 1000)), 1016)
    assert.strictEqual(script.resolveAnchor(anchor, []), 0)
    assert.strictEqual(script.captureAnchor([], 300), null)
    assert.strictEqual(script.resolveAnchor(null, stack(2, 1000)), 0)
  })

  test('only drawing elements pass the allow-list', () => {
    for (const name of ['svg', 'g', 'a', 'path', 'rect', 'line', 'text', 'tspan', 'image']) {
      assert.ok(script.allowedElement(name), name)
    }
    for (const name of ['script', 'style', 'foreignObject', 'iframe', 'animate', 'set', 'link']) {
      assert.ok(!script.allowedElement(name), name)
    }
  })

  test('handlers, inline styles and foreign references are dropped', () => {
    const allowed = script.allowedAttribute
    assert.ok(allowed('path', 'fill', 'currentColor'))
    assert.ok(allowed('a', 'href', 'textedit:///scores/my%20song.ly:8:27:28'))
    assert.ok(allowed('a', 'href', 'https://lilypond.org'))
    assert.ok(allowed('use', 'href', '#glyph'))
    assert.ok(allowed('image', 'href', 'data:image/png;base64,iVBORw0KGgo='))

    assert.ok(!allowed('g', 'onclick', 'alert(1)'))
    assert.ok(!allowed('svg', 'onLoad', 'alert(1)'))
    assert.ok(!allowed('a', 'style', 'color:inherit;'))
    assert.ok(!allowed('a', 'href', ' javascript:alert(1)'))
    assert.ok(!allowed('a', 'href', 'command:workbench.action.terminal.new'))
    assert.ok(!allowed('use', 'href', 'https://evil.test/sprite.svg#x'))
    assert.ok(!allowed('image', 'href', 'https://evil.test/pixel.png'))
    assert.ok(!allowed('image', 'href', 'data:image/svg+xml;base64,PHN2Zz4='))
  })

  test('only textedit links ask the host for a place in the source', () => {
    assert.ok(script.isSourceLink('textedit:///scores/song.ly:1:2:3'))
    assert.ok(!script.isSourceLink('https://lilypond.org/textedit:'))
    assert.ok(!script.isSourceLink(''))
  })

  test('an element in view is left alone; one outside is centred', () => {
    assert.strictEqual(script.scrollToShow(300, 10, 600), 0)
    assert.strictEqual(script.scrollToShow(900, 10, 600), 605)
    assert.strictEqual(script.scrollToShow(-105, 10, 600), -400)
    // Cut off by the edge counts as outside.
    assert.strictEqual(script.scrollToShow(595, 10, 600), 300)
  })
})
