// How bridge.ts reaches the Rust side on the web (DECISIONS D55):
// `node esbuild.mjs --site` bundles this module in place of
// src/renderer/transport.ts. Calls go over the socket to the user's worker
// (connection.ts); the commands the app answers with a native panel or
// alert ask with the page's own dialogs first (dialogs.ts), then pass the
// worker what was chosen. A file the app writes for the user — a PDF, a MIDI
// file — is downloaded too. The menu bar takes the app menu's place.
import type { ExportedMidi, MutedPart, Opened, RecentList, Transport } from '../ipc'
import { Connection } from './connection'
import { ask, Browser, type Listing, leaveOutLabel } from './dialogs'
import { MenuBar } from './menubar'
import './web.css'

type Args = Record<string, unknown>

const connection = new Connection()
const call = <T>(command: string, args?: Args) => connection.call<T>(command, args)
const browser = new Browser(
  (dir) => call<Listing>('browse', dir ? { dir } : {}),
  (parent, name) => call<string>('create_folder', { parent, name }),
)

/** The folder the page shows; given again to a worker that does not have it (D55). */
let folder: string | undefined
let live: boolean | undefined
let dirty = false
let emit: (event: unknown) => void = () => {}

function remember<T>(result: T): T {
  const opened = result as Partial<Opened> | null
  if (opened?.listing?.folder) folder = opened.listing.folder
  return result
}

const name = (path: string) => path.split('/').pop() ?? path

function bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const data = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i)
  return data
}

