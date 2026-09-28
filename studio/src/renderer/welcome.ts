// The welcome screen in the editor pane and the LilyPond setup dialog
// (DECISIONS D37). The welcome screen shows while no score is open, or when
// Help › Welcome asks for it: the sample score, new and open, a few first
// steps, whether LilyPond is ready, and the folders and scores opened last
// (D49). The setup dialog walks through installing LilyPond; it opens by
// itself on a launch that cannot find it. `recentLabel` is pure so the tests
// can run it without a DOM.
import type { LilyPondStatus, RecentEntry } from '../ipc'
import type { StudioApi } from './bridge'
import { button } from './files'

export interface WelcomeOptions {
  /** The editor pane's body; the screen covers the editor there. */
  host: HTMLElement
  studio: StudioApi
  onSample(): void
  onNewScore(): void
  onOpenFile(): void
  onOpenFolder(): void
  /** Opens an entry of the recent list; rejects with why it could not. */
  onOpenRecent(path: string): Promise<void>
  /** Back to the score in the editor; only offered when one is open. */
  onBack(): void
}

const STEPS: [string, string][] = [
  ['Write', 'Notes are letters: c d e f g a b. A number after a note is its length: 4 is a quarter, 2 a half, 1 a whole note.'],
  ['See', 'The score on the right follows as you type. Click a note there to find it in the text.'],
  ['Listen', 'Press ▶ under the score to hear it. The notes light up as they play.'],
  ['Fix', 'Mistakes are underlined in red. A note above the score says what is wrong, in plain words.'],
]

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * How the recent list shows `path`: its last name, and the directory it is in
 * with the home directory as `~`.
 */
export function recentLabel(path: string, home?: string): { name: string; place: string } {
  const trimmed = path.replace(/\/+$/, '') || '/'
  const slash = trimmed.lastIndexOf('/')
  if (trimmed === '/' || slash < 0) return { name: trimmed, place: '' }
  const name = trimmed.slice(slash + 1)
  const parent = slash === 0 ? '/' : trimmed.slice(0, slash)
  const base = home?.replace(/\/+$/, '')
  if (base && (parent === base || parent.startsWith(`${base}/`))) {
    return { name, place: `~${parent.slice(base.length)}` }
  }
  return { name, place: parent }
}

const SVG = 'http://www.w3.org/2000/svg'
/** Outlines of a folder and of a page, 16 by 16. */
const ICONS: Record<RecentEntry['kind'], string> = {
  folder: 'M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z',
  file: 'M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3',
}

function icon(kind: RecentEntry['kind']): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('welcome-recent-icon')
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', ICONS[kind])
  svg.append(path)
  return svg
}

export class Welcome {
  readonly element: HTMLElement
  private readonly back: HTMLButtonElement
  private readonly lilypond: HTMLElement
  private readonly recent: HTMLElement
  private readonly recentList: HTMLElement
  private readonly recentMessage: HTMLElement
  private readonly setup: SetupDialog
  private status: LilyPondStatus | undefined

  constructor(private readonly options: WelcomeOptions) {
    this.element = element('div', 'welcome')
    this.element.dataset.welcome = ''
    const inner = element('div', 'welcome-inner')

    const heading = element('h1', undefined, 'Welcome to Lily Studio')
    const intro = element('p', 'welcome-intro', 'Write music as text, see it engraved as a score, and hear it play.')

    const sample = button('Open the Sample Score', options.onSample)
    sample.className = 'primary'
    sample.dataset.action = 'sample'
    const actions = element('div', 'welcome-actions')
    actions.append(
      sample,
      button('New Score…', options.onNewScore),
      button('Open Score…', options.onOpenFile),
      button('Open Folder…', options.onOpenFolder),
    )

    const steps = element('ol', 'welcome-steps')
    for (const [title, text] of STEPS) {
      const item = element('li')
      item.append(element('strong', undefined, title), element('span', undefined, text))
      steps.append(item)
    }

    this.lilypond = element('div', 'welcome-lilypond')
    this.lilypond.dataset.state = 'checking'
    this.lilypond.textContent = 'Looking for LilyPond…'

    this.back = button('Back to the Score', options.onBack)
    this.back.className = 'welcome-back'
    this.back.hidden = true

    // Hidden until there is something to list.
    this.recent = element('section', 'welcome-recent')
    this.recent.hidden = true
    this.recent.setAttribute('aria-labelledby', 'welcome-recent-title')
    const recentHeader = element('div', 'welcome-recent-header')
    const recentTitle = element('h2', undefined, 'Recent')
    recentTitle.id = 'welcome-recent-title'
    const clear = button('Clear', () => void this.forget(() => options.studio.clearRecent()))
    clear.className = 'welcome-recent-clear'
    clear.title = 'Clear the list of recent folders and scores'
    recentHeader.append(recentTitle, clear)
    this.recentMessage = element('p', 'welcome-recent-message')
    this.recentMessage.hidden = true
    this.recentMessage.setAttribute('role', 'alert')
    this.recentList = element('ul', 'welcome-recent-list')
    this.recent.append(recentHeader, this.recentMessage, this.recentList)

    inner.append(this.back, heading, intro, actions, this.recent, this.lilypond, steps)
    this.element.append(inner)
    options.host.append(this.element)

    this.setup = new SetupDialog(options.studio, (status) => this.setStatus(status))
    options.studio.onRecentChanged(() => void this.refreshRecent())
    void this.refreshRecent()
  }

  /** Shows the screen; `canGoBack` when a score is open behind it. */
  show(canGoBack: boolean): void {
    this.back.hidden = !canGoBack
    this.recentMessage.hidden = true
    this.element.hidden = false
    void this.refreshRecent()
  }

