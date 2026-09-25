// Lily Studio's main process: one window with the fixed layout of
// renderer/index.html (DECISIONS D28), and the file access behind it (D29).
// Later steps add the compile and playback services here and reach the
// renderer only through preload.ts.
import { app, BrowserWindow, dialog, ipcMain, Menu, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import * as path from 'node:path'
import { Access, createFromTemplate, isInside, isScoreFile, listFolder, readScore, unusedName, writeScore, SCORE_EXTENSIONS } from './files'
import { Channel, type Command, type Opened } from './ipc'
import { prepareSmokeTest, runSmokeTest } from './smokeTest'
import { TEMPLATES, type TemplateId } from './templates'

/** Run by `npm test`: load the window hidden, drive it once, exit. */
const smokeTest = process.argv.includes('--smoke-test')

const access = new Access()
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

  ipcMain.handle(Channel.readFile, (event, file: unknown) => {
    owner(event)
    return readScore(access.check(file))
  })

  ipcMain.handle(Channel.saveFile, (event, file: unknown, text: unknown) => {
    owner(event)
    if (typeof text !== 'string') throw new Error('Expected the text to save.')
    return writeScore(access.check(file), text)
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
}
