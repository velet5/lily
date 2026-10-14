// The Separate view of the Stems workspace (DECISIONS D112): RoFormer MLX's
// app in Lily Studio's panes. A song is dropped on the window or chosen with
// the panel; a model is picked from Karaoke or All instruments, with a quality
// and a format; Separate runs karaoke-mlx, with its progress and Cancel. Each
// stem then gets a player, ticked stems export as a mix, and Show in Finder
// opens the stems' folder. A separation goes on in Scores, and the status line
// follows it. The models are asked for when Stems is first shown, not at
// launch, since uv starts Python for them. The functions above the view are
// pure so the tests can run them without a DOM.
import type { FileDrop, SeparationEvent, SeparationModel, SeparationOutput, SeparationRequest } from '../ipc'
import type { StudioApi } from './bridge'
import { button } from './files'

/** What karaoke-mlx's ffmpeg reads, as RoFormer's app offered; src-tauri's choose_song has the same. */
export const SONG_EXTENSIONS = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'aiff', 'aif', 'wma', 'mp4', 'mkv', 'webm']

/** Chunks overlapping each sample: more is slower and cleaner. RoFormer's app's choices. */
export const QUALITIES: readonly { label: string; overlap: number; title: string }[] = [
  { label: 'Fast', overlap: 2, title: 'Two overlapping passes' },
  { label: 'Balanced', overlap: 4, title: 'Four overlapping passes' },
  { label: 'Best', overlap: 8, title: 'Eight overlapping passes; the slowest' },
]
export const DEFAULT_OVERLAP = 4

export const FORMATS: readonly { format: SeparationRequest['format']; label: string }[] = [
  { format: 'wav', label: 'WAV' },
  { format: 'flac', label: 'FLAC' },
  { format: 'mp3', label: 'MP3 320k' },
]

/** The model list's groups, in order. */
export const TASKS: Record<SeparationModel['task'], string> = { karaoke: 'Karaoke', stems: 'All instruments' }

const STAGES: Record<string, string> = {
  download: 'Downloading the model (once)',
  verify: 'Checking the download',
  convert: 'Converting the weights for MLX',
  load: 'Loading the model',
  decode: 'Reading the song',
  separate: 'Separating',
  mix: 'Mixing',
  write: 'Writing the stems',
}
/** The stages whose value says how far they are; the others show a moving bar. */
const MEASURED = new Set(['download', 'separate'])

const STEMS: Record<string, [string, string]> = {
  instrumental: ['Instrumental', 'karaoke backing track'],
  vocals: ['Vocals', 'isolated voice'],
  drums: ['Drums', ''],
  bass: ['Bass', ''],
  guitar: ['Guitar', ''],
  piano: ['Piano', 'and keys'],
  other: ['Other', 'everything else'],
}

/** The last name of `path`. */
export function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

/** Whether `path` is a file karaoke-mlx can separate, by its extension. */
export function isSong(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot > path.lastIndexOf('/') && SONG_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase())
}

/** The first song among `paths`, as dropped on the window. */
export function droppedSong(paths: readonly string[]): string | undefined {
  return paths.find(isSong)
}

/** `models` under Karaoke, then All instruments; a group with none is left out. */
export function modelGroups(models: readonly SeparationModel[]): { task: SeparationModel['task']; label: string; models: SeparationModel[] }[] {
  return Object.entries(TASKS)
    .map(([task, label]) => ({ task: task as SeparationModel['task'], label, models: models.filter((model) => model.task === task) }))
    .filter((group) => group.models.length > 0)
}

/**
 * A model's name in the list, as RoFormer's app shortened it: a karaoke
 * model by who trained it, "Mel-RoFormer Karaoke (becruily)" as "becruily";
 * another by its architecture, "BS-RoFormer SW, 6 stems (jarredou)" as
 * "BS-RoFormer SW".
 */
