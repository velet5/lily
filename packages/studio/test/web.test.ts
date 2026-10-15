import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, test } from 'node:test'
import { leaveOutLabel } from '../src/web/dialogs'
import { keyCommand } from '../src/web/menubar'
import { SEPARATION_COMMANDS, SEPARATION_UNAVAILABLE, separation, separationStub } from '../src/web/separation'

// Runs under `node --test` from out/test/ (npm run test:unit in packages/studio/).
// The web's page (DECISIONS D55); the server's side is crates/server's tests.

const key = (code: string, keys: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  code,
  metaKey: keys.meta ?? false,
  ctrlKey: keys.ctrl ?? false,
  altKey: keys.alt ?? false,
  shiftKey: keys.shift ?? false,
})

describe('keyCommand', () => {
  test('the app menu’s shortcuts, with ⌘ on a Mac and Ctrl elsewhere', () => {
    assert.equal(keyCommand(key('KeyS', { meta: true }), true), 'save')
    assert.equal(keyCommand(key('KeyS', { meta: true, alt: true }), true), 'save-all')
    assert.equal(keyCommand(key('KeyO', { meta: true }), true), 'open-file')
    assert.equal(keyCommand(key('KeyO', { meta: true, shift: true }), true), 'open-folder')
    assert.equal(keyCommand(key('KeyS', { ctrl: true }), false), 'save')
  })

  test('other keys, and the wrong modifier, are left to the page', () => {
    assert.equal(keyCommand(key('KeyS', { ctrl: true }), true), undefined)
    assert.equal(keyCommand(key('KeyS', { meta: true }), false), undefined)
    assert.equal(keyCommand(key('KeyS', { meta: true, shift: true }), true), undefined)
    assert.equal(keyCommand(key('KeyZ', { meta: true }), true), undefined)
    assert.equal(keyCommand(key('KeyS'), true), undefined)
  })
})

describe('leaveOutLabel', () => {
  test('as the app’s save panel says it (midi_export.rs)', () => {
    assert.equal(leaveOutLabel(['Tenor']), 'Leave out the muted part Tenor')
    assert.equal(leaveOutLabel(['Alto', 'Tenor']), 'Leave out the muted parts Alto and Tenor')
    assert.equal(leaveOutLabel(['Soprano', 'Alto', 'Tenor']), 'Leave out the muted parts Soprano, Alto and Tenor')
    assert.equal(leaveOutLabel(['S', 'A', 'T', 'B']), 'Leave out the 4 muted parts')
  })
})

describe('separation on the web (D112)', () => {
  const studioDir = path.resolve(__dirname, '..', '..')
  const read = (file: string) => readFileSync(path.join(studioDir, file), 'utf8')

  test('is unavailable, and says why', () => {
    assert.deepEqual(separation, { available: false, reason: 'Separating stems needs the Mac app.' })
  })

  test('every separation command rejects with the reason, as the app’s Rust side rejects', async () => {
    for (const command of SEPARATION_COMMANDS) {
      await assert.rejects(separationStub(command) ?? Promise.resolve(), (error) => error === SEPARATION_UNAVAILABLE, command)
    }
  })

  test('other commands go on to the worker', () => {
    for (const command of ['open_sample', 'read_file', 'chat_list', 'separation', 'separate_all']) {
      assert.equal(separationStub(command), undefined, command)
    }
  })

  test('the stub answers each command the app registers (src-tauri/src/lib.rs)', () => {
    const registered = [...read('src-tauri/src/lib.rs').matchAll(/^\s*separate::(\w+),$/gm)].map((match) => match[1])
    assert.ok(registered.length > 0)
    assert.deepEqual([...SEPARATION_COMMANDS].sort(), registered.sort())
  })

  test('the worker refuses the same commands, should a page ask it (crates/server)', () => {
    const desktopOnly = read('crates/server/src/worker/commands.rs').match(/const DESKTOP_ONLY[^=]*= &\[([^\]]*)\]/)?.[1] ?? ''
    for (const command of SEPARATION_COMMANDS) assert.ok(desktopOnly.includes(`"${command}"`), command)
  })
})
