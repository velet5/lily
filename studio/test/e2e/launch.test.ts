import * as assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { promisify } from 'node:util'

// `npm run test:e2e` in studio/ (DECISIONS D37): builds the DMG with
// `npm run dist`, then mounts it, installs the app from it into a scratch
// folder as a user would drag it to Applications, and launches that copy with
// the Finder's bare PATH. The app runs its own smoke test (src/smokeTest.ts)
// and reports it as JSON: the window, the welcome screen, LilyPond found,
// a compile, the PDF, playback and live preview, from inside the package.
// Runs from out/test/e2e/.

const run = promisify(execFile)
const studioDir = path.resolve(__dirname, '..', '..', '..')
const APP = 'Lily Studio.app'

let scratch: string
let mountPoint: string | undefined
let dmg: string | undefined

before(async () => {
  if (process.platform !== 'darwin') return
  const pkg = JSON.parse(await fs.readFile(path.join(studioDir, 'package.json'), 'utf8')) as { version: string }
  const candidate = path.join(studioDir, 'release', `Lily Studio-${pkg.version}-${process.arch}.dmg`)
  dmg = await fs.access(candidate).then(() => candidate, () => undefined)
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-e2e-'))
})

after(async () => {
  if (mountPoint) await run('hdiutil', ['detach', mountPoint, '-force']).catch(() => undefined)
  if (scratch) await fs.rm(scratch, { recursive: true, force: true })
})

describe('the macOS package', { skip: process.platform !== 'darwin' && 'the DMG is macOS only' }, () => {
  let installed: string

  test('the DMG mounts with the app and a link to Applications', async () => {
    assert.ok(dmg, `no DMG for ${process.arch} in release/; run \`npm run dist\` first`)
    mountPoint = path.join(scratch, 'mount')
    await run('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint])
    const entries = await fs.readdir(mountPoint)
    assert.ok(entries.includes(APP), `the DMG holds ${entries.join(', ')}`)
    assert.equal(await fs.readlink(path.join(mountPoint, 'Applications')), '/Applications')

    // Installed as a drag to Applications would: a copy, then the DMG ejected.
    installed = path.join(scratch, APP)
    await run('ditto', [path.join(mountPoint, APP), installed])
    await run('hdiutil', ['detach', mountPoint])
    mountPoint = undefined
  })

  test('the app is signed, and lilypond can read its runtime files', async () => {
    assert.ok(installed, 'installed by the test before')
    await run('codesign', ['--verify', '--deep', '--strict', installed])
    const resources = path.join(installed, 'Contents', 'Resources')
    await fs.access(path.join(resources, 'app.asar'))
    for (const name of ['timing.ly', 'worker.scm', 'glyph-cache.scm']) {
      await fs.access(path.join(resources, 'app.asar.unpacked', 'dist', 'runtime', name))
    }
    const plist = await fs.readFile(path.join(installed, 'Contents', 'Info.plist'), 'utf8')
    assert.match(plist, /<string>io\.github\.velet5\.lily-studio<\/string>/)
  })

  test('Gatekeeper accepts the app as notarized (D38)', async (t) => {
    assert.ok(installed, 'installed by the test before')
    // codesign -d prints to stderr.
    const { stderr } = await run('codesign', ['-dv', '--verbose=2', installed])
    if (!/Authority=Developer ID Application/.test(stderr)) return t.skip('built by `npm run dist:local`, not signed with a Developer ID')
    assert.match(stderr, /flags=0x10000\(runtime\)/, 'the hardened runtime is on')
    // The ticket is stapled, so a Mac offline accepts it too.
    await run('xcrun', ['stapler', 'validate', installed])
    const assessed = await run('spctl', ['--assess', '--type', 'execute', '--verbose=2', installed])
    assert.match(assessed.stderr, /source=Notarized Developer ID/)
  })

  test('the installed app launches and passes its smoke test', { timeout: 120_000 }, async () => {
    assert.ok(installed, 'installed by the test before')
    const binary = path.join(installed, 'Contents', 'MacOS', 'Lily Studio')
    // As the Finder starts it: no Homebrew on PATH, no LILYPOND_PATH.
    const env = { HOME: os.homedir(), USER: os.userInfo().username, TMPDIR: os.tmpdir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(binary, ['--smoke-test'], { env })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
      child.on('error', reject)
      child.on('close', (exit) => resolve({ code: exit, stdout: out, stderr: err }))
    })
    // The report is the JSON object printed last; Chromium may log before it.
    const start = stdout.search(/^\{$/m)
    assert.ok(start >= 0, `no report from the app (exit ${code}; is Lily Studio already open?)\n${stdout}\n${stderr}`)
    const report = JSON.parse(stdout.slice(start)) as {
      ok: boolean
      problems: string[]
      welcome?: { state: string; sample: boolean }
      compile: { skipped?: string; pages?: number; pdfPages?: number; banner?: string; live?: { unsaved?: number } }
    }
    assert.deepEqual(report.problems, [])
    assert.equal(code, 0)
    assert.equal(report.welcome?.sample, true)
    if (report.compile.skipped) {
      // Without LilyPond the setup is what the user sees.
      assert.equal(report.welcome?.state, 'missing')
      return
    }
    assert.equal(report.welcome?.state, 'ready')
    assert.equal(report.compile.pages, 1)
    assert.equal(report.compile.pdfPages, 1)
    assert.match(report.compile.banner ?? '', /is not a LilyPond command/)
    assert.equal(report.compile.live?.unsaved, 8)
  })
})