export function modelLabel(model: Pick<SeparationModel, 'title' | 'task'>): string {
  return model.task === 'karaoke' ? model.title.replace(/^.*\((.*)\)$/, '$1') : model.title.replace(/[,(].*$/, '').trim()
}

/** What a model writes, beside its name: its two stems, or how many. */
export function modelStems(model: Pick<SeparationModel, 'stems'>): string {
  return model.stems.length > 2 ? `${model.stems.length} stems` : model.stems.join(' · ')
}

/** The note under the list: what the model does, and the download its first separation makes. */
export function modelNote(model: Pick<SeparationModel, 'description' | 'installed' | 'size'>): string {
  return model.installed ? model.description : `${model.description} Its first separation downloads ${(model.size / 1e9).toFixed(1)} GB.`
}

/** The run button's label. */
export function runLabel(model: Pick<SeparationModel, 'task'> | undefined, running: boolean): string {
  if (running) return 'Cancel'
  return model?.task === 'stems' ? 'Separate instruments' : 'Make karaoke'
}

/** A stem's name and what it holds; a karaoke model's vocals are the lead vocals. */
export function stemTitle(stem: string, task: SeparationModel['task'] | undefined): { title: string; hint: string } {
  if (task === 'karaoke' && stem === 'vocals') return { title: 'Lead vocals', hint: STEMS.vocals![1] }
  const [title, hint] = STEMS[stem] ?? [stem.charAt(0).toUpperCase() + stem.slice(1), '']
  return { title, hint }
}

/** `seconds` as m:ss. */
export function elapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * What the progress bar shows for a progress or status event: the stage, and
 * how far as 0 to 1, or undefined for a stage that does not say. Undefined
 * for the other events.
 */
export function progressOf(event: SeparationEvent): { label: string; value?: number } | undefined {
  if (event.event === 'status') return { label: event.message }
  if (event.event !== 'progress') return undefined
  const label = STAGES[event.stage] ?? event.stage
  return MEASURED.has(event.stage) ? { label, value: Math.min(1, Math.max(0, event.value)) } : { label }
}

/** The status line while a separation runs: the song, the stage, and how far when known. */
export function statusLine(song: string, progress: { label: string; value?: number }): string {
  const percent = progress.value === undefined ? '' : ` ${Math.round(progress.value * 100)}%`
  return `Stems: ${progress.label.toLowerCase()} ${song}${percent}`
}

/** The export button's label for `ticked` stems. */
export function mixLabel(ticked: number, mixing: boolean): string {
  if (mixing) return 'Mixing…'
  return ticked > 0 ? `Export mix of ${ticked}…` : 'Export mix…'
}

const SVG = 'http://www.w3.org/2000/svg'
/** A note, as RoFormer's drop zone had it. */
const NOTE = 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function noteIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', NOTE)
  svg.append(path)
  return svg
}

export interface SeparateOptions {
  /** The Separate pane: its header gets Show in Finder, its body the view. */
  host: HTMLElement
  studio: StudioApi
  /** A message for the status line. */
  onStatus(message: string): void
}

/** What a finished separation left: its stems and where they are. */
interface Separated {
  song: string
  task: SeparationModel['task'] | undefined
  folder: string
  outputs: SeparationOutput[]
  seconds: number
}

export class SeparateView {
  private song: string | undefined
  private models: SeparationModel[] = []
  private model: string | undefined
  private overlap = DEFAULT_OVERLAP
  private loading: Promise<void> | undefined
  private running = false
  private cancelled = false
  private mixing = false
  private separated: Separated | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private lastStatus = ''
  private readonly players: HTMLAudioElement[] = []

