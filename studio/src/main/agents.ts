// Coding agents in the sidebar (DECISIONS D40): Claude Code and Codex, as the
// user installed them, run headless in the open folder, one process per turn.
// This module finds them, builds their arguments and reads their JSONL into
// chat entries. No `electron` here, so the tests run it under plain Node;
// main.ts adds the dialogs, the chat store and the IPC.
import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export type AgentId = 'claude' | 'codex'

export const AGENTS: readonly { id: AgentId; label: string; command: string; signIn: string }[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', signIn: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex', signIn: 'codex login' },
]

export const isAgentId = (value: unknown): value is AgentId => AGENTS.some((agent) => agent.id === value)
export const agentLabel = (id: AgentId): string => AGENTS.find((agent) => agent.id === id)?.label ?? id

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
  | { role: 'user'; text: string }
  | { role: 'agent'; text: string }
  /** Something the agent did: read or edited a file, ran a command. */
  | { role: 'tool'; text: string }
  | { role: 'error'; text: string }

/** What one line of an agent's JSONL means to the chat. */
export type AgentEvent =
  | { kind: 'session'; id: string }
  | { kind: 'entry'; entry: ChatEntry }
  /** The turn ended; `ok` is false when the agent reported a failure. */
  | { kind: 'done'; ok: boolean }

// ---------------------------------------------------------------------------
// Finding the agents

/**
 * The PATH of the user's login shell. An app opened from the Finder gets only
 * `/usr/bin:/bin:/usr/sbin:/sbin`, but the agents are installed by npm, bun,
 * Homebrew or their own installers into directories the shell's profile adds,
 * and Codex from npm needs `node` from there too. Asked once; empty when the
 * shell does not answer within five seconds.
 */
let loginPath: Promise<string> | undefined
export function loginShellPath(): Promise<string> {
  loginPath ??= new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    const marker = '__LILY_STUDIO_PATH__'
    execFile(shell, ['-ilc', `printf '%s%s%s' ${marker} "$PATH" ${marker}`], { timeout: 5_000, env: process.env }, (_error, stdout) => {
      const match = new RegExp(`${marker}(.*?)${marker}`, 's').exec(String(stdout ?? ''))
      resolve(match?.[1] ?? '')
    })
  })
  return loginPath
}

/** Where the agents' installers put them when the shell's PATH does not say. */
export function agentDirs(home = os.homedir()): string[] {
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
}

/** The PATH the agents run with: the login shell's, then the app's own, then agentDirs(). */
export function agentPath(login: string, current: string | undefined, home?: string): string {
  const dirs = [...login.split(path.delimiter), ...(current ?? '').split(path.delimiter), ...agentDirs(home)].filter(Boolean)
  return [...new Set(dirs)].join(path.delimiter)
}

/**
 * The environment of an agent run. The variables a parent Claude Code or
 * Electron sets are left out: they would make the agent think it is nested,
 * or make Electron's own binary act as Node.
 */
export function agentEnv(pathValue: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, PATH: pathValue, NO_COLOR: '1' }
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete result[name]
  return result
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return false
    await fs.access(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The first executable `command` on `pathValue`. */
export async function which(command: string, pathValue: string): Promise<string | undefined> {
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, command)
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

export interface DetectAgentOptions {
  /** A path chosen in the setup; else `command` on `pathValue`. */
  configuredPath?: string
  model?: string
  pathValue: string
  env?: NodeJS.ProcessEnv
  /** Runs `<binary> --version`; tests pass a stand-in. */
  version?(binary: string): Promise<string>
}

export async function detectAgent(id: AgentId, options: DetectAgentOptions): Promise<AgentStatus> {
  const agent = AGENTS.find((a) => a.id === id)!
  const chosen = options.configuredPath?.trim() || undefined
  const extra = { ...(chosen ? { chosen } : {}), ...(options.model ? { model: options.model } : {}) }
  const binary = chosen ? ((await isExecutable(chosen)) ? chosen : undefined) : await which(agent.command, options.pathValue)
  if (!binary) {
    const message = chosen
      ? `${agent.label} could not be found at ${chosen}. Choose it again.`
      : `${agent.label} is not installed, or Lily Studio cannot find it.`
    return { id, state: 'missing', message, ...extra }
  }
  let output: string
  try {
    output = await (options.version ?? ((b) => runVersion(b, options.env ?? agentEnv(options.pathValue))))(binary)
  } catch {
    return { id, state: 'broken', path: binary, message: `${agent.label} was found at ${binary}, but it did not start.`, ...extra }
  }
  const version = /\d+\.\d+(?:\.\d+)?/.exec(output)?.[0]
  return { id, state: 'ready', path: binary, ...(version ? { version } : {}), message: `${agent.label}${version ? ` ${version}` : ''} is ready.`, ...extra }
}

function runVersion(binary: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['--version'], { timeout: 20_000, env }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })
}

