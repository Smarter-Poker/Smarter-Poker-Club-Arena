import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { PausableTableEngine } from './MaintenanceBreak.js';
import {
  assertMaintenanceThawRelease,
  type MaintenanceThawRequest,
  type MaintenanceThawRelease,
} from './maintenanceThawV3.js';
import { completeReconnectFreeze, completeTableReconnectFreeze } from './reconnectFreeze.js';
import {
  markOperationTableResumed,
  setMaintenanceFrozen,
  certifyOperationGlobalRelease,
  isMaintenanceFrozen,
  onNextMaintenanceThaw,
} from './freezeState.js';
import type { OperationTournament, OperationTournamentProof } from './OperationTournament.js';
import {
  OperationHoldClock,
  operationMaintenancePolicy as policy,
  validateOperationState,
  type OperationMaintenanceSnapshot,
  type OperationMaintenanceState,
} from './operationPolicy.js';

export interface OperationResumeWave {
  receiptId: string;
  intervalId: string;
  ownershipToken: string;
  tableIds: readonly string[];
  creditedThroughAt: number;
}

export interface OperationMaintenanceStore {
  loadOperation(knownIntervalId?: string): Promise<OperationMaintenanceSnapshot>;
  claimOperation(
    state: OperationMaintenanceState,
    nextToken: string
  ): Promise<OperationMaintenanceSnapshot>;
  watchOperations(changed: () => void): () => Promise<void>;
  reportOperationReady(
    state: OperationMaintenanceState,
    tableIds: readonly string[],
    waves: readonly (readonly string[])[]
  ): Promise<void>;
  reportOperationRecovery(state: OperationMaintenanceState, reason: string): Promise<void>;
  releaseOperationWave(
    state: OperationMaintenanceState,
    wave: number,
    tableIds: readonly string[]
  ): Promise<OperationResumeWave>;
  completeOperationResume(
    state: OperationMaintenanceState,
    waveReceipts: readonly string[]
  ): Promise<OperationMaintenanceState>;
  acknowledgeOperationWave(
    state: OperationMaintenanceState,
    wave: number,
    receiptId: string,
    tableIds: readonly string[],
    resumedAt: number
  ): Promise<void>;
}

interface Dependencies {
  store: OperationMaintenanceStore;
  engines(): Iterable<[string, PausableTableEngine]>;
  tournaments?(): Iterable<OperationTournament>;
  emit(tableId: string, payload: Record<string, unknown>): void;
  thaw(
    request: Readonly<MaintenanceThawRequest>,
    signal: AbortSignal
  ): Promise<MaintenanceThawRelease>;
  planWaves(
    engines: Array<[string, PausableTableEngine]>
  ): Array<Array<[string, PausableTableEngine]>>;
  waveGapMs: number;
  onActivated(): void;
  report(error: unknown): void;
  monotonicNow?: () => number;
}

/** The v2 runtime uses the same engine pause and v3 thaw authorities as the
 * legacy scheduler. Its input is an admitted durable operation, never :55. */
export class OperationMaintenanceRuntime {
  private policyVersion: 1 | 2 = 1;
  private activationReceipt: string | null = null;
  private current: OperationMaintenanceState | null = null;
  private clock: OperationHoldClock | null = null;
  private ownedToken: string | null = null;
  private refreshJob: Promise<void> | null = null;
  private releaseJob: Promise<void> | null = null;
  private unsubscribe: (() => Promise<void>) | null = null;
  private dirty = false;
  private started = false;
  private readonly abort = new AbortController();
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;
  private presenceRetryAt = 0;
  private releaseInDoubt = false;
  private readyReported = false;
  private recoveryReported: 'recover' | 'recovery_required' | null = null;
  private baseReleased = false;
  private readonly resumedTables = new Set<string>();
  private readonly waitingTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
  private tournamentJob: Promise<void> | null = null;
  private tournamentWakePending = false;
  private readonly adoptedTournaments = new WeakSet<OperationTournament>();
  private readonly tournamentJobs = new Map<
    OperationTournament,
    { promise: Promise<void>; again: boolean }
  >();
  private cancelTournamentThaw: (() => void) | null = null;

