// The renderer's entry point, bundled into dist/renderer/app.js: connects the
// file list, the editor and the status line to `window.studio` (preload.ts).
import type { CompileEvent, Opened } from '../ipc'
import type { StudioApi } from '../preload'
import type { TemplateId } from '../templates'
import { compileStatus, DiagnosticStore } from './diagnostics'
import { ScoreEditor } from './editor'
import { button, FileList } from './files'
import { PdfView } from './pdfView'
import { ScorePreview } from './preview'

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
// The status line: messages on the left, the last compile on the right (D31).
const statusMessage = document.createElement('span')
statusMessage.className = 'status-message'
const compileButton = document.createElement('button')
compileButton.className = 'status-compile'
compileButton.type = 'button'
compileButton.hidden = true
statusLine.replaceChildren(statusMessage, compileButton)

function status(message: string): void {
  statusMessage.textContent = message
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

const diagnostics = new DiagnosticStore()
const editor = new ScoreEditor({
  container: monacoHost,
  save: (file, text) => studio.saveFile(file, text),
  onChange: refreshMarkers,
  diagnostics: (file) => diagnostics.for(file),
})

// The preview pane: the SVG pages (D32) or the PDF (D33), switched in its header.
const previewPane = pane('preview')
const view = (name: 'svg' | 'pdf') => previewPane.querySelector<HTMLElement>(`[data-view="${name}"]`)!
const viewActions = (name: 'svg' | 'pdf') => {
  const actions = document.createElement('span')
  actions.className = 'pane-actions'
  actions.dataset.view = name
  previewPane.querySelector('.pane-header > .pane-actions')!.append(actions)
  return actions
}
const preview = new ScorePreview({
  body: view('svg').querySelector<HTMLElement>('.pane-body')!,
  actions: viewActions('svg'),
  onReveal: (href) => void revealSource(href),
})
const pdfView = new PdfView({
  body: view('pdf').querySelector<HTMLElement>('.pane-body')!,
  actions: viewActions('pdf'),
  compilePdf: (rootFile) => studio.compilePdf(rootFile),
  exportPdf: (rootFile) => studio.exportPdf(rootFile),
  onExported: (written) => status(`Exported ${written.map((file) => file.split(/[\\/]/).pop()).join(', ')} next to the score`),
  onError: report,
})
const tabs = (['svg', 'pdf'] as const).map((name) => {
  const tab = button(name.toUpperCase(), () => showView(name))
  tab.setAttribute('role', 'tab')
  tab.dataset.view = name
  tab.title = name === 'svg' ? 'The score as you edit it: click a note to find it in the source' : 'The score as a PDF, ready to print or export'
  return tab
})
previewPane.querySelector('.preview-tabs')!.append(...tabs)

function showView(name: 'svg' | 'pdf'): void {
  previewPane.dataset.mode = name
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.view === name))
  for (const element of previewPane.querySelectorAll<HTMLElement>('[data-view]:not([role="tab"])')) {
    element.hidden = element.dataset.view !== name
  }
  pdfView.show(name === 'pdf')
}
showView('svg')

const files = new FileList({
  body: filesPane.querySelector<HTMLElement>('.pane-body')!,
  title: filesPane.querySelector<HTMLElement>('.pane-title')!,
  onOpen: (file) => void open(file.path),
  onOpenFolder: () => void run(studio.openFolder()),
  onNewScore: () => showTemplates(),
})

/** A path as the file list shows it, else its name. */
function displayName(file: string): string {
  return files.folder?.files.find((f) => f.path === file)?.relative ?? file.split(/[\\/]/).pop() ?? file
}

/** The score whose compile the status line shows; a click goes to its first problem. */
let shownRoot: string | undefined

function compiled(event: CompileEvent): void {
  if (event.kind === 'finished') {
    for (const file of diagnostics.update(event.outcome)) editor.mark(file)
  }
  const { text, tone, detail } = compileStatus(event, displayName)
  shownRoot = event.kind === 'started' ? event.rootFile : event.outcome.rootFile
  compileButton.hidden = false
  compileButton.textContent = text
  compileButton.dataset.tone = tone
  compileButton.title = detail ?? (tone === 'error' || tone === 'warning' ? 'Show the first problem' : '')
}

async function showFirstProblem(): Promise<void> {
  const problem = shownRoot && diagnostics.first(shownRoot)
  if (!problem) return
  await open(problem.file)
  if (editor.file === problem.file) editor.reveal(problem.line, problem.column)
}

compileButton.addEventListener('click', () => void showFirstProblem())

/** A click on a note in the preview: its place in the source, opened in the editor (D32). */
async function revealSource(href: string): Promise<void> {
  try {
    const location = await studio.revealSource(href)
    if (!location) return
    await open(location.file)
    if (editor.file === location.file) editor.revealSource(location.line, location.char)
  } catch (error) {
    report(error)
  }
}

/** Unsaved-change marks: the file list, the editor header, the window. */
function refreshMarkers(): void {
  const dirty = editor.dirtyFiles()
  files.setDirty(dirty)
  const file = editor.file
  const name = file && displayName(file)
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

studio.onCompile((event) => {
  compiled(event)
  preview.compiled(event)
  pdfView.compiled(event)
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
