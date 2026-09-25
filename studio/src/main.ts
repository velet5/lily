// Lily Studio's main process: one window with the fixed layout of
// renderer/index.html (DECISIONS D28), the file access behind it (D29) and
// compile on save (D31), the PDF tab's compile and export (D33), and the
// watch on the files behind them (D34), and live preview of unsaved edits
// (D36), and LilyPond's setup and the sample score (D37). They reach the
// renderer only through preload.ts.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { CompileService } from '../../src/compile/compiler'
import { parseTextEdit } from '../../src/preview/pointAndClick'
import { Access, createFromTemplate, isInside, isScoreFile, listFolder, readScore, unusedName, writeScore, SCORE_EXTENSIONS } from './files'
import { Channel, type Command, type Opened } from './ipc'
import { StudioCompiler } from './main/compileService'
import { LiveCompile } from './main/liveCompile'
import { choicePath, detectLilyPond, readSettings, searchPath, SETUP_LINKS, writeSettings, type LilyPondStatus, type Settings } from './main/lilypondSetup'
import { ScoreWatcher } from './main/watcher'
import { prepareSmokeTest, runSmokeTest } from './smokeTest'
import { SAMPLE, TEMPLATES, type TemplateId } from './templates'

/** Run by `npm test`: load the window hidden, drive it once, exit. */
const smokeTest = process.argv.includes('--smoke-test')

const access = new Access()
/** userData/settings.json: the LilyPond chosen in the setup (D37). */
let settings: Settings = {}
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
// An app opened from the Finder has a bare PATH; lilypond's own helpers (gs) need more.
process.env.PATH = searchPath(process.env.PATH)
const compiler = new StudioCompiler({
  // runtime/, which esbuild.mjs copies beside this file: timing.ly maps the
  // MIDI to the pages (D35), the rest speeds up compiles (D36). lilypond
  // cannot read inside the app's asar archive, so the packaged app has it
  // unpacked beside it (electron-builder.yml).
  compiler: new CompileService({ runtimeDir: path.join(__dirname, 'runtime').replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked') }),
  buffers: () => live.buffers(),
  acceleration: 'auto',
  candidates: async () => (access.folder === undefined ? [] : (await listFolder(access.folder)).files.map((f) => f.path)),
  emit: (event) => {
    mainWindow?.webContents.send(Channel.compile, event)
    // A compile may have added or removed an include: watch the score as it is now.
    if (event.kind === 'finished' && event.outcome.state !== 'no-root') void watcher.watchScore(event.outcome.rootFile)
    if (event.kind === 'finished') waitingForLilyPond = event.outcome.state === 'no-lilypond'
  },
  lilypondPath: () => settings.lilypondPath ?? process.env.LILYPOND_PATH,
})
/** Unsaved edits compile after a pause in typing, while the status line's switch is on (D36). */
const live = new LiveCompile({ compiler })
/**
 * Another program changed a file: the renderer reloads the open ones, and the
 * score compiles again when the file is one of its own (D34).
 */
const watcher = new ScoreWatcher({
  onChange: (changes, score) => {
    // Only files the renderer may open; an include outside the folder just recompiles.
    const visible = changes.filter((change) => access.allows(change.file))
    if (visible.length > 0) mainWindow?.webContents.send(Channel.filesChanged, visible)
    if (score && watcher.score) void compiler.compile(watcher.score)
  },
})
/** The last compile found no LilyPond; the setup compiles again once it is ready (D37). */
let waitingForLilyPond = false
/** Whether the renderer reports unsaved changes; guards closing the window. */
let dirty = false
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
  window.on('close', (event) => {
    if (!dirty || smokeTest) return
    event.preventDefault()
    void confirmClose(window)
  })
  window.on('closed', () => {
    mainWindow = undefined
  })
  void window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  return window
}

/** Save, Don't Save or Cancel, as a Mac user expects when closing with edits. */
async function confirmClose(window: BrowserWindow): Promise<void> {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    message: 'Do you want to save the changes you made?',
    detail: "Your changes will be lost if you don't save them.",
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  })
  if (response === 2) return
  if (response === 0) {
    sendCommand('save-all')
    if (!(await becameClean(10_000))) return // A save failed; the renderer has said why.
  }
  dirty = false
  window.close()
}

/** Resolves true once the renderer reports no unsaved changes, false after `ms`. */
function becameClean(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const poll = setInterval(() => {
      if (!dirty || Date.now() - started > ms) {
        clearInterval(poll)
        resolve(!dirty)
      }
    }, 50)
  })
}

function sendCommand(command: Command): void {
  mainWindow?.webContents.send(Channel.command, command)
}

