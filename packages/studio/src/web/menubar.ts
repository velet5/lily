// The web's menu bar (DECISIONS D55), in place of the app's menu
// (src-tauri/src/menu.rs): File and Help with the same commands, sent to the
// renderer as the app's menu sends them, and Upload and Download, which a
// browser needs. On the right, who is signed in, and Sign Out. The app's
// shortcuts that a browser lets a page have work too.
import type { Command, RecentList } from '../ipc'
import { recentLabel } from '../renderer/welcome'

interface Item {
  label: string
  /** As shown, e.g. ⌘S; the keys are handled in `keyCommand`. */
  keys?: string
  run(): void
}

type Section = Item[]

export interface MenuBarOptions {
  command(command: Command): void
  openRecent(path: string): void
  recentList(): Promise<RecentList>
  clearRecent(): void
  learn(): void
}

const MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = MAC ? '⌘' : 'Ctrl+'
const ALT = MAC ? '⌥' : 'Alt+'
const SHIFT = MAC ? '⇧' : 'Shift+'

/** The command of a key press, for the shortcuts of the app's menu a browser leaves to a page. */
export function keyCommand(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'code'>, mac: boolean): Command | undefined {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!mod) return undefined
  if (event.code === 'KeyS') return event.altKey ? 'save-all' : event.shiftKey ? undefined : 'save'
  if (event.code === 'KeyO' && !event.altKey) return event.shiftKey ? 'open-folder' : 'open-file'
  return undefined
}

export class MenuBar {
  private readonly element: HTMLElement
  private readonly user: HTMLElement
  private open: HTMLElement | undefined

  constructor(private readonly options: MenuBarOptions) {
    this.element = document.createElement('nav')
    this.element.className = 'web-menubar'
    this.element.setAttribute('aria-label', 'Menu')
    const brand = document.createElement('span')
    brand.className = 'web-brand'
    brand.textContent = 'Lily Studio'
    const run = (command: Command) => () => options.command(command)
    const file: Section[] = [
      [
        { label: 'New Score…', run: run('new-score') },
        { label: 'Open Score…', keys: `${MOD}O`, run: run('open-file') },
        { label: 'Open Folder…', keys: `${SHIFT}${MOD}O`, run: run('open-folder') },
      ],
      [
        { label: 'Save', keys: `${MOD}S`, run: run('save') },
        { label: 'Save All', keys: `${ALT}${MOD}S`, run: run('save-all') },
      ],
      [
        { label: 'Upload Scores…', run: run('upload') },
        { label: 'Download Score', run: run('download') },
        { label: 'Export MIDI…', run: run('export-midi') },
      ],
    ]
    const help: Section[] = [
      [
        { label: 'Welcome', run: run('welcome') },
        { label: 'LilyPond on This Server', run: run('setup-lilypond') },
      ],
      [{ label: 'LilyPond Learning Manual', run: () => options.learn() }],
    ]
    const signOut = document.createElement('form')
    signOut.method = 'post'
    signOut.action = '/logout'
    signOut.className = 'web-account'
    this.user = document.createElement('span')
    this.user.className = 'web-user'
    const leave = document.createElement('button')
    leave.type = 'submit'
    leave.textContent = 'Sign Out'
    signOut.append(this.user, leave)
    this.element.append(brand, this.menu('File', file, true), this.menu('Help', help), signOut)
    document.body.prepend(this.element)
    document.body.classList.add('hosted')

    document.addEventListener('click', (event) => {
      if (this.open && !this.open.parentElement!.contains(event.target as Node)) this.close()
    })
    // Before the editor, which would take ⌘S as text otherwise.
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && this.open) return this.close(true)
        const command = keyCommand(event, MAC)
        if (!command) return
        event.preventDefault()
        event.stopPropagation()
        options.command(command)
      },
      true,
    )
  }

  setUser(name: string): void {
    this.user.textContent = name
  }

  private menu(label: string, sections: Section[], recent = false): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'web-menu'
    const opener = document.createElement('button')
    opener.type = 'button'
    opener.textContent = label
    opener.setAttribute('aria-haspopup', 'menu')
    opener.setAttribute('aria-expanded', 'false')
    const list = document.createElement('div')
    list.className = 'web-menu-items'
    list.setAttribute('role', 'menu')
    list.hidden = true
    const fill = (recentItems: HTMLElement[]) => {
      const groups = sections.map((section) => section.map((item) => this.item(item)))
      if (recentItems.length) groups.splice(1, 0, recentItems)
      list.replaceChildren(...groups.flatMap((group, index) => (index ? [this.separator(), ...group] : group)))
    }
    opener.addEventListener('click', () => {
      if (this.open === list) return this.close()
      this.close()
      this.open = list
      list.hidden = false
      opener.setAttribute('aria-expanded', 'true')
      fill([])
      list.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
      // Open Recent joins once listed, unless the menu was closed or moved on meanwhile.
      if (recent) {
        void this.recentItems().then((items) => {
          if (this.open !== list || items.length === 0) return
          const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).textContent : undefined
          fill(items)
          const again = [...list.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === focused)
          again?.focus()
        })
      }
    })
    // Hovering across the bar moves an open menu along, as a menu bar does.
    opener.addEventListener('mouseenter', () => {
      if (this.open && this.open !== list) opener.click()
    })
    list.addEventListener('keydown', (event) => {
      const items = [...list.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      const at = items.indexOf(document.activeElement as HTMLElement)
      if (event.key === 'ArrowDown') items[(at + 1) % items.length]?.focus()
      else if (event.key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus()
      else return
      event.preventDefault()
    })
    wrapper.append(opener, list)
    return wrapper
  }

  private item(item: Item): HTMLElement {
    const element = document.createElement('button')
    element.type = 'button'
    element.setAttribute('role', 'menuitem')
    const label = document.createElement('span')
    label.textContent = item.label
    element.append(label)
    if (item.keys) {
      const keys = document.createElement('kbd')
      keys.textContent = item.keys
      element.append(keys)
    }
    element.addEventListener('click', () => {
      this.close()
      item.run()
    })
    return element
  }

  private separator(): HTMLElement {
    const line = document.createElement('div')
    line.setAttribute('role', 'separator')
    return line
  }

  /** Open Recent's entries (D49), under a heading, and Clear. */
  private async recentItems(): Promise<HTMLElement[]> {
    let list: RecentList
    try {
      list = await this.options.recentList()
    } catch {
      return []
    }
    const entries = list.entries.filter((entry) => entry.exists)
    if (entries.length === 0) return []
    const heading = document.createElement('div')
    heading.className = 'web-menu-heading'
    heading.textContent = 'Open Recent'
    const items = entries.map((entry) => {
      const { name, place } = recentLabel(entry.path, list.home)
      const item = this.item({ label: name, run: () => this.options.openRecent(entry.path) })
      item.title = place ? `${place.replace(/^~/, 'My Scores')}/${name}` : name
      return item
    })
    return [heading, ...items, this.item({ label: 'Clear Recent', run: () => this.options.clearRecent() })]
  }

  private close(focusOpener = false): void {
    const open = this.open
    if (!open) return
    open.hidden = true
    const opener = open.previousElementSibling as HTMLElement
    opener.setAttribute('aria-expanded', 'false')
    if (focusOpener) opener.focus()
    this.open = undefined
  }
}
