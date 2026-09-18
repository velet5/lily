import * as path from 'node:path'
import * as readline from 'node:readline'
import { version } from '../../package.json'
import { CompileService } from '../../src/compile/compiler'
import { check, type CheckReport } from './check'

// A minimal MCP server on stdio (DECISIONS D11, D22): `initialize`, `ping`,
// `tools/list`, `tools/call` and cancellation, for one tool. Written against the
// 2025-06-18 specification without the SDK, which would be this project's only
// runtime dependency. stdout carries protocol messages and nothing else.

/** Newest first. The tool surface used here is the same in all of them. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export const TOOL_NAME = 'lilypond_compile'

const TOOL = {
  name: TOOL_NAME,
  title: 'Compile a LilyPond score',
  description:
    'Compiles a LilyPond .ly file to SVG and returns JSON: `ok`, `diagnostics` (each with `file`, ' +
    '1-based `line` and `column`, `severity`, `message`, and the `source` line and `token` the ' +
    'column points at), and `pages`, the absolute paths of the SVG pages in order. Call it after ' +
    'every edit of a score; fix the first error first, since later ones often follow from it, and ' +
    'repeat until `ok` is true. Compile the root file, not a file it \\includes.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'The root .ly file. Absolute, or relative to the directory the server runs in.',
      },
      extraArgs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra lilypond arguments, one per item, e.g. "--include=/abs/dir".',
      },
      outDir: {
        type: 'string',
        description: 'Directory for the SVG pages. Default: a temp directory per file, emptied on every run.',
      },
    },
    required: ['file'],
    additionalProperties: false,
  },
} as const

const enum RpcError {
  Parse = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
}

type Id = string | number

interface Message {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

export interface McpOptions {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  cwd?: string
  /** `LILYPOND_PATH` is read from here. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Disposed when the server stops. */
  service?: CompileService
}

/** Serves until `input` ends and every call made until then is answered. */
export async function serveMcp(options: McpOptions): Promise<void> {
  const service = options.service ?? new CompileService()
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  /** Root file of each `tools/call` in flight, by request id. */
  const calls = new Map<Id, string>()
  const pending = new Set<Promise<void>>()

  const send = (message: object) => options.output.write(`${JSON.stringify(message)}\n`)
  const reply = (id: Id, result: object) => send({ jsonrpc: '2.0', id, result })
  const fail = (id: Id | null, code: RpcError, message: string) =>
    send({ jsonrpc: '2.0', id, error: { code, message } })

  async function callTool(id: Id, params: unknown): Promise<void> {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown }
    if (name !== TOOL_NAME) return void fail(id, RpcError.InvalidParams, `Unknown tool: ${String(name)}`)
    const request = toolArguments(args)
    // The model wrote the arguments, so this is its error to read, not a protocol error.
    if (typeof request === 'string') return void reply(id, toolResult(request, true))

    calls.set(id, path.resolve(cwd, request.file))
    const report = await check(service, { ...request, cwd, lilypondPath: env.LILYPOND_PATH })
    // A request the client cancelled gets no response; one that a newer call for
    // the same file superseded gets its `cancelled: true` report.
    if (!calls.delete(id)) return
    // Compile errors are what the tool is for; only a run that never happened is an error.
    reply(id, toolResult(report, report.error !== undefined))
  }

  function handle(line: string): void {
    let message: Message
    try {
      message = JSON.parse(line)
    } catch {
      return void fail(null, RpcError.Parse, 'Parse error')
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return void fail(null, RpcError.InvalidRequest, 'Invalid request')
    }
    const { id, method, params } = message
    // A response to a request of ours; we make none.
    if (typeof method !== 'string') return

    if (typeof id !== 'string' && typeof id !== 'number') {
      if (method === 'notifications/cancelled') {
        const requestId = (params as { requestId?: Id } | undefined)?.requestId as Id
        const rootFile = calls.get(requestId)
        if (rootFile !== undefined) service.cancel(rootFile)
        calls.delete(requestId)
      }
      return
    }

    switch (method) {
      case 'initialize': {
        const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        const supported = PROTOCOL_VERSIONS.find((candidate) => candidate === requested)
        return void reply(id, {
          protocolVersion: supported ?? PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'lily-check', version },
        })
      }
      case 'ping':
        return void reply(id, {})
      case 'tools/list':
        return void reply(id, { tools: [TOOL] })
      case 'tools/call': {
        // Not awaited: a compile must not hold up `ping` or its own cancellation.
        const call = callTool(id, params).finally(() => pending.delete(call))
        pending.add(call)
        return
      }
      default:
        return void fail(id, RpcError.MethodNotFound, `Method not found: ${method}`)
    }
  }

  const lines = readline.createInterface({ input: options.input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() !== '') handle(line)
  }
  // Calls still running are answered first, so requests can be piped in from a file.
  await Promise.all(pending)
  await service.dispose()
}

function toolArguments(
  args: unknown,
): { file: string; extraArgs?: string[]; outDir?: string } | string {
  const { file, extraArgs, outDir } = (args ?? {}) as Record<string, unknown>
  if (typeof file !== 'string' || file === '') return '"file" must be the path of a .ly file.'
  if (extraArgs !== undefined && !(Array.isArray(extraArgs) && extraArgs.every((arg) => typeof arg === 'string'))) {
    return '"extraArgs" must be an array of strings.'
  }
  if (outDir !== undefined && typeof outDir !== 'string') return '"outDir" must be a string.'
  return { file, extraArgs: extraArgs as string[] | undefined, outDir: outDir || undefined }
}

function toolResult(payload: CheckReport | string, isError: boolean): object {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return {
    content: [{ type: 'text', text }],
    ...(typeof payload === 'string' ? {} : { structuredContent: payload }),
    isError,
  }
}
