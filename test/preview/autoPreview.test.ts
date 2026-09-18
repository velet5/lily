import * as assert from 'node:assert'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import { AutoPreview, type AutoPreviewHost } from '../../src/preview/autoPreview'

// Runs without an extension host (DECISIONS D13), on node:test's mock clock.

const SONG = '/scores/song.ly'
const HYMN = '/scores/hymn.ly'
const SHARED = '/scores/parts/shared.ily'

/** A host in which both previewed roots include SHARED. */
function fixture(overrides: Partial<AutoPreviewHost> = {}) {
  const state = {
    enabled: true,
    delayMs: 300,
    roots: [SONG, HYMN],
    compiled: [] as string[],
  }
  const auto: AutoPreview = new AutoPreview({
    settings: () => ({ enabled: state.enabled, delayMs: state.delayMs }),
    previewedRoots: () => state.roots,
    rootsIncluding: async (file, roots) =>
      file === SHARED ? roots : roots.filter((root) => root === file),
    // As extension.ts does: every compile reports its start.
    compile: (rootFile) => {
      auto.compileStarted(rootFile)
      state.compiled.push(rootFile)
    },
    ...overrides,
  })
  return { auto, state }
}

describe('AutoPreview', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
  afterEach(() => mock.timers.reset())

  test('compiles a saved root once the delay has passed', async () => {
    const { auto, state } = fixture()
    await auto.documentSaved(SONG)
    assert.strictEqual(auto.pending, 1)

    mock.timers.tick(299)
    assert.deepStrictEqual(state.compiled, [])
    mock.timers.tick(1)
    assert.deepStrictEqual(state.compiled, [SONG])
    assert.strictEqual(auto.pending, 0)
  })

  test('a burst of saves restarts the delay and compiles once', async () => {
    const { auto, state } = fixture()
    await auto.documentSaved(SONG)
    mock.timers.tick(200)
    await auto.documentSaved(SONG)
    mock.timers.tick(200)
    assert.deepStrictEqual(state.compiled, [])
    mock.timers.tick(100)
    assert.deepStrictEqual(state.compiled, [SONG])
  })

  test('Save All of a root and its include compiles the root once', async () => {
    const { auto, state } = fixture({ previewedRoots: () => [SONG] })
    await Promise.all([auto.documentSaved(SHARED), auto.documentSaved(SONG)])
    mock.timers.tick(300)
    assert.deepStrictEqual(state.compiled, [SONG])
  })

  test('a saved include refreshes every previewed root that reaches it', async () => {
    const { auto, state } = fixture()
    await auto.documentSaved(SHARED)
    mock.timers.tick(300)
    assert.deepStrictEqual(state.compiled, [SONG, HYMN])
  })

  test('a file no previewed root compiles is ignored', async () => {
    const { auto, state } = fixture()
    await auto.documentSaved('/scores/unrelated.ly')
    assert.strictEqual(auto.pending, 0)
    mock.timers.tick(300)
    assert.deepStrictEqual(state.compiled, [])
  })

  test('does not resolve roots when no preview is open', async () => {
    let resolved = 0
    const { auto } = fixture({
      previewedRoots: () => [],
      rootsIncluding: async () => (resolved++, []),
    })
    await auto.documentSaved(SONG)
    assert.strictEqual(resolved, 0)
  })

  test('does nothing while refreshOnSave is off', async () => {
    const { auto, state } = fixture()
    state.enabled = false
    await auto.documentSaved(SONG)
    assert.strictEqual(auto.pending, 0)
    assert.deepStrictEqual(state.compiled, [])
  })

  test('switching the setting off drops a refresh that is waiting', async () => {
    const { auto, state } = fixture()
    await auto.documentSaved(SONG)
    state.enabled = false
    mock.timers.tick(300)
    assert.deepStrictEqual(state.compiled, [])
    assert.strictEqual(auto.pending, 0)
  })

  test('a preview closed during the delay is not compiled', async () => {
    const { auto, state } = fixture()
    await auto.documentSaved(SHARED)
    state.roots = [HYMN]
    mock.timers.tick(300)
    assert.deepStrictEqual(state.compiled, [HYMN])
  })

  test('the delay is read on every save', async () => {
    const { auto, state } = fixture()
    state.delayMs = 0
    await auto.documentSaved(SONG)
    mock.timers.tick(0)
    assert.deepStrictEqual(state.compiled, [SONG])
  })

  test('a compile started by someone else replaces the waiting refresh', async () => {
    const { auto, state } = fixture()
    await auto.documentSaved(SHARED)
    auto.compileStarted(SONG)
    assert.strictEqual(auto.pending, 1)
    mock.timers.tick(300)
    assert.deepStrictEqual(state.compiled, [HYMN])
  })

  test('a save that a later compile already covers schedules nothing', async () => {
    // `LilyPond: Compile` saves the dirty document and compiles right away,
    // before the save's roots have been resolved.
    let release = (_roots: string[]) => {}
    const { auto, state } = fixture({
      rootsIncluding: () => new Promise((resolve) => (release = resolve)),
    })
    const saved = auto.documentSaved(SONG)
    auto.compileStarted(SONG)
    release([SONG, HYMN])
    await saved

    mock.timers.tick(300)
    assert.deepStrictEqual(state.compiled, [HYMN])
  })

  test('a save after that compile started is refreshed again', async () => {
    const { auto, state } = fixture()
    auto.compileStarted(SONG)
    await auto.documentSaved(SONG)
    mock.timers.tick(300)
    assert.deepStrictEqual(state.compiled, [SONG])
  })

  test('a failing root lookup schedules nothing and does not reject', async () => {
    const { auto } = fixture({ rootsIncluding: () => Promise.reject(new Error('EIO')) })
    await auto.documentSaved(SONG)
    assert.strictEqual(auto.pending, 0)
  })

  test('dispose drops waiting refreshes and ignores saves still being resolved', async () => {
    let release = (_roots: string[]) => {}
    const { auto, state } = fixture()
    await auto.documentSaved(HYMN)

    const slow = fixture({ rootsIncluding: () => new Promise((resolve) => (release = resolve)) })
    const saved = slow.auto.documentSaved(SONG)
    auto.dispose()
    slow.auto.dispose()
    release([SONG])
    await saved

    mock.timers.tick(300)
    assert.strictEqual(auto.pending + slow.auto.pending, 0)
    assert.deepStrictEqual([...state.compiled, ...slow.state.compiled], [])
  })
})