  private readonly reveal: HTMLButtonElement
  private readonly drop: HTMLButtonElement
  private readonly dropTitle: HTMLElement
  private readonly dropHint: HTMLElement
  private readonly problem: HTMLElement
  private readonly problemText: HTMLElement
  private readonly modelList: HTMLElement
  private readonly note: HTMLElement
  private readonly qualities: HTMLButtonElement[]
  private readonly format: HTMLSelectElement
  private readonly run: HTMLButtonElement
  private readonly progress: HTMLElement
  private readonly bar: HTMLElement
  private readonly stage: HTMLElement
  private readonly clock: HTMLElement
  private readonly error: HTMLElement
  private readonly empty: HTMLElement
  private readonly results: HTMLElement
  private readonly resultsTitle: HTMLElement
  private readonly resultsMeta: HTMLElement
  private readonly selectAll: HTMLInputElement
  private readonly stemList: HTMLElement
  private readonly mixList: HTMLElement
  private readonly selection: HTMLElement
  private readonly exportMix: HTMLButtonElement

  constructor(private readonly options: SeparateOptions) {
    const { host, studio } = options
    this.reveal = button('Show in Finder', () => this.showInFinder())
    this.reveal.disabled = true
    this.reveal.title = 'Show the stems’ folder in the Finder'
    host.querySelector('.pane-actions')!.replaceChildren(this.reveal)

    // The song: dropped on the window (index.ts), or chosen with the panel.
    this.drop = element('button', 'separate-drop')
    this.drop.type = 'button'
    this.dropTitle = element('strong', undefined, 'Drop a song here')
    this.dropHint = element('small', undefined, 'or click to choose · mp3, m4a, flac, wav…')
    this.drop.append(noteIcon(), this.dropTitle, this.dropHint)
    this.drop.addEventListener('click', () => void this.choose())

    this.problemText = element('span')
    this.problem = element('div', 'separate-problem')
    this.problem.setAttribute('role', 'alert')
    this.problem.append(this.problemText, button('Check again', () => void this.load(true)))
    this.problem.hidden = true

    this.modelList = element('div', 'separate-models')
    this.modelList.setAttribute('role', 'radiogroup')
    this.modelList.setAttribute('aria-label', 'Model')
    this.modelList.append(element('div', 'separate-models-empty', 'Looking for the models…'))
    this.note = element('p', 'separate-note')

    this.qualities = QUALITIES.map(({ label, overlap, title }) => {
      const choice = button(label, () => {
        this.overlap = overlap
        this.refresh()
      })
      choice.title = title
      return choice
    })
    const quality = element('div', 'separate-segments')
    quality.setAttribute('role', 'group')
    quality.setAttribute('aria-label', 'Quality')
    quality.append(...this.qualities)

    this.format = element('select')
    this.format.setAttribute('aria-label', 'Format')
    for (const { format, label } of FORMATS) this.format.append(new Option(label, format, format === 'wav', format === 'wav'))

    this.run = button('Make karaoke', () => (this.running ? void this.cancel() : void this.start()))
    this.run.className = 'primary separate-run'

    this.bar = element('i')
    this.stage = element('span', undefined, 'Starting…')
    this.clock = element('span', undefined, '0:00')
    const track = element('div', 'separate-bar')
    track.append(this.bar)
    const meta = element('div', 'separate-progress-meta')
    meta.append(this.stage, this.clock)
    this.progress = element('div', 'separate-progress')
    this.progress.setAttribute('role', 'status')
    this.progress.append(track, meta)
    this.progress.hidden = true

    this.error = element('p', 'separate-error')
    this.error.setAttribute('role', 'alert')
    this.error.hidden = true

    const setup = element('div', 'separate-setup')
    setup.append(
      this.drop,
      this.problem,
      field('Model', this.modelList),
      this.note,
      field('Quality', quality),
      field('Format', this.format),
      this.run,
      this.progress,
      this.error,
    )

    // The stems, once separated.
    this.empty = element('div', 'separate-empty placeholder', 'The stems appear here, one player each.')
    this.resultsTitle = element('strong')
    this.resultsMeta = element('span', 'separate-results-meta')
    this.selectAll = element('input')
    this.selectAll.type = 'checkbox'
    this.selectAll.addEventListener('change', () => {
      for (const box of this.boxes()) box.checked = this.selectAll.checked
      this.updateSelection()
    })
    const selectAllLabel = element('label', 'separate-check')
    selectAllLabel.append(this.selectAll, document.createTextNode('Select all'))
    const head = element('div', 'separate-results-head')
    head.append(this.resultsTitle, this.resultsMeta, selectAllLabel)
    this.stemList = element('div', 'separate-stems')
    this.mixList = element('div', 'separate-stems separate-mix')
    this.mixList.hidden = true
    this.selection = element('span', 'separate-selection')
    this.exportMix = button('Export mix…', () => void this.mix())
    this.exportMix.className = 'primary'
    const foot = element('div', 'separate-results-foot')
    foot.append(this.selection, this.exportMix)
    this.results = element('div', 'separate-results-list')
    this.results.append(head, this.stemList, this.mixList, foot)
    this.results.hidden = true
    const resultsColumn = element('div', 'separate-results')
    resultsColumn.append(this.empty, this.results)

    const view = element('div', 'separate')
    view.append(setup, resultsColumn)
    const body = host.querySelector('.pane-body')!
    body.className = 'pane-body'
    body.replaceChildren(view)

    studio.onSeparation((event) => this.onEvent(event))
    this.refresh()
  }

