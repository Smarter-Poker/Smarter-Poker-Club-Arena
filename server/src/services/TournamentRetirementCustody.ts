export interface RetirementBinding {
  readonly breakId: string;
  readonly tableId: string;
  readonly tableIncarnation: string;
  readonly tournamentId: string;
  readonly custodyId: string;
  readonly durableRevision: string;
  readonly leaseGeneration: string;
}
export interface RetirementEngine {
  stop(): Promise<void>;
  hasReleasedProcessOwnership(): boolean;
}
export interface RetirementCustody<E extends RetirementEngine> {
  readonly binding: RetirementBinding;
  readonly revision: string;
  readonly engine: E | null;
  assertCurrent(): void;
  /** Call only after exact global CAS and local/H4H removal. */
  confirmAbsent(): void;
}
/** Process-local admission reservation. Durable source exclusion and exact
 * lease/incarnation validation are mandatory caller inputs, not supplied here. */
export class TournamentRetirementCustody<E extends RetirementEngine> {
  private readonly held = new Map<string, string>();
  private revision = 0n;
  private readonly pending = new Map<string, string>();
  private readonly active = new Set<string>();
  private readonly mixedHeld = new Map<string, string>();
  admissionAllowed(tableId: string): boolean {
    return !this.held.has(tableId) && !this.mixedHeld.has(tableId);
  }
  /** Receipt-bound whole-map reservation. Unknown close/ACK bindings stay intact
   * until the caller has verified the durable completion receipt. */
  reserveMixed(
    transferId: string,
    tableIds: readonly string[],
    originals: readonly { table_id: string; revision: string; binding: readonly string[] }[],
    originalsAreLocal: boolean,
    global: Map<string, E>,
    local: Map<string, E>,
    current: () => boolean
  ) {
    const ids = [...new Set(tableIds)];
    if (!transferId || ids.length !== tableIds.length || !ids.length)
      throw new Error('mixed_retirement_identity_invalid');
    const original = new Map(originals.map((r) => [r.table_id, r]));
    const assertOriginals = () => {
      for (const id of ids) {
        const expected = original.get(id);
        if (this.active.has(id) || global.has(id) || local.has(id))
          throw new Error('mixed_retirement_registry_changed');
        if (originalsAreLocal && expected) {
          if (
            this.held.get(id) !== expected.revision ||
            this.pending.get(id) !== JSON.stringify(expected.binding)
          )
            throw new Error('mixed_retirement_original_changed');
        } else if (this.held.has(id) || this.pending.has(id))
          throw new Error('mixed_retirement_foreign_reservation');
      }
    };
    if (!current()) throw new Error('mixed_retirement_owner_changed');
    assertOriginals();
    for (const id of ids)
      if (this.mixedHeld.has(id) && this.mixedHeld.get(id) !== transferId)
        throw new Error('mixed_retirement_custody_busy');
    for (const id of ids) this.mixedHeld.set(id, transferId);
    const assertCurrent = () => {
      if (!current() || ids.some((id) => this.mixedHeld.get(id) !== transferId))
        throw new Error('mixed_retirement_owner_changed');
      assertOriginals();
    };
    return Object.freeze({
      assertCurrent,
      complete: () => {
        assertCurrent();
        for (const id of ids) {
          this.mixedHeld.delete(id);
          if (originalsAreLocal && original.has(id)) {
            this.held.delete(id);
            this.pending.delete(id);
          }
        }
      },
    });
  }

