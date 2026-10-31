/** A hand remains in memory while its original asynchronous owners drain.
 * This is a cooperative barrier, never a hand abort or replacement. Every
 * caller must hold a mutation permit across an external side effect and
 * release it before waiting at a checkpoint. A nested caller uses the same
 * permit; counting an entire parent promise would deadlock on its child.
 */
export class CooperativeHandPause {
  private owners = new Set<string>();
  private mutations = new Set<symbol>();
  private waiters = new Set<() => void>();
  private listeners = new Set<() => void>();
  private stopped = false;

  onStable(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hold(owner: string): void {
    if (!owner || this.stopped) throw new Error('hand_pause_owner_invalid');
    const added = !this.owners.has(owner);
    this.owners.add(owner);
    if (added) this.notify();
  }

  release(owner: string): void {
    if (!this.owners.delete(owner) || this.owners.size > 0) return;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  held(): boolean {
    return this.owners.size > 0;
  }
  pending(): boolean {
    return this.mutations.size > 0;
  }

  stable(owner: string): boolean {
    return !this.stopped && this.owners.has(owner) && this.mutations.size === 0;
  }

  /** Synchronous admission before starting a write, never after starting it. */
  enterMutation(): (() => void) | null {
    if (this.stopped || this.held()) return null;
    const token = Symbol('original-hand-mutation');
    this.mutations.add(token);
    return () => {
      if (this.mutations.delete(token)) this.notify();
    };
  }

  /** Call immediately after external reads and before changing live state. */
  async checkpoint(): Promise<boolean> {
    while (!this.stopped && this.held()) {
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
    return !this.stopped;
  }

  /** Stop wakes original continuations with false; it does not resume play. */
  stop(): void {
    this.stopped = true;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  private notify(): void {
    if (!this.held() || this.mutations.size > 0 || this.stopped) return;
    for (const listener of this.listeners) listener();
  }
}
