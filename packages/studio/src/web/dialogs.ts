// The web's dialogs (DECISIONS D55), in place of the app's AppKit panels
// (src-tauri/src/dialogs.rs): a browser of the user's scores that opens a
// score or a folder or names a new score, a question with buttons and an
// optional checkbox, and a name to type. They show the workspace as
// "My Scores"; its path on the server is never shown.
import { button } from '../renderer/files'

export interface Entry {
  name: string
  path: string
}

/** A folder of the workspace, as the worker's `browse` lists it. */
export interface Listing {
  root: string
  dir: string
  parent?: string
  folders: Entry[]
  files: Entry[]
  truncated: boolean
}

export type Browse = (dir: string | undefined) => Promise<Listing>
export type MakeFolder = (parent: string, name: string) => Promise<string>

type Mode = 'score' | 'folder' | 'save'

export interface BrowseOptions {
  title: string
  /** The default button. */
  prompt: string
  /** The folder it opens in; the workspace when not given. */
  start?: string
  /** For a new file: the name it suggests. */
  name?: string
}

export interface Question {
  title: string
  text?: string
  /** The first is the default. */
  buttons: string[]
  checkbox?: { label: string; checked: boolean }
}

const SVG = 'http://www.w3.org/2000/svg'
const ICONS = {
  folder: 'M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z',
  file: 'M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3',
}

function icon(kind: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', ICONS[kind])
  svg.append(path)
  return svg
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A modal <dialog> that resolves once, removed when it closes. */
function modal<T>(className: string, build: (dialog: HTMLDialogElement, done: (value: T | undefined) => void) => void): Promise<T | undefined> {
  return new Promise((resolve) => {
    const dialog = element('dialog', `web-dialog ${className}`)
    let settled = false
    const done = (value: T | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
      dialog.close()
    }
    dialog.addEventListener('close', () => {
      dialog.remove()
      if (!settled) {
        settled = true
        resolve(undefined)
      }
    })
    build(dialog, done)
    document.body.append(dialog)
    dialog.showModal()
  })
}

/** Asks a question; the index of the button and the checkbox, or undefined on Escape. */
export function ask(question: Question): Promise<{ button: number; checked: boolean } | undefined> {
  return modal('web-question', (dialog, done) => {
    const title = element('h2', undefined, question.title)
    dialog.append(title)
    if (question.text) dialog.append(element('p', undefined, question.text))
    let checkbox: HTMLInputElement | undefined
    if (question.checkbox) {
      const label = element('label', 'web-checkbox')
      checkbox = element('input')
      checkbox.type = 'checkbox'
      checkbox.checked = question.checkbox.checked
      label.append(checkbox, question.checkbox.label)
      dialog.append(label)
    }
    const buttons = element('div', 'web-dialog-buttons')
    // The default last, where a Mac puts it; the first given.
    question.buttons.forEach((label, index) => {
      const choice = button(label, () => done({ button: index, checked: checkbox?.checked ?? false }))
      if (index === 0) choice.className = 'primary'
      buttons.prepend(choice)
    })
    dialog.append(buttons)
    queueMicrotask(() => buttons.querySelector<HTMLButtonElement>('.primary')?.focus())
  })
}

/** Asks for a name; undefined when cancelled. */
export function askName(title: string, label: string, value: string, prompt: string): Promise<string | undefined> {
  return modal('web-name', (dialog, done) => {
    const form = element('form')
    form.method = 'dialog'
    const field = element('label', 'web-field')
    const input = element('input')
    input.value = value
    input.required = true
    field.append(label, input)
    const buttons = element('div', 'web-dialog-buttons')
    const cancel = button('Cancel', () => done(undefined))
    const ok = element('button', 'primary', prompt)
    ok.type = 'submit'
    buttons.append(cancel, ok)
    form.append(element('h2', undefined, title), field, buttons)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const name = input.value.trim()
      if (name) done(name)
    })
    dialog.append(form)
    queueMicrotask(() => input.select())
  })
}

/**
 * The browser of the workspace. `score`: a score to open. `folder`: a
 * folder to open, the one shown or one selected. `save`: a folder and a
 * name typed, for a new score.
 */
export class Browser {
  constructor(
    private readonly browse: Browse,
    private readonly makeFolder: MakeFolder,
  ) {}

  chooseScore(options: BrowseOptions): Promise<string | undefined> {
    return this.open('score', options)
  }

  chooseFolder(options: BrowseOptions): Promise<string | undefined> {
    return this.open('folder', options)
  }

  /** The path of the new file: the folder shown and the name typed. */
  saveAs(options: BrowseOptions): Promise<string | undefined> {
    return this.open('save', options)
  }