// ---------------------------------------------------------------------------
// Arguments

export interface TurnOptions {
  /** The whole prompt of this turn, context included (see `turnPrompt`). */
  prompt: string
  /** The agent's own session to continue; undefined for a chat's first turn. */
  sessionId?: string
  model?: string
  /** The LilyPond executable the agent may run to check its edits. */
  lilypond?: string
}

/**
 * The command line of one turn. Both agents may read and edit files in the
 * folder they run in and run LilyPond, and nothing asks for permission while
 * they work: there is no one at a terminal to answer.
 *
 * Claude Code: `--permission-mode acceptEdits` accepts edits inside the
 * folder; the allowed tools add LilyPond and nothing else that runs commands.
 * Codex: its `workspace-write` sandbox lets commands write only in the folder
 * and the temp directory, without network. `codex exec resume` takes neither
 * `--sandbox` nor `--cd`, so both are given as config and working directory.
 */
export function agentArgs(id: AgentId, turn: TurnOptions): string[] {
  const model = turn.model?.trim()
  if (id === 'claude') {
    const tools = ['Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'LS', 'TodoWrite', 'Bash(lilypond:*)']
    if (turn.lilypond) tools.push(`Bash(${turn.lilypond}:*)`)
    return [
      '-p',
      turn.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      ...tools,
      ...(turn.sessionId ? ['--resume', turn.sessionId] : []),
      ...(model ? ['--model', model] : []),
    ]
  }
  return [
    'exec',
    ...(turn.sessionId ? ['resume'] : []),
    '--json',
    '--skip-git-repo-check',
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'approval_policy="never"',
    ...(model ? ['-m', model] : []),
    ...(turn.sessionId ? [turn.sessionId] : []),
    turn.prompt,
  ]
}

export interface PromptContext {
  /** The open folder, where the agent runs. */
  folder: string
  /** The file in the editor. */
  file?: string
  /** The selected lines in it, 1-based, and their text. */
  selection?: { startLine: number; endLine: number; text: string }
  lilypond?: string
  /** The first turn of a chat carries the instructions; the agent keeps them. */
  first: boolean
}

/**
 * Where an agent's check compiles write: in the temp directory, never next to
 * the sources. The studio creates it before each turn, as an agent may not run
 * `mkdir` (see agentArgs).
 */
export const agentOutDir = (): string => path.join(os.tmpdir(), 'lily-studio-agent')

/** The instructions of a chat's first turn: who the user is and how to check a score. */
export function instructions(context: Pick<PromptContext, 'lilypond'>): string {
  const lilypond = context.lilypond ?? 'lilypond'
  const outDir = agentOutDir()
  return [
    'You are working inside Lily Studio, a desktop editor for LilyPond scores, at the request of its user.',
    'The user may be a musician rather than a programmer: answer briefly and in plain words, and talk about the music rather than the code.',
    'Edit the .ly and .ily files of this folder directly. Lily Studio reloads a changed file in its editor and engraves the score again by itself.',
    `After an edit, check that the score still compiles: \`${lilypond} -dbackend=svg -o ${outDir}/check <score.ly>\`, run on the score that has \\score or \\book, even when you edited a file it \\includes.`,
    'Never write output files next to the sources. If lilypond reports errors, fix the first one and compile again.',
    'A `warning: bar check failed` means the bar before that | has the wrong length: recount it, do not remove the bar check. Keep each file\'s \\version line.',
  ].join('\n')
}

/** The prompt of one turn: the instructions on the first, then where the user is, then what they wrote. */
export function turnPrompt(text: string, context: PromptContext): string {
  const parts: string[] = []
  if (context.first) parts.push(`<lily-studio>\n${instructions(context)}\n</lily-studio>`)
  const where: string[] = []
  if (context.file) where.push(`The file open in the editor is ${relativeTo(context.folder, context.file)}.`)
  if (context.selection) {
    const { startLine, endLine, text: selected } = context.selection
    const lines = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`
    where.push(`The user has selected ${lines} of it:\n\`\`\`lilypond\n${selected}\n\`\`\``)
  }
  if (where.length > 0) parts.push(`<editor>\n${where.join('\n')}\n</editor>`)
  parts.push(text)
  return parts.join('\n\n')
}

