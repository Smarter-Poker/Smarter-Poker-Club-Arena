/** Original weekly money rounds own this pause; maintenance never releases it.
 * Notifications, hand-boundary events and reconnect snapshots drive progress.
 * There is no periodic worker and no financial replay in this controller.
 */
export interface WeeklyPayoutIdentity {
  runId: string;
  ownershipToken: string;
  scopeKind: 'global';
  scopeId: string;
  periodStart: string;
  periodEnd: string;
}
export interface WeeklyPayoutBoundary extends WeeklyPayoutIdentity {
  phase: 'draining' | 'ready' | 'paying' | 'released';
  announcedAt: number;
  moneyStartsAt: number;
  expiresAt: number;
  /** DB-enforced transaction deadline, strictly before the gameplay lease. */
  moneyDeadlineAt: number;
}
export interface WeeklyPayoutTable {
  pauseForWeeklyPayout(owner: string): void;
  engageWeeklyPayoutHandPause(owner: string): void;
  resumeFromWeeklyPayout(owner: string): void;
  isParkedForWeeklyPayout(owner: string): boolean;
  isRunning(): boolean;
  hasUnresolvedF06Preparation?(): boolean;
  hasUnretiredStoppedTimeBankCustody?(): boolean;
  hasWeeklyPayoutMutationInFlight?(): boolean;
}
export interface WeeklyPayoutPauseDeps {
  engines(): Iterable<WeeklyPayoutTable>;
  drainReady?(): boolean;
  /** CAS admission verifies current run/rates/drain and executes no money. */
  admit(expected: WeeklyPayoutBoundary): Promise<WeeklyPayoutBoundary>;
  /** Reads the same durable owner after interruption; never reruns a payer. */
  read(expected: WeeklyPayoutIdentity): Promise<WeeklyPayoutBoundary>;
  /** Database-relative clock derived from an observed DB time and monotonic elapsed time. Never raw host wall time. */
  now(): number;
  onChanged(boundary: WeeklyPayoutBoundary | null): void;
  onError?(error: unknown): void;
}
export const WEEKLY_PAYOUT_MONEY_BUDGET_MS = 240_000;
export const WEEKLY_PAYOUT_PAUSE_MS = 300_000;
export const WEEKLY_PAYOUT_LAST_HAND_MS = 120_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identity(b: WeeklyPayoutIdentity): string {
  return [b.runId, b.ownershipToken, b.scopeKind, b.scopeId, b.periodStart, b.periodEnd].join(':');
}
function validate(b: WeeklyPayoutBoundary): void {
  if (
    ![b.runId, b.ownershipToken, b.scopeId].every((x) => uuid.test(x)) ||
    b.scopeKind !== 'global' ||
    !['draining', 'ready', 'paying', 'released'].includes(b.phase) ||
    !Number.isFinite(Date.parse(b.periodStart)) ||
    !Number.isFinite(Date.parse(b.periodEnd)) ||
    Date.parse(b.periodStart) >= Date.parse(b.periodEnd) ||
    !Number.isFinite(b.announcedAt) ||
    !Number.isFinite(b.moneyStartsAt) ||
    b.moneyStartsAt - b.announcedAt !== WEEKLY_PAYOUT_LAST_HAND_MS ||
    b.expiresAt - b.moneyStartsAt !== WEEKLY_PAYOUT_PAUSE_MS ||
    b.moneyDeadlineAt - b.moneyStartsAt !== WEEKLY_PAYOUT_MONEY_BUDGET_MS
  )
    throw new Error('weekly_payout_boundary_invalid');
}
export class WeeklyPayoutPause {
  private current: WeeklyPayoutBoundary | null = null;
  private generation = 0;
  private admitting = false;
  private stopped = false;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private announcementTimer: ReturnType<typeof setTimeout> | null = null;
  private moneyTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly deps: WeeklyPayoutPauseDeps) {}

  snapshot(): WeeklyPayoutBoundary | null {
    return this.current ? { ...this.current } : null;
  }

  /** Realtime is a wake only. The caller supplies a DB-read authoritative row. */
  accept(boundary: WeeklyPayoutBoundary): void {
    if (this.stopped) throw new Error('weekly_payout_controller_stopped');
    validate(boundary);
    const previous = this.current;
    if (previous && identity(previous) !== identity(boundary))
      throw new Error('weekly_payout_owner_changed_without_release');
    if (
      previous &&
      (previous.announcedAt !== boundary.announcedAt ||
        previous.moneyStartsAt !== boundary.moneyStartsAt ||
        previous.expiresAt !== boundary.expiresAt ||
        previous.moneyDeadlineAt !== boundary.moneyDeadlineAt)
    )
      throw new Error('weekly_payout_deadline_renewal_refused');
    if (
      previous &&
      ((previous.phase === 'paying' && ['draining', 'ready'].includes(boundary.phase)) ||
        (previous.phase === 'ready' && boundary.phase === 'draining'))
    )
      throw new Error('weekly_payout_phase_regression');
    if (boundary.phase === 'released') {
      if (previous) this.release(previous);
      return;
    }
    if (this.deps.now() >= boundary.expiresAt) throw new Error('weekly_payout_expired_boundary');
    this.current = { ...boundary };
    if (this.deps.now() < boundary.announcedAt && !this.announcementTimer) {
      this.announcementTimer = setTimeout(
        () => {
          this.announcementTimer = null;
          for (const engine of this.deps.engines()) this.adopt(engine);
          this.deps.onChanged(this.snapshot());
        },
        Math.ceil(boundary.announcedAt - this.deps.now())
      );
      this.announcementTimer.unref?.();
    }
    if (this.deps.now() < boundary.moneyStartsAt && !this.moneyTimer) {
      this.moneyTimer = setTimeout(
        () => {
          this.moneyTimer = null;
          for (const engine of this.deps.engines()) this.adopt(engine);
          void this.handBoundary().catch((error) => this.deps.onError?.(error));
        },
        Math.ceil(boundary.moneyStartsAt - this.deps.now())
      );
      this.moneyTimer.unref?.();
    }
    if (!this.expiryTimer) {
      // One operation deadline, not a periodic payer or repair worker. SQL
      // fences execution before this DB-relative gameplay lease expires.
      this.expiryTimer = setTimeout(
        () => {
          this.expiryTimer = null;
          this.expire();
        },
        Math.ceil(boundary.expiresAt - this.deps.now()) + 1
      );
      this.expiryTimer.unref?.();
    }
    for (const engine of this.deps.engines()) this.adopt(engine);
    this.deps.onChanged(this.deps.now() >= boundary.announcedAt ? this.snapshot() : null);
  }

  /** All newly adopted cash and tournament engines inherit the same owner. */
  adopt(engine: WeeklyPayoutTable): void {
    if (this.stopped || !this.current || this.deps.now() < this.current.announcedAt) return;
    const owner = identity(this.current);
    engine.pauseForWeeklyPayout(owner);
    if (this.deps.now() >= this.current.moneyStartsAt) engine.engageWeeklyPayoutHandPause(owner);
  }

  /** Called at actual between-hand park events, never by a repair interval. */
  async handBoundary(): Promise<void> {
    const before = this.current;
    if (this.stopped || !before || before.phase !== 'draining' || this.admitting) return;
    if (
      this.deps.now() < before.moneyStartsAt ||
      this.deps.now() >= before.moneyDeadlineAt ||
      this.deps.drainReady?.() === false
    )
      return;
    for (const engine of this.deps.engines()) {
      if (
        engine.hasUnresolvedF06Preparation?.() ||
        engine.hasUnretiredStoppedTimeBankCustody?.() ||
        engine.hasWeeklyPayoutMutationInFlight?.()
      )
        return;
      if (engine.isRunning() && !engine.isParkedForWeeklyPayout(identity(before))) return;
    }
    this.admitting = true;
    const generation = this.generation;
    try {
      const after = await this.deps.admit({ ...before });
      if (generation !== this.generation || this.current !== before) return;
      this.accept(after);
    } finally {
      this.admitting = false;
    }
  }

  /** On RPC loss/reconnect read the SAME operation; do not infer failure. */
  async reconcile(): Promise<void> {
    const before = this.current;
    if (this.stopped || !before) return;
    const generation = this.generation;
    const after = await this.deps.read(before);
    if (generation === this.generation && this.current === before) this.accept(after);
  }

  /** Existing maintenance end event supplies the finite safety boundary.
   * Database admission and the original 240s statement deadline MUST fence
   * financial execution before this five-minute boundary; no payment verdict
   * is inferred when only the gameplay hold expires.
   */
  expire(): void {
    const before = this.current;
    if (!this.stopped && before && this.deps.now() >= before.expiresAt) this.release(before);
  }

  /** Shutdown invalidates pending replies; it never resumes stopped engines. */
  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.announcementTimer) clearTimeout(this.announcementTimer);
    if (this.moneyTimer) clearTimeout(this.moneyTimer);
    this.announcementTimer = this.moneyTimer = null;
  }

  private release(before: WeeklyPayoutBoundary): void {
    const owner = identity(before);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.announcementTimer) clearTimeout(this.announcementTimer);
    if (this.moneyTimer) clearTimeout(this.moneyTimer);
    this.announcementTimer = this.moneyTimer = null;
    this.current = null;
    this.generation++;
    for (const engine of this.deps.engines()) engine.resumeFromWeeklyPayout(owner);
    this.deps.onChanged(null);
  }
}