  private open(mode: Mode, options: BrowseOptions): Promise<string | undefined> {
    return modal<string>('web-browser', (dialog, done) => {
      const crumbs = element('nav', 'web-crumbs')
      crumbs.setAttribute('aria-label', 'Folder')
      const list = element('ul', 'web-list')
      list.setAttribute('role', 'listbox')
      list.tabIndex = 0
      const message = element('p', 'web-message')
      message.hidden = true
      const nameField = element('label', 'web-field')
      const nameInput = element('input')
      nameInput.value = options.name ?? ''
      nameField.append('Name', nameInput)
      nameField.hidden = mode !== 'save'

      let listing: Listing | undefined
      let selected: Entry & { kind: 'folder' | 'file' } | undefined
      const chooseButton = element('button', 'primary', options.prompt)
      chooseButton.type = 'button'

      const report = (error: unknown) => {
        message.textContent = error instanceof Error ? error.message : String(error)
        message.hidden = false
      }
      const refreshButton = () => {
        chooseButton.disabled =
          (mode === 'score' && selected?.kind !== 'file' && selected?.kind !== 'folder') || (mode === 'save' && !nameInput.value.trim())
      }
      const choose = () => {
        if (!listing) return
        if (mode === 'score') {
          if (selected?.kind === 'folder') return void show(selected.path)
          if (selected?.kind === 'file') done(selected.path)
        } else if (mode === 'folder') {
          done(selected?.kind === 'folder' ? selected.path : listing.dir)
        } else {
          const name = nameInput.value.trim()
          if (name) done(`${listing.dir}/${name}`)
        }
      }

      const row = (entry: Entry, kind: 'folder' | 'file') => {
        const item = element('li')
        item.setAttribute('role', 'option')
        item.dataset.kind = kind
        // Files only show where they are when a folder is chosen or a name typed.
        const inert = kind === 'file' && mode !== 'score'
        if (inert) item.setAttribute('aria-disabled', 'true')
        item.append(icon(kind), element('span', undefined, entry.name))
        item.addEventListener('click', () => {
          if (inert) {
            if (mode === 'save') {
              nameInput.value = entry.name
              refreshButton()
            }
            return
          }
          for (const other of list.querySelectorAll('[aria-selected]')) other.removeAttribute('aria-selected')
          item.setAttribute('aria-selected', 'true')
          selected = { ...entry, kind }
          refreshButton()
        })
        item.addEventListener('dblclick', () => {
          if (kind === 'folder') void show(entry.path)
          else if (!inert) done(entry.path)
        })
        return item
      }

      const show = async (dir: string | undefined) => {
        message.hidden = true
        try {
          listing = await this.browse(dir)
        } catch (error) {
          return report(error)
        }
        selected = undefined
        const shown = listing
        const parts = shown.dir === shown.root ? [] : shown.dir.slice(shown.root.length + 1).split('/')
        const crumbButtons = [button('My Scores', () => void show(shown.root))]
        parts.forEach((part, index) => {
          const path = `${shown.root}/${parts.slice(0, index + 1).join('/')}`
          crumbButtons.push(button(part, () => void show(path)))
        })
        crumbButtons.at(-1)!.setAttribute('aria-current', 'location')
        crumbs.replaceChildren(...crumbButtons.flatMap((crumb, index) => (index ? [element('span', 'web-crumb-gap', '›'), crumb] : [crumb])))
        const rows = [...shown.folders.map((entry) => row(entry, 'folder')), ...shown.files.map((entry) => row(entry, 'file'))]
        if (rows.length === 0) rows.push(element('li', 'web-empty', mode === 'score' ? 'No scores in this folder' : 'This folder is empty'))
        if (shown.truncated) rows.push(element('li', 'web-empty', 'Not everything is listed: the folder has too many files.'))
        list.replaceChildren(...rows)
        refreshButton()
      }

      const newFolder = button('New Folder…', () => {
        const current = listing
        if (!current) return
        void askName('New Folder', 'Name', 'untitled folder', 'Create').then(async (name) => {
          if (!name) return
          try {
            await show(await this.makeFolder(current.dir, name))
          } catch (error) {
            report(error)
          }
        })
      })
      newFolder.className = 'web-new-folder'
      const cancel = button('Cancel', () => done(undefined))
      chooseButton.addEventListener('click', choose)
      nameInput.addEventListener('input', refreshButton)
      nameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') choose()
      })
      list.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') choose()
        if (event.key === 'Backspace' && listing?.parent) void show(listing.parent)
      })
      const buttons = element('div', 'web-dialog-buttons')
      buttons.append(newFolder, cancel, chooseButton)
      dialog.append(element('h2', undefined, options.title), crumbs, list, nameField, message, buttons)
      void show(options.start).then(() => (mode === 'save' ? nameInput.select() : list.focus()))
    })
  }
}

/**
 * Export MIDI's checkbox (D54): "Leave out the muted part Tenor", or the
 * parts counted when there are more than a few. As midi_export.rs's
 * `checkbox_title`, which the app's save panel shows.
 */
export function leaveOutLabel(names: string[]): string {
  if (names.length === 1) return `Leave out the muted part ${names[0]}`
  if (names.length <= 3) return `Leave out the muted parts ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `Leave out the ${names.length} muted parts`
}
