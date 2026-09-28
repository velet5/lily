import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import { after, before, describe, test } from 'node:test'
import { locateLilyPond } from '../../src/compile/locate'
import type { CheckReport } from '../../tools/lily-check/check'
import { serveMcp, TOOL_NAME } from '../../tools/lily-check/mcp'

// Runs under `node --test` from out/unit/tools/ (npm run test:unit).
const fixtures = path.resolve(__dirname, '../../../test/fixtures')

let scratch: string
let lilypondInstalled = false

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-mcp-test-'))
  lilypondInstalled = await locateLilyPond().then(
    () => true,
    () => false,
  )
})

after(() => fs.rm(scratch, { recursive: true, force: true }))

interface Response {
  jsonrpc: '2.0'
  id: number | string | null
  result?: any
  error?: { code: number; message: string }
}

/** Feeds the lines to a server, closes its input and returns what it wrote. */
async function exchange(...messages: (object | string)[]): Promise<Response[]> {
  const input = new PassThrough()
  const output = new PassThrough()
  let written = ''
  output.setEncoding('utf8').on('data', (chunk: string) => (written += chunk))

  const served = serveMcp({ input, output, cwd: fixtures, env: {} })
  for (const message of messages) {
    input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
  }
  input.end()
  await served

  assert.ok(written === '' || written.endsWith('\n'))
  return written
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

const request = (id: number, method: string, params?: object) => ({ jsonrpc: '2.0', id, method, params })
const callTool = (id: number, args: object, name = TOOL_NAME) =>
  request(id, 'tools/call', { name, arguments: args })

describe('serveMcp', () => {
  test('initialize echoes a version it knows and offers its newest for one it does not', async () => {
    const [known, unknown] = await exchange(
      request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} }),
      request(2, 'initialize', { protocolVersion: '1999-01-01', capabilities: {} }),
    )
    assert.equal(known.result.protocolVersion, '2024-11-05')
    assert.deepEqual(known.result.capabilities, { tools: {} })
    assert.equal(known.result.serverInfo.name, 'lily-check')
    assert.equal(unknown.result.protocolVersion, '2025-11-25')
  })

  test('lists one tool whose only required argument is the file', async () => {
    const [listed] = await exchange(request(1, 'tools/list'))
    assert.equal(listed.result.tools.length, 1)
    const [tool] = listed.result.tools
    assert.equal(tool.name, TOOL_NAME)
    assert.deepEqual(tool.inputSchema.required, ['file'])
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['file', 'extraArgs', 'outDir'])
  })

  test('notifications get no answer; ping, unknown methods and bad JSON get the right one', async () => {
    const responses = await exchange(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } },
      { jsonrpc: '2.0', id: 7, result: {} },
      request(1, 'ping'),
      request(2, 'resources/list'),
      '{ not json',
      '[]',
      '',
    )
    assert.deepEqual(responses, [
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found: resources/list' } },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } },
    ])
  })

  test('an unknown tool is a protocol error; bad arguments are for the model to read', async () => {
    const [unknownTool, noFile, badArgs] = await exchange(
      callTool(1, { file: 'simple.ly' }, 'lilypond_render'),
      callTool(2, {}),
      callTool(3, { file: 'simple.ly', extraArgs: '-I lib' }),
    )
    assert.equal(unknownTool.error?.code, -32602)
    assert.equal(noFile.result.isError, true)
    assert.match(noFile.result.content[0].text, /"file" must be/)
    assert.equal(badArgs.result.isError, true)
    assert.match(badArgs.result.content[0].text, /"extraArgs" must be/)
  })

  test('a file that cannot be read is a tool error carrying the report', async () => {
    const [response] = await exchange(callTool(1, { file: 'missing.ly' }))
    assert.equal(response.result.isError, true)
    assert.equal(response.result.structuredContent.error.code, 'file-not-found')
    assert.equal(response.result.structuredContent.rootFile, path.join(fixtures, 'missing.ly'))
  })

  test('compile errors are a result, not an error, and the text is the same JSON', async (t) => {
    if (!lilypondInstalled) return t.skip('lilypond is not installed')
    const outDir = path.join(scratch, 'out')
    const [broken, clean] = await exchange(
      callTool(1, { file: 'broken.ly', outDir }),
      callTool(2, { file: path.join(fixtures, 'simple.ly'), outDir }),
    ).then((responses) => responses.sort((a, b) => Number(a.id) - Number(b.id)))

    const report: CheckReport = broken.result.structuredContent
    assert.equal(broken.result.isError, false)
    assert.equal(report.ok, false)
    assert.equal(report.errorCount, 4)
    assert.equal(report.diagnostics[0].token, '\\alsoUndefined')
    assert.deepEqual(JSON.parse(broken.result.content[0].text), report)

    assert.equal(clean.result.isError, false)
    assert.equal(clean.result.structuredContent.ok, true)
    assert.deepEqual(clean.result.structuredContent.pages, [path.join(outDir, 'simple.svg')])
    assert.match(await fs.readFile(path.join(outDir, 'simple.svg'), 'utf8'), /<svg/)
  })

  test('a cancelled call kills its compile and is not answered', async (t) => {
    if (!lilypondInstalled) return t.skip('lilypond is not installed')
    // About half a minute of engraving on 2.26 (ARCHITECTURE appendix A).
    const slow = path.join(scratch, 'slow.ly')
    await fs.writeFile(slow, '\\version "2.24.0"\n{ \\repeat unfold 400 { c8 c c c c c c c } }\n')

    const input = new PassThrough()
    const output = new PassThrough()
    let written = ''
    output.setEncoding('utf8').on('data', (chunk: string) => (written += chunk))
    const started = performance.now()
    const served = serveMcp({ input, output, cwd: fixtures, env: {} })

    input.write(`${JSON.stringify(callTool(1, { file: slow, outDir: path.join(scratch, 'slow') }))}\n`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })}\n`)
    input.end()
    await served

    assert.equal(written, '')
    assert.ok(performance.now() - started < 10_000, 'the compile was not killed')
  })
})
