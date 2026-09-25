// The welcome screen in the editor pane and the LilyPond setup dialog
// (DECISIONS D37). The welcome screen shows while no score is open, or when
// Help › Welcome asks for it: the sample score, new and open, a few first
// steps, and whether LilyPond is ready. The setup dialog walks through
// installing LilyPond; it opens by itself on a launch that cannot find it.
import type { LilyPondStatus } from '../main/lilypondSetup'
import type { StudioApi } from '../preload'
import { button } from './files'

export interface WelcomeOptions {
  /** The editor pane's body; the screen covers the editor there. */
  host: HTMLElement
  studio: StudioApi
  onSample(): void
  onNewScore(): void
  onOpenFile(): void
  onOpenFolder(): void
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

export class Welcome {
  readonly element: HTMLElement
  private readonly back: HTMLButtonElement
  private readonly lilypond: HTMLElement
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

    inner.append(this.back, heading, intro, actions, this.lilypond, steps)
    this.element.append(inner)
    options.host.append(this.element)

    this.setup = new SetupDialog(options.studio, (status) => this.setStatus(status))
  }

  /** Shows the screen; `canGoBack` when a score is open behind it. */
  show(canGoBack: boolean): void {
    this.back.hidden = !canGoBack
    this.element.hidden = false
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
