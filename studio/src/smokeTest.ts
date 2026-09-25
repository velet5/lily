// `npm test` in studio/: starts the real window hidden on a scratch folder and
// drives it once — layout, Monaco, the file list, highlighting, an edit, the
// unsaved marker, a save, the compile it starts, its pages in the preview
// and a click on a note there, the PDF tab and Export PDF, an error marked,
// an edit by another program reloaded and compiled, and its MIDI played with
// the notes marked —
// then prints a JSON report and exits 0 or 1.
import type { BrowserWindow } from 'electron'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Channel } from './ipc'

/** The panes of the layout, by `data-pane`, in their order from the left. */
const PANES = ['files', 'editor', 'preview'] as const

export interface SmokeFolder {
  folder: string
  score: string
}

export async function prepareSmokeTest(): Promise<SmokeFolder> {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-smoke-'))
  const score = path.join(folder, 'smoke.ly')
  await fs.writeFile(score, '\\version "2.24.0"\n{ c4 d e f }\n')
  await fs.mkdir(path.join(folder, 'parts'))
  await fs.writeFile(path.join(folder, 'parts', 'melody.ily'), 'melody = { g1 }\n')
  await fs.writeFile(path.join(folder, 'notes.txt'), 'not a score\n')
  return { folder, score }
}

