// The only bridge between the renderer and Lily Studio's Rust side (DECISIONS
// D28, D42): `studio`, one Tauri command per call (src-tauri/src/commands.rs),
// and one channel that brings everything the Rust side starts itself —
// menu commands, compiles, changes on disk and the agents' chats. Binary data
// comes as base64 and leaves here as Uint8Array.
import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  AgentId,
  AgentStatus,
  ChatEvent,
  ChatInfo,
  ChatMessage,
  Command,
  CompileEvent,
  CompileOutcome,
  FileChange,
  FolderListing,
  LilyPondStatus,
  OpenChat,
  Opened,
  PdfOutcome,
  PlaybackSetup,
  SetupLink,
  SourceLocation,
  TemplateId,
} from '../ipc'

/** How the Rust side sends a CompileOutcome: MIDI as base64. */
type WireOutcome = Omit<CompileOutcome, 'midiData'> & { midiData?: string }
type WireCompileEvent = { kind: 'started'; rootFile: string } | { kind: 'finished'; outcome: WireOutcome }
type WirePdf = Omit<PdfOutcome, 'files'> & { files: { name: string; data: string }[] }

/** What the channel carries; `type` says which listeners it is for. */
type StudioEvent =
  | { type: 'command'; command: Command }
  | { type: 'compile'; event: WireCompileEvent }
  | { type: 'filesChanged'; changes: FileChange[] }
  | { type: 'chat'; event: ChatEvent }

function bytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const data = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i)
  return data
}

function outcome(wire: WireOutcome): CompileOutcome {
  const { midiData, ...rest } = wire
  return midiData === undefined ? rest : { ...rest, midiData: bytes(midiData) }
}

function compileEvent(wire: WireCompileEvent): CompileEvent {
  return wire.kind === 'started' ? wire : { kind: 'finished', outcome: outcome(wire.outcome) }
}

/**
 * A command's result. A command that fails rejects with its message as a
 * string; it becomes an Error, as the renderer reports `error.message`.
 */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** Fire and forget, like an IPC `send`: a failure is only logged. */
function send(command: string, args?: Record<string, unknown>): void {
  invoke(command, args).catch((error: unknown) => console.error(`${command}:`, error))
}

type Listener<T> = (value: T) => void
const listeners = {
  command: new Set<Listener<Command>>(),
  compile: new Set<Listener<CompileEvent>>(),
  filesChanged: new Set<Listener<FileChange[]>>(),
  chat: new Set<Listener<ChatEvent>>(),
}

function dispatch(event: StudioEvent): void {
  switch (event.type) {
    case 'command':
      return listeners.command.forEach((listener) => listener(event.command))
    case 'compile': {
      const compile = compileEvent(event.event)
      return listeners.compile.forEach((listener) => listener(compile))
    }
    case 'filesChanged':
      return listeners.filesChanged.forEach((listener) => listener(event.changes))
    case 'chat':
      return listeners.chat.forEach((listener) => listener(event.event))
  }
}

function subscribe<T>(set: Set<Listener<T>>, listener: Listener<T>): () => void {
  set.add(listener)
  return () => set.delete(listener)
}

const channel = new Channel<StudioEvent>()
channel.onmessage = dispatch
/** Resolves once the Rust side sends on the channel; commands that start compiles wait for it. */
const subscribed = call<void>('subscribe', { channel })

