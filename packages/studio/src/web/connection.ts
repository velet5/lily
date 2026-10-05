// The page's socket to its user's worker (DECISIONS D55), as the gateway
// relays it: calls `{id, command, args}` out, answers `{id, ok | error}` and
// events `{event}` in, and the gateway's own `hello`, `replaced` and
// `closed`. Calls made while it is down wait and go out once it is back, in
// order. When it comes back, to a worker started anew or one another tab
// used, `onHello` runs first, to give the worker what the page had opened.
import { Overlay } from './overlay'

type Pending = { resolve(value: unknown): void; reject(error: Error): void }

interface Hello {
  user: string
  instance: string
}

/** Waits before connecting again: longer after each failure, at most the last. */
const RETRY_MS = [500, 1000, 2000, 5000, 10000]

export class Connection {
  /** The signed-in user, once the gateway has said. */
  user: string | undefined
  /** Runs at each hello; `again` for every hello after the first. */
  onHello: ((hello: Hello, again: boolean) => Promise<void>) | undefined
  onEvent: ((event: unknown) => void) | undefined

  private socket: WebSocket | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  /** Lines waiting for the socket, in order. */
  private queue: string[] = []
  /** True once the hello of the socket was handled; lines go out directly. */
  private open = false
  private instance: string | undefined
  /** Set when the gateway ended the connection for good: another tab, or a stopped worker. */
  private ended = false
  private failures = 0
  private readonly overlay = new Overlay()
  private readonly connected: Promise<void>
  private markConnected!: () => void

  constructor() {
    this.connected = new Promise((resolve) => (this.markConnected = resolve))
    this.connect()
  }

  /** Resolves at the first hello. */
  ready(): Promise<void> {
    return this.connected
  }

  call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      const line = JSON.stringify({ id, command, args: args ?? {} })
      if (this.open && this.socket?.readyState === WebSocket.OPEN) this.socket.send(line)
      else this.queue.push(line)
    })
  }

  private connect(): void {
    this.open = false
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${scheme}://${location.host}/ws`)
    this.socket = socket
    socket.addEventListener('message', (message) => void this.received(String(message.data)))
    socket.addEventListener('close', () => void this.closed(socket))
  }

  private async received(text: string): Promise<void> {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(text) as Record<string, unknown>
    } catch {
      return console.error('not a message:', text)
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if ('error' in message) pending.reject(new Error(String(message.error)))
      else pending.resolve(message.ok)
    } else if ('event' in message) {
      this.onEvent?.(message.event)
    } else if (message.hello) {
      await this.hello(message.hello as Hello)
    } else if (message.replaced) {
      this.ended = true
      this.overlay.show({
        title: 'Lily Studio is open in another tab',
        text: 'It works in one tab at a time. Your changes here are kept until you close this tab.',
        action: { label: 'Use It Here', run: () => this.resume() },
      })
    } else if (typeof message.closed === 'string') {
      this.ended = true
      this.overlay.show({ title: 'Lily Studio stopped', text: message.closed, action: { label: 'Reload', run: () => location.reload() } })
    }
  }

  private async hello(hello: Hello): Promise<void> {
    const again = this.instance !== undefined
    this.instance = hello.instance
    this.user = hello.user
    this.failures = 0
    try {
      await this.onHello?.(hello, again)
    } catch (error) {
      console.error('reconnect:', error)
    }
    this.open = true
    const queued = this.queue
    this.queue = []
    for (const line of queued) this.socket?.send(line)
    this.overlay.hide()
    this.markConnected()
  }

  /**
   * Sends a call ahead of the queue, while connecting: what `onHello` gives
   * a fresh worker before the calls that waited.
   */
  callFirst<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.socket?.send(JSON.stringify({ id, command, args: args ?? {} }))
    })
  }

  private async closed(socket: WebSocket): Promise<void> {
    if (socket !== this.socket) return
    this.open = false
    // What was asked is lost with the worker's answers; the page says so where it asked.
    for (const pending of this.pending.values()) pending.reject(new Error('The connection to the server was lost. Try again.'))
    this.pending.clear()
    if (this.ended) return
    if (await this.signedOut()) {
      this.ended = true
      this.overlay.show({
        title: 'You are signed out',
        text: 'Sign in again to go on. Copy any changes you have not saved first.',
        action: { label: 'Sign In', run: () => location.assign('/login') },
      })
      return
    }
    const wait = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)]
    this.failures++
    if (this.failures > 1) this.overlay.show({ title: 'Reconnecting…', text: 'The connection to the server was lost. Your changes are kept.' })
    setTimeout(() => this.connect(), wait)
  }

  /** True when the session is gone: the studio's page sends to the sign-in page. */
  private async signedOut(): Promise<boolean> {
    try {
      const response = await fetch('/', { redirect: 'manual', cache: 'no-store' })
      return response.type === 'opaqueredirect'
    } catch {
      // The server is down; that is not signing out.
      return false
    }
  }

  /** Takes the worker back from another tab. */
  private resume(): void {
    this.ended = false
    this.overlay.show({ title: 'Reconnecting…', text: '' })
    this.connect()
  }
}
