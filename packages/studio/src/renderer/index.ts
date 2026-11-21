// The renderer's entry point, bundled into dist/web/app.js: connects the
// file list, the editor and the status line to `studio` (bridge.ts),
// with the welcome screen and LilyPond's setup (D37), and the resizable
// sidebar with the agents' accordion (D40), and Scores | Stems at its top
// with the Separate view (D112), whose stems lead to scores that play their
// stem under the preview. On the web (D55) the same page, without the agents
// or Stems, and with upload and download. The editor pane shows the source or
// the piano view of what plays (D116).
import type { CompileEvent, FileChange, Opened, ScoreMeter, SungFound, SungVoice, TempoFound } from '../ipc'
import { AgentPanel, SELECTION_ACTIONS } from './agents'
import { studio, type StudioApi } from './bridge'
import { compileStatus, DiagnosticStore, problemSummary } from './diagnostics'
import { ScoreEditor } from './editor'
import { audioOffsetOfScore, audioOfScore, backingOfScore, bpmOfScore, button, FileList, musicOfScore, startOfScore, stemOfScore, sungOfScore, withScoreLines } from './files'
import { garageBandAudio } from './garageBandPlan'
import { droppedGuitarPro } from './guitarPro'
import { addMidiBlock } from './midiBlock'
import { PdfView } from './pdfView'
import { PianoView, type VideoSound } from './piano'
import { ScorePlayer, StemStrip, type StripAudio } from './player'
import { ScorePreview } from './preview'
import { sungProgress } from './sungMismatch'
import { tempoProgress } from './tempo'
import { SeparateView } from './separate'
import { Sidebar, WorkspaceSwitch } from './sidebar'
import { ownsArrows, stepVolume, transportKey } from './keys'
import { VideoExporter, type VideoRecording } from './video'
import { Welcome } from './welcome'

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

// For the smoke test, which looks for it.
window.studio = studio
const pane = (name: string) => document.querySelector<HTMLElement>(`[data-pane="${name}"]`)!
const editorPane = pane('editor')
const filesPane = pane('files')
const statusLine = pane('status')
// The status line: messages on the left, the live preview switch (D36) and the
// last compile (D31) on the right.
const statusMessage = document.createElement('span')
statusMessage.className = 'status-message'
const compileButton = document.createElement('button')
compileButton.className = 'status-compile'
compileButton.type = 'button'
compileButton.hidden = true
const liveButton = document.createElement('button')
liveButton.className = 'status-live'
liveButton.type = 'button'
liveButton.title = 'Update the preview as you type, without saving'
liveButton.addEventListener('click', () => setLive(liveButton.getAttribute('aria-pressed') !== 'true'))
statusLine.replaceChildren(statusMessage, liveButton, compileButton)

const LIVE_KEY = 'lily-studio.live'

/** Live preview on or off (D36); remembered in this window's storage, on by default. */
function setLive(on: boolean): void {
  liveButton.setAttribute('aria-pressed', String(on))
  liveButton.textContent = on ? 'Live preview: On' : 'Live preview: Off'
  studio.setLive(on)
  try {
    localStorage.setItem(LIVE_KEY, String(on))
  } catch {
    // Storage may be unavailable; the switch still works for this run.
  }
}

function storedLive(): boolean {
  try {
    return localStorage.getItem(LIVE_KEY) !== 'false'
  } catch {
    return true
  }
}
setLive(storedLive())

function status(message: string): void {
  statusMessage.textContent = message
}

function report(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  status(message)
  console.error(error)
}

const editorBody = editorPane.querySelector<HTMLElement>('.pane-body[data-view="source"]')!
const editorTitle = editorPane.querySelector<HTMLElement>('.pane-title')!
editorBody.classList.remove('placeholder')
editorBody.replaceChildren()
const monacoHost = document.createElement('div')
monacoHost.className = 'monaco-host'
monacoHost.hidden = true
editorBody.append(monacoHost)

// Shown while no score is open (D37); Help › Welcome shows it again.
const welcome = new Welcome({
  host: editorBody,
  studio,
  onSample: () => void run(studio.openSample()),
  onNewScore: () => showTemplates(),
  onOpenFile: () => void run(studio.openFile()),
  onOpenFolder: () => void run(studio.openFolder()),
  onImportGuitarPro: () => void run(studio.importGuitarPro()),
  onOpenRecent: (path) => openRecent(path),
  onBack: () => showEditor(),
})

function showEditor(): void {
  if (!editor.file) return
  welcome.hide()
  monacoHost.hidden = false
}