export async function runSmokeTest(window: BrowserWindow, smoke: SmokeFolder): Promise<number> {
  const problems: string[] = []
  const run = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script) as Promise<T>
  /** Polls `script` in the renderer until it returns something truthy. */
  const until = async <T>(what: string, script: string, ms = 10_000): Promise<T | undefined> => {
    const started = Date.now()
    while (Date.now() - started < ms) {
      const value = await run<T>(script)
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    problems.push(`timed out waiting for ${what}`)
    return undefined
  }

  const layout = await run<{
    title: string
    panes: ({ name: string; left: number; width: number; height: number } | null)[]
    studio: boolean
  }>(`(() => {
    const panes = ${JSON.stringify(PANES)}.map((name) => {
      const element = document.querySelector('[data-pane="' + name + '"]')
      const rect = element && element.getBoundingClientRect()
      return rect && { name, left: rect.left, width: rect.width, height: rect.height }
    })
    return { title: document.title, panes, studio: typeof window.studio === 'object' && window.studio !== null }
  })()`)
  if (!layout.title.endsWith('Lily Studio')) problems.push(`title is ${JSON.stringify(layout.title)}`)
  if (!layout.studio) problems.push('the preload API window.studio is missing')
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

  // The file list shows the two LilyPond files and not notes.txt.
  const listed = await until<string[]>(
    'the file list',
    `(() => { const f = [...document.querySelectorAll('[data-file]')].map((e) => e.dataset.relative); return f.length ? f : null })()`,
  )
  if (listed && JSON.stringify(listed) !== JSON.stringify(['smoke.ly', 'parts/melody.ily'])) {
    problems.push(`the file list is ${JSON.stringify(listed)}`)
  }

  // Opening a file shows it in Monaco.
  await run(`document.querySelector('[data-relative="smoke.ly"]').click()`)
  const shown = await until<string>(
    'Monaco to show smoke.ly',
    `(() => { const t = (document.querySelector('.monaco-editor .view-lines')?.textContent ?? '').replace(/\u00a0/g, ' '); return t.includes('c4 d e f') ? t : '' })()`,
  )

  // The grammar colours it (Monaco joins neighbouring pieces of one colour into a span).
  const colours = await until<Record<string, string>>(
    'LilyPond highlighting',
    `(() => {
      const spans = [...document.querySelectorAll('.monaco-editor .view-lines span span')]
      const colour = (text) => { const s = spans.find((span) => span.textContent.trim() === text); return s && getComputedStyle(s).color }
      const found = { brace: colour('{'), string: colour('"2.24.0"'), duration: colour('4') }
      return Object.values(found).every(Boolean) && new Set(Object.values(found)).size === 3 ? found : null
    })()`,
  )

  // Typing marks the file unsaved, in the list and the editor header.
  // Monaco takes input through an EditContext element, or a textarea without it.
  window.webContents.focus()
  await run(`document.querySelector('.monaco-editor .native-edit-context, .monaco-editor textarea').focus()`)
  window.webContents.insertText('% smoke ')
  await until('the unsaved marker', `!!document.querySelector('[data-relative="smoke.ly"][data-dirty]') && document.querySelector('[data-pane="editor"]').dataset.dirty === 'true'`)

  // Save (as the menu does) writes the file and clears the marker.
  window.webContents.send(Channel.command, 'save')
  await until('the marker to clear', `!document.querySelector('.file-list [data-dirty]') && document.querySelector('[data-pane="editor"]').dataset.dirty === 'false'`)
  const saved = await fs.readFile(smoke.score, 'utf8')
  if (!saved.includes('% smoke ')) problems.push(`the saved file is ${JSON.stringify(saved)}`)

  // The save compiled the score (D31); the status line says how it went.
  const tone = `document.querySelector('.status-compile:not([hidden])')?.dataset.tone`
  const firstTone = await until<string>('the compile status', `(() => { const t = ${tone}; return t && t !== 'busy' ? t : '' })()`, 30_000)
  const compile: Record<string, unknown> = { firstTone }
  if (firstTone === 'error' && (await run<string>(`document.querySelector('.status-compile').textContent`)).includes('not installed')) {
    compile.skipped = 'lilypond is not installed'
  } else {
    // The preview shows the pages; a click on the note d puts the cursor on its line (D32).
    compile.pages = await until<number>('the preview pages', `document.querySelectorAll('.preview-page svg').length`)
    const clicked = await run<boolean>(`(() => {
      const link = [...document.querySelectorAll('.preview-page a.source')].find((a) => /smoke\\.ly:2:5:/.test(a.href.baseVal))
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return !!link
    })()`)
    if (!clicked) problems.push('no link to the note d in the preview')
    compile.revealed = await until<string>('the cursor on the line of the clicked note', `(() => {
      if (!document.activeElement?.closest('.monaco-editor')) return ''
      const current = document.querySelector('.monaco-editor .view-overlays .current-line')
      const line = current && [...document.querySelectorAll('.monaco-editor .view-line')].find((l) => l.style.top === current.parentElement.style.top)
      const text = (line?.textContent ?? '').replace(/\\u00a0/g, ' ')
      return text.includes('c4 d e f') ? text : ''
    })()`)

    // The PDF tab draws the PDF with pdf.js; nothing is written next to the
    // score until Export PDF, which writes smoke.pdf there (D33).
    await run(`document.querySelector('.preview-tabs [data-view="pdf"]').click()`)
    compile.pdfPages = await until<number>('the PDF pages', `(() => {
      const canvas = document.querySelector('[data-view="pdf"] canvas.pdf-page')
      return canvas && canvas.width > 0 && !document.querySelector('[data-view="svg"].preview-view').offsetParent ? document.querySelectorAll('canvas.pdf-page').length : 0
    })()`, 30_000)
    const before = await fs.readdir(smoke.folder)
    if (before.some((name) => name.endsWith('.pdf'))) problems.push(`a PDF was written before Export PDF: ${before.join(', ')}`)
    await run(`[...document.querySelectorAll('[data-pane="preview"] button')].find((b) => b.textContent === 'Export PDF').click()`)
    compile.exported = await until<string>('Export PDF to report', `(() => { const t = document.querySelector('.status-message').textContent; return t.startsWith('Exported') ? t : '' })()`, 30_000)
    const pdf = await fs.readFile(path.join(smoke.folder, 'smoke.pdf')).catch(() => undefined)
    if (pdf?.subarray(0, 5).toString() !== '%PDF-') problems.push('Export PDF did not write smoke.pdf next to the score')
    await run(`document.querySelector('.preview-tabs [data-view="svg"]').click()`)

    // A misspelt command is marked in the editor and turns the status red.
    await run(`document.querySelector('.monaco-editor .native-edit-context, .monaco-editor textarea').focus()`)
    // On a line of its own: the cursor is still in the `% smoke` comment.
    window.webContents.insertText('\n\\stacato ')
    window.webContents.send(Channel.command, 'save')
    compile.errorTone = await until<string>('an error status', `(() => { const t = ${tone}; return t === 'error' ? t : '' })()`, 30_000)
    compile.squiggle = await until<boolean>('an error marker in the editor', `!!document.querySelector('.monaco-editor .squiggly-error')`)
    compile.status = await run<string>(`document.querySelector('.status-compile').textContent`)
  }

  // Another program edits the saved score: the editor reloads it and the
  // score compiles again (D34). The last save left the editor clean. The new
  // version has a \midi block, which the player plays below.
  const firstCompile = await run<string>(`document.querySelector('.status-compile').textContent`)
  await fs.writeFile(smoke.score, '\\version "2.24.0"\n\\score { { c4 d e g a b a g } \\layout { } \\midi { } }\n')
  const external: Record<string, unknown> = {}
  external.reloaded = await until<string>(
    'the editor to reload the file changed on disk',
    `(() => { const t = (document.querySelector('.monaco-editor .view-lines')?.textContent ?? '').replace(/\u00a0/g, ' '); return t.includes('c4 d e g') && document.querySelector('[data-pane="editor"]').dataset.dirty === 'false' ? document.querySelector('.status-message').textContent : '' })()`,
  )
  if (!compile.skipped) {
    external.compile = await until<string>(
      'the score to compile after the change on disk',
      `(() => { const t = ${tone}; const s = document.querySelector('.status-compile').textContent; return t === 'ok' && s !== ${JSON.stringify(firstCompile)} ? s : '' })()`,
      30_000,
    )

    // Play shows the length; paused a second in, a note is marked and the
    // playhead stands on its page (D35). Stop clears both. A hidden window
    // draws no animation frames, but a pause draws once.
    const playback: Record<string, unknown> = {}
    playback.length = await until<string>('the MIDI to load', `(() => { const b = document.querySelector('.transport-play'); return b && !b.disabled ? document.querySelector('.transport-time').textContent : '' })()`)
    await run(`document.querySelector('.transport-play').click()`)
    playback.playing = await until<string>('the music to play past one second', `(() => { const t = document.querySelector('.transport-time').textContent; return document.querySelector('.transport').dataset.state === 'playing' && !t.startsWith('0:00') ? t : '' })()`)
    await run(`document.querySelector('.transport-play').click()`)
    playback.paused = await until<{ notes: number; bar: string }>('the notes marked while paused', `(() => {
      const notes = document.querySelectorAll('.preview-page a.playing').length
      const head = document.querySelector('.preview-page > .playhead')
      return notes > 0 && head && head.offsetHeight > 0 ? { notes, bar: document.querySelector('.transport-bar').textContent } : null
    })()`)
    await run(`document.querySelector('.transport button[aria-label="Stop"]').click()`)
    playback.stopped = await until<boolean>('the marks to clear on stop', `!document.querySelector('.preview-page a.playing, .playhead') && document.querySelector('.transport').dataset.state === 'stopped'`)
    external.playback = playback
  }
  // With unsaved edits it asks first; the smoke test's answer keeps them.
  await run(`document.querySelector('.monaco-editor .native-edit-context, .monaco-editor textarea').focus()`)
  window.webContents.insertText('% mine ')
  await until('the unsaved marker before the second change', `document.querySelector('[data-pane="editor"]').dataset.dirty === 'true'`)
  await fs.writeFile(smoke.score, '\\version "2.24.0"\n{ c4 d e a }\n')
  external.kept = await until<string>(
    'the unsaved edits to be kept',
    `(() => { const s = document.querySelector('.status-message').textContent; const t = (document.querySelector('.monaco-editor .view-lines')?.textContent ?? '').replace(/\u00a0/g, ' '); return s.includes('changes are kept') && t.includes('% mine') && document.querySelector('[data-pane="editor"]').dataset.dirty === 'true' ? s : '' })()`,
  )
  compile.external = external

  await fs.rm(smoke.folder, { recursive: true, force: true })
  const ok = problems.length === 0
  console.log(JSON.stringify({ ok, problems, ...layout, listed, monaco: !!shown, colours, saved, compile }, null, 2))
  return ok ? 0 : 1
}