async function openFolder(folder: string, file?: string): Promise<Opened> {
  access.folder = path.resolve(folder)
  return { listing: await listFolder(access.folder), file }
}

/** Looks for LilyPond as a compile would, and puts its directory on PATH. */
async function lilypondStatus(configuredPath = settings.lilypondPath ?? process.env.LILYPOND_PATH): Promise<LilyPondStatus> {
  const status = await detectLilyPond({ configuredPath })
  if (status.path) process.env.PATH = searchPath(process.env.PATH, path.dirname(status.path))
  if (status.state === 'ready' && waitingForLilyPond && compiler.current) void compiler.compile(compiler.current)
  return status
}

const scoreFilters = [{ name: 'LilyPond', extensions: SCORE_EXTENSIONS.map((e) => e.slice(1)) }]

function registerIpc(): void {
  /** Only the studio's own window may call; a dialog is attached to it. */
  const owner = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window !== mainWindow) throw new Error('Unknown sender.')
    return window
  }

  ipcMain.handle(Channel.openFolder, async (event) => {
    const result = await dialog.showOpenDialog(owner(event), {
      title: 'Open Folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: access.folder,
    })
    return result.canceled || !result.filePaths[0] ? undefined : openFolder(result.filePaths[0])
  })

  ipcMain.handle(Channel.openFile, async (event) => {
    const result = await dialog.showOpenDialog(owner(event), {
      title: 'Open Score',
      properties: ['openFile'],
      filters: scoreFilters,
      defaultPath: access.folder,
    })
    const file = result.filePaths[0]
    if (result.canceled || !file) return undefined
    access.allowFile(file)
    return openFolder(path.dirname(file), path.resolve(file))
  })

  ipcMain.handle(Channel.listFolder, async (event) => {
    owner(event)
    return access.folder === undefined ? undefined : listFolder(access.folder)
  })

  ipcMain.handle(Channel.readFile, async (event, file: unknown) => {
    owner(event)
    const allowed = access.check(file)
    const text = await readScore(allowed)
    // The editor keeps the file open when another folder is opened; it must
    // still be able to save it then.
    access.allowFile(allowed)
    // Watched from now on, from what the editor shows.
    await watcher.open(allowed, text)
    return text
  })

  ipcMain.handle(Channel.saveFile, async (event, file: unknown, text: unknown) => {
    owner(event)
    if (typeof text !== 'string') throw new Error('Expected the text to save.')
    const allowed = access.check(file)
    await watcher.writing(allowed, text)
    await writeScore(allowed, text)
    // The save is done; the compile reports on Channel.compile when it ends.
    void compiler.saved(allowed)
  })

  ipcMain.handle(Channel.newScore, async (event, template: unknown) => {
    const window = owner(event)
    if (!TEMPLATES.some((t) => t.id === template)) throw new Error(`Unknown template: ${String(template)}`)
    const result = await dialog.showSaveDialog(window, {
      title: 'New Score',
      buttonLabel: 'Create',
      defaultPath: await unusedName(access.folder ?? app.getPath('documents')),
      filters: scoreFilters,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (result.canceled || !result.filePath) return undefined
    const file = isScoreFile(result.filePath) ? result.filePath : `${result.filePath}.ly`
    await createFromTemplate(file, template as TemplateId)
    access.allowFile(file)
    // A score saved outside the open folder brings its own folder along.
    const folder = access.folder !== undefined && isInside(access.folder, file) ? access.folder : path.dirname(file)
    return openFolder(folder, path.resolve(file))
  })

  ipcMain.handle(Channel.revealSource, async (event, href: unknown) => {
    owner(event)
    const location = typeof href === 'string' ? parseTextEdit(href) : undefined
    if (!location) return undefined
    // A note from a file the studio may not open (lilypond's own ly/ files) goes nowhere.
    return { ...location, file: access.check(location.file) }
  })

  ipcMain.handle(Channel.compilePdf, async (event, rootFile: unknown) => {
    owner(event)
    return compiler.pdf(access.check(rootFile))
  })

  ipcMain.handle(Channel.exportPdf, async (event, rootFile: unknown) => {
    owner(event)
    return compiler.exportPdf(access.check(rootFile))
  })

  ipcMain.handle(Channel.confirmReload, async (event, file: unknown) => {
    const window = owner(event)
    const allowed = access.check(file)
    // The smoke test does not answer dialogs; it keeps the edits.
    if (smokeTest) return false
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      message: `${path.basename(allowed)} was changed by another program.`,
      detail: 'Reload it and lose the changes you have not saved, or keep your changes? Saving them will replace the other version.',
      buttons: ['Reload', 'Keep My Changes'],
      defaultId: 1,
      cancelId: 1,
    })
    return response === 0
  })

  ipcMain.handle(Channel.lilypondStatus, async (event) => {
    owner(event)
    return lilypondStatus()
  })

  ipcMain.handle(Channel.chooseLilyPond, async (event) => {
    const result = await dialog.showOpenDialog(owner(event), {
      title: 'Choose LilyPond',
      message: 'Choose the LilyPond folder you downloaded, or the lilypond program in its bin folder.',
      buttonLabel: 'Choose',
      properties: ['openFile', 'openDirectory'],
      defaultPath: '/Applications',
    })
    const chosen = result.filePaths[0]
    if (result.canceled || !chosen) return undefined
    const configuredPath = choicePath(chosen)
    const status = await lilypondStatus(configuredPath)
    if (status.state === 'missing') {
      return { ...status, message: `There is no LilyPond in ${chosen}. Choose the folder you downloaded from lilypond.org, or the lilypond program inside its bin folder.` }
    }
    // Kept even when too old or broken, so the message stays about this one.
    settings = { ...settings, lilypondPath: configuredPath }
    await writeSettings(settingsFile(), settings)
    return status
  })

  ipcMain.handle(Channel.openLink, async (event, link: unknown) => {
    owner(event)
    // Only the setup's own pages; the renderer cannot name any other address.
    if (typeof link !== 'string' || !Object.hasOwn(SETUP_LINKS, link)) throw new Error(`Unknown link: ${String(link)}`)
    await shell.openExternal(SETUP_LINKS[link as keyof typeof SETUP_LINKS])
  })

  ipcMain.handle(Channel.openSample, async (event) => {
    owner(event)
    const folder = path.join(app.getPath('documents'), 'Lily Studio')
    const file = path.join(folder, SAMPLE.name)
    await fs.mkdir(folder, { recursive: true })
    // An edited sample is the user's now: it is opened, never written over.
    await fs.writeFile(file, SAMPLE.text, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    access.allowFile(file)
    return openFolder(folder, file)
  })

  ipcMain.on(Channel.edited, (event, file: unknown, text: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return
    if (typeof text !== 'string' && text !== null) return
    let allowed: string
    try {
      allowed = access.check(file)
    } catch {
      return
    }
    live.edited(allowed, text ?? undefined)
  })

  ipcMain.on(Channel.setLive, (event, on: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return
    live.setEnabled(on === true)
  })

  ipcMain.on(Channel.setDirty, (event, value: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return
    dirty = value === true
    mainWindow?.setDocumentEdited(dirty)
  })
}