const diagnostics = new DiagnosticStore()
const editor = new ScoreEditor({
  container: monacoHost,
  save: (file, text) => studio.saveFile(file, text),
  onChange: refreshMarkers,
  onText: (file, unsaved) => {
    studio.edited(file, unsaved ?? null)
    // The score's audio track and tempo follow its lines as they are typed (D155).
    if (file === previewRoot) void showScoreAudio(file)
  },
  diagnostics: (file) => diagnostics.for(file),
  onSelection: () => agents?.refreshContext(),
  read: (file) => studio.readFile(file),
  open: (file) => open(file),
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
const previewBody = view('svg').querySelector<HTMLElement>('.pane-body')!
const preview = new ScorePreview({
  body: previewBody,
  actions: viewActions('svg'),
  onReveal: (href) => void revealSource(href),
  onRender: () => player.rendered(),
  onLayout: () => player.refresh(),
})
// What plays, falling onto a keyboard where the source is (D116), or below
// the score (D117). It reads the player only while shown, which it never is
// before the player exists.
const pianoBody = editorPane.querySelector<HTMLElement>('.pane-body[data-view="piano"]')!
const pianoActions = editorPane.querySelector<HTMLElement>('.pane-actions[data-view="piano"]')!
const pianoDock = previewPane.querySelector<HTMLElement>('.piano-dock')!
// Set once the Stem strip is: Karaoke over a backing track keeps the score's
// MIDI silent unless Melody is ticked, and the strip follows the score (D135).
let karaokeSilence: (() => void) | undefined
let followScore: (() => void) | undefined
// Export Video (D140), in the app: ffmpeg is the Mac's.
let videoExporter: VideoExporter | undefined
const piano = new PianoView({
  host: pianoBody,
  actions: pianoActions,
  source: {
    get midi() {
      return player.midi
    },
    get score() {
      return player.score
    },
    get timing() {
      return player.timing
    },
    get position() {
      return player.position
    },
    get playing() {
      return player.playing
    },
    get rootFile() {
      return player.rootFile
    },
    get parts() {
      return player.parts
    },
    get muted() {
      return player.muted
    },
    get voiceTimes() {
      return player.voiceTimes
    },
  },
  onPlace: () => showPiano(piano.visible),
  onStyle: () => karaokeSilence?.(),
  onToggle: () => player.toggle(),
  onExportVideo: studio.hosted
    ? undefined
    : (chosen) => {
        if (chosen) rememberVideoSounds(chosen)
        videoExporter?.toggle(chosen)
      },
  videoSounds: () => videoSounds(),
})
// The score's MIDI, with the notes marked on the pages as they play (D35).
const player = new ScorePlayer({
  transport: previewPane.querySelector<HTMLElement>('.transport')!,
  preview,
  body: previewBody,
  onError: status,
  onAddMidi: () => void addMidi(),
  panel: previewPane.querySelector<HTMLElement>('.playback-setup')!,
  loadSetup: (rootFile) => studio.playbackSetup(rootFile),
  saveSetup: (rootFile, setup) => studio.setPlaybackSetup(rootFile, setup),
  exportMidi: (rootFile, midi, muted) => studio.exportMidi(rootFile, midi, muted),
  // The web has no audio (D162): it downloads the .mid alone.
  exportGarageBand: (rootFile, midi, plan, muted, audioMuted) =>
    studio.exportGarageBand(rootFile, midi, plan, muted, studio.hosted ? undefined : garageBandAudio(editor.textOf(rootFile) ?? '', audioMuted)),
  music: (rootFile) => studio.music(rootFile),
  onExported: status,
  onPiano: () => showPiano(!piano.visible),
  onPlayback: () => {
    piano.update()
    followScore?.()
  },
  karaokeStart: () => (piano.visible && piano.karaoke ? scoreStart() : undefined),
  setScoreLines: (lines, said) => void setScoreLines(lines, said),
  // Files are chosen in the app; the web has no way to play one beside the score.
  chooseAudio: studio.hosted ? undefined : () => void chooseAudio(),
  // lily-transcribe runs on the Mac (D159), as the web's stubs say.
  detectTempo: studio.hosted ? undefined : (meter) => detectTempo(meter),
  onStatus: status,
  onPlaying: (on) => studio.playing(on),
  // From the singer (D276), on the Mac alone as From the recording is.
  detectSung: studio.hosted ? undefined : (voice, notes) => detectSung(voice, notes),
  scoreText: (rootFile) => editor.textOf(rootFile),
})
/** The shown score's `% Start:`, as its text has it now (D149). */
function scoreStart(): number | undefined {
  const rootFile = player.rootFile
  return rootFile === undefined ? undefined : startOfScore(editor.textOf(rootFile) ?? '')
}
const editorTabs = (['source', 'piano'] as const).map((name) => {
  // The piano view, Visual since it has Karaoke too (D136).
  const tab = button(name === 'source' ? 'Source' : 'Visual', () => (name === 'piano' ? showPianoOverSource() : showSource()))
  tab.setAttribute('role', 'tab')
  tab.dataset.view = name
  tab.title = name === 'source' ? 'The score’s source, to edit' : 'The music as it plays: falling onto a keyboard, or as karaoke'
  return tab
})
editorPane.querySelector('.editor-tabs')!.append(...editorTabs)

/**
 * Shows or hides the piano view where it is placed (D116, D117): over the
 * editor, which keeps its state behind it, or below the score, with the
 * source still there.
 */
function showPiano(shown: boolean): void {
  const below = piano.place === 'score'
  if (below && pianoDock.lastElementChild !== pianoBody) pianoDock.append(pianoActions, pianoBody)
  if (!below && pianoBody.parentElement !== editorPane) {
    editorPane.querySelector('.editor-tabs')!.before(pianoActions)
    editorPane.append(pianoBody)
  }
  const mode = shown && !below ? 'piano' : 'source'
  editorPane.dataset.mode = mode
  for (const tab of editorTabs) tab.setAttribute('aria-selected', String(tab.dataset.view === mode))
  for (const element of editorPane.querySelectorAll<HTMLElement>('[data-view]:not([role="tab"])')) {
    element.hidden = element.dataset.view !== mode
  }
  pianoDock.hidden = !(shown && below)
  if (below) pianoActions.hidden = pianoBody.hidden = false
  piano.show(shown)
  player.pianoShown(shown)
}
/** The editor's Piano tab: the view over the source, wherever it was. */
function showPianoOverSource(): void {
  piano.place = 'source'
  showPiano(true)
}
/** The source in the editor pane: a piano view over it goes, one below the score stays. */
function showSource(): void {
  if (piano.place === 'source') showPiano(false)
}
showPiano(false)
// Space plays or pauses when the preview has the focus; a click on the pages gives it.
previewBody.tabIndex = -1
const spacePlays = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement
  // Below the score the piano view is in the preview pane too: one toggle, not two.
  if (event.key !== ' ' || event.repeat || event.defaultPrevented || target.closest('button, input, select')) return
  event.preventDefault()
  player.toggle()
}
previewPane.addEventListener('keydown', spacePlays)
// And in the piano view, which a click focuses.
pianoBody.tabIndex = -1
pianoBody.addEventListener('keydown', spacePlays)
const pdfView = new PdfView({
  body: view('pdf').querySelector<HTMLElement>('.pane-body')!,
  actions: viewActions('pdf'),
  compilePdf: (rootFile) => studio.compilePdf(rootFile),
  exportPdf: (rootFile) => studio.exportPdf(rootFile),
  // A name alone is a download only: the web page's engine wrote it (D271).
  onExported: (written) =>
    status(`Exported ${written.map((file) => file.split(/[\\/]/).pop()).join(', ')} ${written.every((file) => !/[\\/]/.test(file)) ? 'to your downloads' : 'next to the score'}`),
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

// What went wrong in the last compile, in plain words, above the score (D37).
const banner = document.createElement('button')
banner.type = 'button'
banner.className = 'problem-banner'
banner.hidden = true
const bannerHeading = document.createElement('strong')
const bannerText = document.createElement('span')
banner.append(bannerHeading, bannerText)
previewPane.querySelector('.pane-header')!.after(banner)
let bannerAction: (() => void) | undefined
banner.addEventListener('click', () => bannerAction?.())

function showBanner(event: CompileEvent): void {
  if (event.kind === 'started') return
  const outcome = event.outcome
  if (outcome.state === 'no-root') return
  if (outcome.state === 'no-lilypond') {
    banner.hidden = false
    banner.dataset.tone = 'error'
    bannerHeading.textContent = 'LilyPond is needed to engrave the score'
    bannerText.textContent = studio.hosted
      ? 'This server cannot engrave yet. Click here to see why.'
      : 'Click here to set it up. It takes a few minutes, once.'
    bannerAction = () => welcome.openSetup()
    return
  }
  const summary = problemSummary(outcome, displayName)
  banner.hidden = !summary
  if (!summary) return
  banner.dataset.tone = summary.tone
  bannerHeading.textContent = summary.heading
  bannerText.textContent = summary.text
  banner.title = 'Show it in the editor'
  bannerAction = () => void showProblem(summary.diagnostic)
}

function showView(name: 'svg' | 'pdf'): void {
  previewPane.dataset.mode = name
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.view === name))
  for (const element of previewPane.querySelectorAll<HTMLElement>('[data-view]:not([role="tab"])')) {
    // The piano view below the score stays under either.
    if (!element.closest('.piano-dock')) element.hidden = element.dataset.view !== name
  }
  pdfView.show(name === 'pdf')
  player.refresh()
}
showView('svg')

const files = new FileList({
  body: filesPane.querySelector<HTMLElement>('.pane-body')!,
  title: filesPane.querySelector<HTMLElement>('.pane-title')!,
  onOpen: (file) => void open(file.path),
  onOpenFolder: () => void run(studio.openFolder()),
  onNewScore: () => showTemplates(),
})

// The agents' accordion under the files (D40), in the app only. A message
// saves unsaved edits first, so the agent reads what the editor shows; a
// finished turn lists the folder again, for the files it added. Changed files
// reload through D34.
const agentsPane = pane('agents')
const fold = (name: string) => agentsPane.querySelector<HTMLElement>(`[data-fold="${name}"] .fold-body`)!
const agents = studio.hosted ? undefined : new AgentPanel({
  studio,
  chats: fold('chats'),
  setup: fold('setup'),
  beforeSend: async () => {
    if (editor.dirtyFiles().length === 0) return
    await editor.saveAll()
    status('Saved your changes, so the agent works on them')
  },
  context: () => {
    const selection = editor.selection()
    return { ...(editor.file ? { file: editor.file } : {}), ...(selection ? { selection } : {}) }
  },
  displayName: (file) => displayName(file),
  onTurnEnd: () => void studio.listFolder().then((listing) => listing && files.show(listing), report),
  onError: report,
})
const studioGrid = document.querySelector<HTMLElement>('.studio')!
const sidebar = new Sidebar({ studio: studioGrid, sidebar: pane('sidebar'), agents: agentsPane })

// The preview the window's width, and back (D122): the button in its header,
// or View › Preview Full Width. The sidebar and the editor keep their state.
const fullKeys = /Mac/.test(navigator.platform) ? '⌥⌘↩' : 'Ctrl+Alt+Enter'
const fullButton = document.createElement('button')
fullButton.type = 'button'
fullButton.className = 'preview-full'
fullButton.textContent = '⤢'
fullButton.addEventListener('click', () => showPreviewFull(!previewFull()))
previewPane.querySelector('.pane-header > .pane-actions')!.append(fullButton)

function previewFull(): boolean {
  return studioGrid.hasAttribute('data-preview-full')
}

function showPreviewFull(full: boolean): void {
  studioGrid.toggleAttribute('data-preview-full', full)
  fullButton.setAttribute('aria-pressed', String(full))
  fullButton.setAttribute('aria-label', full ? 'Back from full width' : 'Preview full width')
  fullButton.title = full ? `The editor beside the preview again (${fullKeys})` : `The preview the full width of the window (${fullKeys})`
  // WebKit keeps the focus of a pane that is no longer drawn.
  const active = document.activeElement
  if (full && active instanceof HTMLElement && (editorPane.contains(active) || pane('sidebar').contains(active))) active.blur()
}
showPreviewFull(false)
// Scores | Stems (D112), where separation runs: Stems covers the files, the
// editor and the preview, which go on as they were behind it. The Separate
// view asks for its models when Stems is first shown, and a song dropped on
// the window goes to it.
const separation = studio.separationAvailable().available
const separateView = separation
  ? new SeparateView({ host: pane('stems'), studio, onStatus: status, onScore: (opening) => void run(opening) })
  : undefined
// The stem a score was written from plays above the transport (D112).
const stemStrip = separation
  ? new StemStrip({ host: previewPane.querySelector<HTMLElement>('.stem-strip')!, score: player, onError: status, onChange: () => karaokeSilence?.() })
  : undefined
karaokeSilence = () => player.silence(piano.visible && piano.karaoke && !!stemStrip?.backing && !piano.melodyOn)
followScore = () => stemStrip?.follow(player.scheduled, player.playing)
// ← → move the music 5 s, ↑ ↓ its volume, the score's and the recording's
// together, while it plays or Karaoke is shown (D154). The volume is kept
// in this window's storage.
const VOLUME_KEY = 'lily-studio.volume'
let volume = storedVolume()
function setVolume(value: number): void {
  volume = value
  player.volume = value
  if (stemStrip) stemStrip.volume = value
}
function storedVolume(): number {
  try {
    const value = Number(localStorage.getItem(VOLUME_KEY) ?? '1')
    return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 1
  } catch {
    return 1
  }
}
setVolume(volume)
window.addEventListener('keydown', (event) => {
  const key = transportKey(event)
  if (!key || event.defaultPrevented || ownsArrows(event.target)) return
  if (!player.playing && !(piano.visible && piano.karaoke)) return
  event.preventDefault()
  if ('seek' in key) return player.seekBy(key.seek)
  setVolume(stepVolume(volume, key.volume))
  try {
    localStorage.setItem(VOLUME_KEY, String(volume))
  } catch {
    // Storage may be unavailable; the volume still holds for this run.
  }
  const said = `Volume ${Math.round(volume * 100)} %`
  if (!piano.flash(said)) status(said)
})
/** What Export Video was last given for each score, by sound, this run (D155). */
const videoChoices = new Map<string, Map<string, boolean>>()
/**
 * The sounds Export Video can put in (D155): each part, the audio track and
 * the backing track, ticked as they are heard unless the last export of the
 * score was given otherwise.
 */
function videoSounds(): VideoSound[] {
  const muted = player.muted
  const audio = player.audioTrack
  const backing = stemStrip?.backingTrack
  const sounds: VideoSound[] = [
    ...player.parts.map((part) => ({ id: `track:${part.track}`, name: part.name, checked: !muted.has(part.track) && !player.silenced })),
    ...(audio ? [{ id: 'audio', name: `Audio · ${baseName(audio.path)}`, checked: !audio.muted }] : []),
    ...(backing ? [{ id: 'backing', name: `Backing · ${baseName(backing.path)}`, checked: true }] : []),
  ]
  const chosen = player.rootFile === undefined ? undefined : videoChoices.get(player.rootFile)
  return sounds.map((sound) => ({ ...sound, checked: chosen?.get(sound.id) ?? sound.checked }))
}
function rememberVideoSounds(chosen: ReadonlySet<string>): void {
  if (player.rootFile === undefined) return
  videoChoices.set(player.rootFile, new Map(videoSounds().map(({ id }) => [id, chosen.has(id)])))
}
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
videoExporter = new VideoExporter({
  studio,
  source: (chosen) => {
    const { rootFile, score, midi } = player
    if (!rootFile || !score || !midi) return 'The score has no MIDI: press Add MIDI to export its karaoke.'
    const sounds = chosen ?? new Set(videoSounds().filter((sound) => sound.checked).map((sound) => sound.id))
    const tracks = new Set(player.parts.map((part) => part.track).filter((track) => sounds.has(`track:${track}`)))
    const recordings: VideoRecording[] = []
    const audio = player.audioTrack
    if (audio && sounds.has('audio')) recordings.push({ path: audio.path, duration: audio.duration, offset: audio.offset, volume: audio.volume })
    const backing = stemStrip?.backingTrack
    if (backing && sounds.has('backing')) recordings.push({ ...backing, offset: 0, volume: 1, lengthens: true })
    const melody = tracks.size > 0 ? player.videoMelody(tracks) : undefined
    return { rootFile, scene: piano.karaokeScene(), start: scoreStart() ?? 0, duration: player.duration, recordings, melody }
  },
  onProgress: (part) => piano.exporting(part),
  onStatus: status,
})
const workspace = separateView
  ? new WorkspaceSwitch({
      studio: studioGrid,
      tabs: pane('sidebar').querySelector<HTMLElement>('.workspace-switch')!,
      panes: { scores: [filesPane, editorPane, previewPane], stems: [pane('separations'), pane('stems')] },
      onChange: (shown) => {
        if (shown === 'stems') separateView.activate()
      },
    })
  : undefined
studio.onFileDrop((drop) => {
  // A Guitar Pro file dropped is imported (D166): only where to save it is asked.
  const tab = drop.kind === 'drop' ? droppedGuitarPro(drop.paths) : undefined
  if (tab) return void run(studio.importGuitarPro(tab))
  if (separateView?.fileDrop(drop)) workspace?.show('stems')
})

/** Back to Scores, for what opens a score or shows the files or the welcome screen. */
function showScores(): void {
  workspace?.show('scores')
}
if (agents) {
  void agents.refreshSetup()
  // The selection's context menu: ask, explain or fix it with the agent (D41).
  SELECTION_ACTIONS.forEach((action, order) =>
    editor.addSelectionAction({
      id: action.id,
      label: action.label,
      order,
      ...(action.prompt ? {} : { key: 'I' as const }),
      run: () => {
        sidebar.show('chats')
        agents.ask(action.prompt)
      },
    }),
  )
}

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
  compileButton.dataset.state = event.kind === 'started' ? 'busy' : event.outcome.state
  compileButton.textContent = text
  compileButton.dataset.tone = tone
  compileButton.title = detail ?? (tone === 'error' || tone === 'warning' ? 'Show the first problem' : '')
}

