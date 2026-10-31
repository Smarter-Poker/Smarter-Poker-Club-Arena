export interface AbortBoundaryTable {
  table_id: string;
  lifecycle: string;
  required: boolean;
}

export interface AbortBoundaryRequest {
  operation_id: string;
  tournament_id: string;
  current_generation: string;
  tables: AbortBoundaryTable[];
}

export interface AbortBoundaryEngine {
  parkForTournamentAbort(maxWaitMs: number): Promise<boolean>;
  prepareTournamentAbortBoundary(): Promise<void>;
  captureParkedTournamentAbortIdentity(
    tableId: string,
    tournamentId: string,
    generation: string
  ): {
    lifecycle: string;
    hand_number: number;
    engine_id: string;
    allocation_epoch: string | null;
  } | null;
  retireTournamentAbortBoundary(): Promise<void>;
  captureStoppedTournamentAbortIdentity: AbortBoundaryEngine['captureParkedTournamentAbortIdentity'];
}

/** One explicit request owns these originals even after HTTP disconnection.
 * Repeating the operation joins in-flight work; a pending result retains the
 * original roster and may be observed again, never exchanged for new engines.
 */
export class TournamentAbortBoundary {
  private active: Promise<unknown> | null = null;
  private completed: unknown = null;
  private retirementStarted = false;
  constructor(
    readonly request: AbortBoundaryRequest,
    private readonly originals: readonly (readonly [string, AbortBoundaryEngine])[],
    private readonly deps: {
      current(): boolean;
      joinManagerTails(): Promise<void>;
      joinRetiredManagerTails(): Promise<void>;
      managerReadyToFence(): boolean;
      fenceManager(): void;
      managerDrained(): boolean;
      acknowledge(
        tableId: string,
        handNumber: number,
        evidence: Record<string, unknown>
      ): Promise<unknown>;
    }
  ) {}

  run(reprove = false): Promise<unknown> {
    if (reprove) this.completed = null;
    if (this.completed) return Promise.resolve(this.completed);
    if (this.active) return this.active;
    const work = this.execute();
    this.active = work;
    void work
      .finally(() => {
        if (this.active === work) this.active = null;
      })
      .catch(() => {});
    return work;
  }

  private async execute(): Promise<unknown> {
    const pending = (reason: string) => ({
      state: 'pending',
      reason,
      operation_id: this.request.operation_id,
    });
    if (!this.deps.current()) return pending('original_owner_changed');
    const required = this.request.tables.filter((table) => table.required);
    if (
      required.length === 0 ||
      required.length !== this.originals.length ||
      required.some((table) => !this.originals.some(([id]) => id === table.table_id))
    )
      return pending('original_table_coverage_incomplete');
    if (!this.retirementStarted) {
      // Arm every original synchronously before waiting on any individual hand.
      const parked = await Promise.all(
        this.originals.map(([, engine]) => engine.parkForTournamentAbort(30_000))
      );
      if (parked.some((value) => !value)) return pending('accepted_hand_not_parked');
      await this.deps.joinManagerTails();
      if (!this.deps.current()) return pending('original_owner_changed');
      if (!this.deps.managerReadyToFence()) return pending('accepted_manager_tail_pending');
      // Accepted callbacks finish before revocation; callbacks admitted during
      // the final join are fenced synchronously and then physically joined.
      this.deps.fenceManager();
      await this.deps.joinManagerTails();
      await Promise.all(
        this.originals.map(([, engine]) => engine.prepareTournamentAbortBoundary())
      );
      if (!this.deps.current() || !this.deps.managerDrained())
        return pending('manager_tail_not_drained');
      if (
        this.originals.some(
          ([id, engine]) =>
            engine.captureParkedTournamentAbortIdentity(
              id,
              this.request.tournament_id,
              this.request.current_generation
            ) === null
        )
      )
        return pending('physical_writer_not_drained');
      this.retirementStarted = true;
    }
    // Retire and persist these original child objects before the immutable
    // financial header exists. Their manager lease remains heartbeating.
    // Partial/unknown stops retain this phase and these exact original promises.
    await Promise.all(this.originals.map(([, engine]) => engine.retireTournamentAbortBoundary()));
    await this.deps.joinRetiredManagerTails();
    if (!this.deps.current() || !this.deps.managerDrained())
      return pending('manager_tail_not_drained');
    const identities = this.originals.map(
      ([id, engine]) =>
        [
          id,
          engine.captureStoppedTournamentAbortIdentity(
            id,
            this.request.tournament_id,
            this.request.current_generation
          ),
        ] as const
    );
    if (
      identities.some(
        ([id, identity]) =>
          !identity ||
          required.find((table) => table.table_id === id)?.lifecycle !== identity.lifecycle
      )
    )
      return pending('physical_writer_not_drained');
    const receipts: unknown[] = [];
    for (const [id, identity] of identities) {
      // Re-prove after each network await; no old captured proof authorizes
      // another table after ownership or a physical writer changed.
      const engine = this.originals.find(([tableId]) => tableId === id)![1];
      const fresh = engine.captureStoppedTournamentAbortIdentity(
        id,
        this.request.tournament_id,
        this.request.current_generation
      );
      if (
        !fresh ||
        !identity ||
        fresh.engine_id !== identity.engine_id ||
        !this.deps.current() ||
        !this.deps.managerDrained()
      )
        return pending('boundary_changed');
      receipts.push(
        await this.deps.acknowledge(id, fresh.hand_number, {
          ...fresh,
          kind: 'tournament_abort_boundary_v1',
          certificate_version: '1',
          physical_stopped: true,
          parked_before_retirement: true,
          drained: true,
          manager_tail_joined: true,
          pending_writers: 0,
          bank_state_write_pending: false,
          source_table_ids: this.originals.map(([tableId]) => tableId).sort(),
        })
      );
    }
    this.completed = { state: 'acknowledged', operation_id: this.request.operation_id, receipts };
    return this.completed;
  }
}
