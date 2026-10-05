import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { leaveOutLabel } from '../src/web/dialogs'
import { keyCommand } from '../src/web/menubar'

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