async function showProblem(problem: { file: string; line: number; column?: number }): Promise<void> {
  await open(problem.file)
  if (editor.file === problem.file) editor.reveal(problem.line, problem.column)
}

compileButton.addEventListener('click', () => {
  if (compileButton.dataset.state === 'no-lilypond') return welcome.openSetup()
  const problem = shownRoot && diagnostics.first(shownRoot)
  if (problem) void showProblem(problem)
})

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

/**
 * The score of the file in the editor: the preview, the player, the PDF tab
 * and the banner show only its compiles, so a late compile of another score
 * never takes the preview over (D39). Undefined when no score includes the file.
 */
let previewRoot: string | undefined
/** Counts the files shown, so a slow answer about an earlier one is dropped. */
let shownFiles = 0

const forPreview = (event: CompileEvent) => (event.kind === 'started' ? event.rootFile : event.outcome.rootFile) === previewRoot

/** The preview follows the editor: the score of `file`, shown or engraved now. */
async function previewFor(file: string): Promise<void> {
  const shown = ++shownFiles
  const rootFile = await studio.showScore(file)
  if (shown !== shownFiles || rootFile === previewRoot) return
  if (previewRoot !== undefined) player.stop()
  previewRoot = rootFile
  banner.hidden = true
  preview.showScore(rootFile)
  pdfView.showScore(rootFile)
  void showStem(rootFile)
  if (rootFile) void showScoreAudio(rootFile)
  else {
    player.audio = undefined
    player.bpm = undefined
  }
}

