// The agents' accordion in the sidebar (DECISIONS D40). Agent chats: the chats
// of the open folder, and one chat at a time with what its agent said and did;
// a message starts a turn of Claude Code or Codex in the folder. Agent setup:
// where each agent is, its version, and the model it uses. Images pasted or
// dropped into the message box go with the message (D46). A− and A+ size the
// chat's text (D47). `textRuns`, `imageRefusal` and the size steps are pure so
// the tests can run them without a DOM.
import type { AgentId, AgentStatus, Ask, ChatEntry, ChatEvent, ChatInfo, Decision, OpenChat, PastedImage, Permission } from '../ipc'
import type { StudioApi } from './bridge'
import { button } from './files'

/** What the Rust side accepts (crates/agents' MAX_IMAGES, MAX_IMAGE_BYTES). */
export const MAX_IMAGES = 6
export const MAX_IMAGE_BYTES = 10 << 20
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Why an image of `type` and `size` bytes cannot join `count` others; undefined when it can. */
export function imageRefusal(type: string, size: number, count: number): string | undefined {
  if (!IMAGE_TYPES.includes(type)) return 'Only PNG, JPEG, GIF and WebP images can be sent to the agent.'
  if (size > MAX_IMAGE_BYTES) return `The image is too large; the limit is ${MAX_IMAGE_BYTES >> 20} MB.`
  if (count >= MAX_IMAGES) return `A message can carry at most ${MAX_IMAGES} images.`
  return undefined
}

/** An image waiting in the message box: what is sent, and its preview. */
interface Pending extends PastedImage {
  url: string
}

/** A piece of an agent's answer: plain text, `code`, or a fenced block. */
export type TextRun = { kind: 'text' | 'code' | 'block'; text: string }

