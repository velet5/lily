import type * as vscode from 'vscode'

// Activation and command/listener wiring only (ARCHITECTURE §3.2). It must never
// depend on the lilypond binary being present (DECISIONS D9).
export function activate(_context: vscode.ExtensionContext): void {}

export function deactivate(): void {}
