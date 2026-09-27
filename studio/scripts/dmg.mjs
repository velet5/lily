// The last step of `npm run dist` (DECISIONS D37, D38, D42): `tauri build`
// has signed Lily Studio.app with the Developer ID and the hardened runtime.
// This notarizes and staples the app, puts it in a DMG beside a link to
// /Applications, and signs, notarizes and staples the DMG too, so a
// downloaded copy opens without a warning even offline. Tauri's own DMG step
// would build the app again and lose the app's ticket, hence this script.
// Uses the notarytool keychain profile in $APPLE_KEYCHAIN_PROFILE.
//
//   node scripts/dmg.mjs            notarized, for `npm run dist`
//   node scripts/dmg.mjs --local    the ad-hoc signed app as it is, for `npm run dist:local`
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const local = process.argv.includes('--local')
const { productName, version } = JSON.parse(readFileSync('package.json', 'utf8'))
const identity = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).bundle.macOS.signingIdentity
const app = `target/release/bundle/macos/${productName}.app`
const dmg = `release/${productName}-${version}-${process.arch}.dmg`
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })

const profile = process.env.APPLE_KEYCHAIN_PROFILE
if (!local && !profile) throw new Error('Set APPLE_KEYCHAIN_PROFILE to a `xcrun notarytool store-credentials` profile.')

/** Uploads `file` to Apple, waits for the verdict, and staples the ticket to `target`. */
function notarize(file, target = file) {
  run('xcrun', ['notarytool', 'submit', file, '--keychain-profile', profile, '--wait'])
  run('xcrun', ['stapler', 'staple', target])
}

const scratch = mkdtempSync(join(tmpdir(), 'lily-studio-dmg-'))
try {
  if (!local) {
    // notarytool takes a zip of the app, not the bundle itself.
    const zip = join(scratch, `${productName}.zip`)
    run('ditto', ['-c', '-k', '--keepParent', app, zip])
    notarize(zip, app)
  }

  const staging = join(scratch, productName)
  mkdirSync(staging)
  // ditto keeps the signature, the stapled ticket and the bundle's links.
  run('ditto', [app, join(staging, `${productName}.app`)])
  symlinkSync('/Applications', join(staging, 'Applications'))
  mkdirSync('release', { recursive: true })
  rmSync(dmg, { force: true })
  run('hdiutil', ['create', '-volname', productName, '-srcfolder', staging, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg])

  if (!local) {
    run('codesign', ['--sign', identity, '--timestamp', dmg])
    notarize(dmg)
    // Gatekeeper's own verdict on the DMG, as a downloaded copy would get it.
    run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg])
  }
  console.log(dmg)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
