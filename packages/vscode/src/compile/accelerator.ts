import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createInterface } from 'node:readline'

// Only this exact upstream backend has been checked. Unknown/patched versions
// use ordinary spawning; installed LilyPond files are never changed.
const BACKEND_HASH = '82b4a568e196239557fba92670dc0d9a685edae129dc0625fc1f1ef65a70e6d2'
const PROBE = '(begin (display (lilypond-version)) (newline) (display (search-path %load-path "lily/output-svg.scm")) (newline) (primitive-exit 0))'
export const schemeString = (value: string): string =>
  '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"'

export interface ProcessResult { exitCode: number | null; stdout: string; stderr: string }

/** A parent owned by one root/configuration, with one private request at a time. */
export class WarmCompiler {
  private child: ChildProcess
  private answer?: { resolve(value: string): void; reject(error: Error): void }
  private failure?: Error
  private ready: Promise<string>
  private timer?: NodeJS.Timeout
  private requests = 0
  private readonly born = Date.now()

  constructor(binary: string, args: string[], cwd: string, runtimeDir: string) {
    this.child = spawn(binary, [...args, '-e', `(load ${schemeString(path.join(runtimeDir, 'worker.scm'))})`], {
      cwd, env: { ...process.env, LANGUAGE: 'en' },
      stdio: ['pipe', 'ignore', 'pipe', 'pipe'], detached: true, windowsHide: true,
    })
    // Parent output is never a score's output. Bound it; unexpected logging is
    // diagnostic context for fallback, not an unbounded retained buffer.
    let log = ''
    this.child.stderr!.on('data', (chunk: Buffer) => { log = (log + chunk).slice(-8192) })
    this.child.stdin!.on('error', (error) => this.stop(error))
    this.child.on('error', (error) => this.stop(error))
    this.child.on('close', () => this.stop(new Error(`Warm compiler exited. ${log}`)))
    const control = this.child.stdio[3] as NodeJS.ReadableStream
    createInterface({ input: control }).on('line', (line) => {
      const answer = this.answer
      if (!answer || line.length > 100) return this.stop(new Error('Invalid warm compiler response'))
      this.answer = undefined
      answer.resolve(line)
    })
    this.ready = this.response(10000)
    // Startup can fail before run() awaits it.
    void this.ready.catch(() => {})
  }

  get busy(): boolean { return this.answer !== undefined }

  get expired(): boolean { return !!this.failure || this.requests >= 32 || Date.now() - this.born > 5 * 60000 }

  async run(file: string, outputDir: string, timeoutMs: number): Promise<ProcessResult> {
    clearTimeout(this.timer)
    if (await this.ready !== 'READY') throw new Error('Unsupported warm compiler')
    const id = ++this.requests
    const response = this.response(timeoutMs)
    this.child.stdin!.write(`(${id} ${schemeString(file)} ${schemeString(outputDir)})\n`)
    const answer = await response
    const match = new RegExp(`^DONE ${id} ([01])$`).exec(answer)
    if (!match) throw new Error(`Warm compiler failed: ${answer}`)
    const read = (name: string) => fs.readFile(path.join(outputDir, name), 'utf8').catch(() => '')
    const [stdout, stderr] = await Promise.all([read('worker.stdout'), read('worker.stderr')])
    this.timer = setTimeout(() => this.stop(), 60000)
    this.timer.unref()
    return { exitCode: Number(match[1]), stdout, stderr }
  }

  stop(error = new Error('Warm compiler stopped')): void {
    if (this.failure) return
    this.failure = error
    clearTimeout(this.timer)
    // Kill the process group, including a stuck fork, before deleting output.
    if (this.child.pid) {
      try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* already exited */ }
    }
    this.answer?.reject(error)
    this.answer = undefined
  }

  private response(timeoutMs: number): Promise<string> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new Error('Warm compiler timed out')), timeoutMs)
      this.answer = {
        resolve: (line) => { clearTimeout(timer); resolve(line) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      }
    })
  }
}

export class Accelerator {
  private probes = new Map<string, Promise<string | undefined>>()
  private workers = new Map<string, { key: string; worker: WarmCompiler }>()
  private failed = new Set<string>()

  constructor(readonly runtimeDir?: string) {}

  async identity(binary: string): Promise<string> {
    const real = await fs.realpath(binary)
    const stat = await fs.stat(real)
    return JSON.stringify([real, stat.size, stat.mtimeMs, process.env])
  }

  async supported(binary: string, identity: string): Promise<boolean> {
    if (!this.runtimeDir) return false
    let probe = this.probes.get(identity)
    if (!probe) {
      probe = new Promise<string | undefined>((resolve) => {
        execFile(binary, ['--loglevel=ERROR', '-e', PROBE], { timeout: 5000, maxBuffer: 16384 }, async (error, stdout) => {
          if (error) return resolve(undefined)
          const [version, backend] = stdout.trim().split(/\r?\n/)
          try {
            await fs.access(path.join(this.runtimeDir!, 'glyph-cache.scm'))
            resolve(version === '2.26.0' ? backend : undefined)
          } catch { resolve(undefined) }
        })
      })
      this.probes.clear() // bound retained binary identities
      this.probes.set(identity, probe)
    }
    const backend = await probe
    if (!backend) return false
    try {
      return createHash('sha256').update(await fs.readFile(backend)).digest('hex') === BACKEND_HASH
    } catch { return false }
  }

  cacheArgs(): string[] {
    return ['-e', `(load ${schemeString(path.join(this.runtimeDir!, 'glyph-cache.scm'))})`]
  }

  worker(root: string, identity: string, binary: string, args: string[]): WarmCompiler | undefined {
    const key = JSON.stringify([identity, args])
    if (this.failed.has(key)) return undefined
    let entry = this.workers.get(root)
    if (entry && (entry.key !== key || entry.worker.expired)) {
      entry.worker.stop()
      this.workers.delete(root)
      entry = undefined
    }
    if (!entry) {
      // Bound idle processes even when many previews are opened.
      if (this.workers.size >= 4) {
        const idle = [...this.workers].find(([, entry]) => !entry.worker.busy)
        if (!idle) return undefined
        this.release(idle[0])
      }
      entry = { key, worker: new WarmCompiler(binary, args, path.dirname(root), this.runtimeDir!) }
      this.workers.set(root, entry)
    }
    return entry.worker
  }

  failedWorker(root: string, worker: WarmCompiler): void {
    const entry = this.workers.get(root)
    if (entry?.worker !== worker) return
    if (entry) {
      this.failed.add(entry.key)
      if (this.failed.size > 16) this.failed.delete(this.failed.values().next().value!)
    }
    this.release(root)
  }

  release(root: string, expected?: WarmCompiler): void {
    if (expected && this.workers.get(root)?.worker !== expected) return
    this.workers.get(root)?.worker.stop()
    this.workers.delete(root)
  }

  dispose(): void { for (const root of this.workers.keys()) this.release(root) }
}
