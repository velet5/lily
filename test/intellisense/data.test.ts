import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import completions from '../../data/completions.json'
import snippets from '../../snippets/lilypond.json'
import { indexData, snippetCommandsOf, type LilyData } from '../../src/intellisense/data'

// Runs under `node --test` (npm run test:unit). Checks what
// scripts/gen-completions.mjs committed, so a regeneration that loses a
// category, or a Texinfo construct the converter does not know, fails here.

const data = completions as LilyData

describe('data/completions.json', () => {
  test('records the LilyPond version it came from (D8)', () => {
    assert.match(data.lilypond, /^\d+\.\d+\.\d+$/)
  })

  test('has every category, in plausible numbers', () => {
    const count = (kind: string) => data.commands.filter((command) => command.kind === kind).length
    assert.ok(count('function') > 150)
    assert.ok(count('music') > 250)
    assert.ok(count('keyword') > 30)
    assert.ok(count('markup') > 150)
    assert.ok(data.contexts.length > 30)
    assert.ok(data.grobs.length > 120)
    assert.ok(data.grobProperties.length > 250)
    assert.ok(data.contextProperties.length > 150)
  })

  test('names are unique and sorted, so a regenerated file diffs by entry', () => {
    const lists = [data.commands, data.contexts, data.grobs, data.interfaces, data.grobProperties, data.contextProperties]
    for (const list of lists) {
      const names = list.map((entry) => entry.name)
      assert.deepEqual(names, [...new Set(names)].sort())
    }
  })

  test('every command can be written as \\name', () => {
    for (const command of data.commands) assert.match(command.name, /^[A-Za-z]+(?:[-_][A-Za-z]+)*$/)
  })

  test('no Texinfo is left in the documentation', () => {
    const entries = [...data.commands, ...data.contexts, ...data.grobs, ...data.grobProperties, ...data.contextProperties]
    for (const entry of entries) {
      const docs = [entry.doc, 'markup' in entry ? entry.markup?.doc : undefined]
      // eslint-disable-next-line no-control-regex
      for (const doc of docs) assert.doesNotMatch(doc ?? '', /@[A-Za-z]+|[\u0000-\u0008]/, entry.name)
    }
  })

  test('every function is documented and has its signature', () => {
    for (const command of data.commands.filter((entry) => entry.kind === 'function')) {
      assert.ok(command.doc, command.name)
    }
    const relative = data.commands.find((command) => command.name === 'relative')
    assert.equal(relative?.signature, '[pitch] (music)')
  })

  test('grobs point at known interfaces, interfaces at known properties', () => {
    const interfaces = new Set(data.interfaces.map((entry) => entry.name))
    const properties = new Set(data.grobProperties.map((entry) => entry.name))
    for (const grob of data.grobs) {
      for (const name of grob.interfaces) assert.ok(interfaces.has(name), `${grob.name}: ${name}`)
      for (const name of grob.defaults ?? []) assert.ok(properties.has(name), `${grob.name}: ${name}`)
    }
    for (const entry of data.interfaces) {
      for (const name of entry.properties) assert.ok(properties.has(name), `${entry.name}: ${name}`)
    }
  })
})

describe('indexData', () => {
  test('propertiesOf joins the interfaces of a grob', () => {
    const index = indexData(data)
    const noteHead = index.propertiesOf('NoteHead')
    assert.ok(noteHead.includes('color') && noteHead.includes('stencil') && noteHead.includes('font-size'))
    assert.ok(!noteHead.includes('beam-thickness'))
    assert.deepEqual(index.propertiesOf('NoSuchGrob'), [])
  })
})

describe('snippetCommandsOf', () => {
  test('takes the prefixes that are exactly one command', () => {
    const commands = snippetCommandsOf(snippets)
    assert.ok(commands.includes('score') && commands.includes('relative'))
    // `\new Staff` inserts more than `\new`, and `var` no command at all.
    assert.ok(!commands.includes('new') && !commands.includes('var'))
  })
})
