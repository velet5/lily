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

/**
 * Commands sent from the application menu to the renderer. `upload` and
 * `download` come only from the web's menu bar (D55).
 */
export type Command =
  | 'new-score'
  | 'open-file'
  | 'open-folder'
  | 'save'
  | 'save-all'
  | 'export-midi'
  | 'welcome'
  | 'setup-lilypond'
  | 'upload'
  | 'download'

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

/** A part muted in the Parts fold, as Export MIDI names it in its save panel (D54). */
export interface MutedPart {
  /** Its MIDI track. */
  track: number
  name: string
}

/** Where Export MIDI wrote (D54), and how many muted parts it left out. */
export interface ExportedMidi {
  file: string
  leftOut: number
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

/**
 * Whether stems can be separated here (D112): only in the app on a Mac.
 * `reason` is what the page shows where the Stems workspace would be.
 */
export type SeparationAvailability = { available: true } | { available: false; reason: string }

/** A model karaoke-mlx knows, as `karaoke-mlx --json models` lists it (crates/separate). */
export interface SeparationModel {
  id: string
  title: string
  description: string
  /** `karaoke`: lead vocals and instrumental; `stems`: every instrument. */
  task: 'karaoke' | 'stems'
  /** The stems it writes, in order. */
  stems: string[]
  /** The checkpoint's download size, in bytes. */
  size: number
  /** False until its weights are downloaded, on its first separation. */
  installed: boolean
  default: boolean
  /** Chunks overlapping each sample unless a request says otherwise. */
  num_overlap: number
}

/** Where the separation's project is (D112): `KARAOKE_MLX_ROOT`, the setting, or a default. */
export interface SeparationRoot {
  path: string
  source: 'variable' | 'setting' | 'default'
}

/** What the Stems setup says: the project, uv, what is missing, whether one runs. */
export interface SeparationStatus {
  root?: SeparationRoot
  uv?: string
  /** Why separating cannot start, when the project or uv was not found. */
  problem?: string
  running: boolean
}

/** One separation as the page asks for it; the stems go next to the song. */
export interface SeparationRequest {
  /** The song: an absolute path to a file. */
  input: string
  /** A `SeparationModel` id, such as `becruily` or `bs-roformer-sw`. */
  model: string
  /** Chunks overlapping each sample; the model's own when not given. */
  overlap?: number
  format: 'wav' | 'flac' | 'mp3'
}

/** A file karaoke-mlx wrote: a stem, or the mix. */
export interface SeparationOutput {
  stem: string
  path: string
}

/** A song separated before (D114), as separations.json keeps it: its folder and stems. */
export interface PastSeparation {
  folder: string
  outputs: SeparationOutput[]
  /** How long it took; absent for a folder chosen with the panel. */
  seconds?: number
  /** When it was separated or opened last, in milliseconds since 1970. */
  opened: number
}

/** An entry of the separated songs, with whether its folder is still there. */
export interface ListedSeparation extends PastSeparation {
  exists: boolean
}

/**
 * What karaoke-mlx prints while it separates, one per line (D112). Every
 * separation ends with `done` or `error`; `cancelled` is set on the `error`
 * of one that Cancel ended.
 */
export type SeparationEvent =
  | { event: 'status'; message: string }
  | {
      event: 'progress'
      stage: 'download' | 'verify' | 'convert' | 'load' | 'decode' | 'separate' | 'mix' | 'write'
      /** From 0 to 1. */
      value: number
    }
  | { event: 'done'; outputs: SeparationOutput[]; folder: string; seconds: number }
  | { event: 'error'; message: string; cancelled?: boolean }

/**
 * A stem as lily-transcribe heard it (D113): the song's tempo, meter, key
 * and length, and the stem's notes on that grid.
 */
export interface Transcription {
  stem: string
  /** One note at a time (bass, vocals), a draft of chords (guitar, piano…), or drum hits. */
  family: 'melody' | 'chords' | 'drums'
  /** The stem's length. */
  seconds: number
  /** Quarter notes per minute, to the thousandth. */
  bpm: number
  /** One tempo fits the whole song, so the score's MIDI keeps time with the stem. */
  steady: boolean
  /** Quarter-note beats per bar. */
  beatsPerBar: number
  /** Seconds from the stem's start to bar 1. */
  barOne: number
  /** Sixteenths before bar 1: `barOne`, on the grid. */
  pickup: number
  /** Bars from bar 1 to the end of the stem. */
  bars: number
  /** The song's key; `tonic` is a pitch class, 0 for C. */
  key: { tonic: number; mode: 'major' | 'minor'; fit: number }
  /** `[at, length, pitches]`: sixteenths from bar 1 (negative in the pickup) and MIDI pitches, or General MIDI drums. */
  notes: [number, number, number[]][]
}

/** What lily-transcribe prints while it works (D113); it ends with `done` or `error`. */
export type TranscriptionEvent =
  | { event: 'progress'; stage: 'decode' | 'beats' | 'key' | 'notes' }
  | { event: 'done'; transcription: Transcription; seconds: number }
  | { event: 'error'; message: string; cancelled?: boolean }

/**
 * Files dragged over the app's window (D112): their paths on `enter`, and on
 * `drop`. The web has none.
 */
export type FileDrop = { kind: 'enter'; paths: string[] } | { kind: 'drop'; paths: string[] } | { kind: 'leave' }

export type ChatEvent =
  | { kind: 'entry'; chatId: string; entry: ChatEntry }
  | { kind: 'running'; chatId: string; running: boolean }
  | { kind: 'ask'; chatId: string; ask: Ask }
  | { kind: 'answered'; chatId: string; askId: string }

/**
 * How bridge.ts reaches the Rust side (D42, D55): the app's Tauri commands and
 * channel (src/renderer/transport.ts), or the web's socket to the user's
 * worker (src/web/transport.ts), which `esbuild.mjs --site` puts in its place.
 */
export interface Transport {
  /** True on the web: no agents, no LilyPond to choose, files uploaded and downloaded. */
  readonly hosted: boolean
  /** Whether the separation commands run here (D112); on the web they reject. */
  readonly separation: SeparationAvailability
  /** A command's result; rejects with what the Rust side said, as a string or an Error. */
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>
  /** Fire and forget, in the order sent. */
  send(command: string, args?: Record<string, unknown>): void
  /** Delivers what the Rust side sends by itself to `onEvent`; resolves once it does. */
  subscribe(onEvent: (event: unknown) => void): Promise<void>
  /** Web only: asks for scores to upload into `folder` (the workspace when not given) and opens what came. */
  upload?(folder: string | undefined): Promise<Opened | undefined>
  /** Web only: saves `file` of the workspace in the browser's downloads. */
  download?(file: string): Promise<void>
  /** App only: where `<audio>` plays `path` from, through the asset protocol (D112). */
  fileUrl?(path: string): string
  /** App only: runs `onDrop` for files dragged over the window and dropped (D112). */
  onFileDrop?(onDrop: (drop: FileDrop) => void): void
}

export type { PlaybackTiming, SourceLocation }
