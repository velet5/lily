// Lily Studio's main process: one window with the fixed layout of
// renderer/index.html (DECISIONS D28). Later steps add the file, compile and
// playback services here and reach the renderer only through preload.ts.
import { app, BrowserWindow } from 'electron'
import * as path from 'node:path'

/** Run by `npm test`: load the window hidden, check the layout, exit. */
const smokeTest = process.argv.includes('--smoke-test')

/** The panes of the layout, by `data-pane`, in their order from the left. */
const PANES = ['files', 'editor', 'preview'] as const

let mainWindow: BrowserWindow | undefined

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: 'Lily Studio',
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  // The renderer never navigates or opens windows; links out go through the
  // main process when a later step needs them.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (!smokeTest) window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    mainWindow = undefined
  })
  void window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  return window
}

/** Checks that the three panes are laid out side by side and not empty. */
async function runSmokeTest(window: BrowserWindow): Promise<number> {
  const script = `(() => {
    const panes = ${JSON.stringify(PANES)}.map((name) => {
      const element = document.querySelector('[data-pane="' + name + '"]')
      const rect = element && element.getBoundingClientRect()
      return rect && { name, left: rect.left, width: rect.width, height: rect.height }
    })
    return { title: document.title, panes, studio: typeof window.studio === 'object' && window.studio !== null }
  })()`
  const report = (await window.webContents.executeJavaScript(script)) as {
    title: string
    panes: ({ name: string; left: number; width: number; height: number } | null)[]
    studio: boolean
  }
  const problems: string[] = []
  if (report.title !== 'Lily Studio') problems.push(`title is ${JSON.stringify(report.title)}`)
  if (!report.studio) problems.push('the preload API window.studio is missing')
  let right = -1
  report.panes.forEach((pane, index) => {
    if (!pane) {
      problems.push(`pane ${PANES[index]} is missing`)
      return
    }
    if (pane.width < 100 || pane.height < 100) problems.push(`pane ${pane.name} is ${pane.width}×${pane.height}`)
    if (pane.left <= right) problems.push(`pane ${pane.name} is not right of the one before`)
    right = pane.left
  })
  console.log(JSON.stringify({ ok: problems.length === 0, problems, ...report }, null, 2))
  return problems.length === 0 ? 0 : 1
}

// One window per application: a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    mainWindow = createWindow()
    if (smokeTest) {
      const window = mainWindow
      const timeout = setTimeout(() => {
        console.error('smoke test: the window did not load within 20 s')
        app.exit(1)
      }, 20_000)
      window.webContents.once('did-finish-load', () => {
        runSmokeTest(window).then(
          (code) => app.exit(code),
          (error: unknown) => {
            console.error(error)
            app.exit(1)
          },
        ).finally(() => clearTimeout(timeout))
      })
    }
    app.on('activate', () => {
      if (!mainWindow) mainWindow = createWindow()
    })
  })

  // The studio is its one window; closing it ends the application, on macOS too.
  app.on('window-all-closed', () => app.quit())
}
