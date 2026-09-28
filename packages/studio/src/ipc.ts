// What the renderer and Lily Studio's Rust side exchange (DECISIONS D28, D42):
// the types of src/renderer/bridge.ts's calls and events, as the Rust side
// serializes them (crates/engrave, crates/agents). Types only.
import type { LyDiagnostic, PlaybackTiming, SourceLocation } from '@lily/common/types'

/** The scores File › New starts from (crates/engrave/src/templates.rs). */
export type TemplateId = 'melody' | 'song' | 'piano'

export interface ScoreFile {
  /** Absolute path. */
  path: string
  /** Relative to the folder, with `/` as separator, for display and sorting. */
  relative: string
}

/** The LilyPond files of the open folder (D29). */
export interface FolderListing {
  folder: string
  name: string
  files: ScoreFile[]
  /** True when the list was cut short at 500 files. */
  truncated: boolean
}

/** A folder was opened, or a file whose folder becomes the open folder. */
export interface Opened {
  listing: FolderListing
  /** The file to show in the editor, if one was chosen. */
  file?: string
}

/** Commands sent from the application menu to the renderer. */
export type Command = 'new-score' | 'open-file' | 'open-folder' | 'save' | 'save-all' | 'welcome' | 'setup-lilypond'

/**
 * How a compile ended (D31). `no-root`: a saved include that no score in the
 * folder includes, so nothing ran. `no-lilypond` and `error`: lilypond did not
 * run, and `message` says why.
 */
export type CompileState = 'ok' | 'failed' | 'no-root' | 'no-lilypond' | 'error'

export interface CompileOutcome {
  state: CompileState
  /** The score that was compiled; for `no-root`, the saved file. */
  rootFile: string
  /** As src/diagnostics/parse.ts has them: absolute files, 1-based lines and columns. */
  diagnostics: LyDiagnostic[]
  errorCount: number
  warningCount: number
  /** SVG pages of the run, in order; valid until the next compile of `rootFile`. */
  pages: string[]
  /** The text of `pages`, read before the event was sent; the preview shows it (D32). */
  svg: string[]
  midi: string[]
  /** The bytes of the first of `midi`, read with the pages: the music the preview plays (D35). */
  midiData?: Uint8Array
  /** Where the notes of `midiData` are on the pages (D26), when the map was written. */
  timing?: PlaybackTiming
  durationMs: number
  /** Why lilypond did not run, or the end of its output when it failed without a parsable error. */
  message?: string
}

/**
 * A score's PDF for the PDF tab (D33). `failed`: lilypond reported errors, and
 * `files` holds whatever it still wrote. `no-lilypond` and `error`: it did not
 * run, and `message` says why.
 */
export interface PdfOutcome {
  state: 'ok' | 'failed' | 'no-lilypond' | 'error'
  rootFile: string
  /** The PDFs lilypond wrote, one per book, named as it names them. */
  files: { name: string; data: Uint8Array }[]
  errorCount: number
  durationMs: number
  message?: string
}

export type CompileEvent =
  | { kind: 'started'; rootFile: string }
  | { kind: 'finished'; outcome: CompileOutcome }

/** A file another program changed (D34). */
export interface FileChange {
  /** The path the editor opened it under, else its canonical path. */
  file: string
  /** False when the file is gone. */
  exists: boolean
}

/**
 * What the welcome screen and the setup say about LilyPond (D37). `ready`:
 * found and new enough. `missing`: not found, or the chosen path is not
 * lilypond. `too-old` and `broken`: found, but too old, or it did not answer
 * `--version`.
 */
export interface LilyPondStatus {
  state: 'ready' | 'missing' | 'too-old' | 'broken'
  /** The executable, when one was found. */
  path?: string
  version?: string
  source?: 'setting' | 'path' | 'well-known'
  /** The path chosen in the setup, when there is one. */
  chosen?: string
  /** One or two sentences for someone who has never used a terminal. */
  message: string
}

/** The pages the setup may open; the Rust side opens nothing else. */
export type SetupLink = 'download' | 'learn' | 'claude' | 'codex'

/** The sidebar's agents (D40). */
export type AgentId = 'claude' | 'codex'