/**
 * `file` relative to `folder` when inside it, else as it is. `folder` may be
 * given as several spellings of one directory: an agent may report its files
 * under the real path (`/private/var/…` for `/var/…` on macOS).
 */
export function relativeTo(folder: string | readonly string[], file: string): string {
  for (const root of typeof folder === 'string' ? [folder] : folder) {
    const relative = path.relative(root, file)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative
  }
  return file
}

/** A folder's spellings for relativeTo: as given, and its real path when that differs. */
export async function spellings(folder: string): Promise<string[]> {
  const real = await fs.realpath(folder).catch(() => folder)
  return real === folder ? [folder] : [folder, real]
}

// ---------------------------------------------------------------------------
// Reading the output

const MAX_TOOL_TEXT = 160

function short(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_TOOL_TEXT ? `${line.slice(0, MAX_TOOL_TEXT - 1)}…` : line
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A tool call of Claude Code, in words; undefined for bookkeeping that says nothing. */
function claudeTool(name: string, input: Record<string, unknown>, cwd: string | readonly string[]): string | undefined {
  const file = str(input.file_path) || str(input.path) || str(input.notebook_path)
  const where = file ? relativeTo(cwd, file) : ''
  switch (name) {
    case 'Read':
      return `Read ${where}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Edited ${where}`
    case 'Write':
      return `Wrote ${where}`
    case 'Bash':
      return `Ran ${short(str(input.command))}`
    case 'Glob':
    case 'Grep':
      return `Searched for ${short(str(input.pattern))}`
    case 'LS':
      return `Listed ${where || '.'}`
    case 'TodoWrite':
      return undefined
    default:
      return `Used ${name}`
  }
}

/**
 * One line of `claude -p --output-format stream-json --verbose`: the session
 * id from `system/init`, the text and tool calls of `assistant` messages, and
 * the `result` that ends the turn.
 */
export function parseClaudeLine(line: string, cwd: string | readonly string[]): AgentEvent[] {
  let event: Record<string, unknown>
  try {
    event = record(JSON.parse(line))
  } catch {
    return []
  }
  const events: AgentEvent[] = []
  if (event.type === 'system' && event.subtype === 'init' && str(event.session_id)) {
    events.push({ kind: 'session', id: str(event.session_id) })
  } else if (event.type === 'assistant') {
    const content = record(event.message).content
    for (const block of Array.isArray(content) ? content : []) {
      const part = record(block)
      if (part.type === 'text' && str(part.text).trim()) events.push({ kind: 'entry', entry: { role: 'agent', text: str(part.text).trim() } })
      if (part.type === 'tool_use') {
        const text = claudeTool(str(part.name), record(part.input), cwd)
        if (text) events.push({ kind: 'entry', entry: { role: 'tool', text } })
      }
    }
  } else if (event.type === 'result') {
    const denials = Array.isArray(event.permission_denials) ? event.permission_denials : []
    const denied = [...new Set(denials.map((d) => claudeTool(str(record(d).tool_name), record(record(d).tool_input), cwd) ?? str(record(d).tool_name)))]
    if (denied.length > 0) events.push({ kind: 'entry', entry: { role: 'error', text: `Not allowed in Lily Studio: ${denied.join('; ')}` } })
    const failed = event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')
    if (failed) events.push({ kind: 'entry', entry: { role: 'error', text: str(event.result) || `Claude Code stopped: ${str(event.subtype) || 'error'}` } })
    events.push({ kind: 'done', ok: !failed })
  }
  return events
}

/** `/bin/zsh -lc "cat a.ly"` → `cat a.ly`: Codex runs each command through a shell. */
export function unwrapShell(command: string): string {
  const match = /^\S*\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim())
  return match?.[2] ?? command
}

/**
 * One line of `codex exec --json`: `thread.started` names the session,
 * completed items are what the agent said and did, and `turn.completed` or
 * `turn.failed` ends the turn.
 */
