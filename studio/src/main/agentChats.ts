// The agent chats behind the sidebar (DECISIONS D40): a message starts one
// turn of the chat's agent in the chat's folder, and what the agent says and
// does is kept in the chat and sent to the renderer as it happens. No
// `electron` here; main.ts gives it the store, the agents' status and the
// window to send to.
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { agentArgs, agentOutDir, agentLabel, isAgentId, runAgent, spellings, turnPrompt, type AgentId, type AgentRun, type AgentStatus, type ChatEntry } from './agents'
import type { Chat, ChatStore, ChatSummary } from './chats'

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
}

export type ChatEvent =
  | { kind: 'entry'; chatId: string; entry: ChatEntry }
  | { kind: 'running'; chatId: string; running: boolean }

export type ChatInfo = ChatSummary & { running: boolean }
export type OpenChat = Chat & { running: boolean }

export interface AgentChatsOptions {
  store: ChatStore
  emit(event: ChatEvent): void
  /** The agent's executable and model, as the setup found them. */
  status(agent: AgentId): Promise<AgentStatus>
  /** The LilyPond the agent should check its edits with. */
  lilypond(): Promise<string | undefined>
  env(): Promise<NodeJS.ProcessEnv>
}

/** A longer selection is cut; the agent can read the file itself. */
const MAX_SELECTION = 4_000

export class AgentChats {
  private readonly runs = new Map<string, AgentRun>()

  constructor(private readonly options: AgentChatsOptions) {}

  isRunning(chatId: string): boolean {
    return this.runs.has(chatId)
  }

  async list(folder: string): Promise<ChatInfo[]> {
    return (await this.options.store.list(folder)).map((chat) => ({ ...chat, running: this.isRunning(chat.id) }))
  }

  /** The chat `chatId` of `folder`; undefined for another folder's. */
  async get(chatId: string, folder: string): Promise<OpenChat | undefined> {
    const chat = await this.options.store.get(chatId)
    return chat && chat.folder === folder ? { ...chat, running: this.isRunning(chat.id) } : undefined
  }

  /** Sends `message` in `folder`; resolves with its chat's id once the turn has started. */
  async send(message: ChatMessage, folder: string): Promise<string> {
    const { store, emit } = this.options
    const text = message.text.trim()
    if (!text) throw new Error('Write a message first.')
    let chat: Chat
    if (message.chatId !== undefined) {
      const found = await this.get(message.chatId, folder)
      if (!found) throw new Error('This chat belongs to another folder.')
      if (found.running) throw new Error(`${agentLabel(found.agent)} is still working on the last message.`)
      chat = found
    } else {
      if (!isAgentId(message.agent)) throw new Error('Choose an agent first.')
      chat = await store.create(message.agent, folder, text)
    }
    const add = async (entry: ChatEntry) => {
      await store.append(chat.id, entry)
      emit({ kind: 'entry', chatId: chat.id, entry })
    }
    await add({ role: 'user', text })

    const status = await this.options.status(chat.agent)
    if (status.state !== 'ready' || !status.path) {
      await add({ role: 'error', text: `${status.message} Open Agent setup below to set it up.` })
      return chat.id
    }
    const lilypond = await this.options.lilypond()
    await fs.mkdir(agentOutDir(), { recursive: true })
    const inside = message.file && !path.relative(folder, message.file).startsWith('..') && !path.isAbsolute(path.relative(folder, message.file))
    const selection = inside && message.selection ? { ...message.selection, text: message.selection.text.slice(0, MAX_SELECTION) } : undefined
    const prompt = turnPrompt(text, {
      folder,
      ...(inside ? { file: message.file } : {}),
      ...(selection ? { selection } : {}),
      ...(lilypond ? { lilypond } : {}),
      first: chat.sessionId === undefined,
    })
    const args = agentArgs(chat.agent, {
      prompt,
      ...(chat.sessionId ? { sessionId: chat.sessionId } : {}),
      ...(status.model ? { model: status.model } : {}),
      ...(lilypond ? { lilypond } : {}),
    })
    // Entries are kept in the order they came, each after the one before.
    let writing = Promise.resolve()
    const run = runAgent({
      id: chat.agent,
      binary: status.path,
      args,
      cwd: folder,
      roots: await spellings(folder),
      env: await this.options.env(),
      onEvent: (event) => {
        if (event.kind === 'session') writing = writing.then(() => store.setSession(chat.id, event.id))
        else if (event.kind === 'entry') writing = writing.then(() => add(event.entry))
      },
    })
    this.runs.set(chat.id, run)
    emit({ kind: 'running', chatId: chat.id, running: true })
    void run.done
      .then(() => writing)
      .finally(() => {
        this.runs.delete(chat.id)
        emit({ kind: 'running', chatId: chat.id, running: false })
      })
    return chat.id
  }

  stop(chatId: string): void {
    this.runs.get(chatId)?.stop()
  }

  /** Waits for the turn of `chatId`, if one is running (tests). */
  async settled(chatId: string): Promise<void> {
    const run = this.runs.get(chatId)
    if (!run) return
    await run.done
    while (this.runs.has(chatId)) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  async delete(chatId: string, folder: string): Promise<void> {
    if (!(await this.get(chatId, folder))) return
    this.stop(chatId)
    await this.options.store.delete(chatId)
  }

  dispose(): void {
    for (const run of this.runs.values()) run.stop()
  }
}
