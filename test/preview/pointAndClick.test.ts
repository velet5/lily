import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { CompileService } from '../../src/compile/compiler'
import { locateLilyPond } from '../../src/compile/locate'
import {
  LinkIndex,
  canonicalFile,
  charToCharacter,
  characterToChar,
  parseTextEdit,
} from '../../src/preview/pointAndClick'

// Runs under `node --test` (npm run test:unit); the hrefs are verbatim 2.26 output.

const link = (href: string) =>
  `<a style="color:inherit;" xlink:href="${href}">\n<g transform="translate(1, 2)">\n<path d="M0 0z" fill="currentColor"/>\n</g>\n</a>\n`
const svg = (...hrefs: string[]) => `<svg xmlns="http://www.w3.org/2000/svg">\n${hrefs.map(link).join('')}</svg>`

describe('parseTextEdit', { skip: process.platform === 'win32' }, () => {
  test('reads file, line and CHAR; COLUMN is not needed', () => {
    assert.deepEqual(parseTextEdit('textedit:///scores/song.ly:12:4:5'), {
      file: '/scores/song.ly',
      line: 12,
      char: 4,
    })
  })

  test('the path is percent-decoded, UTF-8 and reserved characters included', () => {
    assert.deepEqual(
      parseTextEdit('textedit:///tmp/odd%20dir/a%26b%20%27q%27%20%c3%a9%23%25.ly:3:11:12'),
      { file: "/tmp/odd dir/a&b 'q' é#%.ly", line: 3, char: 11 },
    )
  })

  test('the numbers are taken from the right, so a colon in the path survives', () => {
    assert.deepEqual(parseTextEdit('textedit:///scores/a:1:2/b.ly:3:4:5'), {
      file: '/scores/a:1:2/b.ly',
      line: 3,
      char: 4,
    })
  })

  test('the file LilyPond reached through ../ is spelled plainly', () => {
    assert.equal(parseTextEdit('textedit:///scores/parts/../lib/a.ily:1:0:1')?.file, '/scores/lib/a.ily')
  })

  test('anything else is not a location', () => {
    for (const href of [
      'https://lilypond.org',
      'textedit://relative/song.ly:1:2:3',
      'textedit:///scores/song.ly:1:2',
      'textedit:///scores/song.ly:0:2:3',
      'textedit:///scores/song.ly:1:-2:3',
      'textedit:///scores/%zz.ly:1:2:3',
      'textedit:///scores/a%00.ly:1:2:3',
      'textedit:///scores/song.ly:99999999999999999999:2:3',
    ]) {
      assert.equal(parseTextEdit(href), undefined, href)
    }
  })
})

describe('CHAR and the editor character', () => {
  // 𝄞 is one code point and two UTF-16 units; a tab is one of each.
  const text = '\t{ c\'4^"𝄞é" d\' }'

  test('an astral character before the token shifts the editor character by one', () => {
    const d = Array.from(text).indexOf('d')
    assert.equal(charToCharacter(text, d), text.indexOf('d'))
    assert.equal(text.indexOf('d') - d, 1)
    assert.equal(charToCharacter(text, 3), 3)
  })

  test('the two conversions are inverse, and neither leaves the line', () => {
    for (let char = 0; char <= Array.from(text).length; char++) {
      assert.equal(characterToChar(text, charToCharacter(text, char)), char)
    }
    assert.equal(charToCharacter(text, 500), text.length)
    assert.equal(characterToChar(text, 500), Array.from(text).length)
  })
})