  constructor(private readonly deps: Dependencies) {}

  async start(): Promise<void> {
    if (this.started) return;
    if (this.abort.signal.aborted) throw new Error('maintenance_operation_runtime_stopped');
    this.started = true;
    // Subscribe before snapshot; reconnect is also a reconciliation event.
    this.unsubscribe = this.deps.store.watchOperations(() => {
      void this.refresh().catch(this.deps.report);
    });
    await this.refresh();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.abort.abort();
    this.cancelTournamentThaw?.();
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.deadlineTimer = this.drainTimer = null;
    for (const [timer, finish] of this.waitingTimers) {
      clearTimeout(timer);
      finish();
    }
    this.waitingTimers.clear();
    await this.unsubscribe?.();
    await Promise.allSettled(
      [
        this.refreshJob,
        this.releaseJob,
        this.tournamentJob,
        ...[...this.tournamentJobs.values()].map((job) => job.promise),
      ].filter(Boolean)
    );
  }

  private wait(ms: number): Promise<void> {
    if (this.abort.signal.aborted || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waitingTimers.delete(timer);
        resolve();
      }, Math.ceil(ms));
      this.waitingTimers.set(timer, resolve);
    });
  }

  private async waitUntil(boundary: number): Promise<void> {
    while (!this.abort.signal.aborted && this.clock && this.clock.now() < boundary) {
      await this.wait(boundary - this.clock.now());
    }
  }

  refresh(): Promise<void> {
    this.dirty = true;
    if (this.refreshJob) return this.refreshJob;
    this.refreshJob = this.reconcile()
      .then(() => {
        this.lastError = null;
      })
      .catch((error) => {
        this.retry(error);
        throw error;
      })
      .finally(() => {
        this.refreshJob = null;
        if (this.dirty && this.started) void this.refresh().catch(this.deps.report);
      });
    return this.refreshJob;
  }

  private retry(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    if (!this.started || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh()
        .then(() => this.checkProgress())
        .catch((error) => {
          this.deps.report(error);
          this.retry(error);
        });
    }, 5000);
  }

  private progress(): void {
    void this.checkProgress().catch((error) => {
      this.deps.report(error);
      this.retry(error);
    });
  }

  private async reconcile(): Promise<void> {
    while (this.dirty && this.started) {
      this.dirty = false;
      const snapshot = await this.deps.store.loadOperation(
        this.current?.phase === 'resumed' ? undefined : this.current?.intervalId
      );
      if (!this.started) return;
      if (snapshot.policyVersion === 2) {
        if (!snapshot.activationReceipt) throw new Error('maintenance_activation_receipt_missing');
        if (this.policyVersion !== 2) this.deps.onActivated();
        this.policyVersion = 2;
        this.activationReceipt = snapshot.activationReceipt;
      } else if (this.policyVersion === 2) {
        throw new Error('maintenance_activation_regressed');
      }
      if (this.policyVersion !== 2) return;
      if (!snapshot.operation) {
        if (this.current && this.current.phase !== 'resumed')
          throw new Error('maintenance_owned_interval_missing');
        return;
      }
      let state = validateOperationState(snapshot.operation);
      if (
        this.current &&
        this.current.intervalId !== state.intervalId &&
        this.current.phase !== 'resumed'
      ) {
        throw new Error('maintenance_continuous_hold_replaced');
      }
      const first = !this.current || this.current.intervalId !== state.intervalId;
      if (first && state.phase !== 'resumed') {
        const token = randomUUID();
        const claimed = await this.deps.store.claimOperation(state, token);
        if (!this.started) return;
        if (!claimed.operation) throw new Error('maintenance_operation_claim_missing');
        state = validateOperationState(claimed.operation);
        if (state.intervalId !== snapshot.operation.intervalId || state.ownershipToken !== token) {
          throw new Error('maintenance_operation_claim_changed');
        }
        this.ownedToken = token;
        this.resumedTables.clear();
        for (const wave of state.resumeWaves) {
          if (wave.resumedAt !== null) wave.tableIds.forEach((id) => this.resumedTables.add(id));
        }
        this.baseReleased = false;
        this.releaseInDoubt = false;
        this.readyReported = false;
        this.recoveryReported = null;
      } else if (this.current && state.intervalId === this.current.intervalId) {
        if (
          state.generation < this.current.generation ||
          state.freezeStartedAt !== this.current.freezeStartedAt ||
          state.deadlineAt !== this.current.deadlineAt ||
          JSON.stringify(state.scope) !== JSON.stringify(this.current.scope)
        ) {
          throw new Error('maintenance_interval_identity_changed');
        }
        if (state.ownershipToken !== this.ownedToken && state.phase !== 'resumed') {
          this.ownedToken = null;
          throw new Error('maintenance_operation_ownership_lost');
        }
      }
      const observedAt = Math.max(
        state.observedAt,
        first ? state.observedAt : (this.clock?.now() ?? state.observedAt)
      );
      this.current = state;
      this.clock = new OperationHoldClock(
        { ...state, observedAt },
        this.deps.monotonicNow ?? (() => performance.now())
      );
      if (state.phase === 'resumed') {
        this.baseReleased = true;
        if (state.scope.type === 'platform') setMaintenanceFrozen(false);
        this.adoptTournaments();
        this.redriveTournaments();
        continue;
      }
      if (state.scope.type === 'platform') {
        setMaintenanceFrozen(true);
        if (state.globalTail?.receiptId)
          certifyOperationGlobalRelease(
            state.globalTail.receiptId,
            state.globalTail.creditedThroughAt,
            () => this.clock!.now()
          );
      }
      for (const id of this.resumedTables) markOperationTableResumed(id);
      this.adoptTournaments();
      if (first) {
        this.cancelTournamentThaw?.();
        this.cancelTournamentThaw = onNextMaintenanceThaw(
          () => this.redriveTournaments(),
          this.abort.signal
        );
      }
      this.parkAndAnnounce();
      this.redriveTournaments();
      this.armProgress();
      if (
        ['release_authorized', 'releasing'].includes(state.phase) &&
        !this.releaseJob &&
        !this.releaseInDoubt
      ) {
        this.releaseJob = this.release(state)
          .catch(async (error) => {
            this.releaseInDoubt = true;
            this.lastError = error instanceof Error ? error.message : String(error);
            this.deps.report(error);
            if (this.owned(state)) {
              try {
                await this.deps.store.reportOperationRecovery(state, 'thaw_or_wave_unproven');
              } catch (reportError) {
                this.deps.report(reportError);
                this.retry(reportError);
              }
            }
          })
          .finally(() => {
            this.releaseJob = null;
          });
      }
    }
  }

  private selected(): Array<[string, PausableTableEngine]> {
    const state = this.current;
    if (!state) return [];
    const ids = state.scope.type === 'tables' ? new Set(state.scope.tableIds) : null;
    return [...this.deps.engines()].filter(([id]) => !ids || ids.has(id));
  }

  private tournaments(): OperationTournament[] {
    const state = this.current;
    if (!state) return [];
    return [...(this.deps.tournaments?.() ?? [])].filter(
      (manager) =>
        (state.phase !== 'resumed' || this.adoptedTournaments.has(manager)) &&
        (state.scope.type === 'platform' ||
          manager
            .getTableIds()
            .some((id) => state.scope.type === 'tables' && state.scope.tableIds.includes(id)))
    );
  }

  /** Must run synchronously before manager.start/resume, including empty managers. */
  adoptTournament(manager: OperationTournament): void {
    const state = this.current;
    if (!this.started || !state || !this.enabled() || state.phase === 'resumed') return;
    if (
      state.scope.type === 'platform' ||
      manager
        .getTableIds()
        .some((id) => state.scope.type === 'tables' && state.scope.tableIds.includes(id))
    ) {
      manager.adoptOperationMaintenance(state);
      this.adoptedTournaments.add(manager);
    }
  }

  private adoptTournaments(): void {
    for (const manager of this.tournaments()) this.adoptTournament(manager);
  }

  private tournamentsDrained(): boolean {
    return this.tournaments().every((manager) => manager.operationMaintenanceDrain().ready);
  }

  private async tournamentProof(
    state: OperationMaintenanceState,
    phases: readonly string[] = ['releasing', 'resumed']
  ): Promise<OperationMaintenanceState> {
    const snapshot = await this.deps.store.loadOperation(state.intervalId);
    const fresh = snapshot.operation && validateOperationState(snapshot.operation);
    if (
      !this.started ||
      snapshot.policyVersion !== 2 ||
      snapshot.activationReceipt !== this.activationReceipt ||
      !fresh ||
      fresh.operationId !== state.operationId ||
      fresh.releaseId !== state.releaseId ||
      fresh.intervalId !== state.intervalId ||
      fresh.ownershipToken !== state.ownershipToken ||
      fresh.generation !== state.generation ||
      fresh.freezeStartedAt !== state.freezeStartedAt ||
      JSON.stringify(fresh.scope) !== JSON.stringify(state.scope) ||
      !phases.includes(fresh.phase) ||
      this.current?.intervalId !== state.intervalId ||
      this.current.ownershipToken !== state.ownershipToken
    )
      throw new Error('maintenance_tournament_readback_unowned');
    return fresh;
  }

  /** Restart/readback consumes committed ACKs; it never repeats physical resume. */
  reconcileTournament(manager: OperationTournament): Promise<void> {
    if (!this.started) return Promise.resolve();
    const running = this.tournamentJobs.get(manager);
    if (running) {
      // A later ACK/certificate cannot be consumed by an earlier in-flight read.
      running.again = true;
      return running.promise;
    }
    const job = { promise: Promise.resolve(), again: true };
    job.promise = Promise.resolve()
      .then(async () => {
        do {
          job.again = false;
          await this.reconcileTournamentOnce(manager);
        } while (this.started && job.again);
      })
      .finally(() => this.tournamentJobs.delete(manager));
    this.tournamentJobs.set(manager, job);
    return job.promise;
  }

  private async reconcileTournamentOnce(manager: OperationTournament): Promise<void> {
    this.adoptTournament(manager);
    if (!this.adoptedTournaments.has(manager)) return;
    const state = this.current;
    if (
      !state ||
      !['releasing', 'resumed'].includes(state.phase) ||
      manager.getTableIds().length === 0
    )
      return;
    const ids = manager.getTableIds();
    const wave = state.resumeWaves.find((w) => ids.every((id) => w.tableIds.includes(id)));
    if (!wave || wave.resumedAt === null) return;
    const proof: OperationTournamentProof = {
      state,
      readback: () => this.tournamentProof(state),
      isCurrent: () =>
        this.started &&
        this.current?.intervalId === state.intervalId &&
        this.current.ownershipToken === state.ownershipToken &&
        this.current.generation === state.generation &&
        this.current.operationId === state.operationId &&
        this.current.releaseId === state.releaseId &&
        ['releasing', 'resumed'].includes(this.current.phase),
      now: () => this.clock!.now(),
    };
    await manager.resumeOperationClock(proof);
    if (state.globalTail?.receiptId && this.clock!.now() >= state.globalTail.creditedThroughAt) {
      isMaintenanceFrozen(); // Realize the certificate before the financial readback.
      await manager.resumeOperationGlobal(proof);
    }
  }

  private redriveTournaments(): void {
    if (!this.started) return;
    this.tournamentWakePending = true;
    if (this.tournamentJob) return;
    this.tournamentJob = (async () => {
      do {
        this.tournamentWakePending = false;
        for (const manager of this.tournaments()) await this.reconcileTournament(manager);
      } while (this.started && this.tournamentWakePending);
    })()
      .catch((error) => {
        this.deps.report(error);
        this.retry(error);
      })
      .finally(() => {
        this.tournamentJob = null;
      });
  }

  holds(tableId: string): boolean {
    if (!this.current || this.current.phase === 'resumed' || this.resumedTables.has(tableId))
      return false;
    return this.current.scope.type === 'platform' || this.current.scope.tableIds.includes(tableId);
  }

  adopt(tableId: string, engine: PausableTableEngine): void {
    if (!this.started || !this.holds(tableId)) return;
    engine.pauseForMaintenance(policy.plannedHoldMs, this.current!.intervalId);
    this.deps.emit(tableId, this.payload(false));
  }

  private parkAndAnnounce(): void {
    for (const [id, engine] of this.selected()) this.adopt(id, engine);
  }

  private owned(state: OperationMaintenanceState): boolean {
    return (
      this.started &&
      this.current?.intervalId === state.intervalId &&
      this.current.ownershipToken === state.ownershipToken &&
      this.ownedToken === state.ownershipToken
    );
  }

  private mayRelease(state: OperationMaintenanceState): boolean {
    return (
      this.owned(state) &&
      ['release_authorized', 'releasing'].includes(this.current!.phase) &&
      this.current!.releaseReceipt === state.releaseReceipt
    );
  }

  private armProgress(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    const state = this.current!;
    if (!this.owned(state) || state.phase === 'resumed') return;
    const now = this.clock!.now();
    const next = now < state.forwardDeadlineAt ? state.forwardDeadlineAt : state.deadlineAt;
    if (now < state.deadlineAt)
      this.deadlineTimer = setTimeout(
        () => {
          this.deadlineTimer = null;
          this.progress();
        },
        Math.max(1, next - now)
      );
    if (!this.drainTimer && ['last_hand', 'draining'].includes(state.phase)) {
      this.drainTimer = setTimeout(
        () => {
          this.drainTimer = null;
          this.progress();
        },
        Math.max(250, state.freezeStartedAt + policy.lastHandNoticeMs - now)
      );
    }
  }

  private async checkProgress(): Promise<void> {
    const state = this.current;
    if (!state || !this.owned(state) || state.phase === 'resumed') return;
    const decision = this.clock!.decision(0, policy.recoveryReserveMs, 0);
    if (decision !== 'forward' && this.recoveryReported !== decision) {
      await this.deps.store.reportOperationRecovery(state, decision);
      if (!this.owned(state)) return;
      this.recoveryReported = decision;
      await this.refresh();
      return;
    }
    if (
      !this.readyReported &&
      ['last_hand', 'draining'].includes(state.phase) &&
      this.clock!.now() >= state.freezeStartedAt + policy.lastHandNoticeMs
    ) {
      const engines = this.selected();
      if (this.clock!.now() >= this.presenceRetryAt) {
        this.presenceRetryAt = this.clock!.now() + 5000;
        for (const [, engine] of engines) engine.retryMaintenancePresence?.();
        // Only unresolved accepted own-break writes cause a row read. Their
        // exact committed state can be reconciled while held; no new writer
        // is admitted by this readiness retry.
        const proof: OperationTournamentProof = {
          state,
          readback: () => this.tournamentProof(state, ['last_hand', 'draining']),
          isCurrent: () =>
            this.owned(state) && ['last_hand', 'draining'].includes(this.current!.phase),
          now: () => this.clock!.now(),
        };
        for (const manager of this.tournaments()) await manager.reconcileOperationHold(proof);
        if (!this.owned(state)) return;
      }
      if (
        engines.every(([, e]) => e.isMaintenanceDrained?.() === true) &&
        this.tournamentsDrained()
      ) {
        await this.deps.store.reportOperationReady(
          state,
          engines.map(([id]) => id),
          this.deps.planWaves(engines).map((wave) => wave.map(([id]) => id))
        );
        if (!this.owned(state)) return;
        this.readyReported = true;
        await this.refresh();
        return;
      }
    }
    this.armProgress();
  }

  private async release(state: OperationMaintenanceState): Promise<void> {
    if (!state.releaseReceipt || !this.mayRelease(state))
      throw new Error('maintenance_release_authority_missing');
    if (
      this.selected().some(
        ([id, e]) => !this.resumedTables.has(id) && e.isMaintenanceDrained?.() !== true
      ) ||
      !this.tournamentsDrained()
    ) {
      throw new Error('maintenance_release_live_hand');
    }
    const request = Object.freeze({
      announcedAt: state.freezeStartedAt,
      freezeStartedAt: state.freezeStartedAt,
      frozenSeconds: Math.max(1, (this.clock!.now() - state.freezeStartedAt) / 1000),
      ownershipToken: state.ownershipToken,
    });
    const release = await this.deps.thaw(request, this.abort.signal);
    if (!this.mayRelease(state)) return;
    assertMaintenanceThawRelease(request, release);
    await this.waitUntil(Math.ceil(release.creditedThroughAt));
    if (!this.mayRelease(state)) return;
    this.baseReleased = true;
    completeReconnectFreeze(
      state.freezeStartedAt,
      release.creditedThroughAt - state.freezeStartedAt
    );
    const available = new Map(this.selected());
    const waves = state.resumeWaves;
    if (waves.length === 0 && available.size > 0)
      throw new Error('maintenance_durable_wave_plan_missing');
    const receipts: string[] = [];
    for (let position = 0; position < waves.length; position++) {
      const planned = waves[position];
      const wave = planned.index;
      if (planned.resumedAt !== null) {
        if (!planned.receiptId) throw new Error('maintenance_resumed_wave_receipt_missing');
        receipts.push(planned.receiptId);
        for (const manager of this.tournaments()) await this.reconcileTournament(manager);
        continue;
      }
      if (wave) await this.wait(this.deps.waveGapMs);
      if (!this.mayRelease(state)) return;
      const expected = [...planned.tableIds];
      if (expected.some((id) => !available.has(id)))
        throw new Error('maintenance_wave_engine_missing');
      const proof = await this.deps.store.releaseOperationWave(state, wave, expected);
      if (!this.mayRelease(state)) return;
      if (
        proof.intervalId !== state.intervalId ||
        proof.ownershipToken !== state.ownershipToken ||
        typeof proof.receiptId !== 'string' ||
        !proof.receiptId ||
        JSON.stringify([...proof.tableIds].sort()) !== JSON.stringify([...expected].sort()) ||
        !Number.isFinite(proof.creditedThroughAt) ||
        proof.creditedThroughAt < release.creditedThroughAt
      ) {
        throw new Error('maintenance_wave_release_invalid');
      }
      await this.waitUntil(Math.ceil(proof.creditedThroughAt));
      if (!this.mayRelease(state)) return;
      const resumedAt = Math.floor(this.clock!.now());
      for (const id of expected) {
        const engine = available.get(id)!;
        completeTableReconnectFreeze(id, state.freezeStartedAt, resumedAt);
        markOperationTableResumed(id);
        engine.resumeFromMaintenance();
        this.resumedTables.add(id);
      }
      receipts.push(proof.receiptId);
      await this.deps.store.acknowledgeOperationWave(
        state,
        wave,
        proof.receiptId,
        expected,
        resumedAt
      );
      if (!this.owned(state)) return;
      // Read the committed suffix ACK before loading tournament clocks. The
      // authorization/base receipt predates the physical resume and cannot do this.
      if (this.deps.tournaments) {
        const acknowledged = await this.tournamentProof(state);
        this.current = acknowledged;
        for (const manager of this.tournaments()) await this.reconcileTournament(manager);
      }
      for (const id of expected) this.deps.emit(id, this.payload(true, proof.receiptId));
    }
    // Every physical wave is already durably acknowledged. Global credit is
    // restartable preparation, not an unknown physical action. Reconcile lost
    // replies and continue a stable checkpoint without ever re-running waves.
    let errors = 0;
    while (this.owned(state) && !this.abort.signal.aborted) {
      let progress: OperationMaintenanceState;
      try {
        progress = await this.deps.store.completeOperationResume(state, receipts);
        errors = 0;
      } catch (error) {
        this.deps.report(error);
        // A returned refusal must remain held. A transport loss can recover the
        // exact committed checkpoint/certificate through authoritative readback.
        await this.refresh();
        if (!this.owned(state)) return;
        progress = this.current!;
        if (++errors >= 3 || !['releasing', 'resumed'].includes(progress.phase)) throw error;
      }
      if (!this.owned(state)) return;
      if (!['releasing', 'resumed'].includes(progress.phase))
        throw new Error('maintenance_global_credit_refused');
      // A delayed partial response cannot undo a later recovery readback or
      // replace a newer checkpoint/certificate already observed by subscription.
      if (!['releasing', 'resumed'].includes(this.current!.phase)) return;
      if (
        progress.observedAt < this.current!.observedAt ||
        (this.current!.globalTail?.receiptId && !progress.globalTail?.receiptId) ||
        (this.current!.globalTail?.checkpointNo ?? 0) > (progress.globalTail?.checkpointNo ?? 0)
      ) {
        progress = this.current!;
      }
      this.current = progress;
      const tail = progress.globalTail;
      if (tail?.receiptId) {
        if (state.scope.type === 'platform')
          certifyOperationGlobalRelease(tail.receiptId, tail.creditedThroughAt, () =>
            this.clock!.now()
          );
        await this.waitUntil(tail.creditedThroughAt);
        if (!this.owned(state)) return;
        await this.refresh();
        if (this.current?.phase === 'resumed') return;
      } else {
        if (progress.phase === 'resumed')
          throw new Error('maintenance_global_release_receipt_missing');
        await this.wait(100);
      }
    }
  }

  private payload(ended: boolean, receipt?: string): Record<string, unknown> {
    const state = this.current!;
    return {
      type: ended ? 'MAINTENANCE_BREAK_ENDED' : 'MAINTENANCE_BREAK',
      policy_version: 2,
      activation_receipt: this.activationReceipt,
      interval_id: state.intervalId,
      generation: state.generation,
      phase:
        state.phase === 'last_hand'
          ? 'last_hand'
          : ['recovering', 'recovery_required'].includes(state.phase)
            ? 'recovering'
            : 'counting_down',
      break_ends_at: state.targetAt,
      resume_expected_at: state.targetAt,
      reason: state.reason,
      release_receipt: receipt ?? state.releaseReceipt,
      timestamp: this.clock!.now(),
    };
  }

  enabled(): boolean {
    return this.policyVersion === 2;
  }
  active(): boolean {
    if (
      this.current?.globalTail?.receiptId &&
      this.clock!.now() >= this.current.globalTail.creditedThroughAt
    ) {
      // The health predicate is also an effective thaw observation, so deliver
      // owed one-shot work even when it runs before any sweep or timer callback.
      isMaintenanceFrozen();
      return false;
    }
    return (
      this.current !== null &&
      this.current.phase !== 'resumed' &&
      !(
        this.current.globalTail?.receiptId &&
        this.clock!.now() >= this.current.globalTail.creditedThroughAt
      )
    );
  }
  readyForRestart(): boolean {
    return (
      !this.lastError &&
      !this.releaseInDoubt &&
      !!this.current &&
      this.owned(this.current) &&
      ['ready', 'applying'].includes(this.current.phase) &&
      this.clock!.decision(0, policy.recoveryReserveMs, 0) === 'forward' &&
      this.selected().every(([, e]) => e.isMaintenanceDrained?.() === true) &&
      this.tournamentsDrained()
    );
  }
  snapshot(): Record<string, unknown> {
    return {
      policyVersion: this.policyVersion,
      supportedPolicyVersions: [1, 2],
      activationReceipt: this.activationReceipt,
      active: this.active(),
      readyForRestart: this.readyForRestart(),
      operation: this.current,
      reconciliationError: this.lastError,
      releaseInDoubt: this.releaseInDoubt,
      resumedTables: this.resumedTables.size,
      tournamentDrains: this.tournaments().map((manager) => ({
        tableIds: manager.getTableIds(),
        ...manager.operationMaintenanceDrain(),
      })),
      remainingMs: this.current ? Math.max(0, this.current.targetAt - this.clock!.now()) : 0,
    };
  }
}