/** The audio track attached last (D155): its score, the name its line gave and the file it was found at. */
interface AttachedAudio {
  rootFile: string
  name: string
  path: string | undefined
}
let attachedAudio: AttachedAudio | undefined

/**
 * The shown score's audio track and tempo, as its `% Audio:`, `% Audio offset:`
 * and `% BPM:` lines have them now (D155). A file named again is not looked
 * for again; one that is not beside the score plays nothing.
 */
async function showScoreAudio(rootFile: string): Promise<void> {
  const text = editor.textOf(rootFile) ?? ''
  player.bpm = bpmOfScore(text)
  // The web plays no audio track, so no voice follows its singer (D276).
  player.sung = studio.hosted ? new Map() : sungOfScore(text)
  const name = studio.hosted ? undefined : audioOfScore(text)
  if (!name) {
    attachedAudio = undefined
    player.audio = undefined
    return
  }
  if (attachedAudio?.rootFile !== rootFile || attachedAudio.name !== name) {
    const attaching: AttachedAudio = { rootFile, name, path: undefined }
    attachedAudio = attaching
    try {
      attaching.path = await studio.attachStem(rootFile, name)
    } catch (error) {
      // Not there, or moved since: the score plays without it.
      console.warn('audio track:', error)
    }
    if (attachedAudio !== attaching) return
  }
  const { path } = attachedAudio
  // The text may have changed while the file was looked for.
  const offset = audioOffsetOfScore(editor.textOf(rootFile) ?? text)
  player.audio = path && previewRoot === rootFile ? { path, url: studio.stemUrl(path), offset } : undefined
}