describe('LinkIndex', () => {
  let dir: string
  let song: string

  before(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-links-')))
    song = path.join(dir, 'song.ly')
    await fs.writeFile(song, '')
    await fs.symlink(dir, path.join(dir, 'alias'))
  })

  after(() => fs.rm(dir, { recursive: true, force: true }))

  const href = (file: string, line: number, char: number) =>
    `textedit://${file.split(path.sep).map(encodeURIComponent).join('/')}:${line}:${char}:${char + 1}`

  test('the cursor finds the nearest link at or before it on its line', async () => {
    // { c'4 <e' g'>2 }: links at the c, the e and the g, in drawing order.
    const links = [href(song, 3, 9), href(song, 3, 2), href(song, 3, 6)]
    const index = await LinkIndex.build([svg(...links)])
    assert.deepEqual(index.lookup(song, 3, 2), [links[1]])
    assert.deepEqual(index.lookup(song, 3, 5), [links[1]], 'anywhere in c\'4')
    assert.deepEqual(index.lookup(song, 3, 6), [links[2]])
    assert.deepEqual(index.lookup(song, 3, 40), [links[0]], 'after the last note')
  })

  test('left of the first link it is the first link; other lines and files have none', async () => {
    const index = await LinkIndex.build([svg(href(song, 3, 4), href(song, 3, 8))])
    assert.deepEqual(index.lookup(song, 3, 0), [href(song, 3, 4)])
    assert.deepEqual(index.lookup(song, 4, 4), [])
    assert.deepEqual(index.lookup(path.join(dir, 'other.ly'), 3, 4), [])
    assert.deepEqual(LinkIndex.empty.lookup(song, 3, 4), [])
  })

  test('links of every page are indexed, and other links are not', async () => {
    const second = href(song, 8, 4)
    const index = await LinkIndex.build([
      svg(href(song, 6, 4), 'https://lilypond.org'),
      svg(second, second),
    ])
    assert.deepEqual(index.lookup(song, 6, 4), [href(song, 6, 4)])
    assert.deepEqual(index.lookup(song, 8, 4), [second], 'a music variable used twice is one href')
  })

  test('two spellings of one file are one file, and both hrefs are answered', async () => {
    const direct = href(song, 2, 4)
    const aliased = href(path.join(dir, 'alias', 'song.ly'), 2, 4)
    const index = await LinkIndex.build([svg(direct, aliased)])
    assert.deepEqual(index.lookup(song, 2, 4), [direct, aliased])
    assert.equal(await canonicalFile(path.join(dir, 'alias', 'song.ly')), song)
    assert.equal(await canonicalFile(path.join(dir, 'missing', '..', 'gone.ly')), path.join(dir, 'gone.ly'))
  })

  test('an href is compared as the webview will read it, entities decoded', async () => {
    const raw = `textedit://${dir}/a&amp;b.ly:1:0:1`
    const index = await LinkIndex.build([svg(raw)])
    assert.deepEqual(index.lookup(path.join(dir, 'a&b.ly'), 1, 0), [`textedit://${dir}/a&b.ly:1:0:1`])
  })

  test('a real score: every note of the root and of its include is found again', async (t) => {
    const installed = await locateLilyPond().then(
      () => true,
      () => false,
    )
    if (!installed) return t.skip('lilypond is not installed')

    const part = path.join(dir, 'pa rt.ily')
    const root = path.join(dir, 'röot.ly')
    await fs.writeFile(part, 'part = {\n\tg\'4 a\'\n}\n')
    await fs.writeFile(root, '\\version "2.24.0"\n\\include "pa rt.ily"\n{ c\'4^"𝄞" d\' \\part }\n')
    const compiler = new CompileService()
    try {
      const result = await compiler.compile({ rootFile: root, lilypondPath: '', extraArgs: [] })
      assert.equal(result.ok, true, result.stderr)
      const pages = await Promise.all(result.pages.map((page) => fs.readFile(page, 'utf8')))
      const index = await LinkIndex.build(pages)

      const expectToken = async (file: string, line: number, token: string) => {
        const text = (await fs.readFile(file, 'utf8')).split('\n')[line - 1]
        const character = text.indexOf(token)
        // The cursor sits before the token's last character: at its very end it
        // would already be at the start of a token that follows without a space.
        const char = characterToChar(text, character + token.length - 1)
        const [found, ...rest] = index.lookup(file, line, char)
        assert.deepEqual(rest, [])
        const location = parseTextEdit(found)
        assert.ok(location, `${token} has a link`)
        assert.equal(await canonicalFile(location.file), file)
        assert.equal(charToCharacter(text, location.char), character, `${token} in ${text}`)
      }
      await expectToken(root, 3, "c'4")
      await expectToken(root, 3, '^"𝄞"')
      await expectToken(root, 3, "d'")
      await expectToken(part, 2, "g'4")
      await expectToken(part, 2, "a'")
    } finally {
      await compiler.dispose()
    }
  })
})
