// `npm run test:smoke` in studio/ (DECISIONS D42): `lily-studio --smoke-test`
// opens the real window on a scratch folder and loads this script into it,
// which drives the page once — layout, Monaco, the file list, highlighting,
// an edit, the unsaved marker, a save, the compile it starts, its pages in
// the preview and a click on a note there, the PDF tab and Export PDF, an
// error marked, an edit by another program reloaded and compiled, its MIDI
// played with the notes marked, and unsaved edits in the preview with live
// preview on — then hands a JSON report to the Rust side, which prints it and
// exits 0 or 1. It starts on the welcome screen, sees LilyPond looked for,
// and reads the error explained (D37). Opening a score engraves it without a
// save, and the preview follows the editor from score to score (D39). The
// sidebar's edge drags wider, and a stand-in for Claude Code answers a chat,
// writes a score that the file list then shows, and continues its session on
// the second message (D40). A selection's context menu explains it with the
// agent, the lines attached (D41).
//
// The Rust side prepares the folder and the stand-in agent, and answers the
// smoke_* commands: files on disk as another program sees them, and the menu.
// Typing goes through the editor's input element, as the keyboard's would.
import { invoke } from '@tauri-apps/api/core'
import type { Command } from '../ipc'

/** The panes of the layout, by `data-pane`, in their order from the left. */
const PANES = ['files', 'editor', 'preview'] as const

interface SmokeFolder {
  folder: string
  score: string
}

const $ = <T extends Element = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const $$ = <T extends Element = HTMLElement>(selector: string): T[] => [...document.querySelectorAll<T>(selector)]
const text = (selector: string): string => ($(selector)?.textContent ?? '').replace(/ /g, ' ')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** On disk, as another program sees it. */
const disk = {
  read: (file: string): Promise<string | null> => invoke('smoke_read', { file }),
  write: (file: string, text: string): Promise<void> => invoke('smoke_write', { file, text }),
  list: (dir: string): Promise<string[]> => invoke('smoke_list', { dir }),
}
/** As the application menu sends it. */
const menu = (command: Command): Promise<void> => invoke('smoke_menu', { command })

/** Monaco's input: an EditContext element, or a textarea without it (WebKit). */
function editorInput(): HTMLElement {
  const input = $('.monaco-editor .native-edit-context, .monaco-editor textarea')
  if (!input) throw new Error('no editor input')
  input.focus()
  return input
}

/** Types `value` at the editor's cursor, as a keyboard or an input method would. */
function type(value: string): void {
  editorInput()
  document.execCommand('insertText', false, value)
}

/** A key with ⌘, sent where the keyboard's would go. */
function command(key: string, keyCode: number): void {
  const target = editorInput()
  for (const kind of ['keydown', 'keyup']) {
    const event = new KeyboardEvent(kind, { key, code: `Key${key.toUpperCase()}`, metaKey: true, bubbles: true, cancelable: true })
    // Monaco reads keyCode, which the constructor cannot set.
    Object.defineProperty(event, 'keyCode', { get: () => keyCode })
    target.dispatchEvent(event)
  }
}

const editorLines = () => text('.monaco-editor .view-lines')
const editorDirty = () => $('[data-pane="editor"]')?.dataset.dirty
const statusMessage = () => text('.status-message')
const compileTone = () => $('.status-compile:not([hidden])')?.dataset.tone
const click = (selector: string) => $(selector)?.click()
/** The distinct notes of the preview that link to a line of `file`, or to it at all. */
const linksTo = (pattern: RegExp) =>
  new Set($$<SVGAElement>('.preview-page a.source').map((a) => a.href.baseVal).filter((href) => pattern.test(href))).size