/**
 * Writes the shown score's own lines from the Parts fold (D155), as one
 * undoable edit in the editor that leaves the cursor where it is: never to
 * the file. The status line says what was written, or `said` and that.
 */
async function setScoreLines(lines: Record<string, string | undefined>, said?: string): Promise<void> {
  const rootFile = previewRoot
  if (!rootFile) return
  if (!editor.isOpen(rootFile)) await open(rootFile)
  const text = editor.textOf(rootFile)
  if (text === undefined) return
  const edits = withScoreLines(text, lines)
  if (edits.length === 0) return
  editor.applyEdits(rootFile, edits)
  await showScoreAudio(rootFile)
  const written = Object.entries(lines).map(([label, value]) => (value === undefined ? `took out % ${label}:` : `wrote % ${label}: ${value}`))
  status(`${displayName(rootFile)}: ${said ? `${said}. ` : ''}${written.join(', ')}. Save to keep it.`)
}

/**
 * From the recording (D159): lily-transcribe listens to the shown score's
 * audio track, attached as it is played, and the status line names its stage.
 */
async function detectTempo(meter: ScoreMeter): Promise<TempoFound> {
  const rootFile = previewRoot
  const audio = attachedAudio
  if (!rootFile || audio?.rootFile !== rootFile || !audio.path) throw new Error('The score has no audio track to listen to.')
  const stop = studio.onTranscription((event) => {
    if (event.event === 'progress') status(tempoProgress(audio.name, event.stage))
  })
  status(`Listening to ${audio.name}…`)
  try {
    return await studio.detectTempo(rootFile, audio.name, meter)
  } finally {
    stop()
  }
}