export const studio = {
  /** The templates of New Score, as the Rust side has them. */
  templates: (): Promise<{ id: TemplateId; label: string }[]> => call('templates'),

  /** Asks for a folder; undefined when the dialog was cancelled. */
  openFolder: (): Promise<Opened | undefined> => call<Opened | null>('open_folder').then(orUndefined),
  /** Asks for a LilyPond file; its folder becomes the open folder. */
  openFile: (): Promise<Opened | undefined> => call<Opened | null>('open_file').then(orUndefined),
  /** Lists the open folder again, or undefined when none is open. */
  listFolder: (): Promise<FolderListing | undefined> => call<FolderListing | null>('list_folder').then(orUndefined),
  readFile: (file: string): Promise<string> => call('read_file', { file }),
  saveFile: async (file: string, text: string): Promise<void> => {
    await subscribed
    return call('save_file', { file, text })
  },
  /** Asks where to save a new score from `template`, writes it and opens its folder. */
  newScore: (template: TemplateId): Promise<Opened | undefined> => call<Opened | null>('new_score', { template }).then(orUndefined),
  /**
   * The editor now shows `file`: resolves with its score, or undefined when no
   * score includes it. The score's last result follows at once, then the
   * compile that brings it up to date, on onCompile (D39).
   */
  showScore: async (file: string): Promise<string | undefined> => {
    await subscribed
    const shown = await call<{ rootFile: string; kept?: WireOutcome } | null>('show_score', { file })
    if (!shown) return undefined
    // After the caller has taken the score as the editor's, so it takes the result too.
    const kept = shown.kept
    if (kept) setTimeout(() => dispatch({ type: 'compile', event: { kind: 'finished', outcome: kept } }))
    return shown.rootFile
  },
  /** Tells the Rust side whether any open file has unsaved changes. */
  setDirty: (dirty: boolean): void => send('set_dirty', { dirty }),
  /**
   * Where a `textedit:` link of the preview points; undefined when it is not
   * one. Rejects when the file is not one the studio may open.
   */
  revealSource: (href: string): Promise<SourceLocation | undefined> =>
    call<SourceLocation | null>('reveal_source', { href }).then(orUndefined),
  /**
   * The PDF of the score `rootFile`, compiled into the temp directory (D33);
   * undefined when a newer PDF compile of it took over.
   */
  compilePdf: async (rootFile: string): Promise<PdfOutcome | undefined> => {
    const wire = await call<WirePdf | null>('compile_pdf', { rootFile })
    return wire ? { ...wire, files: wire.files.map((file) => ({ name: file.name, data: bytes(file.data) })) } : undefined
  },
  /** Writes the PDF of `rootFile` next to it; resolves with the files written. */
  exportPdf: (rootFile: string): Promise<string[]> => call('export_pdf', { rootFile }),
  /**
   * Asks, in a dialog, whether to reload `file` from disk and lose its unsaved
   * changes; true for Reload.
   */
  confirmReload: (file: string): Promise<boolean> => call('confirm_reload', { file }),
  /**
   * The unsaved text of `file` after an edit, or null after a save or reload.
   * Live preview compiles with these texts (D36).
   */
  edited: (file: string, text: string | null): void => send('edited', { file, text }),
  /** Turns live preview on or off. */
  setLive: (on: boolean): void => send('set_live', { on }),
  /** Looks for LilyPond and asks it for its version (D37). */
  lilypondStatus: (): Promise<LilyPondStatus> => call('lilypond_status'),
  /** Asks where LilyPond is; undefined when the dialog was cancelled. */
  chooseLilyPond: (): Promise<LilyPondStatus | undefined> => call<LilyPondStatus | null>('choose_lilypond').then(orUndefined),
  /** Opens a page of the setup in the browser. */
  openLink: (link: SetupLink): Promise<void> => call('open_link', { link }),
  /** Opens the sample score, writing it first when it is not there. */
  openSample: (): Promise<Opened> => call('open_sample'),
  /** Looks for Claude Code and Codex and asks each for its version (D40). */
  agentStatus: (): Promise<AgentStatus[]> => call('agent_status'),
  /** Asks where `agent` is; undefined when the dialog was cancelled. */
  chooseAgent: (agent: AgentId): Promise<AgentStatus | undefined> => call<AgentStatus | null>('choose_agent', { agent }).then(orUndefined),
  /** The model `agent` uses from its next turn; empty for its default. */
  setAgentModel: (agent: AgentId, model: string): Promise<void> => call('set_agent_model', { agent, model }),
  /** The chats of the open folder, newest first; empty when none is open. */
  chatList: (): Promise<ChatInfo[]> => call('chat_list'),
  /** A chat of the open folder, with its entries; undefined when it is gone. */
  chatGet: (chatId: string): Promise<OpenChat | undefined> => call<OpenChat | null>('chat_get', { chatId }).then(orUndefined),
  /**
   * Sends a message to an agent working in the open folder; resolves with the
   * chat's id once the turn has started. What follows arrives on onChatEvent.
   */
  chatSend: async (message: ChatMessage): Promise<string> => {
    await subscribed
    return call('chat_send', { message })
  },
  /** A pasted image of a chat (D46) as a data: URL; undefined for any other file. */
  chatImage: async (file: string): Promise<string | undefined> => {
    const data = await call<string | null>('chat_image', { file })
    if (!data) return undefined
    const type = { jpg: 'jpeg', gif: 'gif', webp: 'webp' }[file.split('.').pop() ?? ''] ?? 'png'
    return `data:image/${type};base64,${data}`
  },
  /** Stops the agent of `chatId`, and the commands it started. */
  chatStop: (chatId: string): Promise<void> => call('chat_stop', { chatId }),
  chatDelete: (chatId: string): Promise<void> => call('chat_delete', { chatId }),
  /** The playback setup kept for the score `rootFile` (D45); undefined when there is none. */
  playbackSetup: (rootFile: string): Promise<PlaybackSetup | undefined> =>
    call<PlaybackSetup | null>('playback_setup', { rootFile }).then(orUndefined),
  /** Keeps the playback setup of `rootFile`; an empty one is forgotten. */
  setPlaybackSetup: (rootFile: string, setup: PlaybackSetup): Promise<void> => call('set_playback_setup', { rootFile, setup }),
  /** Runs `listener` for each entry of a chat and each start and end of a turn. */
  onChatEvent: (listener: Listener<ChatEvent>): (() => void) => subscribe(listeners.chat, listener),
  /** Runs `listener` for each menu command; returns a function that removes it. */
  onCommand: (listener: Listener<Command>): (() => void) => subscribe(listeners.command, listener),
  /** Runs `listener` when a compile starts or ends; saving a file starts one (D31). */
  onCompile: (listener: Listener<CompileEvent>): (() => void) => subscribe(listeners.compile, listener),
  /** Runs `listener` when open files or the score's includes change on disk (D34). */
  onFilesChanged: (listener: Listener<FileChange[]>): (() => void) => subscribe(listeners.filesChanged, listener),
}

function orUndefined<T>(value: T | null): T | undefined {
  return value ?? undefined
}

export type StudioApi = typeof studio
