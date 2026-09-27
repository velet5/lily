import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { AgentChats, type ChatEvent } from '../src/main/agentChats'
import {
  agentArgs,
  agentEnv,
  agentPath,
  detectAgent,
  parseClaudeLine,
  parseCodexLine,
  relativeTo,
  runAgent,
  turnPrompt,
  unwrapShell,
  type AgentEvent,
} from '../src/main/agents'
import { chatTitle, ChatStore } from '../src/main/chats'
import { readSettings, writeSettings } from '../src/main/lilypondSetup'
import { contextLabel, SELECTION_ACTIONS, textRuns } from '../src/renderer/agents'
import { clampHeight, clampWidth, FILES_MIN, SIDEBAR_WIDTH } from '../src/renderer/sidebar'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/).

let scratch: string

before(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-agents-')))
})

after(() => fs.rm(scratch, { recursive: true, force: true }))

const cwd = '/Users/me/Scores'

describe('agentArgs', () => {
  test('Claude Code: headless stream-json, edits accepted, LilyPond the only command', () => {
    const args = agentArgs('claude', { prompt: 'Hi', lilypond: '/opt/lilypond/bin/lilypond', model: ' sonnet ' })
    assert.deepEqual(args.slice(0, 8), ['-p', 'Hi', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools'])
    assert.ok(args.includes('Bash(/opt/lilypond/bin/lilypond:*)'))
    assert.ok(args.includes('Bash(lilypond:*)'))
    assert.ok(!args.includes('Bash'), 'no unrestricted Bash')
    assert.deepEqual(args.slice(-2), ['--model', 'sonnet'])
    assert.ok(!args.includes('--resume'))
  })

  test('Claude Code: a later turn resumes the session', () => {
    const args = agentArgs('claude', { prompt: 'More', sessionId: 'abc' })
    assert.equal(args[args.indexOf('--resume') + 1], 'abc')
    assert.ok(!args.includes('--model'))
  })

  test('Codex: exec --json in the workspace-write sandbox, the prompt last', () => {
    assert.deepEqual(agentArgs('codex', { prompt: 'Hi' }), [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'approval_policy="never"',
      'Hi',
    ])
  })

  test('Codex: a later turn is exec resume <id>, with the sandbox as config', () => {
    const args = agentArgs('codex', { prompt: 'More', sessionId: 't-1', model: 'gpt-5' })
    assert.deepEqual(args.slice(0, 2), ['exec', 'resume'])
    assert.ok(!args.includes('--sandbox') && !args.includes('-C'), 'resume takes neither')
    assert.deepEqual(args.slice(-4), ['-m', 'gpt-5', 't-1', 'More'])
  })
})

describe('turnPrompt', () => {
  const context = { folder: cwd, file: `${cwd}/parts/violin.ily`, lilypond: '/bin/lilypond', first: true }

  test('the first turn carries the instructions, the file and the selection', () => {
    const prompt = turnPrompt('Make it louder', { ...context, selection: { startLine: 3, endLine: 4, text: 'c4 d' } })
    assert.match(prompt, /^<lily-studio>\n/)
    assert.match(prompt, /\/bin\/lilypond -dbackend=svg -o /)
    assert.match(prompt, /The file open in the editor is parts\/violin\.ily\./)
    assert.match(prompt, /selected lines 3–4 of it:\n```lilypond\nc4 d\n```/)
    assert.ok(prompt.endsWith('\n\nMake it louder'))
  })

  test('later turns only say where the user is', () => {
    const prompt = turnPrompt('Again', { ...context, first: false })
    assert.ok(!prompt.includes('<lily-studio>'))
    assert.equal(prompt, '<editor>\nThe file open in the editor is parts/violin.ily.\n</editor>\n\nAgain')
    assert.equal(turnPrompt('Just this', { folder: cwd, first: false }), 'Just this')
  })
})

describe('parseClaudeLine', () => {
  // Lines of `claude -p --output-format stream-json --verbose` 2.1, shortened.
  test('the session, text, tool calls and the result', () => {
    assert.deepEqual(parseClaudeLine('{"type":"system","subtype":"init","cwd":"/x","session_id":"6ff8","tools":[]}', cwd), [
      { kind: 'session', id: '6ff8' },
    ])
    assert.deepEqual(parseClaudeLine('{"type":"system","subtype":"thinking_tokens","estimated_tokens":50}', cwd), [])
    const edit = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/a.ly`, old_string: 'f', new_string: 'g' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'lilypond -dbackend=svg -o /tmp/x a.ly' } },
          { type: 'tool_use', name: 'TodoWrite', input: {} },
          { type: 'text', text: 'Done.\n' },
        ],
      },
    })
    assert.deepEqual(parseClaudeLine(edit, cwd), [
      { kind: 'entry', entry: { role: 'tool', text: 'Edited a.ly' } },
      { kind: 'entry', entry: { role: 'tool', text: 'Ran lilypond -dbackend=svg -o /tmp/x a.ly' } },
      { kind: 'entry', entry: { role: 'agent', text: 'Done.' } },
    ])
    assert.deepEqual(parseClaudeLine('{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}', cwd), [])
    assert.deepEqual(parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"result":"Done.","permission_denials":[]}', cwd), [
      { kind: 'done', ok: true },
    ])
  })

  test('a failed turn and denied tools become errors', () => {
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Invalid API key · Please run /login',
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }],
    })
    assert.deepEqual(parseClaudeLine(result, cwd), [
      { kind: 'entry', entry: { role: 'error', text: 'Not allowed in Lily Studio: Ran rm -rf build' } },
      { kind: 'entry', entry: { role: 'error', text: 'Invalid API key · Please run /login' } },
      { kind: 'done', ok: false },
    ])
  })

  test('not JSON: nothing', () => {
    assert.deepEqual(parseClaudeLine('Warning: something', cwd), [])
  })
})

describe('parseCodexLine', () => {
  // Lines of `codex exec --json` 0.157, shortened.
  test('the thread, messages, commands, file changes and the end of the turn', () => {
    assert.deepEqual(parseCodexLine('{"type":"thread.started","thread_id":"01a0"}', cwd), [{ kind: 'session', id: '01a0' }])
    assert.deepEqual(parseCodexLine('{"type":"turn.started"}', cwd), [])
    assert.deepEqual(parseCodexLine('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll update the note.\\n"}}', cwd), [
      { kind: 'entry', entry: { role: 'agent', text: 'I’ll update the note.' } },
    ])
    assert.deepEqual(
      parseCodexLine('{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc \'cat a.ly\'","status":"in_progress"}}', cwd),
      [],
    )
    assert.deepEqual(
      parseCodexLine('{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc \'cat a.ly\'","exit_code":0,"status":"completed"}}', cwd),
      [{ kind: 'entry', entry: { role: 'tool', text: 'Ran cat a.ly' } }],
    )
    assert.deepEqual(
      parseCodexLine('{"type":"item.completed","item":{"id":"item_4","type":"command_execution","command":"/bin/zsh -lc lilypond","exit_code":1,"status":"failed"}}', cwd),
      [{ kind: 'entry', entry: { role: 'tool', text: 'Ran /bin/zsh -lc lilypond (exit code 1)' } }],
    )
    const change = JSON.stringify({
      type: 'item.completed',
      item: { type: 'file_change', changes: [{ path: `${cwd}/a.ly`, kind: 'update' }, { path: `${cwd}/b.ly`, kind: 'add' }], status: 'completed' },
    })
    assert.deepEqual(parseCodexLine(change, cwd), [
      { kind: 'entry', entry: { role: 'tool', text: 'Edited a.ly' } },
      { kind: 'entry', entry: { role: 'tool', text: 'Wrote b.ly' } },
    ])
    assert.deepEqual(parseCodexLine('{"type":"item.completed","item":{"type":"reasoning","text":"…"}}', cwd), [])
    assert.deepEqual(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":1}}', cwd), [{ kind: 'done', ok: true }])
  })

  test('a failed turn', () => {
    assert.deepEqual(parseCodexLine('{"type":"turn.failed","error":{"message":"Not signed in"}}', cwd), [
      { kind: 'entry', entry: { role: 'error', text: 'Not signed in' } },
      { kind: 'done', ok: false },
    ])
  })

  test('unwrapShell', () => {
    assert.equal(unwrapShell(`/bin/zsh -lc 'cat a.ly'`), 'cat a.ly')
    assert.equal(unwrapShell('/bin/bash -lc "ls -la"'), 'ls -la')
    assert.equal(unwrapShell('ls'), 'ls')
  })
})

describe('paths and environment', () => {
  test('relativeTo takes any spelling of the folder', () => {
    assert.equal(relativeTo(['/var/x', '/private/var/x'], '/private/var/x/a.ly'), 'a.ly')
    assert.equal(relativeTo('/var/x', '/elsewhere/a.ly'), '/elsewhere/a.ly')
  })

  test('agentPath: the login shell first, then the app, then the installers', () => {
    const value = agentPath('/login/bin:/usr/bin', '/usr/bin:/bin', '/home/me').split(path.delimiter)
    assert.deepEqual(value.slice(0, 3), ['/login/bin', '/usr/bin', '/bin'])
    assert.ok(value.includes('/home/me/.local/bin'))
    assert.equal(new Set(value).size, value.length)
  })

  test('agentEnv drops what would make the agent think it is nested', () => {
    const env = agentEnv('/p', { CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1', HOME: '/h' })
    assert.deepEqual(env, { HOME: '/h', PATH: '/p', NO_COLOR: '1' })
  })
})

describe('detectAgent', () => {
  test('found on the PATH, with its version', async () => {
    const bin = path.join(scratch, 'bin')
    await fs.mkdir(bin, { recursive: true })
    await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\necho "codex-cli 0.157.0"\n', { mode: 0o755 })
    const status = await detectAgent('codex', { pathValue: bin, model: 'gpt-5' })
    assert.deepEqual(status, { id: 'codex', state: 'ready', path: path.join(bin, 'codex'), version: '0.157.0', model: 'gpt-5', message: 'Codex 0.157.0 is ready.' })
  })

  test('missing, and a chosen path that is gone', async () => {
    assert.equal((await detectAgent('claude', { pathValue: '' })).state, 'missing')
    const status = await detectAgent('claude', { pathValue: '', configuredPath: '/nowhere/claude' })
    assert.equal(status.state, 'missing')
    assert.equal(status.chosen, '/nowhere/claude')
  })

  test('broken when it does not answer --version', async () => {
    const status = await detectAgent('claude', { pathValue: path.join(scratch, 'bin'), configuredPath: path.join(scratch, 'bin', 'codex'), version: async () => Promise.reject(new Error('no')) })
    assert.equal(status.state, 'broken')
  })
})

/** A stand-in agent: prints `lines`, then exits with `code`. */
async function fakeAgent(name: string, lines: string[], code = 0): Promise<string> {
  const file = path.join(scratch, name)
  const body = lines.map((line) => `printf '%s\\n' '${line.replace(/'/g, `'\\''`)}'`).join('\n')
  await fs.writeFile(file, `#!/bin/sh\n${body}\nexit ${code}\n`, { mode: 0o755 })
  return file
}

describe('runAgent', () => {
  test('events line by line, until done', async () => {
    const binary = await fakeAgent('ok-agent', ['{"type":"thread.started","thread_id":"t"}', 'noise', '{"type":"item.completed","item":{"type":"agent_message","text":"Hi"}}', '{"type":"turn.completed"}'])
    const events: AgentEvent[] = []
    await runAgent({ id: 'codex', binary, args: [], cwd: scratch, env: process.env, onEvent: (e) => events.push(e) }).done
    assert.deepEqual(events, [{ kind: 'session', id: 't' }, { kind: 'entry', entry: { role: 'agent', text: 'Hi' } }, { kind: 'done', ok: true }])
  })

  test('a crash without a result: an error with the end of stderr', async () => {
    const binary = path.join(scratch, 'crash-agent')
    await fs.writeFile(binary, '#!/bin/sh\necho "not logged in" >&2\nexit 3\n', { mode: 0o755 })
    const events: AgentEvent[] = []
    await runAgent({ id: 'claude', binary, args: [], cwd: scratch, env: process.env, onEvent: (e) => events.push(e) }).done
    assert.deepEqual(events, [{ kind: 'entry', entry: { role: 'error', text: 'Claude Code ended unexpectedly (exit code 3).\nnot logged in' } }, { kind: 'done', ok: false }])
  })

  test('stop ends it, and says so', async () => {
    const binary = path.join(scratch, 'slow-agent')
    await fs.writeFile(binary, '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
    const events: AgentEvent[] = []
    const run = runAgent({ id: 'codex', binary, args: [], cwd: scratch, env: process.env, onEvent: (e) => events.push(e) })
    setTimeout(() => run.stop(), 100)
    await run.done
    assert.deepEqual(events, [{ kind: 'entry', entry: { role: 'error', text: 'Stopped.' } }, { kind: 'done', ok: false }])
  })
})

describe('ChatStore and AgentChats', () => {
  test('a chat per folder, kept across stores', async () => {
    const file = path.join(scratch, 'store', 'chats.json')
    const store = new ChatStore(file)
    const a = await store.create('claude', '/one', 'Transpose   the melody\nup a tone', 1)
    await store.create('codex', '/two', 'Other', 2)
    await store.append(a.id, { role: 'user', text: 'Transpose' }, 3)
    await store.setSession(a.id, 's-1')
    const again = new ChatStore(file)
    const listed = await again.list('/one')
    assert.deepEqual(listed.map((c) => [c.title, c.agent, c.sessionId, c.updated]), [['Transpose the melody up a tone', 'claude', 's-1', 3]])
    assert.deepEqual((await again.get(a.id))?.entries, [{ role: 'user', text: 'Transpose' }])
    await again.delete(a.id)
    assert.deepEqual(await new ChatStore(file).list('/one'), [])
  })

  test('chatTitle', () => {
    assert.equal(chatTitle('  '), 'New chat')
    assert.equal(chatTitle('x'.repeat(100)).length, 60)
  })

  test('a message runs a turn, and the next continues its session', async () => {
    const folder = path.join(scratch, 'score')
    await fs.mkdir(folder, { recursive: true })
    // Answers with its arguments, so the test sees what it was given.
    const binary = path.join(scratch, 'echo-agent')
    await fs.writeFile(
      binary,
      `#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"s-9"}'
resumed=no
for arg in "$@"; do [ "$arg" = "--resume" ] && resumed=yes; done
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"'"$PWD"'/a.ly"}},{"type":"text","text":"resumed: '$resumed'"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'
`,
      { mode: 0o755 },
    )
    const events: ChatEvent[] = []
    const chats = new AgentChats({
      store: new ChatStore(path.join(scratch, 'chats2.json')),
      emit: (event) => events.push(event),
      status: async (id) => ({ id, state: 'ready', path: binary, message: 'ready' }),
      lilypond: async () => '/bin/lilypond',
      env: async () => process.env,
    })
    const id = await chats.send({ agent: 'claude', text: 'Edit it', file: path.join(folder, 'a.ly') }, folder)
    await assert.rejects(chats.send({ chatId: id, text: 'Too soon' }, folder), /still working/)
    await chats.settled(id)
    await chats.send({ chatId: id, text: 'Again' }, folder)
    await chats.settled(id)
    const chat = await chats.get(id, folder)
    assert.equal(chat?.sessionId, 's-9')
    assert.deepEqual(chat?.entries, [
      { role: 'user', text: 'Edit it' },
      { role: 'tool', text: 'Edited a.ly' },
      { role: 'agent', text: 'resumed: no' },
      { role: 'user', text: 'Again' },
      { role: 'tool', text: 'Edited a.ly' },
      { role: 'agent', text: 'resumed: yes' },
    ])
    assert.deepEqual(
      events.filter((e) => e.kind === 'running').map((e) => e.kind === 'running' && e.running),
      [true, false, true, false],
    )
    assert.equal(await chats.get(id, '/another/folder'), undefined)
    await assert.rejects(chats.send({ chatId: id, text: 'Elsewhere' }, '/another/folder'), /another folder/)
  })

  test('an agent that is not set up: the message is kept, with why', async () => {
    const chats = new AgentChats({
      store: new ChatStore(path.join(scratch, 'chats3.json')),
      emit: () => {},
      status: async (id) => ({ id, state: 'missing', message: 'Codex is not installed, or Lily Studio cannot find it.' }),
      lilypond: async () => undefined,
      env: async () => process.env,
    })
    const id = await chats.send({ agent: 'codex', text: 'Hello' }, '/f')
    assert.deepEqual((await chats.get(id, '/f'))?.entries, [
      { role: 'user', text: 'Hello' },
      { role: 'error', text: 'Codex is not installed, or Lily Studio cannot find it. Open Agent setup below to set it up.' },
    ])
  })
})

describe('settings', () => {
  test('the agents’ paths and models are kept, and nonsense is dropped', async () => {
    const file = path.join(scratch, 'settings.json')
    await writeSettings(file, { lilypondPath: '/l', agents: { claude: { path: '/c', model: 'opus' }, codex: {} } })
    assert.deepEqual(await readSettings(file), { lilypondPath: '/l', agents: { claude: { path: '/c', model: 'opus' } } })
    await fs.writeFile(file, JSON.stringify({ agents: { claude: { path: 3 }, codex: 'x' } }))
    assert.deepEqual(await readSettings(file), {})
  })
})

describe('sidebar sizes', () => {
  test('clampWidth keeps the limits and room for the editor and preview', () => {
    assert.equal(clampWidth(100, 1400), SIDEBAR_WIDTH.min)
    assert.equal(clampWidth(300.4, 1400), 300)
    assert.equal(clampWidth(2000, 1400), SIDEBAR_WIDTH.max)
    assert.equal(clampWidth(600, 900), 420)
    assert.equal(clampWidth(600, 500), SIDEBAR_WIDTH.min)
  })

  test('clampHeight leaves the files their share', () => {
    assert.equal(clampHeight(50, 600), 140)
    assert.equal(clampHeight(900, 600), 600 - FILES_MIN)
  })
})

describe('textRuns', () => {
  test('fenced blocks and inline code', () => {
    assert.deepEqual(textRuns('Use `\\\\relative`:\n```lilypond\nc4 d\n```\nDone.'), [
      { kind: 'text', text: 'Use ' },
      { kind: 'code', text: '\\\\relative' },
      { kind: 'text', text: ':\n' },
      { kind: 'block', text: 'c4 d' },
      { kind: 'text', text: '\nDone.' },
    ])
    assert.deepEqual(textRuns('plain'), [{ kind: 'text', text: 'plain' }])
  })
})

describe('the selection and the agent', () => {
  const name = (file: string) => path.basename(file)

  test('contextLabel says what goes with a message', () => {
    assert.equal(contextLabel({}, name), undefined)
    assert.equal(contextLabel({ file: '/f/song.ly' }, name), 'With song.ly')
    assert.equal(contextLabel({ file: '/f/song.ly', selection: { startLine: 4, endLine: 4, text: 'c' } }, name), 'With line 4 of song.ly')
    assert.equal(contextLabel({ file: '/f/song.ly', selection: { startLine: 2, endLine: 9, text: 'c' } }, name), 'With lines 2–9 of song.ly')
  })

  test('the context menu: Ask opens the message box, the others send', () => {
    assert.deepEqual(SELECTION_ACTIONS.map((a) => [a.label, !!a.prompt]), [
      ['Ask Agent About Selection…', false],
      ['Explain Selection with Agent', true],
      ['Fix Selection with Agent', true],
    ])
    assert.match(SELECTION_ACTIONS[1]!.prompt!, /Do not change any files/)
  })
})