/**
 * From the singer (D276): lily-transcribe hears the shown score's audio
 * track's lead vocals stem sing `voice`, and the status line names its stage.
 */
async function detectSung(voice: string, notes: SungVoice): Promise<SungFound> {
  const rootFile = previewRoot
  const audio = attachedAudio
  if (!rootFile || audio?.rootFile !== rootFile || !audio.path) throw new Error('The score has no audio track to listen to.')
  const stop = studio.onTranscription((event) => {
    if (event.event === 'progress') status(sungProgress(audio.name, event.stage, event.value))
  })
  status(`From the singer: listening to ${voice} in ${audio.name}…`)
  try {
    return await studio.detectSung(rootFile, audio.name, voice, notes)
  } finally {
    stop()
  }
}

/** Add audio… (D155): a recording beside the score, or copied beside it, named in its `% Audio:` line. */
async function chooseAudio(): Promise<void> {
  const rootFile = previewRoot
  if (!rootFile) return
  try {
    const chosen = await studio.chooseAudio(rootFile)
    if (!chosen) return
    await setScoreLines({ Audio: chosen.name })
    if (chosen.copied) status(`Copied ${chosen.name} beside ${displayName(rootFile)} and named it in % Audio:. Save to keep it.`)
  } catch (error) {
    report(error)
  }
}