function base64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Hands a file to the browser to save, as a download. */
function save(file: { name: string; data: string }): void {
  const type = file.name.endsWith('.pdf') ? 'application/pdf' : file.name.match(/\.midi?$/) ? 'audio/midi' : 'text/plain'
  const url = URL.createObjectURL(new Blob([bytes(file.data)], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Replaces a file only when the user says so. */
async function confirmReplace(file: string): Promise<boolean> {
  const answer = await ask({
    title: `Replace “${file}”?`,
    text: 'A file with that name is already in the folder. Replacing it overwrites what it holds.',
    buttons: ['Cancel', 'Replace'],
  })
  return answer?.button === 1
}

/** The app's panels and alerts, asked on the page. */
const dialogs: Record<string, (args: Args) => Promise<unknown>> = {
  open_folder: async () => {
    const chosen = await browser.chooseFolder({ title: 'Open Folder', prompt: 'Open', start: folder })
    return chosen ? remember(await call<Opened>('open_folder', { path: chosen })) : null
  },
  open_file: async () => {
    const chosen = await browser.chooseScore({ title: 'Open Score', prompt: 'Open', start: folder })
    return chosen ? remember(await call<Opened>('open_file', { path: chosen })) : null
  },
  new_score: async ({ template }) => {
    let start = folder
    let suggested = 'Untitled.ly'
    for (;;) {
      const chosen = await browser.saveAs({ title: 'New Score', prompt: 'Create', start, name: suggested })
      if (!chosen) return null
      const created = await call<Opened | { exists: true }>('new_score', { template, path: chosen })
      if (!('exists' in created)) return remember(created)
      const file = name(chosen).match(/\.(ly|ily|lyi)$/i) ? name(chosen) : `${name(chosen)}.ly`
      if (await confirmReplace(file)) return remember(await call<Opened>('new_score', { template, path: chosen, replace: true }))
      start = chosen.slice(0, chosen.lastIndexOf('/'))
      suggested = name(chosen)
    }
  },
  confirm_reload: async ({ file }) => {
    const answer = await ask({
      title: `${name(String(file))} was changed on the server.`,
      text: 'Reload it and lose the changes you have not saved, or keep your changes? Saving them will replace the other version.',
      buttons: ['Keep My Changes', 'Reload'],
    })
    return answer?.button === 1
  },
  // The server's LilyPond is its operator's; agents are the app's.
  choose_lilypond: async () => null,
  choose_agent: async () => null,
  open_link: async ({ link }) => {
    window.open(await call<string>('open_link', { link }), '_blank', 'noopener,noreferrer')
  },
  export_pdf: async ({ rootFile }) => {
    const written = await call<string[]>('export_pdf', { rootFile })
    for (const file of written) save(await call('download', { file }))
    return written
  },
  export_midi: async ({ rootFile, midi, muted }) => {
    const parts = muted as MutedPart[]
    let leaveOut = false
    if (parts.length > 0) {
      const answer = await ask({
        title: 'Export MIDI',
        text: `${name(String(rootFile)).replace(/\.\w+$/, '')}.mid is saved in your downloads.`,
        buttons: ['Export', 'Cancel'],
        checkbox: { label: leaveOutLabel(parts.map((part) => part.name)), checked: true },
      })
      if (answer?.button !== 0) return null
      leaveOut = answer.checked
    }
    const exported = await call<{ name: string; data: string; leftOut: number }>('export_midi', { rootFile, midi, muted, leaveOut })
    save(exported)
    return { file: exported.name, leftOut: exported.leftOut } satisfies ExportedMidi
  },
}

/** Calls that change what the worker has open, kept for a worker that comes back without it. */
const REMEMBERED = new Set(['open_sample', 'open_recent'])

const menuBar = new MenuBar({
  command: (command) => emit({ type: 'command', command }),
  openRecent: (path) => emit({ type: 'openRecent', path }),
  recentList: () => call<RecentList>('recent_list'),
  clearRecent: () => void call('clear_recent').catch(console.error),
  learn: () => void dialogs.open_link({ link: 'learn' }).catch(console.error),
})

// A worker that comes back — restarted, or used by another tab — gets the
// folder and the live preview switch of this page first (D55).
connection.onHello = async (hello, again) => {
  menuBar.setUser(hello.user)
  if (!again) return
  if (live !== undefined) await connection.callFirst('set_live', { on: live })
  if (folder) await connection.callFirst('open_folder', { path: folder })
}

// Unsaved changes: the browser asks before the tab closes.
window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault()
})

export const transport: Transport = {
  hosted: true,
  call: async <T>(command: string, args: Args = {}): Promise<T> => {
    const dialog = dialogs[command]
    if (dialog) return (await dialog(args)) as T
    const result = await call<T>(command, args)
    if (REMEMBERED.has(command)) remember(result)
    if (command === 'list_folder' && result) folder = (result as unknown as { folder: string }).folder
    return result
  },
  send: (command, args = {}) => {
    if (command === 'set_dirty') {
      dirty = Boolean(args.dirty)
      return
    }
    if (command === 'set_live') live = Boolean(args.on)
    call(command, args).catch((error: unknown) => console.error(`${command}:`, error))
  },
  subscribe: (onEvent) => {
    emit = onEvent
    connection.onEvent = onEvent
    return connection.ready()
  },
  upload: async (into) => {
    const files = await pickFiles()
    if (files.length === 0) return undefined
    let written: string[] = []
    let dir = into
    for (const file of files) {
      const data = base64(new Uint8Array(await file.arrayBuffer()))
      let answer = await call<{ path: string } | { exists: true }>('upload', { dir, name: file.name, data })
      if ('exists' in answer) {
        if (!(await confirmReplace(file.name))) continue
        answer = await call<{ path: string }>('upload', { dir, name: file.name, data, replace: true })
      }
      if ('path' in answer) written = [...written, answer.path]
    }
    if (written.length === 0) return undefined
    dir = written[0].slice(0, written[0].lastIndexOf('/'))
    // One score is opened; several show in their folder.
    const opened =
      written.length === 1 ? await call<Opened>('open_file', { path: written[0] }) : await call<Opened>('open_folder', { path: dir })
    return remember(opened)
  },
  download: async (file) => save(await call('download', { file })),
}

/** The scores the user picks in the browser's own file panel. */
function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.ly,.ily,.lyi'
    input.addEventListener('change', () => resolve([...(input.files ?? [])]))
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}