  /** Stems is shown: the models are asked for the first time. */
  activate(): void {
    void this.load(false)
  }

  /**
   * Files dragged over the window: the drop zone lights up for a song, and a
   * song dropped is chosen. True when it took one, so index.ts shows Stems.
   */
  fileDrop(drop: FileDrop): boolean {
    const song = drop.kind === 'leave' ? undefined : droppedSong(drop.paths)
    this.drop.toggleAttribute('data-hover', drop.kind === 'enter' && !!song && !this.running)
    if (drop.kind !== 'drop' || !song || this.running) return false
    this.setSong(song)
    return true
  }

  private async choose(): Promise<void> {
    try {
      const song = await this.options.studio.chooseSong()
      if (song) this.setSong(song)
    } catch (error) {
      this.showError(String(error))
    }
  }

  private setSong(song: string): void {
    if (this.running) return
    this.song = song
    this.dropTitle.textContent = baseName(song)
    this.dropHint.textContent = 'Drop another song, or click to choose'
    this.drop.title = song
    this.error.hidden = true
    this.refresh()
  }

  /** Asks where the project and uv are, then for the models; once unless `again`. */
  private load(again: boolean): Promise<void> {
    if (this.loading && !again) return this.loading
    this.loading = (async () => {
      const { studio } = this.options
      try {
        const status = await studio.separationStatus()
        if (status.problem) {
          this.showProblem(status.problem)
          return
        }
        this.models = await studio.separationModels()
        this.problem.hidden = true
        if (!this.models.some((model) => model.id === this.model)) this.model = (this.models.find((model) => model.default) ?? this.models[0])?.id
        this.showModels()
      } catch (error) {
        this.showProblem(`Separation could not start: ${String(error)}`)
      }
    })().finally(() => this.refresh())
    return this.loading
  }

  private showProblem(message: string): void {
    this.models = []
    this.problemText.textContent = message
    this.problem.hidden = false
    this.modelList.replaceChildren(element('div', 'separate-models-empty', 'No models'))
  }

  private showModels(): void {
    const rows: HTMLElement[] = []
    for (const group of modelGroups(this.models)) {
      rows.push(element('div', 'separate-model-group', group.label))
      for (const model of group.models) {
        const radio = element('input')
        radio.type = 'radio'
        radio.name = 'separate-model'
        radio.value = model.id
        radio.checked = model.id === this.model
        radio.addEventListener('change', () => {
          this.model = model.id
          this.refresh()
        })
        const row = element('label', 'separate-model')
        row.title = model.title
        row.append(radio, element('span', 'separate-model-name', modelLabel(model)), element('small', undefined, modelStems(model)))
        rows.push(row)
      }
    }
    this.modelList.replaceChildren(...rows)
  }

