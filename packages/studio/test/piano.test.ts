import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Midi, Note } from '@lily/common/web/midi.js'
import { firstFrom, HIGHEST, keyboard, keyRange, LOWEST, noteName, pianoNotes, pianoTracks } from '../src/renderer/piano'

// Runs under `node --test` from out/test/ (npm run test:unit).

function note(key: number, time: number, extra: Partial<Note> = {}): Note {
  return { time, duration: 0.5, track: 0, channel: 0, key, velocity: 0.8, program: 0, gain: 1, pan: 0, detune: 0, ...extra }
}

function midi(notes: Note[]): Midi {
  return { title: '', duration: 4, notes, tracks: [], division: 384 }
}

describe('the piano view (D116)', () => {
  test('names the notes as a piano video does', () => {
    assert.deepEqual([60, 61, 63, 66, 68, 70, 71].map(noteName), ['C', 'C#', 'Eb', 'F#', 'Ab', 'Bb', 'B'])
  })

  test('leaves out the drums and what is off the keyboard, and sorts by time', () => {
    const notes = pianoNotes(midi([note(64, 1), note(36, 0, { channel: 9 }), note(60, 0), note(12, 0), note(120, 0)]))
    assert.deepEqual(notes.map((n) => n.key), [60, 64])
    assert.deepEqual(pianoNotes(undefined), [])
  })

  test('shows all 88 keys, or the whole octaves the notes are in', () => {
    const notes = [note(63, 0), note(56, 1), note(75, 2)]
    assert.deepEqual(keyRange(notes, 'full'), { low: LOWEST, high: HIGHEST })
    assert.deepEqual(keyRange(notes, 'notes'), { low: 48, high: 83 })
    // Never past the piano's ends.
    assert.deepEqual(keyRange([note(22, 0), note(108, 0)], 'notes'), { low: LOWEST, high: HIGHEST })
    // Without notes, the octaves around middle C.
    assert.deepEqual(keyRange([], 'notes'), { low: 48, high: 83 })
  })

  test('lays the white keys side by side and the black ones over their edges', () => {
    const keys = keyboard(LOWEST, HIGHEST, 520)
    assert.equal(keys.length, 88)
    const whites = keys.filter((key) => !key.black)
    assert.equal(whites.length, 52)
    assert.equal(whites[0].x, 0)
    assert.ok(Math.abs(whites.at(-1)!.x + whites.at(-1)!.width - 520) < 1e-9)
    // A♯0 sits over the edge between A0 and B0.
    const [a, aSharp, b] = keys
    assert.equal(aSharp.black, true)
    assert.ok(Math.abs(aSharp.x + aSharp.width / 2 - b.x) < 1e-9)
    assert.equal(a.x + a.width, b.x)
  })

  test('lists the tracks as they first sound, with their parts\' names and colours (D117)', () => {
    const notes = [note(60, 0, { track: 2 }), note(48, 0, { track: 1 }), note(62, 1, { track: 2 }), note(40, 2, { track: 3 })]
    const parts = [
      { track: 1, number: 1, name: 'Piano · F clef', written: 'acoustic grand', drums: false },
      { track: 2, number: 2, name: 'Piano · G clef', written: 'acoustic grand', drums: false },
    ]
    const tracks = pianoTracks(notes, parts)
    assert.deepEqual(tracks.map(({ track, name }) => [track, name]), [[2, 'Piano · G clef'], [1, 'Piano · F clef'], [3, 'Track 3']])
    assert.equal(new Set(tracks.map(({ color }) => color)).size, 3)
  })

  test('finds the first note at or after a time', () => {
    const notes = [note(60, 0), note(62, 1), note(64, 1), note(65, 2)]
    assert.equal(firstFrom(notes, -1), 0)
    assert.equal(firstFrom(notes, 1), 1)
    assert.equal(firstFrom(notes, 1.5), 3)
    assert.equal(firstFrom(notes, 5), 4)
  })
})
