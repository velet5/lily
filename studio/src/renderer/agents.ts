// The agents' accordion in the sidebar (DECISIONS D40). Agent chats: the chats
// of the open folder, and one chat at a time with what its agent said and did;
// a message starts a turn of Claude Code or Codex in the folder. Agent setup:
// where each agent is, its version, and the model it uses. `textRuns` is pure
// so the tests can run it without a DOM.
import type { AgentId, AgentStatus, ChatEntry, ChatEvent, ChatInfo, OpenChat, Permission } from '../ipc'
import type { StudioApi } from './bridge'
import { button } from './files'

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
  private readonly sendButton = document.createElement('button')
  private readonly permissionSelect = document.createElement('select')
  /** The model of the agent the next message goes to: the open chat's, or the one chosen for a new chat. */
  private readonly modelSelect = document.createElement('select')

  constructor(private readonly options: AgentPanelOptions) {
    try {
      if (localStorage.getItem(AGENT_KEY) === 'codex') this.agent = 'codex'
      const permission = PERMISSIONS.find((p) => p.id === localStorage.getItem(PERMISSION_KEY))
      if (permission) this.permission = permission.id
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
    this.composer.append(this.attached, this.input, bar)
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
    options.chats.append(this.toolbar, this.content, this.composer)
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

  /** Sends `text`, from the message box or a menu; the box keeps its draft for a menu's. */
  private async send(value: string, fromInput: boolean): Promise<void> {
    const { studio } = this.options
    const text = value.trim()
    if (!text || this.sending) return
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
      })
      if (fromInput) this.input.value = ''
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
    if (event.kind === 'entry') {
      if (!open) return
      open.entries.push(event.entry)
      const log = this.content.querySelector<HTMLElement>('.chat-log')
      if (!log) return
      const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24
      log.querySelector('.chat-working')?.before(entryElement(event.entry))
      if (atEnd) log.scrollTop = log.scrollHeight
      return
    }
    const listed = this.chats.find((chat) => chat.id === event.chatId)
    if (listed) listed.running = event.running
    if (open) {
      open.running = event.running
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
      this.toolbar.append(back, title, remove)
      this.input.placeholder = `Reply to ${agentName(chat.agent)}…`

      const log = document.createElement('div')
      log.className = 'chat-log'
      log.setAttribute('role', 'log')
      for (const entry of chat.entries) log.append(entryElement(entry))
      const working = document.createElement('div')
      working.className = 'chat-working'
      working.textContent = `${agentName(chat.agent)} is working`
      working.hidden = !chat.running
      log.append(working)
      this.content.append(log)
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
    this.toolbar.append(label, select)
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
      meta.textContent = `${agentName(chat.agent)} · ${chat.running ? 'working…' : when(chat.updated)}`
      open.append(title, meta)
      open.title = chat.title
      item.append(open)
      list.append(item)
    }
    this.content.append(list)
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

function entryElement(entry: ChatEntry): HTMLElement {
  const element = document.createElement('div')
  element.className = `chat-entry ${entry.role}`
  if (entry.role !== 'agent') {
    element.textContent = entry.text
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