/** What the setup says about one agent. `broken`: found, but `--version` failed. */
export interface AgentStatus {
  id: AgentId
  state: 'ready' | 'missing' | 'broken'
  path?: string
  version?: string
  /** The path chosen in the setup, when there is one. */
  chosen?: string
  model?: string
  message: string
}

/** One line of a chat, as the sidebar shows it and chats.json keeps it. */
export type ChatEntry =
  /** `images`: the pasted images, as the Rust side saved them (D46). */
  | { role: 'user'; text: string; images?: string[] }
  | { role: 'agent'; text: string }
  /** Something the agent did: read or edited a file, ran a command. */
  | { role: 'tool'; text: string }
  | { role: 'error'; text: string }

export interface Chat {
  id: string
  agent: AgentId
  folder: string
  /** The start of the first message. */
  title: string
  /** The agent's own session, known after the first turn started. */
  sessionId?: string
  created: number
  updated: number
  entries: ChatEntry[]
  /** What the user allowed Claude Code for the rest of the chat (D52). */
  allowedTools?: string[]
  allowedDirs?: string[]
}

/**
 * Something Claude Code asks before it does it (D52); the turn waits for
 * the answer. `always`: it can be allowed for the rest of the chat.
 */
export interface Ask {
  id: string
  /** What the agent wants to do, as the chat's entries say it: "Ran magick …". */
  text: string
  /** The same in full: "… asks to <question>:" and the whole command, file or input. */
  question: string
  subject: string
  /** The agent's own words for it. */
  detail?: string
  always: boolean
  /** What "always" allows: Claude Code's rules (`Bash(magick:*)`) and directories. */
  allows?: string[]
}

/** The answer to an `Ask`: this once, for the rest of the chat, or no. */
export type Decision = 'allow' | 'always' | 'deny'

/** A chat in the list, without its entries. */
export type ChatSummary = Omit<Chat, 'entries' | 'allowedTools' | 'allowedDirs'>
/** `asking`: its agent waits for the user to allow something. */
export type ChatInfo = ChatSummary & { running: boolean; asking: boolean }
/** `asks`: what its agent waits to be allowed, oldest first. */
export type OpenChat = Chat & { running: boolean; asks: Ask[] }

/**
 * What an agent may do in a turn (D43): `read` the folder only, `edit` its
 * files and run LilyPond (D40), or have `full` access, without limits.
 */
export type Permission = 'read' | 'edit' | 'full'

/** What the renderer sends with a message. */
export interface ChatMessage {
  /** The chat to continue; a new one is started without it. */
  chatId?: string
  /** The agent of a new chat. */
  agent?: AgentId
  text: string
  /** The file in the editor, and the lines selected in it. */
  file?: string
  selection?: { startLine: number; endLine: number; text: string }
  /** `edit` when not given. */
  permission?: Permission
  /** Images pasted into the message box (D46): PNG, JPEG, GIF or WebP, in base64. */
  images?: PastedImage[]
}

export interface PastedImage {
  mediaType: string
  data: string
}

/**
 * How a score is played (D45), kept by the Rust side per score: `parts` by the
 * index of their MIDI track, and the bar ▶ starts from.
 */
export interface PlaybackSetup {
  parts?: Record<string, { program?: number; muted?: boolean }>
  startBar?: number
}

/** An entry of the recent list (D49): a folder or a score opened lately. */
export interface RecentEntry {
  path: string
  kind: 'folder' | 'file'
  /** When it was last opened, in milliseconds since 1970. */
  opened: number
  /** False when nothing of its kind is at `path` now. */
  exists: boolean
}

/** The recent list, newest first, and the home directory the welcome screen shortens to `~`. */
export interface RecentList {
  home?: string
  entries: RecentEntry[]
}

export type ChatEvent =
  | { kind: 'entry'; chatId: string; entry: ChatEntry }
  | { kind: 'running'; chatId: string; running: boolean }
  | { kind: 'ask'; chatId: string; ask: Ask }
  | { kind: 'answered'; chatId: string; askId: string }

export type { PlaybackTiming, SourceLocation }
