import * as vscode from 'vscode'
import type { PreviewColors } from './preview/panel'

// Typed access to the `lily.*` settings contributed in package.json. Values are
// read on every call, never cached, so a change applies to the next compile
// without a reload (DECISIONS D9).

export interface CompileSettings {
  /** `lily.lilypond.path`; empty means "search PATH". */
  lilypondPath: string
  /** `lily.compile.extraArgs`; an array, so arguments may contain spaces (D3). */
  extraArgs: string[]
}

export function getCompileSettings(scope?: vscode.ConfigurationScope): CompileSettings {
  const config = vscode.workspace.getConfiguration('lily', scope)
  const extraArgs = config.get<unknown>('compile.extraArgs')
  return {
    lilypondPath: config.get<string>('lilypond.path', '').trim(),
    // settings.json is hand-edited; drop anything that is not an argument.
    extraArgs: Array.isArray(extraArgs)
      ? extraArgs.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0)
      : [],
  }
}

export interface PreviewSettings {
  /** `lily.preview.colors`. */
  colors: PreviewColors
}

export function getPreviewSettings(): PreviewSettings {
  const colors = vscode.workspace.getConfiguration('lily').get<unknown>('preview.colors')
  return { colors: colors === 'paper' ? 'paper' : 'theme' }
}