export function parseCodexLine(line: string, cwd: string | readonly string[]): AgentEvent[] {
  let event: Record<string, unknown>
  try {
    event = record(JSON.parse(line))
  } catch {
    return []
  }
  switch (event.type) {
    case 'thread.started':
      return str(event.thread_id) ? [{ kind: 'session', id: str(event.thread_id) }] : []
    case 'turn.completed':
      return [{ kind: 'done', ok: true }]
    case 'turn.failed':
      return [
        { kind: 'entry', entry: { role: 'error', text: str(record(event.error).message) || 'Codex stopped with an error.' } },
        { kind: 'done', ok: false },
      ]
    case 'error':
      return str(event.message) ? [{ kind: 'entry', entry: { role: 'error', text: str(event.message) } }] : []
    case 'item.completed':
      break
    default:
      return []
  }
  const item = record(event.item)
  switch (item.type) {
    case 'agent_message':
      return str(item.text).trim() ? [{ kind: 'entry', entry: { role: 'agent', text: str(item.text).trim() } }] : []
    case 'command_execution': {
      const code = typeof item.exit_code === 'number' && item.exit_code !== 0 ? ` (exit code ${item.exit_code})` : ''
      return [{ kind: 'entry', entry: { role: 'tool', text: `Ran ${short(unwrapShell(str(item.command)))}${code}` } }]
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes.map(record) : []
      const verb = (kind: string) => (kind === 'add' ? 'Wrote' : kind === 'delete' ? 'Deleted' : 'Edited')
      return changes.map((change) => ({ kind: 'entry', entry: { role: 'tool', text: `${verb(str(change.kind))} ${relativeTo(cwd, str(change.path))}` } }))
    }
    case 'mcp_tool_call':
      return [{ kind: 'entry', entry: { role: 'tool', text: `Used ${str(item.tool) || str(item.server) || 'a tool'}` } }]
    case 'web_search':
      return [{ kind: 'entry', entry: { role: 'tool', text: `Searched the web for ${short(str(item.query))}` } }]
    case 'error':
      return str(item.message) ? [{ kind: 'entry', entry: { role: 'error', text: str(item.message) } }] : []
    default:
      // reasoning, todo_list: the agent's own bookkeeping.
      return []
  }
}

export const parseAgentLine = (id: AgentId, line: string, cwd: string | readonly string[]): AgentEvent[] =>
  id === 'claude' ? parseClaudeLine(line, cwd) : parseCodexLine(line, cwd)

// ---------------------------------------------------------------------------
// Running a turn

export interface RunOptions {
  id: AgentId
  binary: string
  args: string[]
  cwd: string
  /** The spellings of `cwd` that paths in the output are made relative to; `cwd` by default. */
  roots?: readonly string[]
  env: NodeJS.ProcessEnv
  onEvent(event: AgentEvent): void
}

export interface AgentRun {
  /** Resolves when the process has exited and every event was delivered. */
  readonly done: Promise<void>
  stop(): void
}

/**
 * Runs one turn. Events arrive line by line; a turn that ends without its
 * closing event (the agent crashed, was not signed in, or was stopped) gets an
 * error entry with the end of stderr, and a `done`.
 */
export function runAgent(options: RunOptions): AgentRun {
  const { id, binary, args, cwd, env, onEvent } = options
  const roots = options.roots ?? [cwd]
  let finished = false
  let stopped = false
  let stderr = ''
  const emit = (event: AgentEvent) => {
    if (event.kind === 'done') finished = true
    onEvent(event)
  }
  // Its own process group, so Stop ends the commands the agent started too.
  const child = spawn(binary, args, { cwd, env: { ...env, PWD: cwd }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    let newline: number
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line) for (const event of parseAgentLine(id, line, roots)) emit(event)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4_000)
  })
  const done = new Promise<void>((resolve) => {
    const end = (message: string | undefined) => {
      if (buffered.trim()) for (const event of parseAgentLine(id, buffered.trim(), roots)) emit(event)
      buffered = ''
      if (!finished) {
        if (message) emit({ kind: 'entry', entry: { role: 'error', text: message } })
        emit({ kind: 'done', ok: false })
      }
      resolve()
    }
    child.on('error', (error) => end(`${agentLabel(id)} did not start: ${error.message}`))
    child.on('close', (code) => {
      if (stopped) return end('Stopped.')
      const tail = stderr.trim().split('\n').slice(-6).join('\n')
      end(`${agentLabel(id)} ended unexpectedly${code !== null ? ` (exit code ${code})` : ''}.${tail ? `\n${tail}` : ''}`)
    })
  })
  return {
    done,
    stop() {
      if (stopped || child.exitCode !== null || child.pid === undefined) return
      stopped = true
      try {
        if (process.platform === 'win32') child.kill()
        else process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill()
      }
    },
  }
}