/**
 * The Stem strip for the score shown, when its `% Stem:` line names a stem
 * beside it (D112), its `% Backing:` line a backing track (D133), or its
 * `% Music:` line the music without any voice (D137); the first of them is chosen.
 */
async function showStem(rootFile: string | undefined): Promise<void> {
  if (!stemStrip) return
  stemStrip.show([])
  const text = rootFile ? (editor.textOf(rootFile) ?? '') : ''
  const named = [
    { label: 'Music', name: musicOfScore(text) },
    { label: 'Backing', name: backingOfScore(text) },
    { label: 'Stem', name: stemOfScore(text) },
  ]
  if (!rootFile) return
  const audios: StripAudio[] = []
  for (const { label, name } of named) {
    if (!name) continue
    try {
      const path = await studio.attachStem(rootFile, name)
      audios.push({ label, path, url: studio.stemUrl(path) })
    } catch (error) {
      // Moved or deleted since: the score is shown without it.
      console.warn('stem:', error)
    }
  }
  if (previewRoot === rootFile && audios.length > 0) stemStrip.show(audios)
}

/**
 * Add MIDI (D44): the score shown gets its `\midi { }`, in the editor as one
 * undoable edit. Live preview compiles it from there; without it, it is saved,
 * which compiles it.
 */
async function addMidi(): Promise<void> {
  const rootFile = previewRoot
  if (!rootFile) return
  await open(rootFile)
  const text = editor.textOf(rootFile)
  if (text === undefined) return
  const name = displayName(rootFile)
  const insertion = addMidiBlock(text)
  if (insertion.kind === 'has-midi') return status(`${name} has its \\midi block already`)
  if (insertion.kind === 'no-score') {
    return status(`No \\score in ${name} to add MIDI to. Put \\midi { } inside the \\score, next to \\layout { }.`)
  }
  editor.applyEdits(rootFile, insertion.edits, insertion.reveal)
  if (liveButton.getAttribute('aria-pressed') !== 'true') await save(false)
  status(`Added \\midi { } to ${name}. Press ▶ once it is engraved.`)
}

async function open(file: string): Promise<void> {
  try {
    const text = editor.isOpen(file) ? undefined : await studio.readFile(file)
    showScores()
    showSource()
    welcome.hide()
    monacoHost.hidden = false
    editor.show(file, text)
    files.setActive(file)
    await previewFor(file)
  } catch (error) {
    report(error)
  }
}

/** Applies the result of a dialog: shows the folder, opens the chosen file. */
async function run(opening: Promise<Opened | undefined>): Promise<void> {
  try {
    const opened = await opening
    if (!opened) return
    showScores()
    files.show(opened.listing)
    void agents?.folderChanged(opened.listing.folder)
    refreshMarkers()
    if (opened.file) await open(opened.file)
  } catch (error) {
    report(error)
  }
}

