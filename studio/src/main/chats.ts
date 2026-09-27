// The agent chats of the sidebar (DECISIONS D40), kept in userData/chats.json.
// A chat belongs to the folder its agent works in: an agent's session can be
// continued only from there. No `electron` here.
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { isAgentId, type AgentId, type ChatEntry } from './agents'

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
}

/** A chat in the list, without its entries. */
export type ChatSummary = Omit<Chat, 'entries'>

/** The most chats kept; the oldest go first. */
export const MAX_CHATS = 200
const MAX_TITLE = 60

export function chatTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line || 'New chat'
}

const ROLES = new Set(['user', 'agent', 'tool', 'error'])

function validChat(value: unknown): value is Chat {
  if (typeof value !== 'object' || value === null) return false
  const chat = value as Record<string, unknown>
  return (
    typeof chat.id === 'string' &&
    isAgentId(chat.agent) &&
    typeof chat.folder === 'string' &&
    typeof chat.title === 'string' &&
    (chat.sessionId === undefined || typeof chat.sessionId === 'string') &&
    typeof chat.created === 'number' &&
    typeof chat.updated === 'number' &&
    Array.isArray(chat.entries) &&
    chat.entries.every((e: unknown) => {
      const entry = e as Record<string, unknown> | null
      return !!entry && ROLES.has(entry.role as string) && typeof entry.text === 'string'
    })
  )
}

export class ChatStore {
  private chats: Chat[] = []
  private loaded: Promise<void> | undefined
  private writing = Promise.resolve()

  constructor(private readonly file: string) {}

  private load(): Promise<void> {
    this.loaded ??= fs.readFile(this.file, 'utf8').then(
      (text) => {
        const value = JSON.parse(text) as { chats?: unknown }
        this.chats = Array.isArray(value.chats) ? value.chats.filter(validChat) : []
      },
      // Missing or damaged: start again from nothing.
      () => {},
    ).catch(() => {})
    return this.loaded
  }

  /** The chats of `folder`, newest first. */
  async list(folder: string): Promise<ChatSummary[]> {
    await this.load()
    return this.chats
      .filter((chat) => chat.folder === folder)
      .sort((a, b) => b.updated - a.updated)
      .map(({ entries: _entries, ...summary }) => summary)
  }

  async get(id: string): Promise<Chat | undefined> {
    await this.load()
    return this.chats.find((chat) => chat.id === id)
  }

  async create(agent: AgentId, folder: string, text: string, now = Date.now()): Promise<Chat> {
    await this.load()
    const chat: Chat = { id: randomUUID(), agent, folder, title: chatTitle(text), created: now, updated: now, entries: [] }
    this.chats.push(chat)
    if (this.chats.length > MAX_CHATS) {
      this.chats.sort((a, b) => a.updated - b.updated)
      this.chats.splice(0, this.chats.length - MAX_CHATS)
    }
    await this.save()
    return chat
  }

  async append(id: string, entry: ChatEntry, now = Date.now()): Promise<void> {
    const chat = await this.get(id)
    if (!chat) return
    chat.entries.push(entry)
    chat.updated = now
    await this.save()
  }

  async setSession(id: string, sessionId: string): Promise<void> {
    const chat = await this.get(id)
    if (!chat || chat.sessionId === sessionId) return
    chat.sessionId = sessionId
    await this.save()
  }

  async delete(id: string): Promise<void> {
    await this.load()
    this.chats = this.chats.filter((chat) => chat.id !== id)
    await this.save()
  }

  /** Writes one at a time, the newest state each time, through a temp file. */
  private save(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await fs.writeFile(temp, `${JSON.stringify({ chats: this.chats })}\n`)
      await fs.rename(temp, this.file)
    }).catch((error: unknown) => console.error('chats.json:', error))
    return this.writing
  }
}
