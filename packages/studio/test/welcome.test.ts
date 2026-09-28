import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { recentLabel } from '../src/renderer/welcome'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/). The
// list itself is the Rust side's (src-tauri/src/recent.rs's tests).

describe('recentLabel', () => {
  test('the name, and its directory with the home directory as ~', () => {
    assert.deepEqual(recentLabel('/Users/me/Music/song.ly', '/Users/me'), { name: 'song.ly', place: '~/Music' })
    assert.deepEqual(recentLabel('/Users/me/Scores', '/Users/me/'), { name: 'Scores', place: '~' })
  })

  test('outside the home directory, the whole directory', () => {
    assert.deepEqual(recentLabel('/Volumes/T5/Pets/Lily/', '/Users/me'), { name: 'Lily', place: '/Volumes/T5/Pets' })
    assert.deepEqual(recentLabel('/Users/meg/a.ly', '/Users/me'), { name: 'a.ly', place: '/Users/meg' })
    assert.deepEqual(recentLabel('/Users/me/a.ly'), { name: 'a.ly', place: '/Users/me' })
  })

  test('a folder at the top of the disk, and the disk itself', () => {
    assert.deepEqual(recentLabel('/tmp', '/Users/me'), { name: 'tmp', place: '/' })
    assert.deepEqual(recentLabel('/', '/Users/me'), { name: '/', place: '' })
  })
})