  private current(): SeparationModel | undefined {
    return this.models.find((model) => model.id === this.model)
  }

  private refresh(): void {
    const model = this.current()
    this.run.textContent = runLabel(model, this.running)
    this.run.classList.toggle('primary', !this.running)
    this.run.disabled = !this.running && (!this.song || !model)
    this.drop.disabled = this.running
    this.format.disabled = this.running
    for (const radio of this.modelList.querySelectorAll('input')) radio.disabled = this.running
    QUALITIES.forEach(({ overlap }, index) => {
      const choice = this.qualities[index]!
      choice.setAttribute('aria-pressed', String(overlap === this.overlap))
      choice.disabled = this.running
    })
    this.note.textContent = model ? modelNote(model) : ''
    this.reveal.disabled = !this.separated
  }

  private async start(): Promise<void> {
    const model = this.current()
    if (!this.song || !model || this.running) return
    const song = this.song
    this.running = true
    this.cancelled = false
    this.separated = undefined
    this.error.hidden = true
    this.clearResults()
    this.showProgress({ label: 'Starting Python…' })
    this.progress.hidden = false
    const started = Date.now()
    const tick = () => {
      this.clock.textContent = elapsed((Date.now() - started) / 1000)
    }
    tick()
    this.timer = setInterval(tick, 1000)
    this.lastStatus = ''
    this.refresh()
    const request: SeparationRequest = { input: song, model: model.id, overlap: this.overlap, format: this.format.value as SeparationRequest['format'] }
    try {
      await this.options.studio.separate(request)
    } catch (error) {
      if (this.cancelled) this.options.onStatus(`Stems: cancelled ${baseName(song)}`)
      else {
        this.showError(String(error))
        this.options.onStatus(`Stems: ${baseName(song)} was not separated`)
      }
    } finally {
      this.running = false
      clearInterval(this.timer)
      this.progress.hidden = true
      this.refresh()
      // A first separation downloads its model: the note no longer says so.
      void this.load(true)
    }
  }

  private async cancel(): Promise<void> {
    this.cancelled = true
    this.showProgress({ label: 'Cancelling…' })
    try {
      await this.options.studio.cancelSeparation()
    } catch (error) {
      this.showError(String(error))
    }
  }

  private onEvent(event: SeparationEvent): void {
    if (!this.running) return
    const progress = progressOf(event)
    if (progress && !this.cancelled) {
      this.showProgress(progress)
      const line = statusLine(baseName(this.song ?? ''), progress)
      if (line !== this.lastStatus) this.options.onStatus((this.lastStatus = line))
    } else if (event.event === 'done') {
      this.separated = {
        song: this.song ?? '',
        task: this.current()?.task,
        folder: event.folder,
        outputs: event.outputs,
        seconds: event.seconds,
      }
      this.showResults(this.separated)
      this.options.onStatus(`Separated ${baseName(this.separated.song)} in ${elapsed(event.seconds)}`)
    } else if (event.event === 'error' && !event.cancelled) {
      this.showError(event.message)
    }
  }

  private showProgress({ label, value }: { label: string; value?: number }): void {
    this.stage.textContent = label
    this.bar.toggleAttribute('data-moving', value === undefined)
    this.bar.style.width = value === undefined ? '' : `${(value * 100).toFixed(1)}%`
  }

  private showError(message: string): void {
    this.error.textContent = message
    this.error.hidden = false
  }

  private clearResults(): void {
    for (const player of this.players) player.pause()
    this.players.length = 0
    this.stemList.replaceChildren()
    this.mixList.replaceChildren()
    this.mixList.hidden = true
    this.results.hidden = true
    this.empty.hidden = false
  }