async function main(): Promise<void> {
  const smoke = await invoke<SmokeFolder>('smoke_folder')
  const problems: string[] = []
  /** Polls `probe` until it returns something truthy. */
  const until = async <T>(what: string, probe: () => T | null | undefined | false | '' | 0, ms = 10_000): Promise<T | undefined> => {
    const started = Date.now()
    while (Date.now() - started < ms) {
      try {
        const value = probe()
        if (value) {
          void invoke('smoke_log', { level: 'info', message: `${what}: ${Date.now() - started} ms` })
          return value
        }
      } catch {
        // Not there yet.
      }
      await sleep(100)
    }
    problems.push(`timed out waiting for ${what}`)
    void invoke('smoke_log', { level: 'warn', message: `timed out waiting for ${what}` })
    return undefined
  }

  const layout = {
    title: document.title,
    panes: PANES.map((name) => {
      const rect = $(`[data-pane="${name}"]`)?.getBoundingClientRect()
      return rect ? { name, left: rect.left, width: rect.width, height: rect.height } : null
    }),
    studio: typeof window.studio === 'object' && window.studio !== null,
  }
  if (!layout.title.endsWith('Lily Studio')) problems.push(`title is ${JSON.stringify(layout.title)}`)
  if (!layout.studio) problems.push('the bridge window.studio is missing')
  let right = -1
  layout.panes.forEach((pane, index) => {
    if (!pane) {
      problems.push(`pane ${PANES[index]} is missing`)
      return
    }
    if (pane.width < 100 || pane.height < 100) problems.push(`pane ${pane.name} is ${pane.width}×${pane.height}`)
    if (pane.left <= right) problems.push(`pane ${pane.name} is not right of the one before`)
    right = pane.left
  })

  // The welcome screen covers the editor until a score opens (D37), and says
  // whether LilyPond was found. A setup opened for a missing LilyPond is closed,
  // so the rest can run and report the compile as skipped.
  const welcome = await until('the welcome screen to look for LilyPond', () => {
    const screen = $('[data-welcome]')
    const lilypond = screen?.querySelector<HTMLElement>('.welcome-lilypond')
    if (!screen || screen.hidden || !lilypond || lilypond.dataset.state === 'checking') return null
    $<HTMLDialogElement>('dialog.setup[open]')?.close()
    return { sample: !!screen.querySelector('[data-action="sample"]'), lilypond: lilypond.textContent, state: lilypond.dataset.state }
  })
  if (welcome && !welcome.sample) problems.push('the welcome screen has no sample button')

  // The file list shows the two LilyPond files and not notes.txt.
  const listed = await until('the file list', () => {
    const files = $$('[data-file]').map((e) => e.dataset.relative)
    return files.length ? files : null
  })
  if (listed && JSON.stringify(listed) !== JSON.stringify(['second.ly', 'smoke.ly', 'parts/melody.ily'])) {
    problems.push(`the file list is ${JSON.stringify(listed)}`)
  }

  // Opening a file shows it in Monaco.
  click('[data-relative="smoke.ly"]')
  const shown = await until('Monaco to show smoke.ly', () => (editorLines().includes('c4 d e f') ? editorLines() : ''))

  // Opening it engraved it, before any save (D39).
  const openedPages = await until('the preview of the score just opened', () => $$('.preview-page svg').length, 30_000)

  // The grammar colours it (Monaco joins neighbouring pieces of one colour into a span).
  const colours = await until('LilyPond highlighting', () => {
    const spans = $$('.monaco-editor .view-lines span span')
    const colour = (text: string) => {
      const span = spans.find((s) => s.textContent?.trim() === text)
      return span && getComputedStyle(span).color
    }
    const found = { brace: colour('{'), string: colour('"2.24.0"'), duration: colour('4') }
    return Object.values(found).every(Boolean) && new Set(Object.values(found)).size === 3 ? found : null
  })

  // Typing marks the file unsaved, in the list and the editor header.
  type('% smoke ')
  await until('the unsaved marker', () => !!$('[data-relative="smoke.ly"][data-dirty]') && editorDirty() === 'true')

  // Save (as the menu does) writes the file and clears the marker.
  await menu('save')
  await until('the marker to clear', () => !$('.file-list [data-dirty]') && editorDirty() === 'false')
  const saved = await disk.read(smoke.score)
  if (!saved?.includes('% smoke ')) problems.push(`the saved file is ${JSON.stringify(saved)}`)

  // The save compiled the score (D31); the status line says how it went.
  const firstTone = await until('the compile status', () => {
    const tone = compileTone()
    return tone && tone !== 'busy' ? tone : ''
  }, 30_000)
  const compile: Record<string, unknown> = { firstTone }
  if (firstTone === 'error' && text('.status-compile').includes('not installed')) {
    compile.skipped = 'lilypond is not installed'
  } else {
    // The preview shows the pages; a click on the note d puts the cursor on its line (D32).
    compile.pages = await until('the preview pages', () => $$('.preview-page svg').length)
    const link = $$<SVGAElement>('.preview-page a.source').find((a) => /smoke\.ly:2:5:/.test(a.href.baseVal))
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    if (!link) problems.push('no link to the note d in the preview')
    compile.revealed = await until('the cursor on the line of the clicked note', () => {
      if (!document.activeElement?.closest('.monaco-editor')) return ''
      const current = $('.monaco-editor .view-overlays .current-line')
      const line = current && $$('.monaco-editor .view-line').find((l) => l.style.top === current.parentElement?.style.top)
      const lineText = (line?.textContent ?? '').replace(/ /g, ' ')
      return lineText.includes('c4 d e f') ? lineText : ''
    })

    // The PDF tab draws the PDF with pdf.js; nothing is written next to the
    // score until Export PDF, which writes smoke.pdf there (D33).
    click('.preview-tabs [data-view="pdf"]')
    compile.pdfPages = await until('the PDF pages', () => {
      const canvas = $<HTMLCanvasElement>('[data-view="pdf"] canvas.pdf-page')
      return canvas && canvas.width > 0 && !$('[data-view="svg"].preview-view')?.offsetParent ? $$('canvas.pdf-page').length : 0
    }, 30_000)
    const before = await disk.list(smoke.folder)
    if (before.some((name) => name.endsWith('.pdf'))) problems.push(`a PDF was written before Export PDF: ${before.join(', ')}`)
    $$('[data-pane="preview"] button').find((b) => b.textContent === 'Export PDF')?.click()
    compile.exported = await until('Export PDF to report', () => (statusMessage().startsWith('Exported') ? statusMessage() : ''), 30_000)
    const pdf = await disk.read(`${smoke.folder}/smoke.pdf`)
    if (!pdf?.startsWith('%PDF-')) problems.push('Export PDF did not write smoke.pdf next to the score')
    click('.preview-tabs [data-view="svg"]')

    // A misspelt command is marked in the editor and turns the status red.
    // On a line of its own: the cursor is still in the `% smoke` comment.
    type('\n\\stacato ')
    await menu('save')
    compile.errorTone = await until('an error status', () => (compileTone() === 'error' ? 'error' : ''), 30_000)
    compile.squiggle = await until('an error marker in the editor', () => !!$('.monaco-editor .squiggly-error'))
    compile.status = text('.status-compile')
    // The banner above the score says it in plain words (D37).
    compile.banner = await until('the problem explained above the score', () => {
      const banner = $('.problem-banner')
      return banner && !banner.hidden && banner.textContent?.includes('is not a LilyPond command') ? banner.textContent : ''
    })
  }

  // Another program edits the saved score: the editor reloads it and the
  // score compiles again (D34). The last save left the editor clean. The new
  // version has a \midi block, which the player plays below.
  const firstCompile = text('.status-compile')
  await disk.write(smoke.score, '\\version "2.24.0"\n\\score { { c4 d e g a b a g } \\layout { } \\midi { } }\n')
  const external: Record<string, unknown> = {}
  external.reloaded = await until('the editor to reload the file changed on disk', () =>
    editorLines().includes('c4 d e g') && editorDirty() === 'false' ? statusMessage() : '',
  )
  if (!compile.skipped) {
    external.compile = await until('the score to compile after the change on disk', () => {
      const status = text('.status-compile')
      return compileTone() === 'ok' && status !== firstCompile ? status : ''
    }, 30_000)

    // Play shows the length; paused a second in, a note is marked and the
    // playhead stands on its page (D35). Stop clears both.
    const playback: Record<string, unknown> = {}
    playback.length = await until('the MIDI to load', () => {
      const play = $<HTMLButtonElement>('.transport-play')
      return play && !play.disabled ? text('.transport-time') : ''
    })
    click('.transport-play')
    playback.playing = await until('the music to play past one second', () => {
      const time = text('.transport-time')
      return $('.transport')?.dataset.state === 'playing' && !time.startsWith('0:00') ? time : ''
    })
    click('.transport-play')
    playback.paused = await until('the notes marked while paused', () => {
      const notes = $$('.preview-page a.playing').length
      const head = $('.preview-page > .playhead')
      return notes > 0 && head && head.offsetHeight > 0 ? { notes, bar: text('.transport-bar') } : null
    })
    click('.transport button[aria-label="Stop"]')
    playback.stopped = await until('the marks to clear on stop', () => !$('.preview-page a.playing, .playhead') && $('.transport')?.dataset.state === 'stopped')
    external.playback = playback
  }
  // With unsaved edits it asks first; the smoke test's answer keeps them.
  type('% mine ')
  await until('the unsaved marker before the second change', () => editorDirty() === 'true')
  await disk.write(smoke.score, '\\version "2.24.0"\n{ c4 d e a }\n')
  external.kept = await until('the unsaved edits to be kept', () => {
    const status = statusMessage()
    return status.includes('changes are kept') && editorLines().includes('% mine') && editorDirty() === 'true' ? status : ''
  })
  compile.external = external

  // Live preview (D36): the unsaved text engraves without a save; switched
  // off, the preview shows the file on disk again. The disk has `{ c4 d e a }`.
  if (!compile.skipped) {
    const live: Record<string, unknown> = {}
    const notes = () => linksTo(/smoke\.ly:2:/)
    live.button = text('.status-live')
    command('a', 65)
    type('\\version "2.24.0"\n{ c4 d e f g a b c }\n')
    live.unsaved = await until('the unsaved notes in the preview', () => (notes() === 8 && editorDirty() === 'true' ? 8 : 0), 30_000)
    const onDisk = await disk.read(smoke.score)
    if (onDisk !== '\\version "2.24.0"\n{ c4 d e a }\n') problems.push(`live preview wrote the file: ${JSON.stringify(onDisk)}`)
    click('.status-live')
    live.off = await until('the saved notes after switching live preview off', () => (notes() === 4 ? 4 : 0), 30_000)
    // Back on, as the switch is remembered.
    click('.status-live')
    live.on = await until('the unsaved notes after switching it on again', () => (notes() === 8 ? 8 : 0), 30_000)
    compile.live = live
  }

  // The preview follows the editor (D39): another score's pages, a note for
  // an include of no score, and back to smoke.ly as it was, unsaved text and all.
  const switching: Record<string, unknown> = {}
  if (!compile.skipped) {
    const smokeLinks = () => linksTo(/\/smoke\.ly:/)
    const secondLinks = () => linksTo(/\/second\.ly:/)
    const before = smokeLinks()
    click('[data-relative="second.ly"]')
    switching.second = await until('the preview of second.ly', () => (secondLinks() > 0 && smokeLinks() === 0 ? secondLinks() : 0), 30_000)
    click('[data-relative="parts/melody.ily"]')
    switching.include = await until('the note for an include of no score', () => {
      const note = text('[data-view="svg"] .pane-body')
      return !$('.preview-page') && note.includes('not part of a score') ? note : ''
    })
    click('[data-relative="smoke.ly"]')
    switching.back = await until('the preview of smoke.ly again', () => (smokeLinks() === before && secondLinks() === 0 ? before : 0), 30_000)
  }

  // The sidebar (D40): its edge dragged 80 px to the right makes it 80 px wider.
  const sidebar: Record<string, unknown> = {}
  const width = () => $('[data-pane="sidebar"]')!.getBoundingClientRect().width
  const handle = $('.splitter-columns')!
  const edge = handle.getBoundingClientRect()
  const pointer = (kind: string, x: number) =>
    handle.dispatchEvent(new PointerEvent(kind, { bubbles: true, clientX: x, clientY: edge.top + 50, button: 0, pointerId: 1 }))
  const widths = { before: width(), after: 0 }
  pointer('pointerdown', edge.left + 3)
  pointer('pointermove', edge.left + 83)
  pointer('pointerup', edge.left + 83)
  widths.after = width()
  sidebar.width = widths
  if (Math.round(widths.after - widths.before) !== 80) problems.push(`dragging the sidebar's edge by 80 px changed its width from ${widths.before} to ${widths.after}`)

  // Agent setup finds the stand-in; Agent chats sends it a message. Its answer
  // and what it did appear, agent.ly joins the file list, and a second message
  // continues the same session.
  click('[data-fold="setup"] .fold-header button')
  sidebar.setup = await until('Agent setup to find the stand-in agent', () => {
    const card = $('.agent-card[data-agent="claude"]')
    return card && card.dataset.state === 'ready' && card.textContent?.includes('9.9.9') ? text('.agent-card[data-agent="claude"] .agent-card-state') : ''
  }, 20_000)
  click('[data-fold="chats"] .fold-header button')
  const send = (message: string) => {
    $<HTMLTextAreaElement>('.chat-composer textarea')!.value = message
    click('.chat-composer button')
  }
  const answer = (resumed: string) => () => {
    const log = $('.chat-log')
    const said = [...(log?.querySelectorAll('.chat-entry.agent') ?? [])].map((e) => e.textContent).join('|')
    return said.includes(`(resumed: ${resumed})`) && !log?.querySelector('.chat-working:not([hidden])') ? said : ''
  }
  await until('the agent to be ready in the chat', () => $<HTMLSelectElement>('.chat-toolbar select')?.value === 'claude' && !$<HTMLTextAreaElement>('.chat-composer textarea')?.disabled)
  send('Write a new score')
  sidebar.answer = await until('the agent to answer', answer('no'), 20_000)
  sidebar.tool = $$('.chat-entry.tool').map((e) => e.textContent).join('|')
  if (sidebar.tool !== 'Wrote agent.ly') problems.push(`the chat shows the agent did ${JSON.stringify(sidebar.tool)}`)
  sidebar.listed = await until('agent.ly in the file list', () => !!$('[data-relative="agent.ly"]'))
  send('And again')
  sidebar.resumed = await until('the second answer in the same session', answer('yes'), 20_000)

  // A selection in the editor: the message box says it goes along, and the
  // context menu's Explain sends it to the agent in the open chat (D41).
  command('a', 65)
  sidebar.attached = await until('the selection named above the message box', () => {
    const context = text('.chat-context')
    return /^With lines 1–\d+ of smoke\.ly$/.test(context) ? context : ''
  })
  /** Elements matching `selector` in the page and in every shadow root. */
  const deep = (root: ParentNode, selector: string): Element[] => [
    ...root.querySelectorAll(selector),
    ...[...root.querySelectorAll('*')].flatMap((e) => (e.shadowRoot ? deep(e.shadowRoot, selector) : [])),
  ]
  const lines = $('.monaco-editor .view-lines')!
  const box = lines.getBoundingClientRect()
  lines.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 8, button: 2 }))
  sidebar.menu = await until('the agent items in the context menu', () => {
    const labels = deep(document, '.action-label').map((e) => e.textContent?.trim() ?? '').filter((t) => t.includes('Agent') || t.includes('Selection'))
    return labels.length === 3 ? labels : null
  })
  // Monaco's menu takes a mouse-up only a moment after it opens, against stray clicks.
  await sleep(500)
  deep(document, '.action-label')
    .find((e) => e.textContent?.trim() === 'Explain Selection with Agent')
    ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
  sidebar.explained = await until('the selection explained in the open chat', () => {
    const users = $$('.chat-log .chat-entry.user').map((e) => e.textContent ?? '')
    const answers = $$('.chat-log .chat-entry.agent').map((e) => e.textContent ?? '')
    return users.length === 3 && users[2].startsWith('Explain what the selected lines do') && answers.length === 3 && answers[2].includes('with a selection') ? answers[2] : ''
  }, 20_000)

  const ok = problems.length === 0
  const report = { ok, problems, ...layout, welcome, listed, openedPages, switching, monaco: !!shown, colours, saved, compile, sidebar }
  await invoke('smoke_done', { ok, report: JSON.stringify(report, null, 2) })
}

main().catch((error: unknown) => {
  const report = JSON.stringify({ ok: false, problems: [`the smoke test threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`] }, null, 2)
  void invoke('smoke_done', { ok: false, report })
})
