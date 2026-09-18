import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { getAutoPreviewSettings, getCompileSettings, getPreviewSettings } from '../src/config'

suite('compile settings', () => {
  const config = () => vscode.workspace.getConfiguration('lily')
  // Global target: the test host's throwaway user data, not test/fixtures/.vscode.
  const target = vscode.ConfigurationTarget.Global

  teardown(async () => {
    await config().update('lilypond.path', undefined, target)
    await config().update('compile.extraArgs', undefined, target)
    await config().update('preview.colors', undefined, target)
    await config().update('preview.refreshOnSave', undefined, target)
    await config().update('preview.refreshDelay', undefined, target)
  })

  test('defaults search PATH and add no arguments', () => {
    assert.deepStrictEqual(getCompileSettings(), { lilypondPath: '', extraArgs: [] })
  })

  test('a change is visible to the next read without a reload', async () => {
    await config().update('lilypond.path', '  /opt/lilypond/bin/lilypond ', target)
    await config().update('compile.extraArgs', ['--include=/my library', '', 7], target)
    assert.deepStrictEqual(getCompileSettings(), {
      lilypondPath: '/opt/lilypond/bin/lilypond',
      extraArgs: ['--include=/my library'],
    })
  })

  test('the preview follows the theme unless paper is asked for', async () => {
    assert.deepStrictEqual(getPreviewSettings(), { colors: 'theme' })
    await config().update('preview.colors', 'paper', target)
    assert.deepStrictEqual(getPreviewSettings(), { colors: 'paper' })
  })

  test('the preview refreshes on save unless told otherwise', async () => {
    assert.deepStrictEqual(getAutoPreviewSettings(), { enabled: true, delayMs: 300 })
    await config().update('preview.refreshOnSave', false, target)
    await config().update('preview.refreshDelay', 60000, target)
    assert.deepStrictEqual(getAutoPreviewSettings(), { enabled: false, delayMs: 5000 })
    await config().update('preview.refreshDelay', -1, target)
    assert.strictEqual(getAutoPreviewSettings().delayMs, 0)
  })
})
