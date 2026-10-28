/** Native hand timers retain their original callback and unspent duration.
 * Lease, process-heartbeat and release timers must not use this custody.
 */
export class CooperativeHandTimers {
  private owners = new Set<string>();
  private sleeps = new Set<() => void>();
  private timers = new Map<
    ReturnType<typeof setTimeout>,
    {
      current: ReturnType<typeof setTimeout>;
      callback: () => void;
      remaining: number;
      due: number;
    }
  >();

  set(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const remaining = Math.max(0, Number.isFinite(ms) ? ms : 0);
    const entry = {
      current: null as unknown as ReturnType<typeof setTimeout>,
      callback,
      remaining,
      due: Date.now() + remaining,
    };
    const identity = setTimeout(() => this.fire(identity), remaining);
    entry.current = identity;
    this.timers.set(identity, entry);
    if (this.owners.size) clearTimeout(identity);
    return identity;
  }

  clear(identity: ReturnType<typeof setTimeout> | null | undefined): void {
    if (!identity) return;
    const entry = this.timers.get(identity);
    if (!entry) return;
    clearTimeout(entry.current);
    this.timers.delete(identity);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        this.sleeps.delete(finish);
        resolve();
      };
      this.sleeps.add(finish);
      this.set(finish, ms);
    });
  }

  hold(owner: string): void {
    if (this.owners.has(owner)) return;
    const wasHeld = this.owners.size > 0;
    this.owners.add(owner);
    if (wasHeld) return;
    const now = Date.now();
    for (const entry of this.timers.values()) {
      entry.remaining = Math.max(0, entry.due - now);
      clearTimeout(entry.current);
    }
  }

  release(owner: string): void {
    if (!this.owners.delete(owner) || this.owners.size) return;
    for (const [identity, entry] of this.timers) {
      entry.due = Date.now() + entry.remaining;
      entry.current = setTimeout(() => this.fire(identity), entry.remaining);
    }
  }

  stop(): void {
    for (const entry of this.timers.values()) clearTimeout(entry.current);
    this.timers.clear();
    for (const wake of this.sleeps) wake();
    this.sleeps.clear();
  }

  private fire(identity: ReturnType<typeof setTimeout>): void {
    const entry = this.timers.get(identity);
    if (!entry || this.owners.size) return;
    this.timers.delete(identity);
    entry.callback();
  }
}
