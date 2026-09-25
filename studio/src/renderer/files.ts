// The file list in the left pane (DECISIONS D29): the LilyPond files of the
// open folder as a tree, the one in the editor highlighted, unsaved ones
// marked. `fileRows` is pure so the tests can run it without a DOM.
import type { FolderListing, ScoreFile } from '../files'

export type Row =
  | { kind: 'directory'; name: string; depth: number }
  | { kind: 'file'; name: string; depth: number; file: ScoreFile }

/**
 * Turns the listing, already sorted with each directory's files before its
 * subdirectories, into rows: a heading row for each directory the first time
 * one of its files appears, then the file, indented by depth.
 */
export function fileRows(files: readonly ScoreFile[]): Row[] {
  const rows: Row[] = []
  let open: string[] = []
  for (const file of files) {
    const parts = file.relative.split('/')
    const directories = parts.slice(0, -1)
    let shared = 0
    while (shared < open.length && shared < directories.length && open[shared] === directories[shared]) shared++
    for (let depth = shared; depth < directories.length; depth++) {
      rows.push({ kind: 'directory', name: directories[depth] ?? '', depth })
    }
    open = directories
    rows.push({ kind: 'file', name: parts[parts.length - 1] ?? file.relative, depth: directories.length, file })
  }
  return rows
}

export interface FileListOptions {
  /** The pane body the list is drawn into. */
  body: HTMLElement
  /** The pane header's title element, which shows the folder name. */
  title: HTMLElement
  onOpen(file: ScoreFile): void
  onOpenFolder(): void
  onNewScore(): void
}

export class FileList {
  private listing: FolderListing | undefined
  private active: string | undefined
  private dirty = new Set<string>()

  constructor(private readonly options: FileListOptions) {
    this.render()
  }

  get folder(): FolderListing | undefined {
    return this.listing
  }

  show(listing: FolderListing): void {
    this.listing = listing
    this.render()
  }

  setActive(file: string | undefined): void {
    this.active = file
    for (const element of this.items()) element.classList.toggle('active', element.dataset.file === file)
  }

  setDirty(files: Iterable<string>): void {
    this.dirty = new Set(files)
    for (const element of this.items()) {
      if (this.dirty.has(element.dataset.file ?? '')) element.dataset.dirty = ''
      else delete element.dataset.dirty
    }
  }

  private items(): HTMLElement[] {
    return [...this.options.body.querySelectorAll<HTMLElement>('[data-file]')]
  }

  private render(): void {
    const { body, title } = this.options
    body.replaceChildren()
    body.classList.remove('placeholder')
    title.textContent = this.listing?.name ?? 'Files'
    title.title = this.listing?.folder ?? ''

    if (!this.listing || this.listing.files.length === 0) {
      body.classList.add('placeholder')
      const empty = document.createElement('div')
      empty.className = 'empty'
      const message = document.createElement('p')
      message.textContent = this.listing ? 'This folder has no LilyPond scores yet.' : 'No folder open'
      empty.append(message, button('New Score…', this.options.onNewScore), button('Open Folder…', this.options.onOpenFolder))
      body.append(empty)
      return
    }

    const list = document.createElement('ul')
    list.className = 'file-list'
    list.setAttribute('role', 'tree')
    for (const row of fileRows(this.listing.files)) {
      const item = document.createElement('li')
      item.style.setProperty('--depth', String(row.depth))
      item.textContent = row.name
      if (row.kind === 'directory') {
        item.className = 'directory'
        item.setAttribute('role', 'treeitem')
      } else {
        const { file } = row
        item.className = 'file'
        item.setAttribute('role', 'treeitem')
        item.tabIndex = 0
        item.title = file.path
        item.dataset.file = file.path
        item.dataset.relative = file.relative
        item.addEventListener('click', () => this.options.onOpen(file))
        item.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            this.options.onOpen(file)
          }
        })
      }
      list.append(item)
    }
    body.append(list)
    if (this.listing.truncated) {
      const note = document.createElement('p')
      note.className = 'note'
      note.textContent = 'Only the first 500 scores are listed.'
      body.append(note)
    }
    this.setActive(this.active)
    this.setDirty(this.dirty)
  }
}

export function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = label
  element.addEventListener('click', onClick)
  return element
}