  private showResults(separated: Separated): void {
    this.clearResults()
    this.resultsTitle.textContent = baseName(separated.folder)
    this.resultsTitle.title = separated.folder
    const format = FORMATS.find(({ format }) => separated.outputs[0]?.path.toLowerCase().endsWith(`.${format}`))?.label
    this.resultsMeta.textContent = `${separated.outputs.length} stems${format ? ` · ${format}` : ''} · separated in ${elapsed(separated.seconds)}`
    for (const { stem, path } of separated.outputs) {
      const { title, hint } = stemTitle(stem, separated.task)
      this.stemList.append(this.stemRow({ stem, path, title, hint, tick: true }))
    }
    this.empty.hidden = true
    this.results.hidden = false
    this.updateSelection()
  }

  /** A stem's row: a box to tick for the mix, its name, and its player. */
  private stemRow({ stem, path, title, hint, tick }: { stem: string; path: string; title: string; hint: string; tick: boolean }): HTMLElement {
    const row = element('div', 'separate-stem')
    row.dataset.stem = stem
    const name = element('label', 'separate-stem-name')
    if (tick) {
      const box = element('input')
      box.type = 'checkbox'
      box.value = path
      box.dataset.stem = stem
      box.addEventListener('change', () => this.updateSelection())
      name.append(box)
    }
    const words = element('span')
    words.append(element('strong', undefined, title))
    if (hint) words.append(element('small', undefined, hint))
    name.append(words)
    const player = element('audio')
    player.controls = true
    player.preload = 'metadata'
    player.src = this.options.studio.stemUrl(path)
    player.title = baseName(path)
    player.setAttribute('aria-label', `${title}: ${baseName(path)}`)
    // One stem at a time, as in RoFormer's app.
    player.addEventListener('play', () => this.players.forEach((other) => other !== player && other.pause()))
    this.players.push(player)
    row.append(name, player)
    return row
  }

  private boxes(): HTMLInputElement[] {
    return [...this.stemList.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
  }

  private updateSelection(): void {
    const boxes = this.boxes()
    const ticked = boxes.filter((box) => box.checked)
    this.selectAll.checked = boxes.length > 0 && ticked.length === boxes.length
    this.selectAll.indeterminate = ticked.length > 0 && ticked.length < boxes.length
    this.exportMix.textContent = mixLabel(ticked.length, this.mixing)
    this.exportMix.disabled = this.mixing || ticked.length === 0
    const task = this.separated?.task
    this.selection.textContent = ticked.length
      ? ticked.map((box) => stemTitle(box.dataset.stem ?? '', task).title).join(' + ')
      : 'Tick stems to combine them into one file'
  }

  private async mix(): Promise<void> {
    const separated = this.separated
    const ticked = this.boxes().filter((box) => box.checked)
    if (!separated || ticked.length === 0) return
    this.mixing = true
    this.error.hidden = true
    this.updateSelection()
    try {
      const written = await this.options.studio.mixStems(ticked.map((box) => box.value))
      if (!written) return
      this.options.onStatus(`Exported ${baseName(written)}`)
      // The asset scope lets in only the stems' folder: a mix saved elsewhere does not play here.
      if (written.slice(0, written.lastIndexOf('/')) === separated.folder) {
        const hint = ticked.map((box) => stemTitle(box.dataset.stem ?? '', separated.task).title).join(' + ')
        this.mixList.replaceChildren(this.stemRow({ stem: 'mix', path: written, title: 'Mix', hint, tick: false }))
        this.mixList.hidden = false
      }
    } catch (error) {
      this.showError(`The mix was not exported: ${String(error)}`)
    } finally {
      this.mixing = false
      this.updateSelection()
    }
  }

  private showInFinder(): void {
    const separated = this.separated
    if (!separated) return
    this.options.studio.revealInFinder(separated.outputs[0]?.path ?? separated.folder).catch((error: unknown) => this.showError(String(error)))
  }
}

/** A labelled part of the setup column. */
function field(label: string, control: HTMLElement): HTMLElement {
  const part = element('div', 'separate-field')
  part.append(element('span', 'separate-field-label', label), control)
  return part
}