/** Opens an entry of the recent list (D49); rejects when it is gone, saying where it was. */
async function openRecent(path: string): Promise<void> {
  const opened = await studio.openRecent(path)
  await run(Promise.resolve(opened))
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
void studio.templates().then((templates) => {
  for (const template of templates) {
    const item = button(template.label, () => {
      templateMenu.hidden = true
      void run(studio.newScore(template.id))
    })
    item.setAttribute('role', 'menuitem')
    templateMenu.append(item)
  }
}, report)
filesPane.querySelector('.pane-actions')!.append(newButton, openButton)
filesPane.append(templateMenu)

function showTemplates(): void {
  showScores()
  templateMenu.hidden = false
  templateMenu.querySelector('button')?.focus()
}
// WebKit gives a clicked button no focus: the press would blur the menu,
// which hides it, and the release would land on what was under it.
templateMenu.addEventListener('mousedown', (event) => event.preventDefault())
templateMenu.addEventListener('focusout', (event) => {
  if (!templateMenu.contains(event.relatedTarget as Node | null)) templateMenu.hidden = true
})
templateMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') templateMenu.hidden = true
})

studio.onCompile((event) => {
  compiled(event)
  if (!forPreview(event)) return
  showBanner(event)
  preview.compiled(event)
  player.compiled(event)
  pdfView.compiled(event)
})
// The web's engine sends what changed of a page before the outcome that holds it (W8, D171), or the
// page shown whole as soon as the engine has written it (I7, D269).
studio.onCells(({ rootFile, cells }) => {
  if (rootFile !== previewRoot) return
  if (cells.type === 'page') preview.replacePage(cells)
  else preview.replaceCells(cells)
})

/**
 * Files another program changed (D34): an open one is reloaded, after asking
 * when it has unsaved changes. The main process compiles the score again.
 */
async function changedOnDisk(changes: FileChange[]): Promise<void> {
  for (const { file, exists } of changes) {
    if (!editor.isOpen(file)) continue
    const name = displayName(file)
    try {
      if (!exists) {
        status(`${name} was deleted or moved by another program. Save to write it again.`)
        continue
      }
      if (editor.isDirty(file) && !(await studio.confirmReload(file))) {
        status(`${name} was changed by another program; your changes are kept`)
        continue
      }
      // Read now: the file may have changed again while the dialog was open.
      editor.reload(file, await studio.readFile(file))
      status(`${name} was changed by another program and has been reloaded`)
    } catch (error) {
      report(error)
    }
  }
}

// One batch at a time, so a second change does not ask while the first dialog is open.
let reloading = Promise.resolve()
studio.onFilesChanged((changes) => {
  reloading = reloading.then(() => changedOnDisk(changes))
})

studio.onCommand((command) => {
  switch (command) {
    case 'new-score':
      return showTemplates()
    case 'open-file':
      return void run(studio.openFile())
    case 'open-folder':
      return void run(studio.openFolder())
    case 'import-guitar-pro':
      return void run(studio.importGuitarPro())
    case 'save':
      return void save(false)
    case 'save-all':
      return void save(true)
    case 'export-midi':
      return void player.exportMidi()
    case 'export-garageband':
      return void player.exportGarageBand()
    case 'toggle-sidebar':
      // From full width, back to everything.
      if (previewFull()) {
        showPreviewFull(false)
        return sidebar.setShown(true)
      }
      return sidebar.toggleShown()
    case 'preview-full-width':
      return showPreviewFull(!previewFull())
    case 'welcome':
      showPreviewFull(false)
      showScores()
      showSource()
      monacoHost.hidden = true
      return welcome.show(!!editor.file)
    case 'setup-lilypond':
      return welcome.openSetup()
    case 'upload':
      return void run(studio.upload(files.folder?.folder))
    case 'download':
      if (!editor.file) return status('Open a score to download it')
      return void studio.download(editor.file).catch(report)
  }
})

// File › Open Recent; a gone entry says so in the status line.
studio.onOpenRecent((path) => void openRecent(path).catch(report))
// A score opened from Finder (D123), at launch or since.
studio.onOpened((opened) => void run(Promise.resolve(opened)))

welcome.show(false)
// First run, and every run after it: when LilyPond cannot be found, the setup opens.
void welcome.check(true).catch(report)

// A folder the main process already has (the smoke test's) is shown at once.
void studio.listFolder().then((listing) => {
  if (!listing) return
  files.show(listing)
  void agents?.folderChanged(listing.folder)
}, report)
