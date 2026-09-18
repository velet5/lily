import { runCli } from './cli'

// Entry of dist/lily-check.js. Kept apart from cli.ts so that importing the CLI,
// as the tests do, runs nothing.
void runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then((code) => {
  // Not process.exit(): piped output may still be in flight.
  process.exitCode = code
})