  /** Capture inactive reservations without releasing or rebinding an unknown ACK. */
  captureDrained(tournamentId: string, generation: string, tableIds: readonly string[]) {
    const selected: [string, string, string][] = [];
    for (const [id, identity] of this.pending) {
      const binding = JSON.parse(identity) as string[];
      if (binding[0] !== tournamentId) continue;
      if (
        binding[4] !== generation ||
        !tableIds.includes(id) ||
        this.active.has(id) ||
        !this.held.has(id)
      )
        return null;
      selected.push([id, this.held.get(id)!, identity]);
    }
    if (tableIds.some((id) => this.held.has(id) && !selected.some(([key]) => key === id)))
      return null;
    const current = () =>
      selected.every(
        ([id, held, identity]) =>
          !this.active.has(id) && this.held.get(id) === held && this.pending.get(id) === identity
      ) &&
      tableIds.every((id) => !this.held.has(id) || selected.some(([key]) => key === id)) &&
      [...this.pending].every(
        ([id, identity]) =>
          JSON.parse(identity)[0] !== tournamentId ||
          selected.some(([key, , exact]) => key === id && exact === identity)
      );
    const reservations = selected
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table_id, revision, identity]) =>
        Object.freeze({
          table_id,
          revision,
          binding: Object.freeze(JSON.parse(identity) as string[]),
        })
      );
    return Object.freeze({ reservations: Object.freeze(reservations), current });
  }

  /** Local reopen/admission work shares the custody reservation. SQL's durable
   * pending-source guard remains authoritative across processes. */
  async withAdmission<T>(
    tableId: string,
    current: () => boolean,
    work: (assertCurrent: () => void) => Promise<T>
  ): Promise<T> {
    if (!this.admissionAllowed(tableId)) throw new Error('retirement_custody_busy');
    if (this.revision === 9223372036854775807n) throw new Error('retirement_revision_exhausted');
    const revision = (++this.revision).toString();
    this.held.set(tableId, revision);
    const assertCurrent = () => {
      if (!current() || this.held.get(tableId) !== revision)
        throw new Error('admission_revision_stale');
    };
    try {
      assertCurrent();
      const result = await work(assertCurrent);
      assertCurrent();
      return result;
    } finally {
      if (this.held.get(tableId) === revision) this.held.delete(tableId);
    }
  }
  async withCustody<T>(
    binding: RetirementBinding,
    global: Map<string, E>,
    local: Map<string, E>,
    current: () => boolean,
    work: (custody: RetirementCustody<E>) => Promise<T>,
    prepare: () => Promise<void> = async () => {
      throw new Error('retirement_durable_claim_required');
    }
  ): Promise<T> {
    if (Object.values(binding).some((value) => typeof value !== 'string' || value.length === 0))
      throw new Error('retirement_binding_invalid');
    const identity = JSON.stringify([
      binding.tournamentId,
      binding.breakId,
      binding.tableId,
      binding.tableIncarnation,
      binding.leaseGeneration,
      binding.custodyId,
      binding.durableRevision,
    ]);
    if (
      (this.held.has(binding.tableId) && !this.pending.has(binding.tableId)) ||
      this.active.has(binding.tableId) ||
      this.mixedHeld.has(binding.tableId) ||
      (this.pending.has(binding.tableId) && this.pending.get(binding.tableId) !== identity)
    )
      throw new Error('retirement_custody_busy');
    for (const value of [binding.tableIncarnation, binding.durableRevision]) {
      if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)
        throw new Error('retirement_bigint_invalid');
    }
    if (this.revision === 9223372036854775807n) throw new Error('retirement_revision_exhausted');
    const revision = (++this.revision).toString();
    const exact = Object.freeze({ ...binding });
    // Reserve synchronously before inspecting either map. Registration and
    // replacement must consume admissionAllowed on both sides of awaits.
    this.held.set(exact.tableId, revision);
    this.pending.set(exact.tableId, identity);
    this.active.add(exact.tableId);
    let acknowledged = false;
    try {
      const engine = global.get(exact.tableId) ?? null;
      if ((local.get(exact.tableId) ?? null) !== engine)
        throw new Error('retirement_registry_disagreement');
      let absent = engine === null;
      const assertCurrent = () => {
        if (this.held.get(exact.tableId) !== revision || !current())
          throw new Error('retirement_custody_stale');
        const expected = absent ? undefined : engine;
        if (global.get(exact.tableId) !== expected || local.get(exact.tableId) !== expected)
          throw new Error('retirement_registry_changed');
      };
      assertCurrent();
      const custody = Object.freeze({
        binding: exact,
        revision,
        engine,
        assertCurrent,
        confirmAbsent: () => {
          if (
            this.held.get(exact.tableId) !== revision ||
            !current() ||
            global.has(exact.tableId) ||
            local.has(exact.tableId)
          )
            throw new Error('retirement_absence_unproven');
          absent = true;
        },
      });
      await prepare();
      assertCurrent();
      if (engine) {
        try {
          await engine.stop();
        } catch (error) {
          if (!engine.hasReleasedProcessOwnership()) throw error;
        }
        assertCurrent();
        if (!engine.hasReleasedProcessOwnership()) throw new Error('retirement_stop_unproven');
      }
      const result = await work(custody);
      assertCurrent();
      acknowledged = true;
      return result;
    } finally {
      this.active.delete(exact.tableId);
      // An unknown close/ACK keeps admission excluded. Exact same custody may
      // replay; a different generation requires an explicit transfer contract.
      if (acknowledged && this.held.get(exact.tableId) === revision) {
        this.held.delete(exact.tableId);
        this.pending.delete(exact.tableId);
      }
    }
  }
}
