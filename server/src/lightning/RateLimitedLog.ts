/**
 * A per-key "may I say this again yet?" gate for log lines and error reports
 * that would otherwise repeat on every pass of a loop.
 *
 * Bounded: a process that sees an unbounded stream of distinct keys (one per
 * player, one per table) must not grow a map for ever, so the oldest keys are
 * dropped once `maxKeys` is reached. Dropping a key can only make the NEXT
 * line for that key print sooner, never later, so the bound costs at most one
 * extra line and can never hide one.
 */
export class RateLimitedLog {
  private readonly lastAt = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly maxKeys: number = 1000
  ) {}

  /** True when `key` has not been admitted within the interval; admits it. */
  shouldLog(key: string, now: number = Date.now()): boolean {
    const last = this.lastAt.get(key);
    if (last !== undefined && now - last < this.intervalMs) return false;
    // Re-insert so iteration order is oldest-first for the eviction below.
    this.lastAt.delete(key);
    this.lastAt.set(key, now);
    while (this.lastAt.size > this.maxKeys) {
      const oldest = this.lastAt.keys().next().value;
      if (oldest === undefined) break;
      this.lastAt.delete(oldest);
    }
    return true;
  }

  /** Forget one key, so its next line prints at once. */
  forget(key: string): void {
    this.lastAt.delete(key);
  }

  /** Keys currently remembered. For tests and the bound's own proof. */
  get size(): number {
    return this.lastAt.size;
  }
}