  /** Lists the recent folders and scores again, with whether each is still there. */
  async refreshRecent(): Promise<void> {
    let list
    try {
      list = await this.options.studio.recentList()
    } catch (error) {
      console.error('recent list:', error)
      return
    }
    const rows = list.entries.map((entry) => this.recentRow(entry, list.home))
    this.recentList.replaceChildren(...rows)
    this.recent.hidden = rows.length === 0
  }

  private recentRow(entry: RecentEntry, home: string | undefined): HTMLElement {
    const { name, place } = recentLabel(entry.path, home)
    const row = element('li')
    row.dataset.kind = entry.kind
    if (!entry.exists) row.dataset.missing = ''

    const open = element('button', 'welcome-recent-open')
    open.type = 'button'
    const opened = new Date(entry.opened).toLocaleString()
    open.title = entry.exists
      ? `${entry.path}\nOpened ${opened}`
      : `${entry.path}\nNot found: moved, renamed or deleted, or its disk is not connected`
    const text = element('span', 'welcome-recent-text')
    text.append(element('span', 'welcome-recent-name', name))
    if (place) text.append(element('span', 'welcome-recent-place', place))
    if (!entry.exists) text.append(element('span', 'welcome-recent-gone', 'Not found'))
    open.append(icon(entry.kind), text)
    open.addEventListener('click', () => void this.openRecent(entry.path))

    const remove = button('✕', () => void this.forget(() => this.options.studio.forgetRecent(entry.path)))
    remove.className = 'welcome-recent-remove'
    remove.title = 'Remove from Recent'
    remove.setAttribute('aria-label', `Remove ${name} from Recent`)

    row.append(open, remove)
    return row
  }

  private async openRecent(path: string): Promise<void> {
    this.recentMessage.hidden = true
    try {
      await this.options.onOpenRecent(path)
    } catch (error) {
      this.recentMessage.textContent = error instanceof Error ? error.message : String(error)
      this.recentMessage.hidden = false
      await this.refreshRecent()
    }
  }

  /** Removes one entry or all; the list follows on onRecentChanged. */
  private async forget(change: () => Promise<void>): Promise<void> {
    this.recentMessage.hidden = true
    try {
      await change()
    } catch (error) {
      this.recentMessage.textContent = error instanceof Error ? error.message : String(error)
      this.recentMessage.hidden = false
    }
  }

  hide(): void {
    this.element.hidden = true
  }

  get shown(): boolean {
    return !this.element.hidden
  }

  /** Looks for LilyPond; on the first check, opens the setup when it is not ready. */
  async check(openSetupIfNeeded: boolean): Promise<LilyPondStatus> {
    const status = await this.options.studio.lilypondStatus()
    this.setStatus(status)
    if (openSetupIfNeeded && status.state !== 'ready') this.openSetup()
    return status
  }

  openSetup(): void {
    this.setup.open(this.status)
  }

  private setStatus(status: LilyPondStatus): void {
    this.status = status
    this.lilypond.dataset.state = status.state
    const text = element('span', undefined, status.message)
    const setUp = button(status.state === 'ready' ? 'Change…' : 'Set Up LilyPond…', () => this.openSetup())
    setUp.dataset.action = 'setup'
    if (status.state !== 'ready') setUp.className = 'primary'
    this.lilypond.replaceChildren(text, setUp)
  }
}

/** The guided setup: download, install, show the studio where it is, check again. */
class SetupDialog {
  private readonly dialog: HTMLDialogElement
  private readonly message: HTMLElement

  constructor(
    private readonly studio: StudioApi,
    private readonly onStatus: (status: LilyPondStatus) => void,
  ) {
    this.dialog = element('dialog', 'setup')
    this.dialog.setAttribute('aria-labelledby', 'setup-title')
    const title = element('h2', undefined, 'Set Up LilyPond')
    title.id = 'setup-title'
    const why = element(
      'p',
      undefined,
      'LilyPond is the free program that turns your text into printed music. Lily Studio uses it behind the scenes. You install it once.',
    )
    this.message = element('p', 'setup-status')

    const steps = element('ol', 'setup-steps')
    const step = (text: string, ...controls: HTMLElement[]) => {
      const item = element('li')
      item.append(element('span', undefined, text), ...controls)
      steps.append(item)
    }
    step(
      'Download LilyPond for macOS from lilypond.org.',
      button('Open lilypond.org', () => studio.openLink('download')),
    )
    step('Double-click the download to unpack it, and move the lilypond folder into your Applications folder.')
    step(
      'Show Lily Studio where you put it: choose that folder.',
      button('Choose LilyPond…', () => void this.choose()),
    )
    const homebrew = element('p', 'setup-note')
    homebrew.append(
      'Using Homebrew? Run ',
      element('code', undefined, 'brew install lilypond'),
      ' in Terminal, then click Check Again.',
    )

    const footer = element('div', 'setup-buttons')
    const again = button('Check Again', () => void this.check())
    const close = button('Close', () => this.dialog.close())
    close.className = 'primary'
    footer.append(again, close)

    this.dialog.append(title, why, this.message, steps, homebrew, footer)
    document.body.append(this.dialog)
  }

  open(status: LilyPondStatus | undefined): void {
    if (status) this.show(status)
    if (!this.dialog.open) this.dialog.showModal()
  }

  private show(status: LilyPondStatus): void {
    this.message.textContent = status.message
    this.dialog.dataset.state = status.state
    this.onStatus(status)
  }

  private async check(): Promise<void> {
    this.message.textContent = 'Looking for LilyPond…'
    this.show(await this.studio.lilypondStatus())
  }

  private async choose(): Promise<void> {
    const status = await this.studio.chooseLilyPond()
    if (status) this.show(status)
  }
}