/** Splits an answer into fenced blocks, inline code and the text between; nothing else of Markdown. */
export function textRuns(text: string): TextRun[] {
  const runs: TextRun[] = []
  const fence = /```[^\n]*\n([\s\S]*?)(?:```|$)/g
  let at = 0
  const inline = (part: string) => {
    part.split(/(`[^`\n]+`)/).forEach((piece, index) => {
      if (!piece) return
      runs.push(index % 2 === 1 ? { kind: 'code', text: piece.slice(1, -1) } : { kind: 'text', text: piece })
    })
  }
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    inline(text.slice(at, match.index))
    runs.push({ kind: 'block', text: (match[1] ?? '').replace(/\n$/, '') })
    at = fence.lastIndex
  }
  inline(text.slice(at))
  return runs
}

/**
 * The agent's items in the editor's context menu for a selection (D41). With a
 * prompt, the item sends it at once; without, it opens the message box.
 */
export const SELECTION_ACTIONS: readonly { id: string; label: string; prompt?: string }[] = [
  { id: 'lily.agent.ask', label: 'Ask Agent About Selection…' },
  {
    id: 'lily.agent.explain',
    label: 'Explain Selection with Agent',
    prompt: 'Explain what the selected lines do, in plain words, as a musician would say it. Do not change any files.',
  },
  {
    id: 'lily.agent.fix',
    label: 'Fix Selection with Agent',
    prompt: 'Find and fix what is wrong in the selected lines, then check that the score compiles. Say briefly what you changed.',
  },
]

/** The permission modes under the message box (D43), in the order shown. */
export const PERMISSIONS: readonly { id: Permission; label: string; title: string }[] = [
  { id: 'read', label: 'Read only', title: 'The agent reads the scores and answers; it changes nothing.' },
  { id: 'edit', label: 'Edit files', title: 'The agent edits the files of this folder and checks them with LilyPond.' },
  {
    id: 'full',
    label: 'Full access',
    title: 'The agent may run any command and change any file, without asking. Use with care.',
  },
]

const MODELS: Record<AgentId, readonly string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5-codex', 'gpt-5'],
}

/**
 * The models the menu under the message box offers `agent`: its default
 * (value ''), the usual ones, and `current` when it is none of them, as the
 * setup lets any model be typed.
 */
export function modelChoices(agent: AgentId, current?: string): { value: string; label: string }[] {
  const models = [...MODELS[agent]]
  if (current && !models.includes(current)) models.push(current)
  return [{ value: '', label: 'Default model' }, ...models.map((model) => ({ value: model, label: model }))]
}

/** The chat's text sizes in px, from A− to A+; the default is what ⌘0 goes back to. */
export const CHAT_FONT_SIZES: readonly number[] = [11, 12, 13, 14, 15, 16, 18, 20, 22]
export const CHAT_FONT_DEFAULT = 13

/** The size one step from `size` in `direction`, kept within the steps; a size between steps goes to the next one. */
export function stepChatFont(size: number, direction: 1 | -1): number {
  const sizes = direction > 0 ? CHAT_FONT_SIZES : [...CHAT_FONT_SIZES].reverse()
  return sizes.find((step) => (direction > 0 ? step > size : step < size)) ?? sizes[sizes.length - 1]!
}

/** A remembered size, or the default when there is none or it is not a number. */
export function chatFontSize(stored: string | null): number {
  const size = Number(stored)
  if (!stored || !Number.isFinite(size)) return CHAT_FONT_DEFAULT
  return Math.min(Math.max(size, CHAT_FONT_SIZES[0]!), CHAT_FONT_SIZES[CHAT_FONT_SIZES.length - 1]!)
}

/** What goes with a message, as the line above the message box says it. */
export function contextLabel(context: EditorContext, name: (file: string) => string): string | undefined {
  if (!context.file) return undefined
  const { selection } = context
  if (!selection) return `With ${name(context.file)}`
  const lines = selection.startLine === selection.endLine ? `line ${selection.startLine}` : `lines ${selection.startLine}–${selection.endLine}`
  return `With ${lines} of ${name(context.file)}`
}

export interface EditorContext {
  file?: string
  selection?: { startLine: number; endLine: number; text: string }
}

export interface AgentPanelOptions {
  studio: StudioApi
  /** The chats fold's body and the setup fold's. */
  chats: HTMLElement
  setup: HTMLElement
  /** Saves unsaved edits, so the agent reads what the editor shows. */
  beforeSend(): Promise<void>
  /** The file in the editor and its selection, sent along with a message. */
  context(): EditorContext
  /** A file as the file list shows it. */
  displayName(file: string): string
  /** A turn ended: the agent may have added or changed files. */
  onTurnEnd(): void
  onError(error: unknown): void
}

const AGENT_KEY = 'lily-studio.agent'
const PERMISSION_KEY = 'lily-studio.permission'
const FONT_KEY = 'lily-studio.chatFontSize'

type View = { kind: 'list' } | { kind: 'chat'; chat: OpenChat }

export class AgentPanel {
  private statuses: AgentStatus[] = []
  private chats: ChatInfo[] = []
  private view: View = { kind: 'list' }
  private folder: string | undefined
  private agent: AgentId = 'claude'
  private permission: Permission = 'edit'
  /** A message is on its way, before its chat is known. */
  private sending = false
  private readonly toolbar = document.createElement('div')
  private readonly content = document.createElement('div')
  private readonly composer = document.createElement('form')
  private readonly input = document.createElement('textarea')
  /** What goes with the message: the file in the editor, and the selected lines. */
  private readonly attached = document.createElement('div')
  /** The images pasted into the message box, shown above it (D46). */
  private readonly imageStrip = document.createElement('div')
  private images: Pending[] = []
  private readonly sendButton = document.createElement('button')
  private readonly permissionSelect = document.createElement('select')
  /** The model of the agent the next message goes to: the open chat's, or the one chosen for a new chat. */
  private readonly modelSelect = document.createElement('select')
  private fontSize = CHAT_FONT_DEFAULT
  /** A− and A+, at the end of the toolbar in either view. */
  private readonly fontButtons = document.createElement('span')
  private readonly smaller = button('A−', () => this.setFontSize(stepChatFont(this.fontSize, -1)))
  private readonly larger = button('A+', () => this.setFontSize(stepChatFont(this.fontSize, 1)))

  constructor(private readonly options: AgentPanelOptions) {
    try {
      if (localStorage.getItem(AGENT_KEY) === 'codex') this.agent = 'codex'
      const permission = PERMISSIONS.find((p) => p.id === localStorage.getItem(PERMISSION_KEY))
      if (permission) this.permission = permission.id
      this.fontSize = chatFontSize(localStorage.getItem(FONT_KEY))
    } catch {
      // No storage: Claude Code first, editing files.
    }
    this.toolbar.className = 'chat-toolbar'
    this.content.className = 'chat-content'
    this.composer.className = 'chat-composer'
    this.input.rows = 3
    this.input.placeholder = 'Ask the agent to change the score…'
    this.input.setAttribute('aria-label', 'Message to the agent')
    this.sendButton.type = 'submit'
    this.sendButton.className = 'primary'
    this.attached.className = 'chat-context'
    this.permissionSelect.setAttribute('aria-label', 'What the agent may do')
    for (const { id, label, title } of PERMISSIONS) {
      const option = document.createElement('option')
      option.value = id
      option.textContent = label
      option.title = title
      option.selected = id === this.permission
      this.permissionSelect.append(option)
    }
    this.permissionSelect.addEventListener('change', () => this.choosePermission())
    this.modelSelect.setAttribute('aria-label', 'Model')
    this.modelSelect.addEventListener('change', () => void this.chooseModel(this.modelSelect.value))
    const bar = document.createElement('div')
    bar.className = 'chat-composer-bar'
    bar.append(this.permissionSelect, this.modelSelect, this.sendButton)
    this.imageStrip.className = 'chat-images'
    this.imageStrip.hidden = true
    this.composer.append(this.attached, this.imageStrip, this.input, bar)
    this.input.addEventListener('paste', (event) => {
      const files = imageFiles(event.clipboardData)
      if (files.length === 0) return
      // An image copied from a browser comes with its address as text; the image is what was meant.
      event.preventDefault()
      void this.addImages(files)
    })
    this.composer.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    })
    this.composer.addEventListener('drop', (event) => {
      const files = imageFiles(event.dataTransfer)
      if (files.length === 0) return
      event.preventDefault()
      void this.addImages(files)
    })
    this.composer.addEventListener('submit', (event) => {
      event.preventDefault()
      void this.sendOrStop()
    })
    this.input.addEventListener('keydown', (event) => {
      // Enter sends, Shift+Enter starts a new line, as in chat apps.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        if (!this.running()) void this.sendOrStop()
      }
    })
    this.fontButtons.className = 'chat-font'
    this.fontButtons.append(this.smaller, this.larger)
    // ⌘+, ⌘− and ⌘0 while the focus is in the chat; the app menu has none of them.
    options.chats.addEventListener('keydown', (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const size =
        event.key === '=' || event.key === '+'
          ? stepChatFont(this.fontSize, 1)
          : event.key === '-'
            ? stepChatFont(this.fontSize, -1)
            : event.key === '0'
              ? CHAT_FONT_DEFAULT
              : undefined
      if (size === undefined) return
      event.preventDefault()
      this.setFontSize(size)
    })
    options.chats.append(this.toolbar, this.content, this.composer)
    this.setFontSize(this.fontSize, false)
    options.studio.onChatEvent((event) => this.chatEvent(event))
    this.render()
  }

  /** The selection or the file in the editor changed: says what goes with a message. */
  refreshContext(): void {
    const label = contextLabel(this.options.context(), this.options.displayName)
    this.attached.textContent = label ?? ''
    this.attached.hidden = !label || this.folder === undefined
  }

  /**
   * From the editor's context menu: sends `prompt` about the selection, in the
   * open chat unless its agent is still working, else in a new one. Without a
   * prompt, puts the cursor in the message box.
   */
  ask(prompt?: string): void {
    if (prompt) {
      void this.send(prompt, false)
      return
    }
    this.refreshContext()
    this.input.focus()
  }

  /** The open folder changed: its chats, from the list. */
  async folderChanged(folder: string | undefined): Promise<void> {
    if (folder === this.folder) return
    this.folder = folder
    this.view = { kind: 'list' }
    await this.refreshList()
  }

  /** Looks for the agents again; the setup and the agent menu show what was found. */
  async refreshSetup(): Promise<void> {
    try {
      this.statuses = await this.options.studio.agentStatus()
    } catch (error) {
      this.options.onError(error)
    }
    this.renderSetup()
    this.render()
  }

  private async refreshList(): Promise<void> {
    try {
      this.chats = this.folder === undefined ? [] : await this.options.studio.chatList()
    } catch (error) {
      this.options.onError(error)
    }
    this.render()
  }

  private running(): boolean {
    return this.sending || (this.view.kind === 'chat' && this.view.chat.running)
  }

  private async openChat(chatId: string): Promise<void> {
    try {
      const chat = await this.options.studio.chatGet(chatId)
      this.view = chat ? { kind: 'chat', chat } : { kind: 'list' }
      if (!chat) await this.refreshList()
    } catch (error) {
      this.options.onError(error)
    }
    this.render()
    this.input.focus()
  }

  private showList(): void {
    this.view = { kind: 'list' }
    void this.refreshList()
  }

  private async sendOrStop(): Promise<void> {
    const { studio } = this.options
    if (this.view.kind === 'chat' && this.view.chat.running) {
      await studio.chatStop(this.view.chat.id).catch(this.options.onError)
      return
    }
    await this.send(this.input.value, true)
  }

  /** Adds pasted or dropped images to the message, as far as they may go. */
  private async addImages(files: File[]): Promise<void> {
    for (const file of files) {
      const refusal = imageRefusal(file.type, file.size, this.images.length)
      if (refusal) {
        this.options.onError(new Error(refusal))
        return
      }
      const url = await dataUrl(file)
      this.images.push({ mediaType: file.type, data: url.slice(url.indexOf(',') + 1), url })
      this.renderImages()
    }
  }

  private renderImages(): void {
    this.imageStrip.hidden = this.images.length === 0
    this.imageStrip.replaceChildren(
      ...this.images.map((image, index) => {
        const item = document.createElement('div')
        item.className = 'chat-image'
        const img = document.createElement('img')
        img.src = image.url
        img.alt = `Pasted image ${index + 1}`
        const remove = button('✕', () => {
          this.images.splice(index, 1)
          this.renderImages()
          this.input.focus()
        })
        remove.title = 'Remove this image'
        remove.setAttribute('aria-label', `Remove pasted image ${index + 1}`)
        item.append(img, remove)
        return item
      }),
    )
  }

  /** Sends `text`, from the message box or a menu; the box keeps its draft for a menu's. */
  private async send(value: string, fromInput: boolean): Promise<void> {
    const { studio } = this.options
    const text = value.trim()
    // The images in the box go with a message typed there, and with one from a menu.
    const images = this.images.map(({ mediaType, data }) => ({ mediaType, data }))
    if ((!text && images.length === 0) || this.sending) return
    if (this.folder === undefined) return this.options.onError(new Error('Open a score or a folder first; the agent works on its files.'))
    this.sending = true
    this.render()
    try {
      await this.options.beforeSend()
      // A chat whose agent is still working is left to it; the message starts another.
      const chatId = this.view.kind === 'chat' && !this.view.chat.running ? this.view.chat.id : undefined
      const id = await studio.chatSend({
        text,
        ...(chatId ? { chatId } : { agent: this.agent }),
        ...this.options.context(),
        permission: this.permission,
        ...(images.length > 0 ? { images } : {}),
      })
      if (fromInput) this.input.value = ''
      this.images = []
      this.renderImages()
      if (chatId === undefined) {
        this.sending = false
        await this.openChat(id)
      }
    } catch (error) {
      this.options.onError(error)
    } finally {
      this.sending = false
      this.render()
    }
  }

  private chatEvent(event: ChatEvent): void {
    const open = this.view.kind === 'chat' && this.view.chat.id === event.chatId ? this.view.chat : undefined
    const listed = this.chats.find((chat) => chat.id === event.chatId)
    if (event.kind === 'ask' || event.kind === 'answered') {
      if (event.kind === 'ask') {
        if (listed) listed.asking = true
        open?.asks.push(event.ask)
      } else if (open) {
        open.asks = open.asks.filter((ask) => ask.id !== event.askId)
      }
      if (open) this.renderAsks(open)
      else if (this.view.kind === 'list') void this.refreshList()
      return
    }
    if (event.kind === 'entry') {
      if (!open) return
      open.entries.push(event.entry)
      const log = this.content.querySelector<HTMLElement>('.chat-log')
      if (!log) return
      const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24
      log.querySelector('.chat-working')?.before(entryElement(event.entry, this.options.studio.chatImage))
      if (atEnd) log.scrollTop = log.scrollHeight
      return
    }
    if (listed) {
      listed.running = event.running
      if (!event.running) listed.asking = false
    }
    if (open) {
      open.running = event.running
      // What a turn asked ends with it.
      if (!event.running) open.asks = []
      this.render()
    }
    if (!event.running) {
      this.options.onTurnEnd()
      if (this.view.kind === 'list') void this.refreshList()
    } else if (this.view.kind === 'list') {
      this.render()
    }
  }

  private render(): void {
    this.toolbar.replaceChildren()
    this.content.replaceChildren()
    const noFolder = this.folder === undefined
    this.input.disabled = noFolder
    const working = this.view.kind === 'chat' && this.view.chat.running
    this.sendButton.textContent = working ? 'Stop' : 'Send'
    this.sendButton.disabled = noFolder || (this.sending && !working)
    this.composer.dataset.running = String(working)
    this.refreshContext()
    this.renderModels()
    this.permissionSelect.disabled = noFolder
    this.permissionSelect.title = PERMISSIONS.find((p) => p.id === this.permission)?.title ?? ''
    this.composer.dataset.permission = this.permission

    if (this.view.kind === 'chat') {
      const { chat } = this.view
      const back = button('‹ Chats', () => this.showList())
      back.title = 'All chats of this folder'
      const title = document.createElement('span')
      title.className = 'chat-title'
      title.textContent = chat.title
      title.title = `${agentName(chat.agent)}: ${chat.title}`
      const remove = button('Delete', () => void this.deleteChat(chat))
      remove.title = 'Delete this chat'
      this.toolbar.append(back, title, remove, this.fontButtons)
      this.input.placeholder = `Reply to ${agentName(chat.agent)}…`

      const log = document.createElement('div')
      log.className = 'chat-log'
      log.setAttribute('role', 'log')
      for (const entry of chat.entries) log.append(entryElement(entry, this.options.studio.chatImage))
      const working = document.createElement('div')
      working.className = 'chat-working'
      working.hidden = !chat.running
      log.append(working)
      this.content.append(log)
      this.renderAsks(chat)
      requestAnimationFrame(() => (log.scrollTop = log.scrollHeight))
      return
    }

    const select = document.createElement('select')
    select.setAttribute('aria-label', 'Agent for a new chat')
    for (const id of ['claude', 'codex'] as const) {
      const option = document.createElement('option')
      option.value = id
      const status = this.statuses.find((s) => s.id === id)
      option.textContent = status && status.state !== 'ready' ? `${agentName(id)} (not set up)` : agentName(id)
      option.selected = id === this.agent
      select.append(option)
    }
    select.addEventListener('change', () => {
      this.agent = select.value === 'codex' ? 'codex' : 'claude'
      try {
        localStorage.setItem(AGENT_KEY, this.agent)
      } catch {
        // Remembered for this run only.
      }
      this.render()
    })
    const label = document.createElement('span')
    label.className = 'chat-title'
    label.textContent = 'New chat with'
    this.toolbar.append(label, select, this.fontButtons)
    this.input.placeholder = noFolder ? 'Open a score first' : `Ask ${agentName(this.agent)} to change the score…`

    if (noFolder) {
      this.content.append(note('Open a score or a folder, then ask an agent to change it: “Transpose the melody up a tone”, “Add lyrics to the first line”.'))
      return
    }
    if (this.chats.length === 0) {
      this.content.append(note('The agent reads and edits the scores of this folder, and checks them with LilyPond. The file open in the editor, and any lines you select, go with your message.'))
      return
    }
    const list = document.createElement('ul')
    list.className = 'chat-list'
    for (const chat of this.chats) {
      const item = document.createElement('li')
      const open = button('', () => void this.openChat(chat.id))
      const title = document.createElement('span')
      title.className = 'chat-list-title'
      title.textContent = chat.title
      const meta = document.createElement('span')
      meta.className = 'chat-list-meta'
      meta.textContent = `${agentName(chat.agent)} · ${chat.asking ? 'waiting for your answer' : chat.running ? 'working…' : when(chat.updated)}`
      open.append(title, meta)
      open.title = chat.title
      item.append(open)
      list.append(item)
    }
    this.content.append(list)
  }

  /** The questions the open chat's agent waits on, above the line that says it waits (D52). */
  private renderAsks(chat: OpenChat): void {
    const log = this.content.querySelector<HTMLElement>('.chat-log')
    const working = log?.querySelector<HTMLElement>('.chat-working')
    if (!log || !working) return
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24
    const shown = new Set<string>()
    for (const card of log.querySelectorAll<HTMLElement>('.chat-ask')) {
      if (chat.asks.some((ask) => ask.id === card.dataset.ask)) shown.add(card.dataset.ask!)
      else card.remove()
    }
    for (const ask of chat.asks) {
      if (!shown.has(ask.id)) working.before(this.askElement(chat, ask))
    }
    working.textContent = chat.asks.length > 0 ? `${agentName(chat.agent)} is waiting for your answer` : `${agentName(chat.agent)} is working`
    working.classList.toggle('waiting', chat.asks.length > 0)
    if (atEnd) log.scrollTop = log.scrollHeight
  }

  private askElement(chat: OpenChat, ask: Ask): HTMLElement {
    const card = document.createElement('div')
    card.className = 'chat-ask'
    card.dataset.ask = ask.id
    card.setAttribute('role', 'group')
    card.setAttribute('aria-label', `${agentName(chat.agent)} asks to be allowed`)
    const question = document.createElement('div')
    question.className = 'chat-ask-question'
    question.textContent = `${agentName(chat.agent)} asks to ${ask.question}:`
    const what = document.createElement('div')
    what.className = 'chat-ask-text'
    what.textContent = ask.subject || ask.text
    card.append(question, what)
    if (ask.detail) {
      const detail = document.createElement('div')
      detail.className = 'chat-ask-detail'
      detail.textContent = ask.detail
      card.append(detail)
    }
    const actions = document.createElement('div')
    actions.className = 'chat-ask-actions'
    const answer = (decision: Decision) => async () => {
      for (const b of actions.querySelectorAll('button')) b.disabled = true
      try {
        await this.options.studio.chatAnswer(chat.id, ask.id, decision)
      } catch (error) {
        for (const b of actions.querySelectorAll('button')) b.disabled = false
        this.options.onError(error)
      }
    }
    const allow = button('Allow', () => void answer('allow')())
    allow.className = 'primary'
    allow.title = 'Allow this once'
    actions.append(allow)
    if (ask.always) {
      const always = button('Allow for This Chat', () => void answer('always')())
      always.title = `For the rest of this chat, allow ${ask.allows?.join(', ') ?? 'this'}`
      actions.append(always)
    }
    const deny = button('Deny', () => void answer('deny')())
    deny.title = 'Do not allow it; the agent is told and goes on without it'
    actions.append(deny)
    card.append(actions)
    return card
  }

  /** The agent the next message goes to. */
  private target(): AgentId {
    return this.view.kind === 'chat' ? this.view.chat.agent : this.agent
  }

  private renderModels(): void {
    const agent = this.target()
    const current = this.statuses.find((s) => s.id === agent)?.model ?? ''
    this.modelSelect.replaceChildren(
      ...modelChoices(agent, current).map(({ value, label }) => {
        const option = document.createElement('option')
        option.value = value
        option.textContent = label
        option.selected = value === current
        return option
      }),
    )
    this.modelSelect.title = `The model ${agentName(agent)} uses, from the next message on`
    this.modelSelect.disabled = this.folder === undefined
  }

  /** Sizes the chat's text: the messages, the message box and the menus under it. */
  private setFontSize(size: number, remember = true): void {
    this.fontSize = size
    this.options.chats.style.setProperty('--chat-font-size', `${size}px`)
    this.smaller.title = `Smaller text (⌘−); ${size} px now, ⌘0 for ${CHAT_FONT_DEFAULT} px`
    this.larger.title = `Larger text (⌘+); ${size} px now, ⌘0 for ${CHAT_FONT_DEFAULT} px`
    this.smaller.disabled = size <= CHAT_FONT_SIZES[0]!
    this.larger.disabled = size >= CHAT_FONT_SIZES[CHAT_FONT_SIZES.length - 1]!
    if (!remember) return
    try {
      localStorage.setItem(FONT_KEY, String(size))
    } catch {
      // Remembered for this run only.
    }
  }

  private choosePermission(): void {
    this.permission = PERMISSIONS.find((p) => p.id === this.permissionSelect.value)?.id ?? 'edit'
    try {
      localStorage.setItem(PERMISSION_KEY, this.permission)
    } catch {
      // Remembered for this run only.
    }
    this.render()
  }

  /** Keeps `model` as the agent's, as the setup's Model field does; the setup shows it too. */
  private async chooseModel(model: string): Promise<void> {
    const agent = this.target()
    const status = this.statuses.find((s) => s.id === agent)
    if (status) status.model = model || undefined
    this.renderSetup()
    try {
      await this.options.studio.setAgentModel(agent, model)
    } catch (error) {
      this.options.onError(error)
    }
  }

  private async deleteChat(chat: OpenChat): Promise<void> {
    if (!window.confirm(`Delete the chat “${chat.title}”? This cannot be undone.`)) return
    try {
      await this.options.studio.chatDelete(chat.id)
    } catch (error) {
      this.options.onError(error)
    }
    this.showList()
  }

  private renderSetup(): void {
    const { setup, studio } = this.options
    setup.replaceChildren()
    const intro = note('Agents work in the open folder: they read and edit its scores and run LilyPond to check them. Each needs to be installed, and signed in to once in Terminal.')
    const again = button('Check Again', () => void this.refreshSetup())
    const cards = this.statuses.map((status) => {
      const card = document.createElement('div')
      card.className = 'agent-card'
      card.dataset.state = status.state
      card.dataset.agent = status.id
      const heading = document.createElement('div')
      heading.className = 'agent-card-heading'
      const name = document.createElement('strong')
      name.textContent = agentName(status.id)
      const state = document.createElement('span')
      state.className = 'agent-card-state'
      state.textContent = status.state === 'ready' ? (status.version ? `✓ ${status.version}` : '✓ ready') : status.state === 'broken' ? '✕ does not start' : '✕ not found'
      heading.append(name, state)
      const detail = document.createElement('div')
      detail.className = 'agent-card-detail'
      detail.textContent = status.state === 'ready' ? (status.path ?? '') : status.message
      detail.title = status.path ?? ''
      const actions = document.createElement('div')
      actions.className = 'agent-card-actions'
      const choose = button('Choose…', () => void this.choose(status.id))
      choose.title = `Choose where the ${status.id} program is`
      actions.append(choose)
      if (status.state !== 'ready') actions.append(button('How to Install', () => void studio.openLink(status.id).catch(this.options.onError)))
      const model = document.createElement('label')
      model.className = 'agent-card-model'
      const modelText = document.createElement('span')
      modelText.textContent = 'Model'
      const modelInput = document.createElement('input')
      modelInput.type = 'text'
      modelInput.value = status.model ?? ''
      modelInput.placeholder = status.id === 'claude' ? 'default (e.g. sonnet, opus)' : 'default (e.g. gpt-5-codex)'
      modelInput.spellcheck = false
      modelInput.addEventListener('change', () => {
        status.model = modelInput.value.trim() || undefined
        this.renderModels()
        void studio.setAgentModel(status.id, modelInput.value).catch(this.options.onError)
      })
      model.append(modelText, modelInput)
      const signIn = document.createElement('div')
      signIn.className = 'agent-card-detail'
      signIn.textContent = `Sign in: run ${status.id === 'claude' ? 'claude' : 'codex login'} in Terminal once.`
      card.append(heading, detail, actions, model, signIn)
      return card
    })
    setup.append(intro, ...cards, again)
  }

  private async choose(agent: AgentId): Promise<void> {
    try {
      const status = await this.options.studio.chooseAgent(agent)
      if (!status) return
      this.statuses = this.statuses.map((s) => (s.id === agent ? status : s))
      this.renderSetup()
      this.render()
    } catch (error) {
      this.options.onError(error)
    }
  }
}

function agentName(id: AgentId): string {
  return id === 'claude' ? 'Claude Code' : 'Codex'
}

function note(text: string): HTMLElement {
  const element = document.createElement('p')
  element.className = 'chat-note'
  element.textContent = text
  return element
}

function when(time: number): string {
  const date = new Date(time)
  const today = new Date().toDateString() === date.toDateString()
  return today ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function entryElement(entry: ChatEntry, image: (file: string) => Promise<string | undefined>): HTMLElement {
  const element = document.createElement('div')
  element.className = `chat-entry ${entry.role}`
  if (entry.role !== 'agent') {
    element.textContent = entry.text
    if (entry.role === 'user' && entry.images?.length) element.append(entryImages(entry.images, image))
    return element
  }
  for (const run of textRuns(entry.text)) {
    if (run.kind === 'text') element.append(run.text)
    else {
      const code = document.createElement(run.kind === 'block' ? 'pre' : 'code')
      code.textContent = run.text
      element.append(code)
    }
  }
  return element
}

/** A message's pasted images, loaded from where the Rust side saved them. */
function entryImages(files: string[], image: (file: string) => Promise<string | undefined>): HTMLElement {
  const strip = document.createElement('div')
  strip.className = 'chat-images'
  for (const file of files) {
    const img = document.createElement('img')
    img.alt = 'Pasted image'
    img.title = file
    strip.append(img)
    image(file).then(
      (url) => {
        if (url) img.src = url
        else img.replaceWith(Object.assign(document.createElement('span'), { className: 'chat-image-gone', textContent: 'Image no longer available' }))
      },
      () => img.remove(),
    )
  }
  return strip
}

/** The image files of a paste or a drop. */
function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []
  for (const item of data.items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}

function dataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read.'))
    reader.readAsDataURL(file)
  })
}