/**
 * The application menu: only what the studio does. The Edit menu keeps its
 * roles so copy, paste and undo reach the editor.
 */
function buildMenu(): Menu {
  const item = (label: string, accelerator: string, command: Command): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => sendCommand(command),
  })
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        item('New Score…', 'CmdOrCtrl+N', 'new-score'),
        item('Open Score…', 'CmdOrCtrl+O', 'open-file'),
        item('Open Folder…', 'CmdOrCtrl+Shift+O', 'open-folder'),
        { type: 'separator' },
        item('Save', 'CmdOrCtrl+S', 'save'),
        item('Save All', 'CmdOrCtrl+Alt+S', 'save-all'),
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Welcome', click: () => sendCommand('welcome') },
        { label: 'Set Up LilyPond…', click: () => sendCommand('setup-lilypond') },
        { type: 'separator' },
        { label: 'LilyPond Learning Manual', click: () => void shell.openExternal(SETUP_LINKS.learn) },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
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

  void app.whenReady().then(async () => {
    settings = await readSettings(settingsFile())
    registerIpc()
    Menu.setApplicationMenu(buildMenu())
    const smoke = smokeTest ? await prepareSmokeTest() : undefined
    if (smoke) access.folder = smoke.folder
    mainWindow = createWindow()
    if (smoke) {
      const window = mainWindow
      // Renderer warnings and errors explain a failed run.
      window.webContents.on('console-message', ({ level, message }) => {
        if (level === 'warning' || level === 'error') console.error(`renderer ${level}: ${message}`)
      })
      const timeout = setTimeout(() => {
        console.error('smoke test: did not finish within 30 s')
        app.exit(1)
      }, 30_000)
      window.webContents.once('did-finish-load', () => {
        runSmokeTest(window, smoke).then(
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

  // Stop lilypond and delete the pages in the temp directory before exiting.
  let disposed = false
  app.on('will-quit', (event) => {
    if (disposed) return
    event.preventDefault()
    disposed = true
    watcher.dispose()
    live.dispose()
    void compiler.dispose().finally(() => app.quit())
  })
}
