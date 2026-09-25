// The renderer's entry point, bundled into dist/renderer/app.js: connects the
// file list, the editor and the status line to `window.studio` (preload.ts).
import type { Opened } from '../ipc'
import type { StudioApi } from '../preload'
import type { TemplateId } from '../templates'
import { ScoreEditor } from './editor'
import { button, FileList } from './files'

declare global {
  interface Window {
    studio: StudioApi
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker }
  }
}

// Monaco's one worker (diffs, word completion), which esbuild.mjs bundles next
// to this script. currentScript is only set while the script first runs.
const workerUrl = new URL('editor.worker.js', (document.currentScript as HTMLScriptElement).src).href
window.MonacoEnvironment = { getWorker: () => new Worker(workerUrl) }

const studio = window.studio
const pane = (name: string) => document.querySelector<HTMLElement>(`[data-pane="${name}"]`)!
const editorPane = pane('editor')
const filesPane = pane('files')
const statusLine = pane('status')

function status(message: string): void {
  statusLine.textContent = message
}

function report(error: unknown): void {
  // Electron prefixes errors thrown in the main process with the channel name.
  const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)
  status(message)
  console.error(error)
}

const editorBody = editorPane.querySelector<HTMLElement>('.pane-body')!
const editorTitle = editorPane.querySelector<HTMLElement>('.pane-title')!
editorBody.classList.remove('placeholder')
editorBody.replaceChildren()
const emptyEditor = document.createElement('div')
emptyEditor.className = 'editor-empty placeholder'
emptyEditor.textContent = 'Choose a score on the left, or create a new one.'
const monacoHost = document.createElement('div')
monacoHost.className = 'monaco-host'
monacoHost.hidden = true
editorBody.append(emptyEditor, monacoHost)

const editor = new ScoreEditor({
  container: monacoHost,
  save: (file, text) => studio.saveFile(file, text),
  onChange: refreshMarkers,
})

const files = new FileList({
  body: filesPane.querySelector<HTMLElement>('.pane-body')!,
  title: filesPane.querySelector<HTMLElement>('.pane-title')!,
  onOpen: (file) => void open(file.path),
  onOpenFolder: () => void run(studio.openFolder()),
  onNewScore: () => showTemplates(),
})

/** Unsaved-change marks: the file list, the editor header, the window. */
function refreshMarkers(): void {
  const dirty = editor.dirtyFiles()
  files.setDirty(dirty)
  const file = editor.file
  const relative = file && files.folder?.files.find((f) => f.path === file)?.relative
  const name = relative ?? file?.split(/[\\/]/).pop()
  const unsaved = !!file && editor.isDirty(file)
  editorTitle.textContent = name ?? 'Editor'
  editorPane.dataset.file = file ?? ''
  editorPane.dataset.dirty = String(unsaved)
  document.title = name ? `${name} — Lily Studio` : 'Lily Studio'
  studio.setDirty(dirty.length > 0)
}

async function open(file: string): Promise<void> {
  try {
    const text = editor.isOpen(file) ? undefined : await studio.readFile(file)
    emptyEditor.hidden = true
    monacoHost.hidden = false
    editor.show(file, text)
    files.setActive(file)
  } catch (error) {
    report(error)
  }
}

/** Applies the result of a dialog: shows the folder, opens the chosen file. */
async function run(opening: Promise<Opened | undefined>): Promise<void> {
  try {
    const opened = await opening
    if (!opened) return
    files.show(opened.listing)
    refreshMarkers()
    if (opened.file) await open(opened.file)
  } catch (error) {
    report(error)
  }
}

async function save(all: boolean): Promise<void> {
  if (!editor.file) return
  try {
    if (all) await editor.saveAll()
    else await editor.save()
    status(all ? 'All changes saved' : 'Saved')
  } catch (error) {
    report(error)
  }
}

// New Score: the header button and File › New Score… open a small template menu.
const newButton = button('New', () => showTemplates())
newButton.title = 'New Score from a template'
const openButton = button('Open', () => void run(studio.openFolder()))
openButton.title = 'Open Folder'
const templateMenu = document.createElement('div')
templateMenu.className = 'template-menu'
templateMenu.hidden = true
templateMenu.setAttribute('role', 'menu')
for (const template of studio.templates) {
  const item = button(template.label, () => {
    templateMenu.hidden = true
    void run(studio.newScore(template.id as TemplateId))
  })
  item.setAttribute('role', 'menuitem')
  templateMenu.append(item)
}
filesPane.querySelector('.pane-actions')!.append(newButton, openButton)
filesPane.append(templateMenu)

function showTemplates(): void {
  templateMenu.hidden = false
  templateMenu.querySelector('button')?.focus()
}
templateMenu.addEventListener('focusout', (event) => {
  if (!templateMenu.contains(event.relatedTarget as Node | null)) templateMenu.hidden = true
})
templateMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') templateMenu.hidden = true
})

studio.onCommand((command) => {
  switch (command) {
    case 'new-score':
      return showTemplates()
    case 'open-file':
      return void run(studio.openFile())
    case 'open-folder':
      return void run(studio.openFolder())
    case 'save':
      return void save(false)
    case 'save-all':
      return void save(true)
  }
})

// A folder the main process already has (the smoke test's) is shown at once.
void studio.listFolder().then((listing) => {
  if (listing) files.show(listing)
}, report)
