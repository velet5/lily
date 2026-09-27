// The sidebar (DECISIONS D40): its right edge drags to make it wider or
// narrower, and the edge between the files and the agents' accordion drags to
// share its height. Both edges also move with the arrow keys and go back to
// where they started on a double-click. The accordion opens one fold at a time,
// or none. Sizes and the open fold are remembered in this window's storage.
// `clampWidth` and `clampHeight` are pure so the tests can run them without a DOM.

export const SIDEBAR_WIDTH = { min: 180, max: 640, initial: 240 }
/** The editor and the preview keep at least this much of the window between them. */
export const MAIN_MIN = 480
/** The files keep at least this much height, the open fold at least AGENTS_MIN. */
export const FILES_MIN = 96
export const AGENTS_MIN = 140
/** Arrow keys move an edge by STEP, by BIG_STEP with Shift. */
const STEP = 16
const BIG_STEP = 64

export type Fold = 'chats' | 'setup'

/** The sidebar's width, kept within its limits and leaving MAIN_MIN to the rest. */
export function clampWidth(width: number, windowWidth: number): number {
  const max = Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, windowWidth - MAIN_MIN))
  return Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH.min, width)))
}

/** The open fold's height, leaving FILES_MIN to the files in a sidebar `available` high. */
export function clampHeight(height: number, available: number): number {
  const max = Math.max(AGENTS_MIN, available - FILES_MIN)
  return Math.round(Math.min(max, Math.max(AGENTS_MIN, height)))
}

const KEYS = { width: 'lily-studio.sidebar-width', height: 'lily-studio.agents-height', fold: 'lily-studio.agents-fold' }

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage may be unavailable; the size still holds for this run.
  }
}

export interface SidebarOptions {
  /** The grid whose first column the sidebar is; gets `--sidebar-width`. */
  studio: HTMLElement
  sidebar: HTMLElement
  agents: HTMLElement
  /** Runs when a fold opens or closes. */
  onFold?(fold: Fold | undefined): void
}

export class Sidebar {
  private width: number
  /** Undefined until the sidebar has a height to share. */
  private height: number | undefined
  private open: Fold | undefined
  private readonly columns: HTMLElement
  private readonly rows: HTMLElement

  constructor(private readonly options: SidebarOptions) {
    const { sidebar } = options
    this.columns = sidebar.querySelector<HTMLElement>('.splitter-columns')!
    this.rows = sidebar.querySelector<HTMLElement>('.splitter-rows')!
    this.width = Number(stored(KEYS.width)) || SIDEBAR_WIDTH.initial
    const height = Number(stored(KEYS.height))
    this.height = height > 0 ? height : undefined
    const fold = stored(KEYS.fold)
    this.open = fold === 'none' ? undefined : fold === 'setup' ? 'setup' : 'chats'

    this.drag(this.columns, 'x', (start, delta) => this.setWidth(start + delta), () => this.width)
    this.drag(this.rows, 'y', (start, delta) => this.setHeight(start - delta), () => this.currentHeight())
    this.keys(this.columns, ['ArrowLeft', 'ArrowRight'], (step) => this.setWidth(this.width + step, true))
    this.keys(this.rows, ['ArrowDown', 'ArrowUp'], (step) => this.setHeight(this.currentHeight() + step, true))
    this.columns.addEventListener('dblclick', () => this.setWidth(SIDEBAR_WIDTH.initial, true))
    this.rows.addEventListener('dblclick', () => this.setHeight(this.initialHeight(), true))

    for (const section of options.agents.querySelectorAll<HTMLElement>('.fold')) {
      const name = section.dataset.fold as Fold
      section.querySelector('.fold-header button')!.addEventListener('click', () => this.toggle(name))
    }
    // The window got narrower or shorter: the sizes shrink with it, and grow back.
    window.addEventListener('resize', () => this.apply())
    this.apply()
  }

  get fold(): Fold | undefined {
    return this.open
  }

  /** Opens `fold`, closing the other; opening the open one closes it. */
  toggle(fold: Fold): void {
    this.show(this.open === fold ? undefined : fold)
  }

  show(fold: Fold | undefined): void {
    this.open = fold
    store(KEYS.fold, fold ?? 'none')
    this.apply()
    this.options.onFold?.(fold)
  }

  private setWidth(width: number, remember = false): void {
    this.width = clampWidth(width, window.innerWidth)
    this.apply()
    if (remember) this.remember()
  }

  private setHeight(height: number, remember = false): void {
    this.height = clampHeight(height, this.options.sidebar.clientHeight)
    this.apply()
    if (remember) this.remember()
  }

  private remember(): void {
    store(KEYS.width, String(this.width))
    if (this.height !== undefined) store(KEYS.height, String(this.height))
  }

  private initialHeight(): number {
    return Math.round(this.options.sidebar.clientHeight * 0.5)
  }

  private currentHeight(): number {
    return this.height ?? this.initialHeight()
  }

  private apply(): void {
    const { studio, sidebar, agents } = this.options
    const width = clampWidth(this.width, window.innerWidth)
    studio.style.setProperty('--sidebar-width', `${width}px`)
    this.columns.setAttribute('aria-valuenow', String(width))
    this.columns.setAttribute('aria-valuemin', String(SIDEBAR_WIDTH.min))
    this.columns.setAttribute('aria-valuemax', String(clampWidth(Infinity, window.innerWidth)))

    agents.dataset.open = this.open ?? ''
    this.rows.hidden = this.open === undefined
    if (this.open === undefined) {
      agents.style.removeProperty('height')
    } else {
      const height = clampHeight(this.currentHeight(), sidebar.clientHeight)
      agents.style.height = `${height}px`
      this.rows.setAttribute('aria-valuenow', String(height))
    }
    for (const section of agents.querySelectorAll<HTMLElement>('.fold')) {
      const open = section.dataset.fold === this.open
      section.dataset.open = String(open)
      section.querySelector('.fold-header button')!.setAttribute('aria-expanded', String(open))
      section.querySelector<HTMLElement>('.fold-body')!.hidden = !open
    }
  }

  /** Pointer drags of `handle` along `axis`: `move(start, delta)` with the value at the press. */
  private drag(handle: HTMLElement, axis: 'x' | 'y', move: (start: number, delta: number) => void, current: () => number): void {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      try {
        handle.setPointerCapture(event.pointerId)
      } catch {
        // A synthetic pointer (the smoke test's) cannot be captured.
      }
      const origin = axis === 'x' ? event.clientX : event.clientY
      const start = current()
      document.body.dataset.resizing = axis
      const onMove = (e: PointerEvent) => move(start, (axis === 'x' ? e.clientX : e.clientY) - origin)
      const onEnd = () => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onEnd)
        handle.removeEventListener('pointercancel', onEnd)
        delete document.body.dataset.resizing
        this.remember()
      }
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onEnd)
      handle.addEventListener('pointercancel', onEnd)
    })
  }

  private keys(handle: HTMLElement, [less, more]: [string, string], move: (step: number) => void): void {
    handle.addEventListener('keydown', (event) => {
      if (event.key !== less && event.key !== more) return
      event.preventDefault()
      const step = event.shiftKey ? BIG_STEP : STEP
      move(event.key === more ? step : -step)
    })
  }
}
