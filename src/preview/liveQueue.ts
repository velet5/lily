/** One running request and one replaceable pending request per root. Completion
 * includes consuming the result, so its files stay alive until the panel reads
 * them. Repeated edits never kill a nearly finished compilation. */
export class LiveQueue<T> {
  private slots = new Map<string, {
    next?: () => Promise<T>
    waiting: Array<{ resolve(value: T | undefined): void; reject(error: unknown): void }>
  }>()

  request(root: string, run: () => Promise<T>): Promise<T | undefined> {
    let slot = this.slots.get(root)
    if (!slot) {
      slot = { waiting: [] }
      this.slots.set(root, slot)
      const active = slot
      // Defer starting until the first waiter has joined.
      queueMicrotask(() => void this.drain(root, active))
    }
    slot.next = run
    return new Promise((resolve, reject) => slot!.waiting.push({ resolve, reject }))
  }

  cancel(root: string): void {
    const slot = this.slots.get(root)
    if (!slot) return
    slot.next = undefined
    for (const waiter of slot.waiting.splice(0)) waiter.resolve(undefined)
    // Keep the slot until the running callback finishes; reopening the same
    // preview must still wait for its old cancelled run to settle.
  }

  private async drain(root: string, slot: NonNullable<ReturnType<typeof this.slots.get>>): Promise<void> {
    while (slot.next) {
      const run = slot.next
      slot.next = undefined
      const waiting = slot.waiting.splice(0)
      try {
        const result = await run()
        for (const waiter of waiting) waiter.resolve(result)
      } catch (error) { for (const waiter of waiting) waiter.reject(error) }
    }
    this.slots.delete(root)
  }
}
