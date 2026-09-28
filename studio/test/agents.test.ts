import * as assert from 'node:assert/strict'
import * as path from 'node:path'
import { describe, test } from 'node:test'
import { contextLabel, imageRefusal, MAX_IMAGE_BYTES, MAX_IMAGES, modelChoices, PERMISSIONS, SELECTION_ACTIONS, textRuns } from '../src/renderer/agents'
import { clampHeight, clampWidth, FILES_MIN, SIDEBAR_WIDTH } from '../src/renderer/sidebar'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/): the
// sidebar and the agent panel. Running the agents is the Rust side's
// (crates/agents's tests).

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

  test('the permission modes, from least to most', () => {
    assert.deepEqual(PERMISSIONS.map((p) => p.id), ['read', 'edit', 'full'])
  })

  test('modelChoices: the default, the usual models, and one typed in the setup', () => {
    assert.deepEqual(modelChoices('claude').map((c) => c.value), ['', 'opus', 'sonnet', 'haiku'])
    assert.deepEqual(modelChoices('claude', 'sonnet').map((c) => c.value), ['', 'opus', 'sonnet', 'haiku'])
    assert.deepEqual(modelChoices('codex', 'o4-mini').map((c) => c.value), ['', 'gpt-5-codex', 'gpt-5', 'o4-mini'])
    assert.equal(modelChoices('codex')[0]!.label, 'Default model')
  })
})

describe('imageRefusal', () => {
  test('PNG, JPEG, GIF and WebP up to the limits go; anything else is said why not', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) assert.equal(imageRefusal(type, 1000, 0), undefined)
    assert.match(imageRefusal('image/svg+xml', 10, 0)!, /PNG, JPEG, GIF and WebP/)
    assert.match(imageRefusal('image/png', MAX_IMAGE_BYTES + 1, 0)!, /too large/)
    assert.match(imageRefusal('image/png', 10, MAX_IMAGES)!, /at most 6/)
  })
})
