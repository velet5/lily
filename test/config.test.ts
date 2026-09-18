import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { getCompileSettings } from '../src/config'

suite('compile settings', () => {
  const config = () => vscode.workspace.getConfiguration('lily')
  // Global target: the test host's throwaway user data, not test/fixtures/.vscode.
  const target = vscode.ConfigurationTarget.Global

  teardown(async () => {
    await config().update('lilypond.path', undefined, target)
    await config().update('compile.extraArgs', undefined, target)
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
})
