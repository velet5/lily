// The last step of `npm run dist` (DECISIONS D38): electron-builder notarizes
// and staples the app; this does the same for the DMG that carries it, so a
// downloaded DMG opens without a warning even offline. Uses the notarytool
// keychain profile in $APPLE_KEYCHAIN_PROFILE, as electron-builder does.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const profile = process.env.APPLE_KEYCHAIN_PROFILE
if (!profile) throw new Error('Set APPLE_KEYCHAIN_PROFILE to a `xcrun notarytool store-credentials` profile.')
const { productName, version } = JSON.parse(readFileSync('package.json', 'utf8'))
const dmg = `release/${productName}-${version}-${process.arch}.dmg`
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })

run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait'])
run('xcrun', ['stapler', 'staple', dmg])
// Gatekeeper's own verdict on the DMG, as a downloaded copy would get it.
run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg])
