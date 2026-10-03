import {
  custodyJSON,
  immutableCustody,
  prepareMixedF06Transfer,
  readMixedF06PresenceEvidence,
  retainMixedF06Intent,
  completeMixedF06Transfer,
  type MixedF06Transfer,
  type MixedF06Proposal,
} from './mixedF06Custody.js';
/**
 * TournamentManager, layer 3/3 — table balancing, satellites, late reg.
 *
 * Split out of the 4,096-line `src/GameServer.ts` monolith on 2026-07-28
 * (engine audit D21 — god-class decomposition). Behavior is preserved
 * line-for-line: the only edits are module boundaries, `private` widened to
 * `protected` where a member is reached across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { randomUUID } from 'node:crypto';
import { INSTANCE_ID, INSTANCE_VERSION } from '../services/tableLease.js';
import {
  readF06RecoveryAdmission,
  type DrainedF06Custody,
  type F06CustodyRefusal,
} from './drainedF06Custody.js';
import { verifyF06MovementAdmission } from './f06MovementAdmission.js';
import {
  TournamentTableBreakRpc,
  TournamentTableBreakCapacityError,
  TournamentTableBreakRosterChangedError,
  TournamentNoStartContinuationRefusedError,
  type TableBreakMemberInput,
  type TournamentTableBreakState,
} from './tournamentTableBreakRpc.js';
import { supabase } from '../services/supabase.js';
import { type BalancerTable, type MoveInstruction } from '../engine/TableBalancer.js';
import type { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { reportError } from '../services/errorReporter.js';
import { selectInChunks } from '../services/supabase/chunkedIn.js';
import { tableStateHub } from '../transport/TableStateHub.js';
import {
  TournamentManagerEliminations,
  type TournamentBalanceProgress,
} from './TournamentManagerEliminations.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import type { TournamentLifecycleToken } from './TournamentLifecycleEpoch.js';
import type { AbandonedRetirement } from '../services/TournamentRetirementCustody.js';
import { requestSatelliteSettlementReceipt } from './satelliteSettlementRpc.js';
import { compareBreakSourceRoster, type BreakSourceRegistration } from './breakSourceRoster.js';
import type { VerifiedSatelliteSettlementReceipt } from './satelliteSettlementReceipt.js';
import {
  moveTournamentPlayerAtomically,
  resolveCommittedTournamentSeatMove,
  TournamentSeatMoveOutcomeUnknownError,
  type TournamentSeatMoveInput,
  type TournamentSeatMoveSourceMode,
  type VerifiedTournamentSeatMoveReceipt,
} from './tournamentSeatMoveRpc.js';
import {
  CLOSED_ORPHAN_RESEAT_REASON,
  planOrphanReseats,
  describeUnmovableOrphans,
  type OrphanTableRow,
  type OrphanSeatRow,
} from './orphanedSeatRepair.js';

/** Lease owns the implementation and the actual global registry. */
interface BreakRetirementBinding {
  breakId: string;
  tableId: string;
  tableIncarnation: string;
  tournamentId: string;
  custodyId: string;
  durableRevision: string;
  leaseGeneration: string;
}
interface BreakRetirementCustody {
  binding: BreakRetirementBinding;
  revision: string;
  engine: ServerTableEngine | null;
  assertCurrent(): void;
  confirmAbsent(): void;
}
interface BreakRetirementHost {
  withRetirementCustody<T>(
    binding: BreakRetirementBinding,
    local: Map<string, ServerTableEngine>,
    current: () => boolean,
    work: (custody: BreakRetirementCustody) => Promise<T>,
    prepare: () => Promise<void>
  ): Promise<T>;
}

interface AbandonedRetirementHost {
  yieldAbandonedRetirementCustody(
    tournamentId: string,
    manager: TournamentManager,
    confirm: (reservation: AbandonedRetirement) => Promise<boolean>
  ): Promise<AbandonedRetirement[]>;
}

interface LateRegistrationCapacityResult {
  ok: boolean;
  created: boolean;
  reason?: string;
  table_id?: string;
  table_number?: number;
  table_capacity?: number;
  active_entries?: number;
  remaining_deficit?: number;
  pending_table_ids?: string[];
  pending_table_count?: number;
}

interface TournamentTableCloseResult {
  ok?: boolean;
  reason?: string;
  table_id?: string;
  tournament_id?: string;
  status?: string;
  current_players?: number;
}

interface ClaimedTournamentMoveBoundary {
  sourceMode: TournamentSeatMoveSourceMode;
  engine: ServerTableEngine | null;
  mixedTransferId?: string;
}

interface PendingTournamentSeatMoveOutcome {
  move: MoveInstruction;
  input: TournamentSeatMoveInput;
}

/**
 * A retired original's roster does not fit the other open tables yet. This
 * is a wait, not an outcome: it is thrown from inside retirement custody only
 * so that custody keeps the table fenced under the same identity, and
 * `retireTournamentBreak` turns it back into a pending break.
 */
class TournamentBreakAwaitsSeatsError extends Error {}

/** The two doors out of an unbegun park whose table keeps its players. */
type NoStartExit = 'continue' | 'withdraw';

export class TournamentManager extends TournamentManagerEliminations {
  private mixedRecovery: {
    transfer: MixedF06Transfer;
    assertCurrent: () => void;
    sources: Map<string, string>;
    completion: Readonly<Record<string, unknown>> | null;
  } | null = null;
  private mixedRecoveryOperation: Promise<Readonly<Record<string, unknown>>> | null = null;

  protected override eliminationMutationAllowed(): boolean {
    if (super.eliminationMutationAllowed()) return true;
    // One discovered break's visit finishes once started; stop and abort
    // still end it (see visitTournamentBreakPage).
    if (this.tournamentBreakVisitOpen && this.running && !this.eliminationSweepSignal?.aborted)
      return true;
    if (!this.mixedRecovery || !this.isF06RecoveryOwner() || this.mixedRecovery.completion)
      return false;
    try {
      this.mixedRecovery.assertCurrent();
      return true;
    } catch {
      return false;
    }
  }

  private receiptOwnsSource(tableId: string): boolean {
    if (!this.mixedRecovery?.sources.has(tableId) || !this.isF06RecoveryOwner()) return false;
    this.mixedRecovery.assertCurrent();
    if (this.tableEngines.size || this.gameServer.getTableEngine(tableId))
      throw new Error('f06_mixed_receipt_has_live_dealer');
    return true;
  }

  /** Finite continuation of the original admission, not a scheduler or dealer. */
  recoverMixedF06Custody(
    transfer: MixedF06Transfer,
    assertCurrent: () => void
  ): Promise<Readonly<Record<string, unknown>>> {
    if (this.mixedRecoveryOperation) return this.mixedRecoveryOperation;
    if (!this.isF06RecoveryOwner()) throw new Error('f06_mixed_recovery_owner_required');
    assertCurrent();
    if (this.mixedRecovery && this.mixedRecovery.transfer !== transfer)
      throw new Error('f06_mixed_recovery_identity_changed');
    if (!this.mixedRecovery) {
      const local = transfer.local;
      const continuations = (transfer.canonical as { no_start_continuations?: unknown })
        .no_start_continuations;
      if (!Array.isArray(local.no_start) || !Array.isArray(continuations))
        throw new Error('f06_mixed_no_start_evidence_unavailable');
      for (const [breakId, pending] of local.no_start as [
        string,
        { binding: BreakRetirementBinding },
      ][]) {
        const binding = pending.binding;
        if (
          !continuations.some(
            (item: any) =>
              item.break_id === breakId &&
              item.tournament_id === this.tournamentId &&
              item.table_id === binding.tableId &&
              String(item.lifecycle) === binding.tableIncarnation &&
              item.park?.custody_id === binding.custodyId &&
              item.park?.custody_generation === binding.leaseGeneration &&
              String(item.park?.revision) === binding.durableRevision
          )
        )
          throw new Error('f06_mixed_no_start_unresolved');
      }
      const load = <T>(name: string, into: Map<string, T>) => {
        const entries = local[name];
        if (!Array.isArray(entries) || into.size !== 0)
          throw new Error('f06_mixed_pending_vector_invalid');
        for (const entry of entries) {
          if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== 'string' ||
            into.has(entry[0])
          )
            throw new Error('f06_mixed_pending_identity_invalid');
          into.set(entry[0], immutableCustody(entry[1]) as T);
        }
      };
      load('durable', this.durableTournamentBreaks);
      load('pending_moves', this.pendingTournamentSeatMoveOutcomes);
      load('parks', this.pendingTournamentParkRequests);
      load('begins', this.pendingTournamentBreakBegins);
      load('amendments', this.pendingTournamentBreakAmendments);
      load('rejected_begins', this.rejectedTournamentBreakBegins);
      load('resolved_proposals', this.resolvedTournamentBreakProposals);
      load('custody_ids', this.pendingTournamentBreakCustodyIds);
      load('cleanup_kinds', this.pendingTournamentCleanupKinds);
      const retained = local.retained as { table_id: string; break_id: string }[];
      const sources = new Map(retained.map((row) => [row.table_id, row.break_id]));
      const historical = (transfer.canonical as any).historical_loss;
      const pendingSources = historical?.pending_arrivals ?? [];
      if (!Array.isArray(pendingSources)) throw new Error('f06_mixed_pending_source_unproven');
      for (const entry of pendingSources) {
        const proof = entry?.proof?.historical_loss;
        const original = proof?.observations?.[0]?.original;
        const captured = (local.historical_loss_pending_arrivals as any[])?.find(
          (row) => custodyJSON(row.original) === custodyJSON(original)
        );
        const operation = (transfer.canonical as any).operations?.find(
          (row: any) => row.break_id === original?.break_id
        );
        if (
          historical.kind !== 'historical_loss_normal_session_v1' ||
          proof?.original_kind !== 'pending_arrival_historical_loss_v1' ||
          !original ||
          !captured ||
          !operation ||
          entry.source?.table_id !== original.table_id ||
          captured.absence?.table_id !== original.table_id ||
          captured.absence.global_absent !== true ||
          captured.absence.owned_absent !== true ||
          captured.absence.retirement_absent !== true ||
          operation.source_table_id !== original.table_id ||
          String(operation.lifecycle) !== String(original.lifecycle) ||
          operation.tournament_id !== this.tournamentId ||
          sources.has(original.table_id)
        )
          throw new Error('f06_mixed_pending_source_unproven');
        // This receipt owns an already absent original source, separately from
        // the stopped engine cohort. No old dealer is recreated.
        sources.set(original.table_id, original.break_id);
      }
      this.mixedRecovery = {
        transfer,
        assertCurrent,
        sources,
        completion: null,
      };
    }
    const owned = this.mixedRecovery;
    const work = this.trackLifecycleJob(
      (async () => {
        assertCurrent();
        const rpc = this.tableBreakRpc();
        // Every possibly sent original park/begin/amend input is replayed exactly.
        for (const [source, pending] of this.pendingTournamentParkRequests) {
          const state = await rpc.requestPark(
            pending.breakId,
            source,
            pending.lifecycle,
            pending.boundaryId
          );
          assertCurrent();
          if (state.source_table_id !== source || state.lifecycle !== pending.lifecycle)
            throw new Error('f06_mixed_park_identity_changed');
          this.rememberTournamentBreak(state);
          this.pendingTournamentParkRequests.delete(source);
        }
        for (const [breakId, members] of this.pendingTournamentBreakBegins) {
          const source = [...owned.sources].find(([, id]) => id === breakId)?.[0];
          if (!source) throw new Error('f06_mixed_begin_source_missing');
          await this.beginTournamentBreak(breakId, source, members);
          assertCurrent();
        }
        for (const [key, amendment] of this.pendingTournamentBreakAmendments) {
          const next = await rpc.amend(amendment);
          assertCurrent();
          const member = next.members.find((m) => m.user_id === amendment.userId);
          if (
            !member ||
            (!member.winner_request_id && member.active_request_id !== amendment.newRequestId)
          )
            throw new Error('f06_mixed_amendment_unresolved');
          this.rememberTournamentBreak(next);
          this.pendingTournamentBreakAmendments.delete(key);
        }
        if (!(await this.redrivePendingTournamentSeatMoveOutcomes()))
          throw new Error('f06_mixed_original_move_unresolved');
        assertCurrent();
        const operations = (
          transfer.canonical as { operations: { break_id: string; state: string }[] }
        ).operations;
        for (const [source, breakId] of owned.sources) {
          const original = operations.find((row) => row.break_id === breakId);
          if (!original) throw new Error('f06_mixed_original_operation_missing');
          // A recorded no-start continuation is terminal already; completion SQL
          // requires its immutable original receipt. No new no-start is inferred.
          if (original.state === 'withdrawn_before_manifest') continue;
          const state = await rpc.reconcile(breakId);
          assertCurrent();
          if (state.source_table_id !== source) throw new Error('f06_mixed_source_changed');
          this.rememberTournamentBreak(state);
          await this.recoverTournamentBreak(state);
          assertCurrent();
          const terminal = await rpc.reconcile(breakId);
          assertCurrent();
          if (terminal.state !== 'acknowledged') throw new Error('f06_mixed_operation_incomplete');
        }
        if (
          this.pendingTournamentSeatMoveOutcomes.size ||
          this.pendingTournamentParkRequests.size ||
          this.pendingTournamentBreakBegins.size ||
          this.pendingTournamentBreakAmendments.size
        )
          throw new Error('f06_mixed_pending_original_unresolved');
        const completion = await completeMixedF06Transfer(
          this.tournamentId,
          this.getTournamentLeaseGeneration()!,
          transfer,
          assertCurrent
        );
        owned.completion = completion;
        return completion;
      })()
    );
    this.mixedRecoveryOperation = work;
    void work
      .finally(() => {
        if (this.mixedRecoveryOperation === work) this.mixedRecoveryOperation = null;
      })
      .catch(() => {});
    return work;
  }

  finishMixedF06RecoveryAdmission(completion: Readonly<Record<string, unknown>>): void {
    if (this.mixedRecovery?.completion !== completion || this.mixedRecoveryOperation)
      throw new Error('f06_mixed_completion_not_owned');
    this.leaveCompletedF06RecoveryOwnership();
    // Evidence remains in mixedRecovery; normal manager state starts clean only
    // after every canonical operation and the completion receipt are verified.
    this.durableTournamentBreaks.clear();
    this.pendingTournamentBreakCustodyIds.clear();
    this.pendingTournamentCleanupKinds.clear();
    this.rejectedTournamentBreakBegins.clear();
    this.resolvedTournamentBreakProposals.clear();
  }

  private async retireTransferredTournamentBreak(state: TournamentTableBreakState): Promise<void> {
    const owned = this.mixedRecovery;
    if (!owned || !this.receiptOwnsSource(state.source_table_id))
      throw new Error('f06_mixed_retirement_unproven');
    owned.assertCurrent();
    const rpc = this.tableBreakRpc();
    let next = await rpc.reconcile(state.break_id);
    owned.assertCurrent();
    if (next.state === 'acknowledged') return;
    if (
      next.terminal_handoff_required ||
      next.members.length === 0 ||
      next.members.some((m) => !m.winner_request_id)
    )
      throw new Error('f06_mixed_retirement_has_unresolved_members');
    let custodyId = this.pendingTournamentBreakCustodyIds.get(next.break_id);
    if (!custodyId) {
      custodyId = next.custody_id ?? randomUUID();
      this.pendingTournamentBreakCustodyIds.set(next.break_id, custodyId);
    }
    await retainMixedF06Intent(
      this.tournamentId,
      this.getTournamentLeaseGeneration()!,
      owned.transfer,
      `custody:${next.break_id}`,
      { custodyId },
      owned.assertCurrent
    );
    next = await rpc.claimCustody(next.break_id, custodyId, next.revision);
    owned.assertCurrent();
    const revision = next.revision;
    if (
      next.custody_id !== custodyId ||
      next.custody_generation !== this.getTournamentLeaseGeneration()
    )
      throw new Error('f06_mixed_custody_claim_unproven');
    if (next.state !== 'close_confirmed') next = await rpc.close(next.break_id);
    owned.assertCurrent();
    if (
      next.state !== 'close_confirmed' ||
      next.custody_id !== custodyId ||
      next.revision !== revision
    )
      throw new Error('f06_mixed_close_unproven');
    const kind = this.pendingTournamentCleanupKinds.get(next.break_id) ?? 'retired';
    this.pendingTournamentCleanupKinds.set(next.break_id, kind);
    next = await rpc.ackCleanup(next.break_id, custodyId, revision, kind);
    owned.assertCurrent();
    if (
      next.state !== 'acknowledged' ||
      next.custody_id !== custodyId ||
      next.revision !== revision
    )
      throw new Error('f06_mixed_ack_unproven');
    this.rememberTournamentBreak(next);
  }

  private static readonly MOVE_BOUNDARY_PROBE_MS = 1_000;
  /**
   * `fn_f06_discover_breaks` accepts 1..32 and raises F06_PAGE_SIZE outside it.
   * Ask for all of it: the page is what the manager SEES, never what it works
   * on, and a short page is what made the completeness claim cost one admitted
   * sweep per pending operation. See `discoverTournamentBreaks`.
   */
  private static readonly BREAK_DISCOVERY_PAGE = 32;
  /** Exact manager generation that owns every live-source move fence it arms. */
  private readonly tournamentMoveBoundaryOwner = randomUUID();
  /** Ambiguous replies retain the exact UUID and source fence until replay resolves. */
  private readonly pendingTournamentSeatMoveOutcomes = new Map<
    string,
    PendingTournamentSeatMoveOutcome
  >();
  private tournamentBreakCursorRevision = '0';
  private tournamentBreakTraversalStarted = false;
  private tournamentBreakCleanupFirst = false;
  private tournamentBreakDiscoveryComplete = false;
  private readonly durableTournamentBreaks = new Map<string, TournamentTableBreakState>();
  /** A response loss must not mint a new begin/request identity in this process. */
  private readonly pendingTournamentBreakBegins = new Map<
    string,
    readonly TableBreakMemberInput[]
  >();

  // A resolved capacity failure allows placement changes only. Keep the rejected
  // payload until a durable manifest is adopted, including delayed-send races.
  private readonly rejectedTournamentBreakBegins = new Map<
    string,
    readonly TableBreakMemberInput[]
  >();
  private readonly resolvedTournamentBreakProposals = new Map<string, unknown[]>();

  /**
   * THE ROSTER A REFUSED BEGIN NAMED IS RE-READ, NOT RE-SENT (2026-09-28).
   *
   * `pendingTournamentBreakBegins` keeps an exact proposal so that a LOST reply
   * is replayed with the same identities. It was also keeping proposals the
   * database had definitively refused because the source roster was no longer
   * the one they named, and `prepareParkedTournamentBreak` replays a retained
   * proposal before it reads anything, so that break re-sent the same refused
   * roster on every pass for ever. Production 2026-09-28 03:20-03:51 UTC: eleven
   * breaks in nine events refused `F06_WHOLE_ROSTER_REQUIRED` over and over;
   * break cf0e43f3 (event 700df3bc, table c04d29c0) kept refusing while its
   * source held exactly one live seat and one playing registration, which a
   * one-member proposal passes, so the proposal being re-sent named a player
   * who was no longer there. Its source was parked and excluded from every
   * other plan the whole time, one more table nobody could merge.
   *
   * The refusal proves the operation was still unbegun (the door checks the
   * manifest first) and rolled back. So the refused proposal moves into the
   * resolved-proposal history (a delayed begin of it can still be adopted by
   * reconciliation) and the next pass reads the roster again.
   */
  private async releaseRefusedBreakRoster(
    breakId: string,
    sourceId: string,
    refused: readonly TableBreakMemberInput[],
    code: string
  ): Promise<TournamentTableBreakState> {
    const state = await this.tableBreakRpc().reconcile(breakId);
    if (
      state.source_table_id !== sourceId ||
      state.break_id !== breakId ||
      state.tournament_id !== this.tournamentId
    )
      throw new Error('F06 refused roster resolution identity mismatch');
    const known = this.durableTournamentBreaks.get(breakId);
    if (known && state.lifecycle !== known.lifecycle)
      throw new Error('F06 refused roster resolution lifecycle mismatch');
    if (state.state === 'park_requested' && state.members.length === 0) {
      this.retainResolvedBreakProposal(breakId, refused);
      if (this.pendingTournamentBreakBegins.get(breakId) === refused)
        this.pendingTournamentBreakBegins.delete(breakId);
      // A capacity-rejected proposal pins placement only; its membership is
      // exactly what the database has just refused, so it is dropped too.
      this.rejectedTournamentBreakBegins.delete(breakId);
      this.noteBreakPreparationRefusal(breakId, `begin_refused:${code}`);
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
    } else this.assertSentBreakMembership(breakId, state.members);
    this.rememberTournamentBreak(state);
    return state;
  }

  /** A durable manifest must be one this manager actually sent for this break. */
  private assertSentBreakMembership(
    breakId: string,
    actual: readonly TableBreakMemberInput[]
  ): void {
    const sent = [
      this.pendingTournamentBreakBegins.get(breakId),
      this.rejectedTournamentBreakBegins.get(breakId),
      ...(this.resolvedTournamentBreakProposals.get(breakId) ?? []),
    ].filter((proposal): proposal is readonly TableBreakMemberInput[] => Array.isArray(proposal));
    for (const proposal of sent) {
      try {
        this.assertBreakMembership(proposal, actual);
        return;
      } catch {
        // Try the next proposal this manager sent.
      }
    }
    throw new Error('F06 original source membership mismatch');
  }

  /**
   * WHY THE LAST BREAK PREPARATION DID NOTHING (2026-09-28).
   *
   * `prepareParkedTournamentBreak` ended in a dozen guards that all answered a
   * bare `null`, and `recoverTournamentBreak` turned that null into silence, so
   * a park that never began left no line saying which guard had refused it.
   * Each guard keeps its exact condition and order; it names itself here, and
   * the name is logged once per change so a stuck break reads its own reason.
   */
  lastBreakPreparationRefusal(breakId: string): string | null {
    return this.breakPreparationRefusals.get(breakId) ?? null;
  }

  private readonly breakPreparationRefusals = new Map<string, string>();

  private noteBreakPreparationRefusal(breakId: string, reason: string): null {
    if (this.breakPreparationRefusals.get(breakId) !== reason) {
      this.breakPreparationRefusals.set(breakId, reason);
      console.warn(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Break ${breakId.slice(0, 8)} not begun: ${reason}`
      );
    }
    return null;
  }

  private retainResolvedBreakProposal(breakId: string, proposal: unknown): void {
    const history = this.resolvedTournamentBreakProposals.get(breakId) ?? [];
    history.push(proposal);
    this.resolvedTournamentBreakProposals.set(breakId, history);
  }

  private assertBreakMembership(
    expected: readonly TableBreakMemberInput[],
    actual: readonly TableBreakMemberInput[]
  ): void {
    const identity = (members: readonly TableBreakMemberInput[]) =>
      members
        .map((m) => [
          m.user_id,
          m.source_seat_id,
          m.source_seat_number,
          m.occupancy_id,
          m.request_id,
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (JSON.stringify(identity(expected)) !== JSON.stringify(identity(actual)))
      throw new Error('F06 original source membership mismatch');
  }

  protected tableBreakRpc(): TournamentTableBreakRpc {
    const generation = this.getTournamentLeaseGeneration();
    if (!generation || !this.eliminationMutationAllowed())
      throw new Error('F06 manager authority unavailable');
    return new TournamentTableBreakRpc(this.tournamentId, generation);
  }

  protected async startParkedMovementEngine(
    engine: ServerTableEngine,
    tableId: string,
    tableLifecycle: string,
    current: () => boolean
  ): Promise<void> {
    const rpc = this.tableBreakRpc();
    const table = await rpc.tableState(tableId);
    if (!current() || !table.excluded || !table.break_id || table.lifecycle !== tableLifecycle)
      throw new Error('f06_movement_source_changed');
    const state = await rpc.reconcile(table.break_id);
    const generation = this.getTournamentLeaseGeneration();
    if (
      !current() ||
      !generation ||
      state.source_table_id !== tableId ||
      state.lifecycle !== tableLifecycle ||
      state.terminal_handoff_required ||
      !['park_requested', 'begun'].includes(state.state)
    )
      throw new Error('f06_movement_break_changed');
    const expected = Object.freeze({
      admission_id: randomUUID(),
      tournament_id: this.tournamentId,
      lease_generation: generation,
      table_id: tableId,
      lifecycle: tableLifecycle,
      break_id: state.break_id,
      custody_id: randomUUID(),
    });
    const request = Object.freeze({
      p_tournament_id: expected.tournament_id,
      p_lease_generation: generation,
      p_table_id: tableId,
      p_lifecycle: tableLifecycle,
      p_break_id: state.break_id,
      p_admission_id: expected.admission_id,
      p_custody_id: expected.custody_id,
      p_expected_revision: state.revision,
    });
    const readAdmission = async () => {
      if (!current()) throw new Error('f06_movement_owner_changed');
      const { data, error } = await supabase.rpc('fn_f06_admit_parked_movement', request);
      if (!current()) throw new Error('f06_movement_admission_unproven [owner_changed]');
      /**
       * A REFUSAL NAMES ITS REASON (2026-09-27, CLAUDE.md 10.86 rule 1). This
       * threw the bare label and dropped the door's message, so five parked
       * tables of 618741a5 logged `f06_movement_admission_unproven` every
       * fifteen seconds for two hours while the door was actually saying
       * `F06_MOVEMENT_ELIMINATION_UNPROVEN` (f06_movement_prior: a player the
       * source's last hand left at 0 chips was still `playing`, because the
       * elimination sweep had not recorded the bust). The label stays as the
       * prefix; the door's code and message ride behind it.
       */
      if (error) {
        throw new Error(
          `f06_movement_admission_unproven [${String(error.code ?? 'no_code')}]: ${String(error.message ?? error)}`
        );
      }
      return verifyF06MovementAdmission(data, expected);
    };
    const admission = await readAdmission();
    engine.installF06MovementAdmission(
      this.tournamentMoveBoundaryOwner,
      admission,
      current,
      async () => {
        const repeated = await readAdmission();
        if (
          repeated.revision !== admission.revision ||
          repeated.proof_hash !== admission.proof_hash
        )
          throw new Error('f06_movement_proof_changed');
      }
    );
    await engine.start();
  }

  /**
   * The database refused this dealer a hand because this table is the source
   * of a break (`source_excluded`). Fence it for that break with the same
   * owner the break claims, so it parks at the next gate and stays parked
   * until the break is acknowledged or withdrawn, and wake discovery so the
   * break is claimed. No hand is admitted and nothing is retried here.
   */
  /**
   * THE LIVE GENERATION TAKES OVER A RETIRED GENERATION'S RESERVATION
   * (2026-09-29). The receipt is `fn_f06_break_state` read under THIS lease:
   * it is lease-fenced (`f06_authority`) and locks the break row, so a
   * generation that no longer holds the lease cannot change the row and its
   * unknown close/ACK outcome is now whatever the row says. The row must name
   * the reservation's break, table and lifecycle. The break itself stays
   * open and keeps the table source-excluded in SQL; this generation claims
   * its custody (revision CAS) through the ordinary retirement path.
   */
  protected override async adoptAbandonedRetirementCustody(
    lifecycle: TournamentLifecycleToken
  ): Promise<void> {
    const generation = this.getTournamentLeaseGeneration();
    const host = this.gameServer as typeof this.gameServer & Partial<AbandonedRetirementHost>;
    if (!generation || !host.yieldAbandonedRetirementCustody) return;
    const receipts = new Map<string, TournamentTableBreakState>();
    const yielded = await host.yieldAbandonedRetirementCustody(
      this.tournamentId,
      this,
      async (reservation) => {
        if (
          !this.lifecycleIsCurrent(lifecycle) ||
          this.getTournamentLeaseGeneration() !== generation
        )
          return false;
        const state = await this.tableBreakRpc().reconcile(reservation.breakId);
        if (
          !this.lifecycleIsCurrent(lifecycle) ||
          this.getTournamentLeaseGeneration() !== generation
        )
          return false;
        if (
          state.ok !== true ||
          state.tournament_id !== this.tournamentId ||
          state.break_id !== reservation.breakId ||
          state.source_table_id !== reservation.tableId ||
          state.lifecycle !== reservation.tableIncarnation
        )
          return false;
        receipts.set(reservation.breakId, state);
        return true;
      }
    );
    for (const reservation of yielded) {
      const state = receipts.get(reservation.breakId);
      if (state) this.rememberTournamentBreak(state);
      console.warn(
        '[f06-abandoned-retirement-yielded]',
        JSON.stringify({
          tournamentId: this.tournamentId,
          tableId: reservation.tableId,
          breakId: reservation.breakId,
          fromGeneration: reservation.leaseGeneration,
          toGeneration: generation,
          durableState: state?.state ?? null,
          durableRevision: state?.revision ?? null,
          durableCustodyGeneration: state?.custody_generation ?? null,
        })
      );
    }
    if (yielded.length) this.requestEliminationSweep('f06_abandoned_retirement_yielded');
  }

  protected override holdSourceForItsBreak(tableId: string, engine: ServerTableEngine): void {
    if (
      !this.running ||
      this.tableEngines.get(tableId) !== engine ||
      !this.gameServer.ownsTournamentTableEngine(tableId, engine)
    )
      return;
    void engine.parkForTournamentMove(this.tournamentMoveBoundaryOwner, 0, true).catch((error) =>
      reportError(error, 'Tournament.break_source_hold_failed', {
        tournamentId: this.tournamentId,
        tableId,
      })
    );
    this.requestEliminationSweep('f06_source_excluded');
  }

  private rememberTournamentBreak(state: TournamentTableBreakState): void {
    if (state.state !== 'park_requested') this.breakPreparationRefusals.delete(state.break_id);
    if (state.state === 'acknowledged') {
      this.durableTournamentBreaks.delete(state.break_id);
      this.breakDispatchRefusals.delete(state.break_id);
      this.breakRetirementRefusals.delete(state.break_id);
      this.resolvedTournamentBreakProposals.delete(state.break_id);
      this.tournamentBreakArrivalWakes.delete(state.break_id);
    } else this.durableTournamentBreaks.set(state.break_id, state);
  }

  private readonly tournamentBreakArrivalWakes = new Map<string, Map<string, ServerTableEngine>>();

  /** Direct and reconciled receipts name the same committed arrival. */
  private wakeTournamentBreakArrival(
    breakId: string,
    receipt: VerifiedTournamentSeatMoveReceipt
  ): void {
    if (!this.eliminationMutationAllowed()) return;
    const engine = this.tableEngines.get(receipt.destinationTableId);
    if (!engine || !this.gameServer.ownsTournamentTableEngine(receipt.destinationTableId, engine))
      return;
    const arrivals =
      this.tournamentBreakArrivalWakes.get(breakId) ?? new Map<string, ServerTableEngine>();
    if (arrivals.get(receipt.requestId) === engine) return;
    engine.wakeWaitingForPlayers();
    arrivals.set(receipt.requestId, engine);
    this.tournamentBreakArrivalWakes.set(breakId, arrivals);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  SEEING EVERY OPERATION IS ONE READ, NOT ONE ADMISSION EACH (2026-09-29)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The second half of the same 2026-09-29 freeze. `a break the sweep starts
   * is finished` (above) fixed the VISIT: a discovered operation is now worked
   * to the end once started. This is about the CLAIM the balancer waits on.
   *
   * `checkTableBalance` will not plan a move until
   * `tournamentBreakDiscoveryComplete` is true - a correct guard, because a
   * balancer that has not seen every pending break can plan onto a table a
   * break already owns. Asking for a page of ONE made that claim cost a walk of
   * the whole durable cursor TWICE: ~2*(N+1) discovery calls for an event with
   * N pending operations. The flag lives only in this process and the engine
   * restarts every hour, so above a handful of operations it could not be
   * re-earned within one restart cycle at all - and a balancer that never runs
   * is what leaves a field one funded player to a table, which is what opens
   * the breaks in the first place. A ratchet.
   *
   * Production 2026-09-29: 87a68e55 ("$100 Freeroll 6:00 AM") and cb8f2dd1
   * ("$100 Freeroll 6:00 PM") held seven and five pending operations, so 16 and
   * 12 calls. Between 04:44 and 05:10Z their durable cursors advanced once and
   * twice - the scheduler had 381 of 408 managers queued on four slots with an
   * oldest wait of 478 s - so the claim needed hours and expired every 60
   * minutes. 38 players on 38 tables and 48 on 41, no table able to deal to
   * itself, for hours, while their level clocks reached 25 and 16 and the
   * average stack fell under one big blind.
   *
   * Seeing an operation and working on it are different questions, and only the
   * second needs rationing. The page is now the SQL's own maximum, so the
   * complete pending set - and the exclusion set every balancer board is built
   * from - arrives in one or two calls whatever N is. A wrap is the server
   * proving nothing is left beyond the cursor; it resets the cursor to zero and
   * pages from the beginning in the same statement, so a wrapped page that did
   * not FILL is already that complete set and no second traversal can add to
   * it. `visitTournamentBreakPage` keeps the rationing exactly where #5583 put
   * it: one operation per unit, budget re-asked between units. The page is what
   * the manager SEES; it is never what one unit works on.
   */
  protected async discoverTournamentBreaks(): Promise<TournamentTableBreakState[] | null> {
    const page = await this.tableBreakRpc().discover(
      this.tournamentBreakCursorRevision,
      TournamentManager.BREAK_DISCOVERY_PAGE
    );
    // Receipt bookkeeping is safe after budget expiry; it grants no new authority.
    this.tournamentBreakCursorRevision = page.cursor_revision;
    if (!page.ok) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return null;
    }
    if (page.wrapped) {
      // A wrapped page that did not FILL started at ordinal zero and was not
      // truncated, so it IS the event's whole non-terminal set: proven, in one
      // call. Only a filled page may have been cut at the limit, and that is
      // the one case still owed the second wrap.
      if (
        this.tournamentBreakTraversalStarted ||
        page.operations.length < TournamentManager.BREAK_DISCOVERY_PAGE
      )
        this.tournamentBreakDiscoveryComplete = true;
      this.tournamentBreakTraversalStarted = true;
    }
    if (this.tournamentBreakTraversalStarted && page.operations.length < 1)
      this.tournamentBreakDiscoveryComplete = true;
    for (const state of page.operations) this.rememberTournamentBreak(state);
    return page.operations;
  }

  /** Persist a caller-owned original member set; exact retries retain every UUID. */
  protected async beginTournamentBreak(
    breakId: string,
    sourceId: string,
    members: readonly TableBreakMemberInput[]
  ): Promise<TournamentTableBreakState> {
    const prior = this.pendingTournamentBreakBegins.get(breakId);
    const canonical = [...members].sort((a, b) => a.user_id.localeCompare(b.user_id));
    if (prior && JSON.stringify(prior) !== JSON.stringify(canonical))
      throw new Error('F06 original begin membership changed');
    const exact = prior ?? Object.freeze(canonical.map((member) => Object.freeze({ ...member })));
    const rejected = this.rejectedTournamentBreakBegins.get(breakId);
    if (rejected && prior) this.assertBreakMembership(rejected, exact);
    else if (rejected) {
      try {
        this.assertBreakMembership(rejected, exact);
      } catch {
        // The capacity refusal rolled back, and the source roster has changed
        // since (a bust landed). Its membership can never be accepted again, so
        // it stops pinning this break; the whole-roster door judges the new one
        // and reconciliation still adopts the old one if it ever committed.
        this.retainResolvedBreakProposal(breakId, rejected);
        this.rejectedTournamentBreakBegins.delete(breakId);
      }
    }
    this.pendingTournamentBreakBegins.set(breakId, exact);
    if (this.mixedRecovery && this.isF06RecoveryOwner())
      await retainMixedF06Intent(
        this.tournamentId,
        this.getTournamentLeaseGeneration()!,
        this.mixedRecovery.transfer,
        `begin:${breakId}`,
        exact,
        this.mixedRecovery.assertCurrent
      );
    let state: TournamentTableBreakState;
    try {
      state = await this.tableBreakRpc().begin(breakId, exact);
    } catch (error) {
      if (
        error instanceof TournamentTableBreakRosterChangedError &&
        error.parameters.p_break_id === breakId &&
        JSON.stringify(error.parameters.p_members) === JSON.stringify(exact)
      )
        return this.releaseRefusedBreakRoster(breakId, sourceId, exact, error.code);
      if (
        !(error instanceof TournamentTableBreakCapacityError) ||
        error.rpc !== 'fn_f06_begin_break' ||
        error.parameters.p_break_id !== breakId ||
        JSON.stringify(error.parameters.p_members) !== JSON.stringify(exact)
      )
        throw error;
      state = await this.tableBreakRpc().reconcile(breakId);
      if (
        state.source_table_id !== sourceId ||
        state.break_id !== breakId ||
        state.tournament_id !== this.tournamentId
      )
        throw new Error('F06 begin resolution identity mismatch');
      const known = this.durableTournamentBreaks.get(breakId);
      if (known && state.lifecycle !== known.lifecycle)
        throw new Error('F06 begin resolution lifecycle mismatch');
      if (state.state === 'park_requested' && state.members.length === 0) {
        this.retainResolvedBreakProposal(breakId, exact);
        this.rejectedTournamentBreakBegins.set(breakId, exact);
        this.pendingTournamentBreakBegins.delete(breakId);
      } else this.assertBreakMembership(exact, state.members);
    }
    if (state.source_table_id !== sourceId) throw new Error('F06 begin source mismatch');
    if (state.ok && state.state !== 'park_requested') {
      this.assertBreakMembership(exact, state.members);
      this.pendingTournamentBreakBegins.delete(breakId);
      this.rejectedTournamentBreakBegins.delete(breakId);
      this.resolvedTournamentBreakProposals.delete(breakId);
    }
    this.rememberTournamentBreak(state);
    return state;
  }

  /** Dispatch stored active identities only; SQL's unavoidable guard owns winners. */
  protected async dispatchTournamentBreakMembers(state: TournamentTableBreakState): Promise<void> {
    if (!state.ok || state.state !== 'begun' || state.terminal_handoff_required) return;
    const refuse = (reason: string): void => this.noteBreakDispatchRefusal(state.break_id, reason);
    await this.runWithTournamentSeatMoveAuthority(async () => {
      // An unrelated unknown movement still invalidates this board's plan.
      if (this.pendingTournamentSeatMoveOutcomes.size > 0)
        return refuse(`seat_move_outcome_pending:${this.pendingTournamentSeatMoveOutcomes.size}`);
      const engine = this.tableEngines.get(state.source_table_id);
      if (
        !this.receiptOwnsSource(state.source_table_id) &&
        (!engine ||
          !this.retainTournamentBreakSource(state.break_id, state.source_table_id, engine))
      )
        return refuse(engine ? 'source_retention_refused' : 'source_engine_absent');
      for (const member of state.members) {
        if (member.winner_request_id) continue;
        if (
          !member.active_request_id ||
          !member.destination_table_id ||
          member.destination_seat_number === null
        )
          throw new Error('F06 active attempt has no exact destination');
        if (!this.eliminationMutationAllowed()) return refuse('mutation_not_allowed');
        const move: MoveInstruction = {
          playerId: member.user_id,
          fromTableId: state.source_table_id,
          fromSeat: member.source_seat_number,
          toTableId: member.destination_table_id,
          toSeat: member.destination_seat_number,
          reason: 'table_break',
        };
        const boundary = await this.claimTournamentMoveBoundary(move, 'live_source');
        if (!this.eliminationMutationAllowed()) return refuse('mutation_not_allowed');
        if (!boundary) return refuse('source_boundary_unclaimed');
        const input: TournamentSeatMoveInput = {
          requestId: member.active_request_id,
          tournamentId: this.tournamentId,
          userId: member.user_id,
          sourceTableId: state.source_table_id,
          destinationTableId: member.destination_table_id,
          destinationSeatNumber: member.destination_seat_number,
          sourceMode: 'live_source',
        };
        try {
          const receipt = await this.requestTournamentSeatMoveAtBoundary(input, boundary, true);
          if (
            receipt.sourceSeatId !== member.source_seat_id ||
            receipt.sourceSeatNumber !== member.source_seat_number
          )
            throw new Error('F06 committed source receipt differs from original member');
          this.wakeTournamentBreakArrival(state.break_id, receipt);
        } catch (error) {
          // Durable reconciliation/amendment decides the outcome. Never turn a
          // transport refusal into a new UUID or release whole-break custody.
          reportError(error, 'Tournament.break_member_outcome_unresolved', {
            tournamentId: this.tournamentId,
            breakId: state.break_id,
            requestId: input.requestId,
          });
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          return;
        }
      }
      this.noteBreakDispatchRefusal(state.break_id, null);
    });
  }

  /**
   * WHY THE LAST DISPATCH MOVED NOBODY (2026-09-28).
   *
   * A begun break's members are moved only here, and every guard above used to
   * answer a bare `return`. Production 2026-09-28: break fae96c1e (event
   * 6a18ddaa) was begun by lease generation bb31566e with five active attempts
   * to five single-player tables and not one was ever dispatched; 44 players on
   * 40 tables sat frozen and the log said nothing, because nothing here could
   * say which guard had declined. Breaks 0d1ff042 (event 2dbd67a7) and b7c61dda
   * (event 0e1d340e) sat the same way. Each guard keeps its exact condition and
   * order; it names itself here, once per change, and a full dispatch clears it.
   */
  lastBreakDispatchRefusal(breakId: string): string | null {
    return this.breakDispatchRefusals.get(breakId) ?? null;
  }

  private readonly breakDispatchRefusals = new Map<string, string>();

  private noteBreakDispatchRefusal(breakId: string, reason: string | null): void {
    if (reason === null) {
      this.breakDispatchRefusals.delete(breakId);
      return;
    }
    if (this.breakDispatchRefusals.get(breakId) === reason) return;
    this.breakDispatchRefusals.set(breakId, reason);
    console.warn(
      `[Tournament:${this.tournamentId.slice(0, 8)}] Break ${breakId.slice(0, 8)} members not dispatched: ${reason}`
    );
  }

  /** Why the last retirement attempt left this break open (logged once per change). */
  lastBreakRetirementRefusal(breakId: string): string | null {
    return this.breakRetirementRefusals.get(breakId) ?? null;
  }

  private readonly breakRetirementRefusals = new Map<string, string>();

  private noteBreakRetirementRefusal(breakId: string, reason: string): void {
    if (this.breakRetirementRefusals.get(breakId) === reason) return;
    this.breakRetirementRefusals.set(breakId, reason);
    console.warn(
      `[Tournament:${this.tournamentId.slice(0, 8)}] Break ${breakId.slice(0, 8)} not retired: ${reason}`
    );
  }

  private readonly pendingTournamentParkRequests = new Map<
    string,
    { breakId: string; lifecycle: string; boundaryId: string }
  >();

  /** The durable park request precedes the physical drain; never invert them. */
  protected async requestTournamentBreakPark(
    sourceId: string
  ): Promise<TournamentTableBreakState | null> {
    const rpc = this.tableBreakRpc();
    let pending = this.pendingTournamentParkRequests.get(sourceId);
    if (!pending) {
      const table = await rpc.tableState(sourceId);
      if (!this.eliminationMutationAllowed() || !table.ok) return null;
      if (table.excluded) {
        // Discovery owns an already existing operation, including restart.
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
        return null;
      }
      pending = {
        breakId: randomUUID(),
        lifecycle: table.lifecycle,
        boundaryId: randomUUID(),
      };
      this.pendingTournamentParkRequests.set(sourceId, pending);
    }
    const state = await rpc.requestPark(
      pending.breakId,
      sourceId,
      pending.lifecycle,
      pending.boundaryId
    );
    if (state.source_table_id !== sourceId || state.lifecycle !== pending.lifecycle)
      throw new Error('F06 park source lifecycle mismatch');
    this.rememberTournamentBreak(state);
    if (state.ok) this.pendingTournamentParkRequests.delete(sourceId);
    return state;
  }

  protected async prepareParkedTournamentBreak(
    state: TournamentTableBreakState
  ): Promise<TournamentTableBreakState | null> {
    if (!state.ok || state.state !== 'park_requested' || state.terminal_handoff_required)
      return state;
    const receiptOwned = this.receiptOwnsSource(state.source_table_id);
    const engine = this.tableEngines.get(state.source_table_id);
    const refuse = (reason: string): null =>
      this.noteBreakPreparationRefusal(state.break_id, reason);
    if (!receiptOwned) {
      if (!engine) return refuse('source_engine_absent');
      if (!this.retainTournamentBreakSource(state.break_id, state.source_table_id, engine))
        return refuse('source_retention_refused');
      // The durable park row is the claim this pause waits for; only the
      // break's acknowledgement or withdrawal releases it, never an expiry.
      const parked = await engine.parkForTournamentMove(
        this.tournamentMoveBoundaryOwner,
        TournamentManager.MOVE_BOUNDARY_PROBE_MS,
        true
      );
      if (!this.eliminationMutationAllowed()) return refuse('mutation_not_allowed');
      if (!parked) return refuse('source_park_probe_missed');
      if (
        this.tableEngines.get(state.source_table_id) !== engine ||
        !this.gameServer.ownsTournamentTableEngine(state.source_table_id, engine)
      )
        return refuse('source_engine_replaced');
    }
    const retained = this.pendingTournamentBreakBegins.get(state.break_id);
    if (retained) {
      const replayed = await this.beginTournamentBreak(
        state.break_id,
        state.source_table_id,
        retained
      );
      // Only a definitive roster refusal releases the retained proposal (see
      // releaseRefusedBreakRoster); anything else is answered exactly as before.
      if (
        !replayed.ok ||
        replayed.state !== 'park_requested' ||
        replayed.members.length !== 0 ||
        this.pendingTournamentBreakBegins.has(state.break_id) ||
        this.rejectedTournamentBreakBegins.has(state.break_id)
      )
        return replayed;
      // The database refused the roster that proposal named: read the one it
      // holds now, in this same pass, instead of waiting for the next visit.
    }

    const { data, error } = await supabase
      .from('table_seats')
      .select('id, user_id, seat_number, stack, occupancy_id')
      .eq('table_id', state.source_table_id)
      .is('left_at', null);
    if (!this.eliminationMutationAllowed()) return refuse('mutation_not_allowed');
    if (error || !data) return refuse(`source_roster_unread:${error?.message ?? 'no data'}`);
    if (data.length === 0) return refuse('source_roster_empty');
    const rows = data as {
      id: string;
      user_id: string;
      seat_number: number;
      stack: number;
      occupancy_id: string;
    }[];
    if (
      rows.some(
        (row) =>
          !row.user_id ||
          !row.occupancy_id ||
          !Number.isFinite(Number(row.stack)) ||
          Number(row.stack) <= 0
      )
    )
      return refuse('source_seat_unfunded_or_unbound');
    // The door counts registrations as well as seats (breakSourceRoster.ts).
    // Ask the same question before proposing, and name whoever differs.
    const { data: registrationData, error: registrationError } = await supabase
      .from('tournament_players')
      .select('user_id, status, chips, seat_number')
      .eq('tournament_id', this.tournamentId)
      .eq('table_id', state.source_table_id)
      .in('status', ['playing', 'registered']);
    if (!this.eliminationMutationAllowed()) return refuse('mutation_not_allowed');
    if (registrationError || !registrationData)
      return refuse(`source_registrations_unread:${registrationError?.message ?? 'no data'}`);
    const disagreement = compareBreakSourceRoster(
      rows,
      registrationData as BreakSourceRegistration[]
    );
    if (disagreement) {
      // A bust not yet recorded is the bust stage's work, and this break
      // cannot begin until it is done: give that stage the next admission.
      if (disagreement.unrecordedBusts.length > 0) this.bustAwaitsItsStage();
      this.requestUrgentEliminationSweepAfter(
        disagreement.unrecordedBusts.length > 0 ? 0 : TournamentManagerBase.BALANCE_REDRIVE_MS
      );
      return refuse(disagreement.reason);
    }
    const others = await this.eligibleBreakDestinations(state.source_table_id, state.break_id);
    if (!this.eliminationMutationAllowed()) return refuse('mutation_not_allowed');
    if (!others) return refuse(`destinations_unread:${this.destinationReadRefusal}`);
    const source: BalancerTable = {
      tableId: state.source_table_id,
      playerCount: rows.length,
      maxSeats: 10,
      players: rows.map((row) => ({
        userId: row.user_id,
        seat: row.seat_number,
        stack: Number(row.stack),
      })),
    };
    const moves = this.tableBalancer.breakTable(source, others);
    if (moves.length !== rows.length) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      // Existing capacity owner must supply legal space.
      return refuse(
        `destinations_full:${moves.length}_of_${rows.length}_placed_across_${others.length}_tables`
      );
    }
    const members = rows.map((row) => {
      const move = moves.find((candidate) => candidate.playerId === row.user_id);
      if (!move) throw new Error('F06 complete original roster cannot be placed');
      return {
        user_id: row.user_id,
        source_seat_id: row.id,
        source_seat_number: row.seat_number,
        occupancy_id: row.occupancy_id,
        request_id:
          this.rejectedTournamentBreakBegins
            .get(state.break_id)
            ?.find((member) => member.user_id === row.user_id)?.request_id ?? randomUUID(),
        destination_table_id: move.toTableId,
        destination_seat_number: move.toSeat,
      };
    });
    if (
      !receiptOwned &&
      (!engine ||
        this.tableEngines.get(state.source_table_id) !== engine ||
        !this.gameServer.ownsTournamentTableEngine(state.source_table_id, engine))
    )
      return refuse('source_engine_replaced');
    if (receiptOwned) this.mixedRecovery!.assertCurrent();
    return this.beginTournamentBreak(state.break_id, state.source_table_id, members);
  }

  private readonly pendingTournamentBreakAmendments = new Map<
    string,
    Parameters<TournamentTableBreakRpc['amend']>[0]
  >();

  protected async amendTournamentBreakMember(
    state: TournamentTableBreakState,
    userId: string,
    destinationTableId: string,
    destinationSeatNumber: number
  ): Promise<TournamentTableBreakState> {
    const member = state.members.find((candidate) => candidate.user_id === userId);
    if (!member || member.winner_request_id || !member.active_request_id || state.state !== 'begun')
      return state;
    const key = `${state.break_id}:${userId}:${member.active_request_id}`;
    let amendment = this.pendingTournamentBreakAmendments.get(key);
    if (!amendment) {
      amendment = Object.freeze({
        breakId: state.break_id,
        userId,
        expectedRequestId: member.active_request_id,
        amendmentId: randomUUID(),
        newRequestId: randomUUID(),
        destinationTableId,
        destinationSeatNumber,
        reason: 'original destination unavailable',
      });
      this.pendingTournamentBreakAmendments.set(key, amendment);
    }
    if (this.mixedRecovery && this.isF06RecoveryOwner())
      await retainMixedF06Intent(
        this.tournamentId,
        this.getTournamentLeaseGeneration()!,
        this.mixedRecovery.transfer,
        `amend:${state.break_id}:${amendment.amendmentId}`,
        amendment,
        this.mixedRecovery.assertCurrent
      );
    let next: TournamentTableBreakState;
    try {
      next = await this.tableBreakRpc().amend(amendment);
    } catch (error) {
      if (
        !(error instanceof TournamentTableBreakCapacityError) ||
        error.rpc !== 'fn_f06_amend_attempt' ||
        error.parameters.p_break_id !== amendment.breakId ||
        error.parameters.p_amendment_id !== amendment.amendmentId ||
        error.parameters.p_new_request_id !== amendment.newRequestId ||
        error.parameters.p_expected_request_id !== amendment.expectedRequestId ||
        error.parameters.p_user_id !== amendment.userId ||
        error.parameters.p_destination_table_id !== amendment.destinationTableId ||
        error.parameters.p_destination_seat_number !== amendment.destinationSeatNumber ||
        error.parameters.p_reason !== amendment.reason
      )
        throw error;
      next = await this.reconcileTournamentBreak(state);
      this.assertBreakMembership(state.members, next.members);
      // Capacity refusal is correlated to this exact proposal; the subsequent
      // state is authoritative even if an older in-flight send won meanwhile.
      this.retainResolvedBreakProposal(state.break_id, amendment);
      this.pendingTournamentBreakAmendments.delete(key);
      this.rememberTournamentBreak(next);
      return next;
    }
    if (next.source_table_id !== state.source_table_id || next.lifecycle !== state.lifecycle)
      throw new Error('F06 amendment source lifecycle mismatch');
    this.rememberTournamentBreak(next);
    const updated = next.members.find((candidate) => candidate.user_id === userId);
    if (
      next.ok &&
      updated &&
      (updated.winner_request_id || updated.active_request_id !== member.active_request_id)
    )
      this.pendingTournamentBreakAmendments.delete(key);
    return next;
  }

  protected async reconcileTournamentBreak(
    state: TournamentTableBreakState
  ): Promise<TournamentTableBreakState> {
    const next = await this.tableBreakRpc().reconcile(state.break_id);
    if (next.source_table_id !== state.source_table_id || next.lifecycle !== state.lifecycle)
      throw new Error('F06 reconciliation source lifecycle mismatch');
    const original =
      this.pendingTournamentBreakBegins.get(state.break_id) ??
      this.rejectedTournamentBreakBegins.get(state.break_id);
    if (original && next.state !== 'park_requested') {
      this.assertSentBreakMembership(state.break_id, next.members);
      this.pendingTournamentBreakBegins.delete(state.break_id);
      this.rejectedTournamentBreakBegins.delete(state.break_id);
      this.resolvedTournamentBreakProposals.delete(state.break_id);
    }
    // The RPC decoder proves the winner's original member/occupancy, break,
    // lifecycle and destination. A lost move reply is not a new dispatch.
    if (next.ok && !next.terminal_handoff_required && next.state !== 'acknowledged') {
      for (const member of next.members) {
        if (member.winning_receipt)
          this.wakeTournamentBreakArrival(next.break_id, member.winning_receipt);
      }
    }
    this.rememberTournamentBreak(next);
    return next;
  }

  /**
   * THE BREAK A SWEEP DISCOVERED IS THE BREAK IT FINISHES (2026-09-29).
   *
   * Every step of a break visit asks `eliminationMutationAllowed()`, and that
   * answer turns false the moment the sweep's five-second work budget is
   * spent. So a visit that began late in an admission stopped wherever the
   * clock ran out - after `fn_f06_break_state`, inside the destination read
   * (`destinations_unread`), between the custody claim and the close - and the
   * next admission's discovery had already advanced the server cursor to the
   * NEXT operation. A half-visited break then waited one whole round of every
   * open operation, one operation per admitted balance stage, before anyone
   * looked at it again.
   *
   * Production 2026-09-29, engine 41b91390 after the 03:55Z restart: the
   * elimination scheduler had 223 managers queued on four slots with an
   * oldest wait of 277 s. $100 Freeroll 6:00 AM (87a68e55) held seven open
   * operations and its discovery cursor went from revision 28 to 29 in
   * fifteen minutes (04:22-04:37Z): break 390e1e90 was visited once and moved
   * its three players, and nothing else was looked at. $100 Freeroll 6:00 PM
   * (cb8f2dd1) held five and was visited once, at 04:30:36Z, where the budget
   * ran out inside the destination read (`Break f1af44bb members not
   * dispatched: destinations_unread`). Two begun breaks whose every member
   * had already moved (192437a7, 4576ca30) and three close_confirmed breaks
   * still in the custody of dead generations (7b44499f, 086b55a3, eb53ed4f)
   * needed only their claim, close and ACK, and got none of them. The path
   * itself works: aec45ff6 (source 54f49f08), held by dead generation
   * b16497dd, was claimed, acknowledged and released the moment the live
   * generation reached it.
   *
   * The bust stage fixed the same livelock on 2026-09-27 with its batch
   * window: the clock decides only whether a pass may START. Breaks now follow
   * the same rule. Discovering one operation and visiting it is one unit: the
   * window opens before the discovery call advances the cursor and closes
   * when that one operation's visit returns, so the budget can no longer
   * strand a discovered break half-visited. The unit is bounded - one
   * operation, at most ten members, a fixed sequence of receipted doors - and
   * manager stop and the sweep's abort still end it. After each unit the clock
   * is asked again, so further operations are visited in the same admission
   * only while budget remains, each at most once per pass. The balancer's own
   * planning reads (checkTableBalance steps 1 and 2) and every other stage
   * still answer to the budget exactly as before. A cursor conflict
   * (every new lease generation starts at revision 0) returns the cursor's
   * revision, and the adopted revision is used at once instead of costing the
   * whole admission.
   */
  private tournamentBreakVisitOpen = false;

  /** A refused prefix never prevents the next discovered operation being visited. */
  protected async visitTournamentBreakPage(
    visit: (state: TournamentTableBreakState) => Promise<void>
  ): Promise<boolean> {
    const visited = new Set<string>();
    let pages = 0;
    // The page is the whole pending set now (see `discoverTournamentBreaks`),
    // so it is HELD across units and re-read only once it has been worked
    // through: the server cursor advances once per traversal instead of once
    // per operation, which is what the balancer's completeness claim waits on.
    let held: TournamentTableBreakState[] = [];
    for (;;) {
      if (!this.eliminationMutationAllowed()) return pages > 0;
      if (pages > 0 && this.eliminationWorkBudgetExpired()) return true;
      this.tournamentBreakVisitOpen = true;
      let fresh = 0;
      try {
        if (!held.some((op) => !visited.has(op.break_id))) {
          let page = await this.discoverTournamentBreaks();
          // The conflict carried the cursor's revision; ask once more with it.
          if (page === null && this.eliminationMutationAllowed())
            page = await this.discoverTournamentBreaks();
          if (page === null) {
            this.noteBreakDiscoveryRefusal('cursor_revision_conflict_twice');
            return pages > 0;
          }
          this.noteBreakDiscoveryRefusal(null);
          pages += 1;
          held = page;
        }
        const unseen = held.filter((op) => !visited.has(op.break_id));
        fresh = unseen.length;
        // ONE operation per unit, always. The window opened above suspends the
        // work budget for everything inside it, so a unit that took a whole
        // page would let one admission run as long as the page is deep - the
        // bounded unit is the entire point of it.
        if (
          fresh > 0 &&
          !(await this.visitTournamentBreakWork(unseen.slice(0, 1), pages === 1, visit, visited))
        )
          return pages > 1;
      } finally {
        this.tournamentBreakVisitOpen = false;
      }
      // An empty page, or a wrap back to operations already visited in this
      // pass, means every open operation has had its visit.
      if (fresh === 0) return true;
    }
  }

  private async visitTournamentBreakWork(
    page: TournamentTableBreakState[],
    includeRetained: boolean,
    visit: (state: TournamentTableBreakState) => Promise<void>,
    visited: Set<string>
  ): Promise<boolean> {
    // One operation per unit prevents a slow first item from forever hiding the
    // rest of a pre-advanced page - the caller hands exactly one, and asks the
    // clock again between units. Alternate retained ACK cleanup with discovery
    // so a committed/lost ACK can release its local reservation.
    const retainedId = includeRetained
      ? [...this.pendingTournamentCleanupKinds.keys()].find(
          (id) => !page.some((op) => op.break_id === id)
        )
      : undefined;
    const retained = retainedId ? this.durableTournamentBreaks.get(retainedId) : undefined;
    if (includeRetained) this.tournamentBreakCleanupFirst = !this.tournamentBreakCleanupFirst;
    const work = retained
      ? this.tournamentBreakCleanupFirst
        ? [retained, ...page]
        : [...page, retained]
      : page;
    if (retainedId) {
      const kind = this.pendingTournamentCleanupKinds.get(retainedId)!;
      this.pendingTournamentCleanupKinds.delete(retainedId);
      this.pendingTournamentCleanupKinds.set(retainedId, kind);
    }
    for (const state of work) {
      if (!this.eliminationMutationAllowed()) return false;
      visited.add(state.break_id);
      try {
        await visit(state);
      } catch (error) {
        reportError(error, 'Tournament.break_recovery_unresolved', {
          tournamentId: this.tournamentId,
          breakId: state.break_id,
        });
      }
    }
    if (page.length)
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
    return true;
  }

  private breakDiscoveryRefusal: string | null = null;

  private noteBreakDiscoveryRefusal(reason: string | null): void {
    if (this.breakDiscoveryRefusal === reason) return;
    this.breakDiscoveryRefusal = reason;
    if (reason)
      console.warn(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Break discovery did not run: ${reason}`
      );
  }

  /** Exact original source kept through no-start, movement and final ACK. */
  private readonly stoppedOriginalBreaks = new Map<string, ServerTableEngine>();
  private readonly activeStoppedOriginalCustody = new Set<string>();
  private originalAdmissionCursor = 0;
  private readonly originalAdmissionRecoveries = new WeakMap<ServerTableEngine, Promise<void>>();

  /** One original admission decision per RUNNING sweep; never a dealer restart. */
  protected async recoverF06OriginalAdmissions(): Promise<void> {
    const pendingContinuation = this.pendingNoStartContinuations.keys().next().value;
    if (pendingContinuation && (await this.replayNoStartContinuation(pendingContinuation))) return;
    const entries = [...this.tableEngines.entries()];
    if (!entries.length || !this.eliminationMutationAllowed()) return;
    const [tableId, engine] = entries[this.originalAdmissionCursor++ % entries.length];
    await this.recoverStoppedOriginalAdmission(tableId, engine);
  }

  /** The balance pass and this original's restart event join one disposition. */
  protected override recoverStoppedOriginalAdmission(
    tableId: string,
    engine: ServerTableEngine
  ): Promise<void> {
    // A positive no-start continuation has already cleared this permit and
    // can re-enter dealer admission while its original disposition unwinds.
    if (!engine.getF06RecoverablePermit?.()) return Promise.resolve();
    const existing = this.originalAdmissionRecoveries.get(engine);
    if (existing) return existing;
    let tracked!: Promise<void>;
    tracked = this.performStoppedOriginalAdmission(tableId, engine).finally(() => {
      if (this.originalAdmissionRecoveries.get(engine) === tracked)
        this.originalAdmissionRecoveries.delete(engine);
    });
    this.originalAdmissionRecoveries.set(engine, tracked);
    return tracked;
  }

  private async performStoppedOriginalAdmission(
    tableId: string,
    engine: ServerTableEngine
  ): Promise<void> {
    const token = this.captureLifecycleToken();
    const generation = this.getTournamentLeaseGeneration();
    if (!token || !generation) return;
    const current = () =>
      this.lifecycleIsCurrent(token) &&
      this.getTournamentLeaseGeneration() === generation &&
      this.eliminationMutationAllowed() &&
      this.tableEngines.get(tableId) === engine &&
      this.gameServer.ownsTournamentTableEngine(tableId, engine);
    if (!current()) return;
    const permit = engine.getF06RecoverablePermit?.();
    if (permit) {
      if (!['unknown', 'reserved', 'terminated'].includes(permit.phase)) return;
      if (
        permit.binding.tournament_id !== this.tournamentId ||
        permit.binding.lease_generation !== generation ||
        permit.binding.table_id !== tableId
      )
        throw new Error('F06 original permit owner mismatch');
      const state = await this.requestTournamentBreakPark(tableId);
      if (!current()) throw new Error('F06 original park owner changed');
      if (state) {
        if (state.lifecycle !== permit.binding.lifecycle)
          throw new Error('F06 original park lifecycle mismatch');
        this.stoppedOriginalBreaks.set(state.break_id, engine);
        await this.retireTournamentBreak(state);
      }
      // An excluded source/lost park reply is recovered through durable discovery.
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
    }
    // A failed hand-number allocation is not recovered here (2026-09-26). It
    // claims no hand and discards no BEGIN identity - at most it burns a
    // number - so it fails the one deal attempt it belonged to and the
    // dealer's next preparation allocates fresh. This sweep used to be the
    // only thing that cleared it, one table per pass, which left a table
    // re-throwing one statement timeout until its turn came round.
  }

  private bindStoppedOriginalBreak(state: TournamentTableBreakState): boolean {
    const engine = this.tableEngines.get(state.source_table_id);
    const retained = this.stoppedOriginalBreaks.get(state.break_id);
    if (
      retained &&
      !engine &&
      state.state === 'close_confirmed' &&
      this.pendingTournamentCleanupKinds.has(state.break_id) &&
      !this.gameServer.getTableEngine(state.source_table_id)
    )
      return false;
    if (
      retained &&
      (retained !== engine ||
        !this.gameServer.ownsTournamentTableEngine(state.source_table_id, retained))
    )
      throw new Error('F06 stopped original registry changed');
    if (!engine || !this.gameServer.ownsTournamentTableEngine(state.source_table_id, engine))
      return false;
    if (this.stoppedOriginalBreaks.get(state.break_id) === engine) return true;
    const permit = engine.getF06RecoverablePermit?.();
    if (!permit || !['unknown', 'reserved', 'terminated'].includes(permit.phase)) return false;
    const b = permit.binding;
    if (
      b.tournament_id !== this.tournamentId ||
      b.lease_generation !== this.getTournamentLeaseGeneration() ||
      b.table_id !== state.source_table_id ||
      b.lifecycle !== state.lifecycle
    )
      return false;
    this.stoppedOriginalBreaks.set(state.break_id, engine);
    return true;
  }

  private readonly pendingTournamentBreakCustodyIds = new Map<string, string>();
  private readonly pendingTournamentCleanupKinds = new Map<string, 'retired' | 'verified_absent'>();

  /** Release only this process's already-proven absent reservation after lost ACK. */
  private async finishAcknowledgedTournamentBreak(state: TournamentTableBreakState): Promise<void> {
    const kind = this.pendingTournamentCleanupKinds.get(state.break_id);
    const custodyId = this.pendingTournamentBreakCustodyIds.get(state.break_id);
    if (!kind || !custodyId) {
      this.rememberTournamentBreak(state);
      return;
    }
    const generation = this.getTournamentLeaseGeneration();
    if (!generation || state.custody_id !== custodyId || state.custody_generation !== generation)
      throw new Error('F06 acknowledged custody differs from retained cleanup');
    const host = this.gameServer as typeof this.gameServer & Partial<BreakRetirementHost>;
    if (!host.withRetirementCustody)
      throw new Error('F06 Lease withRetirementCustody adapter unavailable');
    const binding: BreakRetirementBinding = {
      breakId: state.break_id,
      tableId: state.source_table_id,
      tableIncarnation: state.lifecycle,
      tournamentId: this.tournamentId,
      custodyId,
      durableRevision: state.revision,
      leaseGeneration: generation,
    };
    const current = () =>
      this.getTournamentLeaseGeneration() === generation && this.eliminationMutationAllowed();
    await host.withRetirementCustody(
      binding,
      this.tableEngines,
      current,
      async (custody) => {
        custody.assertCurrent();
        if (custody.engine) throw new Error('F06 old acknowledgement cannot stop an engine');
        custody.confirmAbsent();
      },
      async () => {
        // The retained local reservation excludes admission. Never use historical
        // ACK to select a current engine, even if table UUID happens to match.
        if (
          !current() ||
          this.tableEngines.has(binding.tableId) ||
          this.gameServer.getTableEngine(binding.tableId)
        )
          throw new Error('F06 acknowledged absence is not current');
      }
    );
    this.pendingTournamentCleanupKinds.delete(state.break_id);
    this.pendingTournamentBreakCustodyIds.delete(state.break_id);
    this.stoppedOriginalBreaks.delete(state.break_id);
    const retained = this.retainedTournamentBreakSources.get(state.source_table_id);
    if (retained?.breakId === state.break_id)
      this.retainedTournamentBreakSources.delete(state.source_table_id);
    this.rememberTournamentBreak(state);
  }

  private readonly pendingNoStartContinuations = new Map<
    string,
    {
      state: TournamentTableBreakState;
      engine: ServerTableEngine;
      binding: BreakRetirementBinding;
      /** Which door this pending request went through; absent = continuation. */
      exit?: NoStartExit;
    }
  >();

  /**
   * Take one no-start exit for a stopped original's unbegun park. The last
   * table's continuation answers false when it cannot read the witness; the
   * withdrawal answers false when the field has room for the roster (the break
   * then goes on) or the witness is missing. A withdrawal the database refuses
   * outright is not this break's failure: it waits for seats exactly as before.
   */
  private async takeNoStartExit(
    exit: NoStartExit,
    state: TournamentTableBreakState
  ): Promise<boolean> {
    const rpc = this.tableBreakRpc();
    if (exit === 'continue') return rpc.continueNoStartLastTable(state);
    try {
      return await rpc.withdrawUnplaceablePark(state);
    } catch (error) {
      if (error instanceof TournamentNoStartContinuationRefusedError) return false;
      throw error;
    }
  }

  private forgetContinuedNoStartPark(
    state: TournamentTableBreakState,
    engine: ServerTableEngine
  ): void {
    if (
      this.tableEngines.get(state.source_table_id) !== engine ||
      !this.gameServer.ownsTournamentTableEngine(state.source_table_id, engine) ||
      !engine.hasReleasedProcessOwnership() ||
      engine.getF06RetainedPermit()
    )
      throw new Error('F06 continued dealer drain changed');
    const retained = this.retainedTournamentBreakSources.get(state.source_table_id);
    if (retained && retained.breakId !== state.break_id)
      throw new Error('F06 continued source belongs to another break');
    if (
      [...this.pendingTournamentSeatMoveOutcomes.values()].some(
        (item) => item.input.sourceTableId === state.source_table_id
      )
    )
      throw new Error('F06 continued source has a pending move');
    this.pendingNoStartContinuations.delete(state.break_id);
    this.durableTournamentBreaks.delete(state.break_id);
    this.resolvedTournamentBreakProposals.delete(state.break_id);
    this.tournamentBreakArrivalWakes.delete(state.break_id);
    this.pendingTournamentBreakCustodyIds.delete(state.break_id);
    this.pendingTournamentCleanupKinds.delete(state.break_id);
    this.stoppedOriginalBreaks.delete(state.break_id);
    if (retained) this.retainedTournamentBreakSources.delete(state.source_table_id);
    engine.releaseTournamentMovePause(this.tournamentMoveBoundaryOwner);
  }

  private async replayNoStartContinuation(breakId: string): Promise<boolean> {
    const pending = this.pendingNoStartContinuations.get(breakId);
    if (!pending) return false;
    const { state, engine, binding } = pending;
    const lifecycle = this.captureLifecycleToken();
    const current = () =>
      !!lifecycle &&
      this.lifecycleIsCurrent(lifecycle) &&
      this.eliminationMutationAllowed() &&
      this.getTournamentLeaseGeneration() === binding.leaseGeneration &&
      this.pendingNoStartContinuations.get(breakId) === pending &&
      this.tableEngines.get(binding.tableId) === engine &&
      this.gameServer.ownsTournamentTableEngine(binding.tableId, engine);
    const host = this.gameServer as typeof this.gameServer & Partial<BreakRetirementHost>;
    if (!host.withRetirementCustody) throw new Error('F06 retirement adapter unavailable');
    await host.withRetirementCustody(
      binding,
      this.tableEngines,
      current,
      async (custody) => {
        custody.assertCurrent();
        if (custody.engine !== engine || engine.getF06RetainedPermit())
          throw new Error('F06 no-start original disposition unresolved');
        try {
          const replayed =
            pending.exit === 'withdraw'
              ? await this.tableBreakRpc().withdrawUnplaceablePark(state)
              : await this.tableBreakRpc().continueNoStartLastTable(state);
          if (!replayed) {
            this.pendingNoStartContinuations.delete(breakId);
            throw new Error(
              'F06 continuation is not eligible; ordinary retirement remains pending'
            );
          }
        } catch (error) {
          if (error instanceof TournamentNoStartContinuationRefusedError)
            this.pendingNoStartContinuations.delete(breakId);
          throw error;
        }
        custody.assertCurrent();
      },
      async () => {
        // Only an already positively drained exact pending request reaches here.
        // Re-claiming a withdrawn park would strand a committed lost reply.
        if (!current() || !engine.hasReleasedProcessOwnership())
          throw new Error('F06 continuation replay custody changed');
      }
    );
    this.forgetContinuedNoStartPark(state, engine);
    await this.readmitContinuedNoStartTable(state.source_table_id, engine);
    return true;
  }

  protected async continueExcludedNoStartTable(
    tableId: string,
    engine: ServerTableEngine,
    current: () => boolean
  ): Promise<boolean> {
    if (!current() || engine.getF06RetainedPermit()) return false;
    // A read-only hint keeps ordinary multi-table movement admission intact.
    // The RPC repeats the complete locked scope check before any transition.
    const { data: openTables, error: tablesError } = await supabase
      .from('tables')
      .select('id')
      .eq('tournament_id', this.tournamentId)
      .neq('status', 'closed')
      .or('is_deleted.is.null,is_deleted.eq.false');
    if (!current() || tablesError || !openTables) throw new Error('F06 open table scope unproven');
    if (openTables.length !== 1 || openTables[0]?.id !== tableId) return false;
    const rpc = this.tableBreakRpc();
    const table = await rpc.tableState(tableId);
    if (!current() || !table.ok || !table.excluded || !table.break_id) return false;
    const state = await rpc.reconcile(table.break_id);
    if (
      !current() ||
      state.state !== 'park_requested' ||
      state.members.length ||
      state.source_table_id !== tableId ||
      state.lifecycle !== table.lifecycle ||
      !state.custody_id
    )
      return false;
    const continued = await this.gameServer.tournamentRetirementCustody.withAdmission(
      tableId,
      current,
      async (assertCurrent) => {
        try {
          await engine.stop();
        } catch (error) {
          if (!engine.hasReleasedProcessOwnership()) throw error;
        }
        assertCurrent();
        if (!engine.hasReleasedProcessOwnership() || engine.getF06RetainedPermit())
          throw new Error('F06 continuation candidate not drained');
        const continued = await rpc.continueNoStartLastTable(state);
        assertCurrent();
        if (continued) return true;
        /*
         * THE LAST TABLE OVER A SEALED HAND (2026-10-03).
         *
         * SNG 657e45b2 "PLO4 Heads-Up 5", table bba21601: its park's witness
         * is the accepted, sealed previous hand (the timed-out BEGIN rolled
         * back), which the continuation cannot read. After the 03:55Z release
         * every admission of the table stopped the new dealer, met
         * POSITIVE_ORIGINAL_REQUIRED here and failed "never ready" - the
         * heads-up match stayed frozen. The withdrawal door reads that witness
         * on the last table (20261003021958); it admits only the park's
         * custodian, so a park an earlier generation left is claimed first.
         */
        const generation = this.getTournamentLeaseGeneration();
        let park = state;
        if (park.custody_generation !== generation) {
          park = await rpc.claimCustody(state.break_id, randomUUID(), state.revision);
          assertCurrent();
          this.rememberTournamentBreak(park);
          if (
            !park.ok ||
            park.state !== 'park_requested' ||
            park.members.length !== 0 ||
            park.custody_generation !== generation
          )
            return false;
        }
        const withdrawn = await this.takeNoStartExit('withdraw', park);
        assertCurrent();
        if (withdrawn)
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Break ${park.break_id.slice(0, 8)} withdrawn: the last table's park stood over a sealed hand; table ${tableId.slice(0, 8)} deals again`
          );
        return withdrawn;
      }
    );
    // The scope may change while stopping. A terminal candidate cannot fall
    // through to movement start; ordinary exact-owner recovery must replace it.
    if (!continued)
      throw new TournamentNoStartContinuationRefusedError(
        'F06 continuation eligibility changed after drain'
      );
    this.forgetContinuedNoStartPark(state, engine);
    return true;
  }

  protected async retireTournamentBreak(state: TournamentTableBreakState): Promise<void> {
    if (this.receiptOwnsSource(state.source_table_id))
      return this.retireTransferredTournamentBreak(state);
    if (await this.replayNoStartContinuation(state.break_id)) return;
    // Historical completion cannot select or stop whichever engine exists now.
    if (state.state === 'acknowledged') {
      await this.finishAcknowledgedTournamentBreak(state);
      return;
    }
    // Every early exit below names itself (CLAUDE.md 10.86 rule 1): a break
    // that is not retired says why, once per change of reason.
    const refuse = (reason: string): void =>
      this.noteBreakRetirementRefusal(state.break_id, reason);
    if (state.terminal_handoff_required) return refuse('terminal_handoff_required');
    const stoppedOriginal = this.bindStoppedOriginalBreak(state);
    const managerLifecycle = this.captureLifecycleToken();
    if (stoppedOriginal && (!managerLifecycle || !this.lifecycleIsCurrent(managerLifecycle)))
      return refuse('original_owner_lifecycle_changed');
    if (
      !stoppedOriginal &&
      state.state !== 'close_confirmed' &&
      (state.state !== 'begun' ||
        !state.members.length ||
        state.members.some((member) => !member.winner_request_id))
    )
      return refuse(
        state.state === 'begun'
          ? `members_unresolved:${state.members.filter((m) => !m.winner_request_id).length}_of_${state.members.length}`
          : `state_not_retirable:${state.state}`
      );
    const generation = this.getTournamentLeaseGeneration();
    if (!generation || !this.eliminationMutationAllowed())
      return refuse('manager_authority_unavailable');
    const rpc = this.tableBreakRpc();
    const fresh = await this.reconcileTournamentBreak(state);
    if (!fresh.ok) return refuse(`reconcile_refused:${fresh.reason ?? 'no_reason'}`);
    if (fresh.terminal_handoff_required) return refuse('terminal_handoff_required');
    if (!this.eliminationMutationAllowed()) return refuse('manager_authority_unavailable');
    if (stoppedOriginal && (!managerLifecycle || !this.lifecycleIsCurrent(managerLifecycle)))
      throw new Error('F06 original retirement owner changed');
    if (fresh.state === 'acknowledged') {
      await this.finishAcknowledgedTournamentBreak(fresh);
      return;
    }
    let custodyId = this.pendingTournamentBreakCustodyIds.get(state.break_id);
    if (!custodyId) {
      custodyId =
        fresh.custody_generation === generation && fresh.custody_id
          ? fresh.custody_id
          : randomUUID();
      this.pendingTournamentBreakCustodyIds.set(state.break_id, custodyId);
    }
    // The local reservation must precede durable claim and stop. The exact
    // successful CAS revision is predictable from the published +1 contract.
    const expectedRevision =
      fresh.custody_id === custodyId && fresh.custody_generation === generation
        ? fresh.revision
        : (BigInt(fresh.revision) + 1n).toString();
    let owned = fresh;
    const binding: BreakRetirementBinding = {
      breakId: fresh.break_id,
      tableId: fresh.source_table_id,
      tableIncarnation: fresh.lifecycle,
      tournamentId: this.tournamentId,
      custodyId,
      durableRevision: expectedRevision,
      leaseGeneration: generation,
    };
    const host = this.gameServer as typeof this.gameServer & Partial<BreakRetirementHost>;
    if (!host.withRetirementCustody)
      throw new Error('F06 Lease withRetirementCustody adapter unavailable');
    let acknowledged = false;
    let continued = false;
    const current = () =>
      (!stoppedOriginal || (!!managerLifecycle && this.lifecycleIsCurrent(managerLifecycle))) &&
      this.getTournamentLeaseGeneration() === generation &&
      this.eliminationMutationAllowed() &&
      (acknowledged ||
        continued ||
        (this.durableTournamentBreaks.get(owned.break_id)?.revision === owned.revision &&
          this.durableTournamentBreaks.get(owned.break_id)?.lifecycle ===
            binding.tableIncarnation));
    const retirement = host.withRetirementCustody(
      binding,
      this.tableEngines,
      current,
      async (custody) => {
        custody.assertCurrent();
        if (stoppedOriginal && owned.state !== 'close_confirmed') {
          const engine = this.stoppedOriginalBreaks.get(owned.break_id);
          if (!engine || custody.engine !== engine)
            throw new Error('F06 stopped original engine changed');
          await engine.admitF06StoppedOriginalMovement(
            this.tournamentMoveBoundaryOwner,
            custody,
            async () => {
              custody.assertCurrent();
              const park = await this.reconcileTournamentBreak(owned);
              custody.assertCurrent();
              return park;
            }
          );
          custody.assertCurrent();
          if (!this.retainTournamentBreakSource(owned.break_id, binding.tableId, engine))
            throw new Error('F06 stopped original source retention refused');
          this.activeStoppedOriginalCustody.add(binding.tableId);
          try {
            if (!(await this.redrivePendingTournamentSeatMoveOutcomes()))
              throw new Error('F06 original movement remains unknown');
            custody.assertCurrent();
            if (owned.state === 'park_requested') {
              const begun = await this.prepareParkedTournamentBreak(owned);
              custody.assertCurrent();
              if (!begun) {
                /*
                 * A FULL FIELD IS NOT THE LAST TABLE (2026-09-26).
                 *
                 * `prepareParkedTournamentBreak` also answers null when the
                 * roster does not fit the free seats elsewhere. Event
                 * 45b5b001, table 7441f3b1: 9 players, 6 free seats across
                 * four other open tables; this branch asked the last-table
                 * continuation, SQL refused it (five tables open), and every
                 * sweep threw "placement remains pending". Only the event's
                 * last open table may continue; any other source waits,
                 * fenced under this same custody, for seats.
                 */
                const last = await this.isOnlyOpenTournamentTable(binding.tableId);
                custody.assertCurrent();
                /*
                 * A ROSTER NOBODY CAN SEAT IS NOT PARKED FOR EVER (2026-10-03).
                 *
                 * Event 79feebfc (Prime Time Free Buy): a Supabase IO stall
                 * at 01:07Z left fifteen full tables' permits unknown, the
                 * zombie watchdog rebuilt them and this path parked every one
                 * as a stopped original. The field needed every table it had,
                 * so each break waited here for seats - its custody holding
                 * the stopped dealer - and 135 players were dealt nothing for
                 * over an hour. The withdrawal door was never reached from
                 * here, only from discovery, which this custody fences out.
                 *
                 * So the roster that cannot be seated is withdrawn under this
                 * same custody: the database proves the park never began, that
                 * nothing is in flight and that the other tables really lack
                 * the seats, and the dealer is readmitted as after a
                 * continuation. The last table tries its continuation first.
                 * Only a field the database finds room in still waits.
                 */
                const exits: NoStartExit[] = last ? ['continue', 'withdraw'] : ['withdraw'];
                let exit: NoStartExit | null = null;
                for (const candidate of exits) {
                  // A bust being recorded may free the chairs this roster needs.
                  if (candidate === 'withdraw' && !this.unplaceableGraceElapsed(owned.break_id))
                    continue;
                  this.pendingNoStartContinuations.set(owned.break_id, {
                    state: owned,
                    engine,
                    binding,
                    exit: candidate,
                  });
                  let taken = false;
                  try {
                    taken = await this.takeNoStartExit(candidate, owned);
                  } catch (error) {
                    if (error instanceof TournamentNoStartContinuationRefusedError)
                      this.pendingNoStartContinuations.delete(owned.break_id);
                    throw error;
                  }
                  custody.assertCurrent();
                  if (taken) {
                    exit = candidate;
                    break;
                  }
                  this.pendingNoStartContinuations.delete(owned.break_id);
                }
                if (!exit) {
                  if (!last)
                    throw new TournamentBreakAwaitsSeatsError(
                      'F06 original roster awaits seats at the other open tables'
                    );
                  throw new Error('F06 original placement remains pending');
                }
                this.unplaceableParkSince.delete(owned.break_id);
                if (exit === 'withdraw')
                  console.log(
                    `[Tournament:${this.tournamentId.slice(0, 8)}] Break ${owned.break_id.slice(0, 8)} withdrawn: its roster has no free seats; table ${binding.tableId.slice(0, 8)} deals again`
                  );
                continued = true;
                return;
              }
              // A capacity refusal from BEGIN leaves the row pre-manifest.
              if (begun.state === 'park_requested' && begun.members.length === 0)
                throw new TournamentBreakAwaitsSeatsError(
                  'F06 original roster awaits seats at the other open tables'
                );
              if (begun.state !== 'begun')
                throw new Error('F06 original placement remains pending');
              owned = begun;
            }
            owned = await this.repairTournamentBreakDestinations(owned);
            custody.assertCurrent();
            await this.dispatchTournamentBreakMembers(owned);
            custody.assertCurrent();
            owned = await this.reconcileTournamentBreak(owned);
            custody.assertCurrent();
            if (
              owned.state !== 'begun' ||
              !owned.members.length ||
              owned.members.some((member) => !member.winner_request_id)
            )
              throw new Error('F06 original movement remains pending');
          } finally {
            this.activeStoppedOriginalCustody.delete(binding.tableId);
          }
        }
        const closed = owned.state === 'close_confirmed' ? owned : await rpc.close(owned.break_id);
        custody.assertCurrent();
        if (
          !closed.ok ||
          closed.state !== 'close_confirmed' ||
          closed.lifecycle !== binding.tableIncarnation ||
          closed.source_table_id !== binding.tableId ||
          closed.custody_id !== binding.custodyId ||
          closed.custody_generation !== generation ||
          closed.revision !== binding.durableRevision
        )
          throw new Error('F06 exact close confirmation unavailable');
        this.rememberTournamentBreak(closed);
        const cleanupKind =
          this.pendingTournamentCleanupKinds.get(owned.break_id) ??
          (custody.engine ? 'retired' : 'verified_absent');
        this.pendingTournamentCleanupKinds.set(owned.break_id, cleanupKind);
        if (custody.engine) {
          if (!this.gameServer.unregisterTableEngine(binding.tableId, custody.engine))
            throw new Error('F06 global registry CAS refused');
          if (this.tableEngines.get(binding.tableId) !== custody.engine)
            throw new Error('F06 local registry CAS refused');
          this.tableEngines.delete(binding.tableId);
        }
        this.retireManagedTableFromHandForHand(binding.tableId);
        custody.confirmAbsent();
        const ack = await rpc.ackCleanup(
          owned.break_id,
          binding.custodyId,
          binding.durableRevision,
          cleanupKind
        );
        custody.assertCurrent();
        if (
          !ack.ok ||
          ack.state !== 'acknowledged' ||
          ack.source_table_id !== binding.tableId ||
          ack.lifecycle !== binding.tableIncarnation ||
          ack.custody_id !== binding.custodyId ||
          ack.custody_generation !== generation ||
          ack.revision !== binding.durableRevision
        )
          throw new Error('F06 cleanup acknowledgement unproven');
        acknowledged = true;
        this.rememberTournamentBreak(ack);
        const retained = this.retainedTournamentBreakSources.get(binding.tableId);
        if (retained?.breakId === binding.breakId)
          this.retainedTournamentBreakSources.delete(binding.tableId);
        this.pendingTournamentBreakCustodyIds.delete(binding.breakId);
        this.pendingTournamentCleanupKinds.delete(binding.breakId);
        this.stoppedOriginalBreaks.delete(binding.breakId);
      },
      async () => {
        const claimed = await rpc.claimCustody(binding.breakId, binding.custodyId, fresh.revision);
        if (
          !this.eliminationMutationAllowed() ||
          !claimed.ok ||
          claimed.state === 'acknowledged' ||
          claimed.custody_id !== binding.custodyId ||
          claimed.custody_generation !== generation ||
          claimed.lifecycle !== binding.tableIncarnation ||
          claimed.source_table_id !== binding.tableId ||
          claimed.revision !== binding.durableRevision
        )
          throw new Error('F06 custody claim identity mismatch before stop');
        owned = claimed;
        this.rememberTournamentBreak(claimed);
      }
    );
    if (await this.breakAwaitsSeats(retirement, binding)) return;
    if (continued) {
      const engine = this.stoppedOriginalBreaks.get(owned.break_id);
      if (!engine) throw new Error('F06 continued original missing');
      this.forgetContinuedNoStartPark(owned, engine);
      await this.readmitContinuedNoStartTable(owned.source_table_id, engine);
      return;
    }
    // Registry work is finished. Client reconstruction owns a lost broadcast.
    if (acknowledged && this.eliminationMutationAllowed())
      await this.broadcast('table_rebalance', {
        closedTableId: owned.source_table_id,
        movedPlayers: owned.members.length,
        reason: 'table_break',
      });
  }

  private readonly breaksAwaitingSeats = new Set<string>();

  /**
   * Settle one retirement attempt. A roster that does not fit yet ends the
   * attempt with the break still pending and its custody still holding the
   * table (the custody is released only by an acknowledged retirement), and
   * asks the Manager's existing redrive; a bust elsewhere also wakes the
   * sweep. It is named once per break, not reported on every sweep.
   */
  private async breakAwaitsSeats(
    retirement: Promise<unknown>,
    binding: BreakRetirementBinding
  ): Promise<boolean> {
    try {
      await retirement;
      this.breaksAwaitingSeats.delete(binding.breakId);
      return false;
    } catch (error) {
      if (!(error instanceof TournamentBreakAwaitsSeatsError)) throw error;
      if (!this.breaksAwaitingSeats.has(binding.breakId)) {
        this.breaksAwaitingSeats.add(binding.breakId);
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Break ${binding.breakId.slice(0, 8)} of table ${binding.tableId.slice(0, 8)} waits for seats at the other open tables`
        );
      }
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return true;
    }
  }

  /**
   * Read-only hint: is this table the event's only open table? The same read
   * `continueExcludedNoStartTable` makes; the continuation RPC repeats the
   * complete locked scope check itself.
   */
  private async isOnlyOpenTournamentTable(tableId: string): Promise<boolean> {
    const { data: openTables, error } = await supabase
      .from('tables')
      .select('id')
      .eq('tournament_id', this.tournamentId)
      .neq('status', 'closed')
      .or('is_deleted.is.null,is_deleted.eq.false');
    if (error || !openTables) throw new Error('F06 open table scope unproven');
    return openTables.length === 1 && openTables[0]?.id === tableId;
  }

  /**
   * Why the last destination read answered null. `destinations_unread` used to
   * be the whole message; it now carries this (CLAUDE.md 10.86 rule 1).
   */
  private destinationReadRefusal = 'unknown';

  private async eligibleBreakDestinations(
    sourceId: string,
    breakId: string
  ): Promise<BalancerTable[] | null> {
    const { data, error } = await supabase
      .from('tables')
      .select('id')
      .eq('tournament_id', this.tournamentId)
      .in('status', ['running', 'waiting', 'active'])
      .or('is_deleted.is.null,is_deleted.eq.false');
    if (!this.eliminationMutationAllowed()) {
      this.destinationReadRefusal = 'mutation_not_allowed';
      return null;
    }
    if (error || !data) {
      this.destinationReadRefusal = `tables_unread:${error?.message ?? 'no data'}`;
      return null;
    }
    const eligible = data.map((row) => String(row.id)).filter((id) => id !== sourceId);
    const board = await this.loadBalancerTables(eligible, 'breakReplacement', breakId);
    if (!board)
      this.destinationReadRefusal = this.eliminationMutationAllowed()
        ? 'balancer_snapshot_incomplete'
        : 'mutation_not_allowed';
    return board;
  }

  protected async repairTournamentBreakDestinations(
    state: TournamentTableBreakState
  ): Promise<TournamentTableBreakState> {
    let current = state;
    // Validate unchanged original destinations against one complete board.
    // Re-reading every table/seat/roster for every member can spend the shared
    // sweep budget before dispatching its first immutable request. The move
    // RPC still validates each destination atomically; this board grants no
    // mutation authority and never survives this invocation or an amendment.
    let destinations: BalancerTable[] | null = null;
    for (const member of state.members) {
      if (member.winner_request_id) continue;
      if (!this.eliminationMutationAllowed()) return current;
      destinations ??= await this.eligibleBreakDestinations(state.source_table_id, state.break_id);
      if (!destinations || !this.eliminationMutationAllowed()) {
        this.noteBreakDispatchRefusal(
          state.break_id,
          destinations
            ? 'mutation_not_allowed'
            : `destinations_unread:${this.destinationReadRefusal}`
        );
        return current;
      }
      const destination = destinations.find(
        (table) => table.tableId === member.destination_table_id
      );
      const occupied = destination?.players.some(
        (player) => player.seat === member.destination_seat_number
      );
      if (
        destination &&
        !occupied &&
        member.destination_seat_number !== null &&
        member.destination_seat_number <= destination.maxSeats
      )
        continue;
      // The existing balancer chooses legal available space; SQL revalidates it
      // atomically when fencing the predecessor and installing the new UUID.
      const replacement = this.tableBalancer.breakTable(
        {
          tableId: state.source_table_id,
          maxSeats: 10,
          playerCount: 1,
          players: [{ userId: member.user_id, seat: member.source_seat_number, stack: 1 }],
        },
        destinations
      )[0];
      if (!replacement) {
        this.noteBreakDispatchRefusal(
          state.break_id,
          `destination_unplaceable:${String(member.destination_table_id).slice(0, 8)}#${String(member.destination_seat_number)}`
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
        return current;
      }
      current = await this.amendTournamentBreakMember(
        current,
        member.user_id,
        replacement.toTableId,
        replacement.toSeat
      );
      if (!current.ok) return current;
      // A changed proposal may reserve different space. Read the current board
      // before validating or planning another member of this same break.
      destinations = null;
    }
    return current;
  }

  protected async recoverTournamentBreak(state: TournamentTableBreakState): Promise<void> {
    if (state.state === 'acknowledged') {
      if (this.receiptOwnsSource(state.source_table_id)) return;
      await this.finishAcknowledgedTournamentBreak(state);
      return;
    }
    let current = await this.reconcileTournamentBreak(state);
    if (!this.eliminationMutationAllowed()) return;
    if (!current.ok) {
      this.noteBreakDispatchRefusal(
        current.break_id,
        `reconcile_refused:${current.reason ?? 'no_reason'}`
      );
      return;
    }
    if (!current.terminal_handoff_required && this.bindStoppedOriginalBreak(current)) {
      await this.retireTournamentBreak(current);
      return;
    }
    if (current.terminal_handoff_required) {
      reportError(
        new Error('F06 terminal owner disposition required'),
        'Tournament.break_terminal_handoff',
        { tournamentId: this.tournamentId, breakId: current.break_id }
      );
      return;
    }
    if (current.state === 'park_requested') {
      const begun = await this.prepareParkedTournamentBreak(current);
      if (!begun) {
        // A roster the field cannot seat is not a reason to stop its table:
        // the park is withdrawn and the table deals until there is room.
        if (await this.withdrawUnplaceablePark(current)) return;
        // No destination could be proven. On the last open table that is not a
        // transient capacity shortage that a later sweep will clear - it is the
        // terminal case, and the no-start continuation is its only exit.
        await this.continueAbandonedNoStartPark(current);
        return;
      }
      if (!begun.ok || !this.eliminationMutationAllowed()) return;
      current = begun;
    }
    if (current.state === 'begun') {
      current = await this.repairTournamentBreakDestinations(current);
      if (!this.eliminationMutationAllowed()) return;
      if (!current.ok) {
        this.noteBreakDispatchRefusal(
          current.break_id,
          `amendment_refused:${current.reason ?? 'no_reason'}`
        );
        return;
      }
      await this.dispatchTournamentBreakMembers(current);
      if (!this.eliminationMutationAllowed()) return;
      current = await this.reconcileTournamentBreak(current);
    }
    if (this.eliminationMutationAllowed()) await this.retireTournamentBreak(current);
  }

  /**
   * The no-start continuation is the only terminal exit a park on the last open
   * table has. Until now it was reachable from exactly one place - table engine
   * admission - so a park abandoned by a retired lease generation could never
   * take it: the discovery path reaches the continuation only through
   * bindStoppedOriginalBreak, and that demands an in-memory hand permit issued
   * under the CURRENT generation, which a table parked by a dead generation and
   * not dealt since can never present. The operation was then discovered for
   * ever and finished never. This offers the already audited exit to the
   * operation discovery just found; continueExcludedNoStartTable re-proves the
   * whole scope itself and refuses anything it has not proven.
   */
  protected async continueAbandonedNoStartPark(state: TournamentTableBreakState): Promise<boolean> {
    if (
      !state.ok ||
      state.state !== 'park_requested' ||
      state.terminal_handoff_required ||
      state.members.length ||
      !state.custody_id
    )
      return false;
    const engine = this.tableEngines.get(state.source_table_id);
    if (!engine || !this.gameServer.ownsTournamentTableEngine(state.source_table_id, engine))
      return false;
    const lifecycle = this.captureLifecycleToken();
    const leaseGeneration = this.getTournamentLeaseGeneration();
    if (!lifecycle || !leaseGeneration) return false;
    const current = (): boolean =>
      this.lifecycleIsCurrent(lifecycle) &&
      this.eliminationMutationAllowed() &&
      this.getTournamentLeaseGeneration() === leaseGeneration &&
      this.tableEngines.get(state.source_table_id) === engine &&
      this.gameServer.ownsTournamentTableEngine(state.source_table_id, engine);
    if (!current()) return false;
    let continued = false;
    try {
      continued = await this.continueExcludedNoStartTable(state.source_table_id, engine, current);
    } catch (error) {
      // Eligibility that changed under us is the ordinary race, not a defect:
      // the next discovery pass re-reads the operation and decides again.
      if (error instanceof TournamentNoStartContinuationRefusedError) return false;
      throw error;
    }
    if (!continued) return false;
    if (!current()) throw new Error('F06 abandoned continuation owner changed');
    await this.readmitContinuedNoStartTable(state.source_table_id, engine);
    return true;
  }

  /**
   * A PARK WHOSE ROSTER CANNOT BE SEATED IS WITHDRAWN (2026-10-02).
   *
   * Production 13:28Z-14:30Z, event 4d2afa41 (Morning Free Buy): seven full
   * tables were parked for breaks whose players the rest of the field had no
   * seats for (`destinations_full:7_of_9_placed_across_25_tables`; 286
   * players needed all 32 nine-max tables). A park waits until it can begin,
   * so 62 players were dealt nothing for over an hour while the tables
   * around them played. Industry standard is that a table is broken only
   * when its players can be seated at once; otherwise it keeps playing.
   *
   * So a park that has not begun, and whose roster has found no seats for
   * UNPLACEABLE_PARK_GRACE_MS (long enough for a bust being recorded to free
   * its chair), is withdrawn through fn_f06_withdraw_unplaceable_park. The
   * database proves the park never began and that the other tables really
   * have fewer free seats than the roster, writes the receipt, and moves
   * nothing. The dealer is then stopped and readmitted exactly as after a
   * last-table continuation, and the balancer parks the table again only
   * when the field has room for it (shouldBreakTable / breakTable).
   */
  static UNPLACEABLE_PARK_GRACE_MS = 30_000;

  private readonly unplaceableParkSince = new Map<string, number>();

  /** True once this park has found no seats for UNPLACEABLE_PARK_GRACE_MS. */
  private unplaceableGraceElapsed(breakId: string): boolean {
    const now = Date.now();
    const since = this.unplaceableParkSince.get(breakId);
    if (since === undefined) this.unplaceableParkSince.set(breakId, now);
    if (since !== undefined && now - since >= TournamentManager.UNPLACEABLE_PARK_GRACE_MS)
      return true;
    this.requestUrgentEliminationSweepAfter(TournamentManager.UNPLACEABLE_PARK_GRACE_MS);
    return false;
  }

  protected async withdrawUnplaceablePark(state: TournamentTableBreakState): Promise<boolean> {
    const refusal = this.lastBreakPreparationRefusal(state.break_id);
    if (
      !state.ok ||
      state.state !== 'park_requested' ||
      state.terminal_handoff_required ||
      state.members.length ||
      !state.custody_id ||
      !refusal?.startsWith('destinations_full:')
    ) {
      this.unplaceableParkSince.delete(state.break_id);
      return false;
    }
    const now = Date.now();
    const since = this.unplaceableParkSince.get(state.break_id);
    if (since === undefined) this.unplaceableParkSince.set(state.break_id, now);
    if (since === undefined || now - since < TournamentManager.UNPLACEABLE_PARK_GRACE_MS) {
      this.requestUrgentEliminationSweepAfter(TournamentManager.UNPLACEABLE_PARK_GRACE_MS);
      return false;
    }
    // A break that has begun elsewhere may be about to take or free seats the
    // database counts differently from this board; decide after it settles.
    for (const other of this.durableTournamentBreaks.values())
      if (other.break_id !== state.break_id && other.state !== 'park_requested') return false;
    const tableId = state.source_table_id;
    const engine = this.tableEngines.get(tableId);
    if (!engine || !this.gameServer.ownsTournamentTableEngine(tableId, engine)) return false;
    const lifecycle = this.captureLifecycleToken();
    const leaseGeneration = this.getTournamentLeaseGeneration();
    if (!lifecycle || !leaseGeneration) return false;
    const current = (): boolean =>
      this.lifecycleIsCurrent(lifecycle) &&
      this.eliminationMutationAllowed() &&
      this.getTournamentLeaseGeneration() === leaseGeneration &&
      this.tableEngines.get(tableId) === engine &&
      this.gameServer.ownsTournamentTableEngine(tableId, engine);
    if (
      !current() ||
      engine.getF06RetainedPermit() ||
      !this.gameServer.tournamentRetirementCustody.admissionAllowed(tableId)
    )
      return false;
    const rpc = this.tableBreakRpc();
    let withdrawn = false;
    try {
      withdrawn = await this.gameServer.tournamentRetirementCustody.withAdmission(
        tableId,
        current,
        async (assertCurrent) => {
          // The door admits only the park's custodian. A park made by an
          // earlier generation (an engine release since) names that dead
          // generation, so the live one claims it first - the same claim
          // retirement makes - or the door refuses every time (it had never
          // fired in production before 2026-10-03).
          let park = state;
          if (park.custody_generation !== leaseGeneration) {
            const claimed = await rpc.claimCustody(state.break_id, randomUUID(), state.revision);
            assertCurrent();
            this.rememberTournamentBreak(claimed);
            if (
              !claimed.ok ||
              claimed.state !== 'park_requested' ||
              claimed.members.length !== 0 ||
              claimed.custody_generation !== leaseGeneration
            )
              return false;
            park = claimed;
          }
          // The database decides first, while the dealer is still parked on
          // this break: a refusal writes nothing and leaves the park exactly
          // as it was. Only a withdrawn park's dealer is stopped.
          if (!(await rpc.withdrawUnplaceablePark(park))) return false;
          assertCurrent();
          try {
            await engine.stop();
          } catch (error) {
            if (!engine.hasReleasedProcessOwnership()) throw error;
          }
          assertCurrent();
          if (!engine.hasReleasedProcessOwnership() || engine.getF06RetainedPermit())
            throw new Error('F06 withdrawn park dealer not drained');
          return true;
        }
      );
    } catch (error) {
      if (error instanceof TournamentNoStartContinuationRefusedError) return false;
      throw error;
    }
    if (!withdrawn) return false;
    if (!current()) throw new Error('F06 withdrawn park owner changed');
    this.unplaceableParkSince.delete(state.break_id);
    this.breakPreparationRefusals.delete(state.break_id);
    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] Break ${state.break_id.slice(0, 8)} withdrawn: its roster has no free seats (${refusal}); table ${tableId.slice(0, 8)} deals again`
    );
    this.forgetContinuedNoStartPark(state, engine);
    await this.readmitContinuedNoStartTable(tableId, engine);
    return true;
  }

  /** Local custody only; durable discovery and completion belong to the break RPC. */
  private readonly retainedTournamentBreakSources = new Map<
    string,
    { breakId: string; engine: ServerTableEngine }
  >();

  /** Called only after a durable begin/adoption proves this break's source. */
  protected retainTournamentBreakSource(
    breakId: string,
    tableId: string,
    engine: ServerTableEngine
  ): boolean {
    if (
      !breakId ||
      !this.eliminationMutationAllowed() ||
      this.tableEngines.get(tableId) !== engine ||
      !this.gameServer.ownsTournamentTableEngine(tableId, engine)
    )
      return false;
    const prior = this.retainedTournamentBreakSources.get(tableId);
    if (prior && (prior.breakId !== breakId || prior.engine !== engine)) return false;
    this.retainedTournamentBreakSources.set(tableId, { breakId, engine });
    return true;
  }

  private retainsTournamentBreakSource(tableId: string, engine: ServerTableEngine): boolean {
    return this.retainedTournamentBreakSources.get(tableId)?.engine === engine;
  }

  /**
   * WHY THE LAST CAPTURE RETURNED NULL, or null when it returned a packet.
   *
   * Both captures below end in a dozen guards that used to answer with the
   * same bare `null`. On 2026-09-25 seventeen lease-lost managers were
   * re-offered this transfer every five seconds for hours and the log said
   * nothing, because nothing here could say which guard had refused. Every
   * guard keeps its exact condition and order; it now names itself here on
   * the way out, and GameServer reads this when the packet is missing.
   */
  lastF06CustodyRefusal(): F06CustodyRefusal | null {
    return this.f06CustodyRefusal;
  }

  private f06CustodyRefusal: F06CustodyRefusal | null = null;

  private refuseF06Custody(
    path: F06CustodyRefusal['path'],
    refused: string,
    detail?: string | null
  ): null {
    this.f06CustodyRefusal = Object.freeze(detail ? { path, refused, detail } : { path, refused });
    return null;
  }

  /** Transfer only a positively drained pre-manifest park, never an unknown move. */
  async captureDrainedF06Custody(): Promise<DrainedF06Custody | null> {
    return this.runWithTournamentSeatMoveAuthority(async () => {
      const refuse = (refused: string, detail?: string | null) =>
        this.refuseF06Custody('drained', refused, detail);
      const engines = this.captureDrainedF06Originals();
      const originGeneration = this.getTournamentLeaseGeneration();
      if (!engines) return refuse('originals_not_drained', this.drainedF06OriginalsRefusal());
      if (!originGeneration) return refuse('lease_generation_unknown');
      if (this.retainedTournamentBreakSources.size === 0)
        return refuse('no_retained_break_sources');
      const retained = [...this.retainedTournamentBreakSources];
      const durable = [...this.durableTournamentBreaks];
      const authorityRevision = this.tournamentSeatMoveAuthorityRevision;
      const sources = Object.freeze(
        retained
          .map(([table_id, value]) =>
            Object.freeze({
              break_id: value.breakId,
              table_id,
              lifecycle: this.durableTournamentBreaks.get(value.breakId)?.lifecycle ?? '',
            })
          )
          .sort((a, b) => a.table_id.localeCompare(b.table_id))
      );
      // The same conjunction it always was, clause by clause, so that a false
      // answer can say which clause. `current` is derived from it.
      const staleness = (): string | null => {
        if (this.tournamentSeatMoveAuthorityRevision !== authorityRevision)
          return 'authority_revision_changed';
        if (this.captureDrainedF06Originals() !== engines) return 'originals_changed';
        if (this.pendingTournamentSeatMoveOutcomes.size !== 0) return 'pending_seat_moves';
        if (this.pendingTournamentParkRequests.size !== 0) return 'pending_park_requests';
        if (this.pendingTournamentBreakBegins.size !== 0) return 'pending_break_begins';
        if (this.pendingTournamentBreakAmendments.size !== 0) return 'pending_break_amendments';
        if (this.rejectedTournamentBreakBegins.size !== 0) return 'rejected_break_begins';
        if (this.resolvedTournamentBreakProposals.size !== 0) return 'resolved_break_proposals';
        if (this.pendingTournamentBreakCustodyIds.size !== 0) return 'pending_break_custody_ids';
        if (this.pendingTournamentCleanupKinds.size !== 0) return 'pending_cleanup_kinds';
        if (this.pendingNoStartContinuations.size !== 0) return 'pending_no_start_continuations';
        if (this.activeStoppedOriginalCustody.size !== 0) return 'active_stopped_original_custody';
        if (this.stoppedOriginalBreaks.size !== 0) return 'stopped_original_breaks';
        if (this.tournamentBreakArrivalWakes.size !== 0) return 'break_arrival_wakes';
        if (this.pendingTableBreakRetirement !== null) return 'pending_table_break_retirement';
        if (this.retainedTournamentBreakSources.size !== retained.length)
          return 'retained_break_sources_changed';
        if (
          !retained.every(
            ([id, value]) =>
              this.retainedTournamentBreakSources.get(id) === value &&
              this.tableEngines.get(id) === value.engine
          )
        )
          return 'retained_break_source_changed';
        if (this.durableTournamentBreaks.size !== durable.length) return 'durable_breaks_changed';
        if (durable.length !== retained.length) return 'durable_and_retained_breaks_differ';
        if (
          !durable.every(
            ([id, value]) =>
              this.durableTournamentBreaks.get(id) === value &&
              value.state === 'park_requested' &&
              value.revision === '0' &&
              value.members.length === 0 &&
              value.custody_id === null &&
              value.custody_generation === null &&
              !value.terminal_handoff_required
          )
        )
          return 'durable_break_not_premanifest';
        if (!sources.every((source) => /^[1-9][0-9]*$/.test(source.lifecycle)))
          return 'source_lifecycle_unknown';
        if (
          !engines.every(
            ([id, engine]) =>
              this.gameServer.tournamentRetirementCustody.admissionAllowed(id) &&
              (!engine.hasClaimedTournamentMoveBoundary() ||
                retained.some(
                  ([sourceId, value]) =>
                    sourceId === id &&
                    value.engine === engine &&
                    engine.hasOnlyDrainedTournamentMoveOwner(this.tournamentMoveBoundaryOwner)
                ))
          )
        )
          return 'engine_admission_or_move_boundary_refused';
        return null;
      };
      const current = () => staleness() === null;
      const staleBeforeRead = staleness();
      if (staleBeforeRead !== null) return refuse('stale_before_admission_read', staleBeforeRead);
      const state = await readF06RecoveryAdmission(this.tournamentId, null, {
        originGeneration,
        sources,
        proof: null,
      });
      const staleAfterRead = staleness();
      if (staleAfterRead !== null) return refuse('stale_after_admission_read', staleAfterRead);
      this.f06CustodyRefusal = null;
      return Object.freeze({
        manager: this,
        tournamentId: this.tournamentId,
        originGeneration,
        engines,
        sources,
        current,
        proof: state.proof,
      });
    });
  }

  private mixedF06Proposal: MixedF06Proposal | null = null;

  /** A separate mixed-state transfer; the strict premanifest path stays intact. */
  async captureMixedF06Custody(successorGeneration: string): Promise<DrainedF06Custody | null> {
    return this.runWithTournamentSeatMoveAuthority(async () => {
      const refuse = (refused: string, detail?: string | null) =>
        this.refuseF06Custody('mixed', refused, detail);
      const engines = this.captureDrainedF06Originals();
      const originGeneration = this.getTournamentLeaseGeneration();
      if (!engines) return refuse('originals_not_drained', this.drainedF06OriginalsRefusal());
      if (!originGeneration) return refuse('lease_generation_unknown');
      if (originGeneration === successorGeneration) return refuse('successor_is_origin');
      if (
        !this.retainedTournamentBreakSources.size &&
        !engines.some(([, engine]) => engine.hasUnretiredStoppedTimeBankCustody())
      )
        return refuse('nothing_to_transfer');
      if (this.activeStoppedOriginalCustody.size) return refuse('active_stopped_original_custody');
      const reservations = this.gameServer.tournamentRetirementCustody.captureDrained(
        this.tournamentId,
        originGeneration,
        engines.map(([id]) => id)
      );
      if (!reservations) return refuse('retirement_reservation_refused');
      const sorted = <T>(map: Map<string, T>) => [...map].sort(([a], [b]) => a.localeCompare(b));
      const physical = () =>
        engines.map(
          ([id, engine]) =>
            engine.captureDrainedF06Identity?.(id, this.tournamentId, originGeneration) ?? null
        );
      const initial = physical();
      if (initial.some((value) => value === null)) return refuse('physical_identity_unreadable');
      // At the process root: see readMixedF06PresenceEvidence.
      const { data: presence, error: presenceError } = await readMixedF06PresenceEvidence(
        engines.map(([id]) => id)
      );
      if (
        presenceError ||
        !presence ||
        new Set(presence.map((row) => row.table_id)).size !== presence.length
      )
        throw new Error('f06_mixed_bank_evidence_unavailable');
      const presenceByTable = new Map(presence.map((row) => [row.table_id, immutableCustody(row)]));
      const vector = () => ({
        manager_id: this.getLifecycleDiagnosticSnapshot().instanceId,
        stopped_bank_owner: {
          kind: 'mtt_pre_disposal_bank_v1',
          instance_id: INSTANCE_ID,
          version: INSTANCE_VERSION,
          generation: originGeneration,
          tournament_id: this.tournamentId,
        },
        move_owner: this.tournamentMoveBoundaryOwner,
        engines: physical().map(
          (engine) =>
            engine && {
              ...engine,
              bank_custody: {
                ...engine.bank_custody,
                durable_presence: presenceByTable.get(engine.table_id) ?? null,
              },
            }
        ),
        retained: sorted(this.retainedTournamentBreakSources).map(([table_id, value]) => ({
          table_id,
          break_id: value.breakId,
          engine_id:
            value.engine.captureDrainedF06Identity?.(table_id, this.tournamentId, originGeneration)
              ?.engine_id ?? null,
        })),
        durable: sorted(this.durableTournamentBreaks),
        pending_moves: sorted(this.pendingTournamentSeatMoveOutcomes),
        parks: sorted(this.pendingTournamentParkRequests),
        begins: sorted(this.pendingTournamentBreakBegins),
        amendments: sorted(this.pendingTournamentBreakAmendments),
        rejected_begins: sorted(this.rejectedTournamentBreakBegins),
        resolved_proposals: sorted(this.resolvedTournamentBreakProposals),
        custody_ids: sorted(this.pendingTournamentBreakCustodyIds),
        cleanup_kinds: sorted(this.pendingTournamentCleanupKinds),
        no_start: sorted(this.pendingNoStartContinuations).map(([id, value]) => [
          id,
          {
            state: value.state,
            binding: value.binding,
            table_id: value.binding.tableId,
            engine_id:
              value.engine.captureDrainedF06Identity?.(
                value.binding.tableId,
                this.tournamentId,
                originGeneration
              )?.engine_id ?? null,
          },
        ]),
        stopped_originals: sorted(this.stoppedOriginalBreaks).map(([id, engine]) => [
          id,
          engines.find(([, value]) => value === engine)?.[0] ?? null,
        ]),
        arrival_wakes: sorted(this.tournamentBreakArrivalWakes).map(([id, map]) => [
          id,
          sorted(map).map(([table, engine]) => [
            table,
            engines.find(([, value]) => value === engine)?.[0] ?? null,
          ]),
        ]),
        retirement: this.pendingTableBreakRetirement
          ? {
              table_id: this.pendingTableBreakRetirement.tableId,
              moved_players: this.pendingTableBreakRetirement.movedPlayers,
              engine_id:
                this.pendingTableBreakRetirement.engine.captureDrainedF06Identity?.(
                  this.pendingTableBreakRetirement.tableId,
                  this.tournamentId,
                  originGeneration
                )?.engine_id ?? null,
            }
          : null,
        reservations: reservations.reservations,
      });
      const local = immutableCustody(vector());
      if (local.retained.some((entry) => !entry.engine_id))
        return refuse('local_vector_incomplete', 'retained_engine_id');
      if (local.no_start.some((entry) => !(entry[1] as { engine_id: string | null }).engine_id))
        return refuse('local_vector_incomplete', 'no_start_engine_id');
      if (local.stopped_originals.some(([, table]) => !table))
        return refuse('local_vector_incomplete', 'stopped_original_table');
      if (
        local.arrival_wakes.some(([, entries]) =>
          (entries as (string | null)[][]).some(([, table]) => !table)
        )
      )
        return refuse('local_vector_incomplete', 'arrival_wake_table');
      if (local.retirement && !local.retirement.engine_id)
        return refuse('local_vector_incomplete', 'retirement_engine_id');
      const revision = this.tournamentSeatMoveAuthorityRevision;
      // The same conjunction it always was, clause by clause, so that a false
      // answer can say which clause. `current` is derived from it.
      const staleness = (): string | null => {
        if (this.tournamentSeatMoveAuthorityRevision !== revision)
          return 'authority_revision_changed';
        if (this.captureDrainedF06Originals() !== engines) return 'originals_changed';
        if (!reservations.current()) return 'retirement_reservation_changed';
        if (!this.gameServer.hasCompleteMixedF06PhysicalMap(this.tournamentId, this, engines))
          return 'physical_map_incomplete';
        if (this.activeStoppedOriginalCustody.size !== 0) return 'active_stopped_original_custody';
        if (
          !engines.every(
            ([id, engine]) =>
              this.gameServer.ownsTournamentTableEngine(id, engine) ||
              this.gameServer.hasMixedF06CustodyOriginal(this.tournamentId, this, id, engine)
          )
        )
          return 'original_not_owned';
        if (!physical().every((value) => value !== null)) return 'physical_identity_unreadable';
        if (custodyJSON(vector()) !== custodyJSON(local)) return 'local_vector_changed';
        if (
          ![...this.retainedTournamentBreakSources].every(([id, value]) =>
            engines.some(([key, engine]) => key === id && engine === value.engine)
          )
        )
          return 'retained_break_source_not_original';
        if (
          !engines.every(
            ([, engine]) =>
              !engine.hasClaimedTournamentMoveBoundary() ||
              engine.hasOnlyDrainedTournamentMoveOwner(this.tournamentMoveBoundaryOwner)
          )
        )
          return 'move_boundary_not_drained';
        return null;
      };
      const current = () => staleness() === null;
      const staleBeforePrepare = staleness();
      if (staleBeforePrepare !== null) return refuse('stale_before_prepare', staleBeforePrepare);
      if (!this.mixedF06Proposal)
        this.mixedF06Proposal = {
          transferId: randomUUID(),
          successorGeneration,
          local,
          canonical: null,
        };
      if (
        this.mixedF06Proposal.successorGeneration !== successorGeneration ||
        custodyJSON(this.mixedF06Proposal.local) !== custodyJSON(local)
      )
        throw new Error('f06_mixed_original_transfer_changed');
      const mixed = await prepareMixedF06Transfer(
        this.tournamentId,
        originGeneration,
        this.mixedF06Proposal,
        current
      );
      const staleAfterPrepare = staleness();
      if (staleAfterPrepare !== null) return refuse('stale_after_prepare', staleAfterPrepare);
      this.f06CustodyRefusal = null;
      return Object.freeze({
        manager: this,
        tournamentId: this.tournamentId,
        originGeneration,
        engines,
        sources: Object.freeze([]),
        current,
        proof: mixed.canonical,
        mixed,
      });
    });
  }

  /** One manager generation has exactly one seat-move authority at a time. */
  private tournamentSeatMoveSerialTail: Promise<void> = Promise.resolve();
  private tournamentSeatMoveAuthorityRevision = 0;
  /** One break per pass; retain its exact generation across ambiguous closes. */
  private pendingTableBreakRetirement: {
    tableId: string;
    engine: ServerTableEngine;
    movedPlayers: number;
  } | null = null;

  private runWithTournamentSeatMoveAuthority<T>(operation: () => Promise<T>): Promise<T> {
    this.tournamentSeatMoveAuthorityRevision++;
    const result = this.tournamentSeatMoveSerialTail.then(operation);
    this.tournamentSeatMoveSerialTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  /**
   * Read a complete balancer picture in bounded ID-list chunks. The former
   * implementation issued two sequential requests per table, twice per pass;
   * a four-slot scheduler therefore still let four 1,000-table tournaments
   * hold every physical slot for minutes. This is O(chunks), fail closed, and
   * never releases a live scheduler promise while work remains.
   */
  private async loadBalancerTables(
    tableIds: string[],
    label: string,
    recoveringBreakId?: string
  ): Promise<BalancerTable[] | null> {
    if (!this.eliminationMutationAllowed()) return null;
    const excluded = new Set<string>();
    for (const pending of this.durableTournamentBreaks.values()) {
      excluded.add(pending.source_table_id);
      if (pending.break_id !== recoveringBreakId) {
        for (const member of pending.members) {
          if (!member.winner_request_id) excluded.add(member.destination_table_id);
        }
      }
    }
    tableIds = tableIds.filter((id) => !excluded.has(id));
    const tableRead = await selectInChunks<{
      id: string;
      max_players: number | null;
    }>(
      tableIds,
      (batch) => supabase.from('tables').select('id, max_players').in('id', batch),
      `Tournament.${label}.tables(${this.tournamentId.slice(0, 8)})`
    );
    if (!this.eliminationMutationAllowed()) return null;
    if (!tableRead.complete) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return null;
    }
    const seatRead = await selectInChunks<{
      table_id: string;
      user_id: string;
      stack: number | null;
      seat_number: number | null;
    }>(
      tableIds,
      (batch) =>
        supabase
          .from('table_seats')
          .select('table_id, user_id, stack, seat_number')
          .in('table_id', batch)
          .is('left_at', null),
      `Tournament.${label}.seats(${this.tournamentId.slice(0, 8)})`
    );
    if (!this.eliminationMutationAllowed()) return null;
    if (!seatRead.complete) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return null;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  THE PLANNER MUST SEE THE CHAIRS THE ROSTER STILL HOLDS (2026-09-12)
    // ════════════════════════════════════════════════════════════════════════
    //
    // `fn_move_tournament_player` refuses a destination chair whose
    // `tournament_players` row is still `registered`/`playing` there, even
    // when no live `table_seats` row occupies it — an unrecorded bust keeps
    // its roster chair until the elimination sweep records it. Planning off
    // the live seats alone therefore proposes chairs the database will not
    // accept: measured on event 05e104c7, 294 of 378 planned chairs came back
    // `tournament move destination roster is occupied` and only 42 of 378
    // were genuinely free.
    //
    // One more chunked read per pass, on the same ID-list bound as the two
    // above — never one query per table.
    const rosterRead = await selectInChunks<{
      table_id: string | null;
      seat_number: number | null;
    }>(
      tableIds,
      (batch) =>
        supabase
          .from('tournament_players')
          .select('table_id, seat_number')
          .eq('tournament_id', this.tournamentId)
          .in('status', ['registered', 'playing'])
          .in('table_id', batch),
      `Tournament.${label}.roster(${this.tournamentId.slice(0, 8)})`
    );
    if (!this.eliminationMutationAllowed()) return null;
    if (!rosterRead.complete) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return null;
    }

    const tableById = new Map(tableRead.rows.map((row) => [row.id, row]));
    if (tableById.size !== new Set(tableIds).size) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] ${label} table snapshot was incomplete`
        ),
        'Tournament.balance_table_snapshot_incomplete'
      );
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return null;
    }
    const seatsByTable = new Map<string, typeof seatRead.rows>();
    for (const seat of seatRead.rows) {
      const seats = seatsByTable.get(seat.table_id) ?? [];
      seats.push(seat);
      seatsByTable.set(seat.table_id, seats);
    }
    const rosterChairsByTable = new Map<string, Set<number>>();
    for (const row of rosterRead.rows) {
      if (!row.table_id || !row.seat_number) continue;
      const chairs = rosterChairsByTable.get(row.table_id) ?? new Set<number>();
      chairs.add(row.seat_number);
      rosterChairsByTable.set(row.table_id, chairs);
    }
    return tableIds.map((tableId) => {
      const seats = seatsByTable.get(tableId) ?? [];
      const liveSeats = new Set(seats.map((seat) => seat.seat_number || 0));
      return {
        tableId,
        playerCount: seats.length,
        maxSeats: tableById.get(tableId)?.max_players || 9,
        buttonSeat: this.tableEngines.get(tableId)?.getCurrentButtonSeat() ?? 0,
        // Roster chairs with no live seat row. The move door refuses them, so
        // they are not free chairs to the planner either.
        reservedSeats: [...(rosterChairsByTable.get(tableId) ?? [])].filter(
          (chair) => !liveSeats.has(chair)
        ),
        players: seats.map((seat) => ({
          userId: seat.user_id,
          stack: seat.stack || 0,
          seat: seat.seat_number || 0,
        })),
      };
    });
  }

  /**
   * Complete one table-break retirement without losing the object that owns
   * the unfinished work.  The database RPC serializes a close against live
   * seat acquisition and returns the exact durable row.  Only after that
   * receipt exists do we remove the same engine generation from GameServer,
   * this manager, the hub, and hand-for-hand.
   *
   * Any refusal leaves both registries pointing at the stopped/quarantined
   * engine. Retained legacy close work is retried before new break discovery;
   * new whole-break requests use the durable original membership above.
   */
  protected async closeBrokenTableAndReleaseEngine(
    tableId: string,
    engine: ServerTableEngine,
    movedPlayers = 0
  ): Promise<boolean> {
    if (!this.eliminationMutationAllowed() || this.tableEngines.get(tableId) !== engine) {
      return false;
    }
    const pending = this.pendingTableBreakRetirement;
    if (pending && (pending.tableId !== tableId || pending.engine !== engine)) return false;
    this.pendingTableBreakRetirement ??= { tableId, engine, movedPlayers };
    // Arm before awaiting stop/RPC: a thrown transport error or an expired
    // sweep budget must retain both the operation and its coalesced wake.
    this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);

    try {
      await engine.stop();
    } catch (error) {
      if (!engine.hasReleasedProcessOwnership()) {
        reportError(error, 'Tournament.broken_table_engine_stop_failed', {
          tournamentId: this.tournamentId,
          tableId,
        });
        return false;
      }
      // Ownership is already gone; a trailing cleanup diagnostic must not
      // strand an empty table forever.
      reportError(error, 'Tournament.broken_table_engine_stop_cleanup_failed', {
        tournamentId: this.tournamentId,
        tableId,
      });
    }
    if (!this.eliminationMutationAllowed() || this.tableEngines.get(tableId) !== engine) {
      return false;
    }

    const leaseGeneration = this.getTournamentLeaseGeneration();
    if (!leaseGeneration) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] cannot close broken table ${tableId.slice(0, 8)} without exact protocol-2 authority`
        ),
        'Tournament.broken_table_close_unverified'
      );
      return false;
    }

    const { data, error } = await supabase.rpc('fn_close_empty_tournament_table', {
      p_tournament_id: this.tournamentId,
      p_table_id: tableId,
      p_lease_generation: leaseGeneration,
    });
    if (!this.eliminationMutationAllowed() || this.tableEngines.get(tableId) !== engine) {
      return false;
    }
    const receipt = data as TournamentTableCloseResult | null;
    const closed =
      !error &&
      receipt?.ok === true &&
      receipt.table_id === tableId &&
      receipt.tournament_id === this.tournamentId &&
      String(receipt.status).toLowerCase() === 'closed' &&
      Number(receipt.current_players) === 0;
    if (!closed) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] broken table ${tableId.slice(0, 8)} close was not durably proven (${error?.message ?? receipt?.reason ?? 'malformed receipt'})`
        ),
        'Tournament.broken_table_close_unproven'
      );
      return false;
    }

    if (!this.gameServer.unregisterTableEngine(tableId, engine)) {
      const ownershipError = new Error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] broken table ${tableId.slice(0, 8)} changed global engine generation before retirement CAS`
      );
      reportError(ownershipError, 'Tournament.broken_table_unregister_lost_ownership');
      // An independent generation owns the process slot.  Fence this manager
      // synchronously; stop() is intentionally detached because this method is
      // itself running inside the scheduler that stop() must drain.
      void this.stop().catch((stopError) =>
        reportError(stopError, 'Tournament.broken_table_ownership_loss_cleanup_failed', {
          tableId,
        })
      );
      return false;
    }

    if (this.tableEngines.get(tableId) === engine) this.tableEngines.delete(tableId);
    this.retireManagedTableFromHandForHand(tableId);
    this.pendingTableBreakRetirement = null;
    return true;
  }

  /**
   * Own the exact source-table generation before a seat can be vacated.
   *
   * A live source requires its retained, physically parked original engine.
   * Empty local registries do not prove original hand disposition. Only the
   * existing closed_orphan mode permits an engineless mutation boundary.
   */
  private async claimTournamentMoveBoundary(
    move: MoveInstruction,
    sourceMode: TournamentSeatMoveSourceMode
  ): Promise<ClaimedTournamentMoveBoundary | null> {
    if (sourceMode === 'live_source' && this.receiptOwnsSource(move.fromTableId))
      return { sourceMode, engine: null, mixedTransferId: this.mixedRecovery!.transfer.transferId };
    const managerEngine = this.tableEngines.get(move.fromTableId);
    const serverEngine = this.gameServer.getTableEngine(move.fromTableId);

    if (sourceMode === 'closed_orphan') {
      if (managerEngine || serverEngine) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] closed-orphan move ${move.playerId.slice(0, 8)} found a live source engine generation`
          ),
          'Tournament.closed_orphan_move_has_live_engine',
          { sourceTableId: move.fromTableId }
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
        return null;
      }
      return { sourceMode, engine: null };
    }

    if (
      !managerEngine ||
      serverEngine !== managerEngine ||
      !this.gameServer.ownsTournamentTableEngine(move.fromTableId, managerEngine)
    ) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] live-source move ${move.playerId.slice(0, 8)} does not own one identical source engine generation`
        ),
        'Tournament.atomic_move_source_generation_unproven',
        { sourceTableId: move.fromTableId }
      );
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return null;
    }

    const parked = await managerEngine.parkForTournamentMove(
      this.tournamentMoveBoundaryOwner,
      TournamentManager.MOVE_BOUNDARY_PROBE_MS
    );
    if (!this.eliminationMutationAllowed()) {
      if (!this.retainsTournamentBreakSource(move.fromTableId, managerEngine))
        managerEngine.releaseTournamentMovePause(this.tournamentMoveBoundaryOwner);
      return null;
    }
    if (!parked) {
      // The pause owner remains armed. A long current hand lands normally;
      // the next causal sweep claims the physical gate without polling it.
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return null;
    }
    if (
      this.tableEngines.get(move.fromTableId) !== managerEngine ||
      !this.gameServer.ownsTournamentTableEngine(move.fromTableId, managerEngine)
    ) {
      if (!this.retainsTournamentBreakSource(move.fromTableId, managerEngine))
        managerEngine.releaseTournamentMovePause(this.tournamentMoveBoundaryOwner);
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return null;
    }
    return { sourceMode, engine: managerEngine };
  }

  /** Invoke the RPC only while the exact source generation remains fenced. */
  private requestTournamentSeatMoveAtBoundary(
    input: TournamentSeatMoveInput,
    boundary: ClaimedTournamentMoveBoundary,
    outcomeWasAlreadyUnknown = false
  ): Promise<VerifiedTournamentSeatMoveReceipt> {
    if (boundary.mixedTransferId) {
      const owned = this.mixedRecovery;
      if (
        !owned ||
        owned.transfer.transferId !== boundary.mixedTransferId ||
        input.sourceMode !== 'live_source' ||
        !this.receiptOwnsSource(input.sourceTableId)
      )
        return Promise.reject(new Error('f06_mixed_move_boundary_changed'));
      owned.assertCurrent();
      return moveTournamentPlayerAtomically(input, { outcomeWasAlreadyUnknown }).then((receipt) => {
        owned.assertCurrent();
        return receipt;
      });
    }
    if (!boundary.engine) {
      if (
        input.sourceMode !== 'closed_orphan' ||
        boundary.sourceMode !== 'closed_orphan' ||
        this.tableEngines.has(input.sourceTableId) ||
        this.gameServer.getTableEngine(input.sourceTableId)
      ) {
        return Promise.reject(new Error('closed-orphan source boundary is no longer exact'));
      }
      return moveTournamentPlayerAtomically(input, {
        outcomeWasAlreadyUnknown,
      });
    }
    if (
      input.sourceMode !== 'live_source' ||
      boundary.sourceMode !== 'live_source' ||
      this.tableEngines.get(input.sourceTableId) !== boundary.engine ||
      !this.gameServer.ownsTournamentTableEngine(input.sourceTableId, boundary.engine)
    ) {
      return Promise.reject(new Error('live-source engine generation changed before move RPC'));
    }
    return boundary.engine.executeTournamentMoveAtBoundary(this.tournamentMoveBoundaryOwner, () =>
      moveTournamentPlayerAtomically(input, { outcomeWasAlreadyUnknown })
    );
  }

  /**
   * Complete an ambiguous operation by replaying its immutable UUID. Nothing
   * else in this tournament may be planned from possibly stale seats first.
   */
  protected redrivePendingTournamentSeatMoveOutcomes(): Promise<boolean> {
    return this.runWithTournamentSeatMoveAuthority(() =>
      this.redrivePendingTournamentSeatMoveOutcomesOwned()
    );
  }

  private async redrivePendingTournamentSeatMoveOutcomesOwned(): Promise<boolean> {
    for (const pending of this.pendingTournamentSeatMoveOutcomes.values()) {
      if (
        [...this.stoppedOriginalBreaks.values()].some(
          (engine) => this.tableEngines.get(pending.input.sourceTableId) === engine
        ) &&
        !this.activeStoppedOriginalCustody.has(pending.input.sourceTableId)
      )
        return false;
    }
    for (const [requestId, pending] of this.pendingTournamentSeatMoveOutcomes) {
      if (!this.eliminationMutationAllowed()) return false;
      if (
        pending.input.sourceMode === 'live_source' &&
        !this.receiptOwnsSource(pending.input.sourceTableId) &&
        !this.tableEngines.has(pending.input.sourceTableId) &&
        !this.gameServer.getTableEngine(pending.input.sourceTableId)
      ) {
        // Unknown UUIDs authorize only a receipt read when the original engine
        // is absent. A missing receipt is not proof of no commit or no start.
        try {
          const receipt = await resolveCommittedTournamentSeatMove(pending.input);
          if (
            !this.eliminationMutationAllowed() ||
            this.pendingTournamentSeatMoveOutcomes.get(requestId) !== pending
          )
            return false;
          if (!receipt) {
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
            return false;
          }
          this.pendingTournamentSeatMoveOutcomes.delete(requestId);
          continue;
        } catch (error) {
          reportError(error, 'Tournament.atomic_move_receipt_only_unresolved', {
            tournamentId: this.tournamentId,
            requestId,
            sourceTableId: pending.input.sourceTableId,
          });
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          return false;
        }
      }
      const boundary = await this.claimTournamentMoveBoundary(
        pending.move,
        pending.input.sourceMode
      );
      if (!boundary) return false;

      let releaseBoundary = true;
      try {
        const receipt = await this.requestTournamentSeatMoveAtBoundary(
          pending.input,
          boundary,
          true
        );
        this.pendingTournamentSeatMoveOutcomes.delete(requestId);
        this.tableEngines.get(pending.move.toTableId)?.wakeWaitingForPlayers();
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Atomic move ${receipt.requestId.slice(0, 8)} replay certified for ${pending.move.playerId.slice(0, 8)}`
        );
      } catch (moveErr) {
        releaseBoundary = false;
        if (moveErr instanceof TournamentSeatMoveOutcomeUnknownError) {
          reportError(moveErr, 'Tournament.atomic_move_outcome_still_unknown', {
            tournamentId: this.tournamentId,
            requestId,
            sourceTableId: pending.move.fromTableId,
          });
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          return false;
        }
        // A refusal on a later invocation cannot prove that the earlier request
        // did not commit: authentication and other preconditions run before the
        // receipt lookup. Only the verified receipt path above may delete an
        // already-ambiguous UUID. Local boundary failures follow the same rule.
        reportError(moveErr, 'Tournament.atomic_move_replay_boundary_unavailable', {
          tournamentId: this.tournamentId,
          requestId,
          sourceTableId: pending.move.fromTableId,
        });
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
        return false;
      } finally {
        if (
          releaseBoundary &&
          boundary.engine &&
          !this.retainsTournamentBreakSource(pending.move.fromTableId, boundary.engine)
        ) {
          boundary.engine.releaseTournamentMovePause(this.tournamentMoveBoundaryOwner);
        }
      }
    }
    return this.pendingTournamentSeatMoveOutcomes.size === 0;
  }

  /**
   * Resolve retained UUIDs after the exact source engine has stopped and joined
   * every writer. Runtime recovery passes one source; manager shutdown passes
   * null to certify the complete pending set before releasing either registry.
   */
  protected resolveTournamentSeatMoveQuarantine(
    tableId: string | null,
    engine: ServerTableEngine | null
  ): Promise<boolean> {
    return this.runWithTournamentSeatMoveAuthority(async () => {
      const path = tableId === null && !engine ? 'shutdown' : 'recovery';
      this.noteSeatMoveQuarantineRefusal(`${path}:f06_permit_retained`);
      if (
        engine?.getF06RetainedPermit?.() ||
        (engine && [...this.stoppedOriginalBreaks.values()].includes(engine))
      ) {
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
        return false;
      }
      const pending = [...this.pendingTournamentSeatMoveOutcomes.entries()].filter(
        ([, item]) => tableId === null || item.input.sourceTableId === tableId
      );

      for (const [requestId, item] of pending) {
        let boundary: ClaimedTournamentMoveBoundary;
        if (item.input.sourceMode === 'closed_orphan') {
          this.noteSeatMoveQuarantineRefusal(`${path}:closed_orphan_source_has_live_engine`);
          if (
            this.tableEngines.has(item.input.sourceTableId) ||
            this.gameServer.getTableEngine(item.input.sourceTableId)
          ) {
            return false;
          }
          boundary = { sourceMode: 'closed_orphan', engine: null };
        } else {
          const sourceEngine = engine ?? this.tableEngines.get(item.input.sourceTableId) ?? null;
          this.noteSeatMoveQuarantineRefusal(`${path}:live_source_boundary_unavailable`);
          if (
            !sourceEngine ||
            (tableId !== null && item.input.sourceTableId !== tableId) ||
            this.tableEngines.get(item.input.sourceTableId) !== sourceEngine ||
            !this.gameServer.ownsTournamentTableEngine(item.input.sourceTableId, sourceEngine) ||
            !sourceEngine.hasReleasedProcessOwnership() ||
            !(await sourceEngine.parkForTournamentMove(this.tournamentMoveBoundaryOwner, 0))
          ) {
            return false;
          }
          boundary = { sourceMode: 'live_source', engine: sourceEngine };
        }

        try {
          const receipt = await this.requestTournamentSeatMoveAtBoundary(
            item.input,
            boundary,
            true
          );
          this.pendingTournamentSeatMoveOutcomes.delete(requestId);
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Quarantined move ${receipt.requestId.slice(0, 8)} replay certified before engine release`
          );
        } catch (error) {
          this.noteSeatMoveQuarantineRefusal(`${path}:replay_unresolved`);
          reportError(error, 'Tournament.atomic_move_quarantine_unresolved', {
            tournamentId: this.tournamentId,
            requestId,
            sourceTableId: item.input.sourceTableId,
          });
          return false;
        }
      }

      if (tableId !== null && engine) {
        const stillPending = [...this.pendingTournamentSeatMoveOutcomes.values()].some(
          (item) => item.input.sourceTableId === tableId
        );
        this.noteSeatMoveQuarantineRefusal(
          stillPending ? 'recovery:source_seat_move_pending' : 'recovery:break_source_retained'
        );
        if (stillPending) return false;
        /*
         * A KILLED BREAK SOURCE WHOSE PARK WAS NEVER CLAIMED IS REBUILT
         * (2026-09-26).
         *
         * The retention exists to keep this exact generation as the source a
         * break decided its moves against. That decision is made only across
         * a CLAIMED boundary: the park is claimed before the manifest is
         * begun and before any member moves, and a claimed owner survives
         * teardown so the stopped engine can still serve as the quarantined
         * source. A claimed boundary therefore still refuses here.
         *
         * A break whose one-second park probe missed has retained the source
         * but claimed nothing, and a killed engine drops that unclaimed owner
         * (`clearUnclaimedTournamentMovePauses`). Refusing replacement then
         * waited for a break that could never move: on a stopped engine
         * `parkForTournamentMove` answers yes only for an already-claimed
         * park, so `prepareParkedTournamentBreak` returned null for ever, and
         * this certificate rescheduled recovery for ever. On 2026-09-26
         * 04:22-04:43 UTC that held ten dead tables in four events (55 players
         * seated) with their break rows at `park_requested`, revision 0,
         * custody null - 22 of 30 stalled-table observations.
         *
         * Such a retention protects nothing a replacement could cross: no
         * move was decided, none is in flight, and the database refuses every
         * hand on the table while the row exists (`source_excluded`). So it
         * is released here and recovery replaces the engine. The replacement
         * meets `source_excluded` at admission and starts movement-only
         * (`startParkedMovementEngine`, `fn_f06_admit_parked_movement`, which
         * claims a null custody), and the break retains and parks THAT
         * engine on its next pass.
         */
        if (this.retainsTournamentBreakSource(tableId, engine)) {
          if (engine.hasClaimedTournamentMoveBoundary()) return false;
          this.retainedTournamentBreakSources.delete(tableId);
        }
        engine.releaseTournamentMovePause(this.tournamentMoveBoundaryOwner);
        this.noteSeatMoveQuarantineRefusal('recovery:claimed_move_boundary');
        if (engine.hasClaimedTournamentMoveBoundary()) return false;
        this.noteSeatMoveQuarantineRefusal(null);
        return true;
      }

      this.noteSeatMoveQuarantineRefusal('shutdown:unresolved_seat_move_uuid');
      if (this.pendingTournamentSeatMoveOutcomes.size > 0) return false;
      /*
       * A RETAINED BREAK SOURCE IS NOT A SEAT MOVE (2026-09-25).
       *
       * #4799 added `if (this.retainedTournamentBreakSources.size > 0) return
       * false;` here, beside the pending-UUID guard. In the RECOVERY branch
       * above, its sibling is right and stays: that branch is asked whether one
       * named engine may be released while the manager lives, and a manager
       * that still fences that engine for a break must say no.
       *
       * This branch is a different question. It is asked once, during the
       * manager's own teardown, about the whole generation - and nothing on
       * that path can ever clear this map. `retainedTournamentBreakSources` is
       * cleared only by a durable break reaching `acknowledged`
       * (retireTournamentBreak / finishAcknowledgedTournamentBreak) or by
       * `forgetContinuedNoStartPark`, and none of those run while a fenced
       * manager is being stopped. So a manager that was fencing one break
       * source when its lease was lost could never stop again, for the life of
       * the process: on release 778075b4, thirteen tournaments, 5,678 refusals
       * in twenty-five minutes, 20 quarantined managers and a restart gate that
       * could not open. That is the shape the maintenance-break bound was
       * written against - "a fail-closed gate with no bound... trades 'breaks
       * get dismantled' for 'a stuck table never recovers', and the second is
       * the worse bug".
       *
       * Nothing is discarded by letting it go. The retention is LOCAL custody
       * of a source engine, as its own declaration says ("Local custody only;
       * durable discovery and completion belong to the break RPC"). The break
       * row, its members and their immutable `active_request_id`s are durable;
       * a successor re-discovers the break and re-dispatches the SAME request
       * identities. The one obligation that lives only in this process - an
       * ambiguous move UUID - is fenced by the guard above and is replayed to a
       * receipt before it is ever forgotten. No move is discarded on any path.
       *
       * What is kept is the part that was actually unsafe: a retained source
       * whose engine is still in this manager's registry and has NOT released
       * process ownership is a dealer this teardown has not joined, so it still
       * refuses - by name.
       */
      this.noteSeatMoveQuarantineRefusal('shutdown:break_source_owns_running_engine');
      for (const [sourceTableId, retained] of this.retainedTournamentBreakSources) {
        const live = this.tableEngines.get(sourceTableId);
        if (live === retained.engine && !live.hasReleasedProcessOwnership()) return false;
      }
      this.noteSeatMoveQuarantineRefusal('shutdown:claimed_move_boundary');
      for (const sourceEngine of this.tableEngines.values()) {
        sourceEngine.releaseTournamentMovePause(this.tournamentMoveBoundaryOwner);
        if (sourceEngine.hasClaimedTournamentMoveBoundary()) return false;
      }
      this.noteSeatMoveQuarantineRefusal(null);
      return true;
    });
  }

  /** Same short-table bound as TableBalancer.shouldBreakTable. */
  private static readonly SHORT_BREAK_SOURCE_PLAYERS = 3;

  /**
   * Players still seated on sources whose park has not begun. Their break
   * will place them on the tables the balancer sees, so a new plan must leave
   * that many seats free. Unknown is null, never zero.
   */
  private async unbegunBreakDemand(): Promise<number | null> {
    const sources = [...this.durableTournamentBreaks.values()]
      .filter((state) => state.state === 'park_requested' && state.members.length === 0)
      .map((state) => state.source_table_id);
    if (sources.length === 0) return 0;
    const { data, error } = await supabase
      .from('table_seats')
      .select('table_id')
      .in('table_id', sources)
      .is('left_at', null);
    if (error || !data) return null;
    return data.length;
  }

  protected async checkTableBalance(): Promise<TournamentBalanceProgress | void> {
    if (!this.eliminationMutationAllowed()) return;
    try {
      await this.recoverF06OriginalAdmissions();
    } catch (error) {
      reportError(error, 'Tournament.original_admission_recovery_pending', {
        tournamentId: this.tournamentId,
      });
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
    }
    const pendingRetirement = this.pendingTableBreakRetirement;
    if (pendingRetirement) {
      if (!(await this.redrivePendingTournamentSeatMoveOutcomes())) return;
      // Finish the exact prior break even with zero/one occupied tables, or
      // with a now-closed source absent from the database's live-table list.
      // One attempt per scheduler pass; no new move plan while it is unknown.
      this.breakOccurredThisCycle = true;
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      const { tableId, engine, movedPlayers } = pendingRetirement;
      const retired = await this.closeBrokenTableAndReleaseEngine(tableId, engine, movedPlayers);
      if (retired && this.eliminationMutationAllowed()) {
        await this.broadcast('table_rebalance', {
          closedTableId: tableId,
          movedPlayers,
          reason: 'table_break',
        });
        return { kind: 'table-retired', tableId };
      }
      return;
    }
    if (!(await this.visitTournamentBreakPage((state) => this.recoverTournamentBreak(state))))
      return;
    if (!(await this.redrivePendingTournamentSeatMoveOutcomes())) return;
    if (!this.tournamentBreakDiscoveryComplete) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return;
    }
    // Check for final table (table_size or fewer players remaining, 2026-08-22
    // parity: was hardcoded 9) — only announce once
    if (!this.isFinalTable && this.durableTournamentBreaks.size === 0) {
      const { count: remainingPlayers, error: remainingPlayersErr } = await supabase
        .from('tournament_players')
        .select('*', { count: 'exact', head: true })
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'playing');
      if (!this.eliminationMutationAllowed()) return;

      const finalTableSize = Math.min(
        10,
        Math.max(2, Number(this.tournamentCache?.table_size) || 9)
      );
      /**
       * ═══════════════════════════════════════════════════════════════════
       *  A HEADCOUNT IS NOT A FINAL TABLE (2026-08-27, P0)
       * ═══════════════════════════════════════════════════════════════════
       *
       * This was `remaining <= finalTableSize` and nothing else, so nine
       * players sitting three-three-three across three felts were declared a
       * final table: everyone got the overlay, the deal poll (which shared
       * the same shape) opened voting, and `fn_settle_final_table_deal_atomic` would chop
       * the pool between nine players who were never at the same table.
       *
       * The count stays as the CHEAP first test — it is what keeps this off
       * the table-count query for the whole life of a big field — but the
       * declaration now also requires exactly ONE live table still holding
       * players. Consolidating the field is the balancer's job and happens
       * further down this same method; this is only the gate, so a field that
       * is short enough but not yet merged waits one cycle for the balancer
       * and is declared on the next.
       *
       * `countLiveTablesWithPlayers()` returns null for UNKNOWN, which is
       * treated as "not yet".
       */
      if (remainingPlayersErr || remainingPlayers === null) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] final-table headcount unreadable (${remainingPlayersErr?.message ?? 'null count'}) - final-table state left unchanged`
          ),
          'Tournament.final_table_count_unavailable'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      } else if (remainingPlayers <= finalTableSize) {
        const liveTables = await this.countLiveTablesWithPlayers();
        if (!this.eliminationMutationAllowed()) return;
        if (liveTables === 1) {
          this.isFinalTable = true;
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] FINAL TABLE reached with ${remainingPlayers} players on one table`
          );
          /**
           * ═══════════════════════════════════════════════════════════════
           *  A ONE-SHOT BROADCAST IS NOT A STATE (Dan 2026-08-28, bug 7)
           * ═══════════════════════════════════════════════════════════════
           *
           * Reported: "you can not see the final table background either."
           *
           * `this.isFinalTable` is an in-memory flag on this process and the
           * announcement below is sent ONCE. Anyone not listening at that
           * instant never learns the tournament reached its final table:
           * a player who reconnects (which is exactly what happened — see
           * bug 1), a second device, a spectator arriving later, or every
           * client at once if the engine restarts.
           *
           * The client had a fallback, and it was a REGEX ON THE TABLE NAME:
           *   /\bfinal table\b/i.test(table.name)
           * on the stated grounds that "TournamentService canonically names
           * the consolidated table 'Final Table'". Production disagrees —
           * 4f42d847's final table is named "Union PKO Afternoon (PLO4) -
           * Table 2" — so the fallback matched nothing and the background
           * never loaded.
           *
           * `tournaments.final_table_triggered` has existed as a column the
           * whole time and NOTHING EVER WROTE IT: 0 of 1,286 completed MTTs
           * in thirty days had it set. Writing it makes the state durable and
           * lets any client, at any time, ask the tournament rather than
           * guess from a name.
           *
           * A failed write is logged and nothing else: the broadcast below
           * still goes out, so the live table is unaffected, and the next
           * sweep re-enters this branch only if the process restarts —
           * `.eq('final_table_triggered', false)` keeps that idempotent.
           */
          const { error: flagErr } = await supabase
            .from('tournaments')
            .update({ final_table_triggered: true })
            .eq('id', this.tournamentId)
            .eq('final_table_triggered', false);
          if (!this.eliminationMutationAllowed()) return;
          if (flagErr) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] could not persist final_table_triggered (${flagErr.message}) - the announcement still went out, but a reconnecting client will not see the final-table theme`
              ),
              'Tournament.final_table_flag_write_failed'
            );
          }
          await this.broadcast('final_table', {
            playerCount: remainingPlayers,
          });
          if (!this.eliminationMutationAllowed()) return;
        } else if (liveTables !== null && liveTables > 1) {
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] ${remainingPlayers} players left but still spread over ${liveTables} tables - NOT the final table until the balancer consolidates`
          );
        }
      }
    }

    /* A TABLE WITH ONE PLAYER NEVER GETS AN ENGINE (2026-09-10).
       This read `this.tableEngines`, which holds only tables that are DEALING.
       A table cannot deal to one player, so a table down to its last player has
       no engine, so the balancer never saw it, so nobody moved that player to
       join anybody. Thirty-five running events were frozen exactly that way -
       every live table holding one funded player and no table holding two, the
       worst of them 36 players on 36 tables. Ask the database which tables
       still hold players; loadBalancerTables already reads everything else from
       there and only wants tableEngines for a button seat, which defaults. */
    const liveTableIds = await this.liveTournamentTableIdsWithPlayers();
    if (!this.eliminationMutationAllowed()) return;
    if (liveTableIds === null) {
      // UNKNOWN is not "balanced". Come back rather than conclude anything.
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return;
    }
    if (liveTableIds.length <= 1) return;

    // ── FIX 154: Build BalancerTable[] from a bounded live DB snapshot ──
    const balancerTables = await this.loadBalancerTables(liveTableIds, 'balanceInitial');
    if (!balancerTables) return;

    // ── STEP 1: Break every table that should be broken (merged into others) ──
    //
    // EVERY SHORT TABLE IS BROKEN IN THE SAME PASS (2026-10-01).
    //
    // This step used to request ONE park and then `break` to wait for the next
    // sweep. A source that is mid-hand cannot begin until its hand ends (the
    // one-second probe logs `source_park_probe_missed`), so each table cost
    // about one hand of its own plus a redrive, one after another. Production
    // 2026-10-01 ~20:18Z: event e604d224 held 25 players on 17 tables, nine of
    // them single-player tables, while its breaks crept along one every 6-10 s
    // (f06_operations 20:16-20:21Z). Industry standard is that every short
    // table is broken at its own next hand boundary.
    //
    // So the whole plan is made at once, on a simulated board: each chosen
    // source is removed and its players placed on the tables that remain, so
    // the next choice sees the seats the earlier ones will take. Unbegun parks
    // from earlier sweeps keep their seats too (`unbegunBreakDemand`), so no
    // table is parked whose players could not be placed. Every chosen source
    // is parked durably, its dealer is fenced at once so all of them stop at
    // their own hand boundary together, and each is then worked as before;
    // one whose hand is still running is claimed on its park edge.
    const unbegunDemand = await this.unbegunBreakDemand();
    if (!this.eliminationMutationAllowed()) return;
    if (unbegunDemand === null) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return;
    }
    const copyTable = (t: BalancerTable): BalancerTable => ({
      ...t,
      players: t.players.map((p) => ({ ...p })),
      reservedSeats: t.reservedSeats ? [...t.reservedSeats] : t.reservedSeats,
    });
    // A roster chair with no live seat (an unrecorded bust) is refused by the
    // move door, so it is not a free seat for a waiting park either.
    const freeSeats = (tables: BalancerTable[]) =>
      tables.reduce(
        (sum, t) => sum + Math.max(0, t.maxSeats - t.playerCount - (t.reservedSeats?.length ?? 0)),
        0
      );
    let plannedBoard = balancerTables.map(copyTable);
    const breakSources: string[] = [];
    for (;;) {
      let chosen: string | null = null;
      for (const bt of plannedBoard) {
        if (!this.tableBalancer.shouldBreakTable(bt, plannedBoard)) continue;
        // Empty-source retirement is discovered through its original durable
        // operation above; emptiness never creates a new whole-break intent.
        if (bt.playerCount === 0) continue;
        const remaining = plannedBoard.filter((t) => t.tableId !== bt.tableId).map(copyTable);
        const breakMoves = this.tableBalancer.breakTable(bt, remaining);

        // The balancer says this table should close but cannot yet place its
        // full roster. That is outstanding work, not a balanced state. Keep a
        // single coalesced retry due without reviving the old per-manager poll.
        if (bt.playerCount > 0 && breakMoves.length !== bt.playerCount) {
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          continue;
        }
        // Players of a park that has not begun still need seats here, so a
        // pass adds no park that would take them. One exception: a park that
        // can never begin (production 2026-10-02, f8c6f298 left 1/1/9 with its
        // full table parked since 04:51Z) must not stop lone players merging,
        // so the first choice of a pass may still be a SHORT table.
        //
        // A FULL TABLE NEVER JUMPS THE QUEUE (2026-10-02). The exception used
        // to cover any first choice. Production 13:09-13:28Z: event 4d2afa41
        // had one 7-player park that could not begin, and every later pass
        // parked one more 7-9 player table past it, each taking seats the
        // others needed, until ten nine-handed tables sat frozen at once
        // (`destinations_full:5_of_9`, PokerTablesFrozen). A table this big
        // is a consolidation, not a stranded player, and it waits its turn.
        const shortSource = bt.playerCount <= TournamentManager.SHORT_BREAK_SOURCE_PLAYERS;
        if ((breakSources.length > 0 || !shortSource) && freeSeats(remaining) < unbegunDemand)
          continue;
        chosen = bt.tableId;
        plannedBoard = remaining;
        break;
      }
      if (!chosen) break;
      breakSources.push(chosen);
    }

    if (breakSources.length > 0) {
      const requestedBreaks: TournamentTableBreakState[] = [];
      for (const tableId of breakSources) {
        if (requestedBreaks.length > 0 && this.eliminationWorkBudgetExpired()) break;
        const requested = await this.requestTournamentBreakPark(tableId);
        if (!this.eliminationMutationAllowed()) return;
        if (!requested?.ok) continue;
        requestedBreaks.push(requested);
        // The durable park precedes the fence. Fence now, so every source
        // stops at its own next boundary instead of waiting for its turn; the
        // engine's park edge wakes the sweep that claims it.
        const sourceEngine = this.tableEngines.get(tableId);
        if (sourceEngine && this.gameServer.ownsTournamentTableEngine(tableId, sourceEngine))
          void sourceEngine
            .parkForTournamentMove(this.tournamentMoveBoundaryOwner, 0, true)
            .catch((error) =>
              reportError(error, 'Tournament.break_source_hold_failed', {
                tournamentId: this.tournamentId,
                tableId,
              })
            );
      }
      this.breakOccurredThisCycle = true;
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      let everyBreakRetired = requestedBreaks.length === breakSources.length;
      let retiredTableId: string | null = null;
      for (const [index, requested] of requestedBreaks.entries()) {
        // A source left unworked is parked and fenced; its park edge and the
        // redrive below claim it in the next admission.
        if (index > 0 && this.eliminationWorkBudgetExpired()) {
          everyBreakRetired = false;
          break;
        }
        await this.recoverTournamentBreak(requested);
        if (!this.eliminationMutationAllowed()) return;
        const sourceId = requested.source_table_id;
        // Preserve the current admitted sweep's continuation only after this
        // exact durable operation acknowledged cleanup. A park request or an
        // unresolved move/close is not a retired table.
        if (
          !this.durableTournamentBreaks.has(requested.break_id) &&
          !this.tableEngines.has(sourceId) &&
          !this.gameServer.getTableEngine(sourceId)
        )
          retiredTableId = sourceId;
        else everyBreakRetired = false;
      }
      if (everyBreakRetired && retiredTableId && this.eliminationMutationAllowed())
        return { kind: 'table-retired', tableId: retiredTableId };
    }

    // ── STEP 2: Standard gap-1 rebalancing across remaining tables ──
    // Re-fetch after potential break (tables may have changed)
    // Same rule as the break step above: the tables that hold players, not the
    // tables that happen to be dealing.
    const freshTableIds = await this.liveTournamentTableIdsWithPlayers();
    if (!this.eliminationMutationAllowed()) return;
    if (freshTableIds === null) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return;
    }
    if (freshTableIds.length > 1) {
      const freshTables = await this.loadBalancerTables(freshTableIds, 'balanceFresh');
      if (!freshTables) return;

      if (this.tableBalancer.shouldRebalance(freshTables)) {
        const moves = this.tableBalancer.calculateMoves(freshTables);
        if (moves.length === 0) {
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
        }
        if (moves.length > 0) {
          const score = this.tableBalancer.evaluateBalance(freshTables);
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Rebalancing: ${moves.length} moves (gap was ${score.gap}, target ≤1)`
          );

          // AUDIT FIX 2026-07-19: gap rebalance previously moved players with no
          // regard for in-flight hands. Wait for each source table's current
          // hand to complete (final stacks persisted) before moving.
          const sourceTables = [...new Set(moves.map((m) => m.fromTableId))] as string[];
          const unsafeTables = new Set<string>();
          for (const t of sourceTables) {
            const safe = await this.waitForHandComplete(t);
            if (!this.eliminationMutationAllowed()) return;
            if (safe) continue;
            unsafeTables.add(t);
            /* A DEFERRED MOVE FENCES ITS SOURCE (2026-10-02). This check is a
               snapshot, and a dealing table is between hands for a moment
               only, so a move deferred here was deferred again on every
               sweep. Production 2026-10-02 05:03-05:05Z: event 09a56a25 sat
               9/9/9/1, its six moves "Deferring ... still in-hand" every
               sweep while one player waited alone. Arm the same move fence
               `claimTournamentMoveBoundary` arms (it expires on its own if
               never claimed): the source stops at its next boundary and its
               park edge wakes the sweep that moves the player. */
            const sourceEngine = this.tableEngines.get(t);
            if (sourceEngine && this.gameServer.ownsTournamentTableEngine(t, sourceEngine))
              void sourceEngine
                .parkForTournamentMove(this.tournamentMoveBoundaryOwner, 0)
                .catch((error) =>
                  reportError(error, 'Tournament.rebalance_source_hold_failed', {
                    tournamentId: this.tournamentId,
                    tableId: t,
                  })
                );
          }
          // TOURNEY-AUDIT 2026-07-24 (sweep 4): drop moves from tables still
          // in-hand instead of moving players with stale mid-hand stacks.
          const safeMoves = moves.filter((m) => !unsafeTables.has(m.fromTableId));
          if (unsafeTables.size > 0) {
            console.warn(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Deferring ${moves.length - safeMoves.length} rebalance move(s) - source table(s) still in-hand`
            );
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          }
          if (safeMoves.length > 0) {
            const movedCount = await this.executePlayerMoves(safeMoves);
            if (!this.eliminationMutationAllowed()) return;
            if (movedCount < safeMoves.length) {
              console.warn(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Rebalance incomplete - ${movedCount}/${safeMoves.length} move(s) landed. Deferring remainder.`
              );
            }

            // A move changes the shape the planner read. Verify from fresh DB
            // state in one coalesced follow-up; balanced tournaments never arm
            // this path because shouldRebalance is false.
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);

            await this.broadcast('table_rebalance', {
              moveCount: movedCount,
              reason: 'gap_balance',
            });
          }
        }
      }
    }
  }

  /**
   * FIX 154: Execute a set of player move instructions (used by both table break + rebalance).
   * Moves player seats in DB: marks old seat as left, inserts new seat, updates tournament_players.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  A PLAYER LEFT ON A CLOSED TABLE IS BROUGHT BACK TO THE FELT
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The evidence and every rule are in `orphanedSeatRepair.ts`. The short
   * version: `checkTableBalance` iterates `tableEngines`, a closed table has
   * no engine, so a live seat left behind on one is invisible to the balancer
   * forever - and the tournament counts that player as still in the game and
   * waits for an action nobody can take.
   *
   * This reads the tournament's own tables and live seats, asks the pure
   * planner what to do, and hands the answer to `executePlayerMoves`. Every
   * protection that path has earned now lives in the one atomic move RPC:
   * source/destination identity, exact stack, seat reuse and an immutable
   * receipt commit together. This adds no second way to move a player.
   *
   * Both reads fail CLOSED. An unreadable board is UNKNOWN, never "nobody is
   * stranded" and never "everybody is".
   */
  public async absorbOrphanedSeats(): Promise<number> {
    if (!(await this.redrivePendingTournamentSeatMoveOutcomes())) return 0;
    const { data: tableRows, error: tableErr } = await supabase
      .from('tables')
      .select('id, status, is_deleted, max_players')
      .eq('tournament_id', this.tournamentId);
    if (tableErr || !tableRows || tableRows.length === 0) return 0;

    const tableIds = tableRows.map((r) => String((r as { id: string }).id));
    const { data: seatRows, error: seatErr } = await supabase
      .from('table_seats')
      .select('table_id, user_id, seat_number, stack')
      .in('table_id', tableIds)
      .is('left_at', null);
    if (seatErr || !seatRows) return 0;

    const moves = planOrphanReseats(tableRows as OrphanTableRow[], seatRows as OrphanSeatRow[]);

    const { duplicateSeat, noChips, ambiguousClosedSources } = describeUnmovableOrphans(
      tableRows as OrphanTableRow[],
      seatRows as OrphanSeatRow[]
    );
    if (duplicateSeat.length > 0) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] ${duplicateSeat.length} player(s) hold a live seat on BOTH a closed table and an open one. Which stack is real is a money decision, so nothing was moved: ${duplicateSeat.map((id) => id.slice(0, 8)).join(', ')}`
        ),
        'Tournament.orphan_seat_duplicate_not_moved'
      );
    }
    if (ambiguousClosedSources.length > 0) {
      reportError(
        new Error('Players hold multiple positive closed-table sources; no source was selected'),
        'Tournament.orphan_closed_sources_ambiguous_not_moved',
        { tournamentId: this.tournamentId, ambiguousClosedSources }
      );
    }
    if (noChips.length > 0) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] ${noChips.length} stranded seat(s) on a closed table hold no chips, so the elimination path owns them rather than this repair: ${noChips.map((id) => id.slice(0, 8)).join(', ')}`
        ),
        'Tournament.orphan_seat_no_chips_not_moved'
      );
    }

    if (moves.length === 0) return 0;

    console.warn(
      `[Tournament:${this.tournamentId.slice(0, 8)}] ${moves.length} player(s) stranded on a closed table - moving them to open felt so the tournament can deal again`
    );
    return this.executePlayerMoves(moves);
  }

  protected executePlayerMoves(moves: MoveInstruction[]): Promise<number> {
    return this.runWithTournamentSeatMoveAuthority(() => this.executePlayerMovesOwned(moves));
  }

  private async executePlayerMovesOwned(moves: MoveInstruction[]): Promise<number> {
    let moved = 0;
    const batch = moves.slice(0, TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE);
    if (moves.length > batch.length) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
    }
    if (batch.length === 0) return moved;
    if (!(await this.redrivePendingTournamentSeatMoveOutcomesOwned())) return moved;

    const sourcePlans = new Map<
      string,
      { move: MoveInstruction; sourceMode: TournamentSeatMoveSourceMode }
    >();
    for (const move of batch) {
      const sourceMode: TournamentSeatMoveSourceMode =
        move.reason === CLOSED_ORPHAN_RESEAT_REASON ? 'closed_orphan' : 'live_source';
      const prior = sourcePlans.get(move.fromTableId);
      if (prior && prior.sourceMode !== sourceMode) {
        reportError(
          new Error('one source table was assigned contradictory move authority modes'),
          'Tournament.atomic_move_source_mode_conflict',
          { sourceTableId: move.fromTableId }
        );
        continue;
      }
      sourcePlans.set(move.fromTableId, { move, sourceMode });
    }

    // Arm every source together. A slow current hand costs this scheduler one
    // short probe, not one serial minute per table; its owner stays armed and
    // the next causal sweep claims the physical park.
    const boundaryResults = await Promise.all(
      [...sourcePlans.entries()].map(
        async ([sourceTableId, plan]) =>
          [
            sourceTableId,
            await this.claimTournamentMoveBoundary(plan.move, plan.sourceMode),
          ] as const
      )
    );
    const boundaries = new Map(boundaryResults);
    const retainedUnknownSources = new Set<string>();
    const refusedSources = new Set<string>();

    try {
      for (const move of batch) {
        if (!this.eliminationMutationAllowed()) break;
        if (refusedSources.has(move.fromTableId)) continue;
        const boundary = boundaries.get(move.fromTableId);
        if (!boundary) continue;
        const requestId = randomUUID();
        const input: TournamentSeatMoveInput = {
          requestId,
          tournamentId: this.tournamentId,
          userId: move.playerId,
          sourceTableId: move.fromTableId,
          destinationTableId: move.toTableId,
          destinationSeatNumber: move.toSeat,
          sourceMode: boundary.sourceMode,
        };
        try {
          const receipt = await this.requestTournamentSeatMoveAtBoundary(input, boundary);
          moved++;
          // The destination may be waiting below its deal minimum on a
          // backed-off roster read; it looks now rather than in a minute.
          this.tableEngines.get(move.toTableId)?.wakeWaitingForPlayers();
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Atomic move ${receipt.requestId.slice(0, 8)} certified for ${move.playerId.slice(0, 8)}: table ${move.fromTableId.slice(0, 8)} seat ${receipt.sourceSeatNumber} to table ${move.toTableId.slice(0, 8)} seat ${receipt.destinationSeatNumber}`
          );
        } catch (moveErr) {
          if (moveErr instanceof TournamentSeatMoveOutcomeUnknownError) {
            this.pendingTournamentSeatMoveOutcomes.set(requestId, {
              move,
              input,
            });
            retainedUnknownSources.add(move.fromTableId);
          } else {
            refusedSources.add(move.fromTableId);
          }
          reportError(moveErr, 'Tournament.atomic_move_refused_or_unknown', {
            tournamentId: this.tournamentId,
            requestId,
            playerId: move.playerId,
            sourceTableId: move.fromTableId,
            destinationTableId: move.toTableId,
            destinationSeat: move.toSeat,
          });
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          // An unknown source shape invalidates every remaining destination
          // chosen from the same snapshot. Resolve that UUID before planning.
          if (moveErr instanceof TournamentSeatMoveOutcomeUnknownError) break;
        }
      }
    } finally {
      for (const [sourceTableId, boundary] of boundaries) {
        if (
          boundary?.engine &&
          !retainedUnknownSources.has(sourceTableId) &&
          !this.retainsTournamentBreakSource(sourceTableId, boundary.engine)
        ) {
          boundary.engine.releaseTournamentMovePause(this.tournamentMoveBoundaryOwner);
        }
      }
    }
    return moved;
  }

  /**
   * Is this table safe to move from RIGHT NOW?
   *
   * This used to poll hand_state_snapshots every two seconds for up to sixty
   * seconds. Under the process-wide scheduler, four ordinary in-hand tables
   * could therefore occupy all four physical sweep slots and starve an urgent
   * bust for a full minute-the same fan-out in a different shape. The engine
   * already owns the authoritative boundary: no hand controller and no
   * settlement promise in flight. Probe it once, fail closed, and let the
   * caller arm one coalesced BALANCE_REDRIVE_MS wake.
   *
   * Kept async to avoid widening every established caller; it never waits.
   */
  protected async waitForHandComplete(tableId: string): Promise<boolean> {
    const engine = this.tableEngines.get(tableId);
    return Boolean(
      engine &&
      this.gameServer.ownsTournamentTableEngine(tableId, engine) &&
      engine.isBetweenHands() &&
      !engine.hasSettlementInFlight()
    );
  }

  /**
   * Ask the one database authority to settle and certify the complete
   * satellite result. TypeScript neither derives an award nor infers success
   * from tournament status; only the exact immutable receipt is accepted.
   */
  protected async processSatelliteAwards(
    _tournament: any,
    winnerId: string
  ): Promise<VerifiedSatelliteSettlementReceipt> {
    const verified = await requestSatelliteSettlementReceipt(this.tournamentId, winnerId);
    console.log(
      `[Satellite:${this.tournamentId.slice(0, 8)}] atomic settlement certified: ${verified.ticketAwardCount} full award(s), ${verified.seatCount} target seat(s), ${verified.entryTicketCount} noncash tournament ticket(s), ${verified.cashTicketCount} cash substitute(s), winner value ${verified.winnerAmount}`
    );
    return verified;
  }

  /**
   * FIX 155: Dynamic table creation during rebuy/re-entry/late-reg period.
   * When player count exceeds (tableCount × maxPerTable), create new tables
   * and rebalance players across all tables using TableBalancer.
   *
   * Called from bounded elimination scheduling after causal manager wakes and
   * ordinary gameplay mutations. The database re-counts the committed field;
   * this process never scans a seatless roster to authorize a chair write.
   */
  // Round 51 RE-RUN-2 fix: when a table was just broken in the same
  // elimination-loop cycle, skip expansion. Otherwise the broken table's
  // close → reduces dbActiveTableCount → triggers fresh expansion → and
  // the next cycle breaks ANOTHER empty table → loop creates 12 new
  // tables/minute. Verified live on "Union PKO Afternoon" with 12 playing
  // / 2 active / 109 closed: 12 tables/min churn rate continued for 8+
  // minutes after the first defensive cap deployed.
  protected breakOccurredThisCycle = false;

  protected async checkDynamicTableExpansion(): Promise<boolean> {
    if (!this.eliminationMutationAllowed()) return false;
    // Skip expansion in the same scheduler pass as a break - gives
    // executePlayerMoves time to actually seat players to remaining tables
    // before we evaluate "are we over capacity?"
    if (this.breakOccurredThisCycle) {
      this.breakOccurredThisCycle = false;
      return true;
    }

    // Registration and every manager process enter through ONE database
    // authority. The RPC locks the tournament row and then re-counts active
    // entrants and live capacity. No count made in this process authorizes an
    // insert, and this class never inserts a tournament table directly.
    const newTableIds: string[] = [];
    let admittedCapacity = false;
    let totalPlaying = 0;
    let remainingDeficit = 0;
    for (let i = 0; i < TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE; i++) {
      if (!this.eliminationMutationAllowed()) return false;
      const { data, error: createErr } = await supabase.rpc(
        'fn_ensure_late_registration_capacity',
        { p_tournament_id: this.tournamentId, p_reserved_entries: 0 }
      );

      if (!this.eliminationMutationAllowed()) return false;

      if (createErr) {
        reportError(createErr, 'Tournament.dynamic_expansion_capacity_authority_unavailable');
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
        return false;
      }

      const result = data as LateRegistrationCapacityResult | null;
      if (!result || result.ok !== true || typeof result.created !== 'boolean') {
        reportError(
          new Error('late-registration capacity RPC returned an invalid contract'),
          'Tournament.dynamic_expansion_capacity_contract_invalid'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
        return false;
      }

      totalPlaying = Number.isFinite(Number(result.active_entries))
        ? Number(result.active_entries)
        : totalPlaying;
      remainingDeficit = Number.isFinite(Number(result.remaining_deficit))
        ? Math.max(0, Number(result.remaining_deficit))
        : 0;

      if (result.reason === 'tournament_not_running') return true;
      const rawPendingTableIds = result.pending_table_ids;
      const pendingTableIds = Array.isArray(rawPendingTableIds)
        ? rawPendingTableIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      const pendingTableCount = Number(result.pending_table_count);
      const createdTableId = typeof result.table_id === 'string' ? result.table_id : '';
      if (
        !Array.isArray(rawPendingTableIds) ||
        pendingTableIds.length !== rawPendingTableIds.length ||
        new Set(pendingTableIds).size !== pendingTableIds.length ||
        !Number.isSafeInteger(pendingTableCount) ||
        pendingTableCount < pendingTableIds.length ||
        (result.created && (!createdTableId || !pendingTableIds.includes(createdTableId)))
      ) {
        reportError(
          new Error('capacity RPC returned an invalid durable table hand-off'),
          'Tournament.dynamic_expansion_table_handoff_invalid'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
        return false;
      }

      // The pending set includes tables created by a registration transaction,
      // whose HTTP response can never safely mutate this process. Admit every
      // exact receipt before acknowledging any of them; a lost acknowledgement
      // simply returns the same idempotent hand-off to this manager or its
      // successor after a crash.
      for (const tableId of pendingTableIds) {
        if (!this.eliminationMutationAllowed()) return false;
        if (!this.tableEngines.has(tableId)) {
          const engine = this.createManagedTableEngine(tableId);
          engine.setHub(tableStateHub); // Phase 1.1 PR-2
          this.wireEliminationWake(engine);
          this.tableEngines.set(tableId, engine);
          this.admitManagedTableEngine(tableId, engine);
          this.startManagedTableEngine(engine, 'Tournament.dynamic_expansion_table_engine_error', {
            tableId,
          });
          newTableIds.push(tableId);
        }
        admittedCapacity = true;
      }

      if (pendingTableIds.length > 0) {
        // Queue the manager continuation before the acknowledgement RPC. If
        // its response is lost after the database commits, the admitted engine
        // still gets a causal gameplay pass in this lifecycle.
        this.requestUrgentEliminationSweepAfter(0);
        const { data: ackData, error: ackError } = await supabase.rpc(
          'fn_ack_tournament_capacity_tables',
          { p_tournament_id: this.tournamentId, p_table_ids: pendingTableIds }
        );
        if (!this.eliminationMutationAllowed()) return false;
        const acknowledgement = (ackData ?? {}) as {
          ok?: boolean;
          reason?: string;
          requested?: number;
        };
        if (
          ackError ||
          acknowledgement.ok !== true ||
          Number(acknowledgement.requested) !== pendingTableIds.length
        ) {
          reportError(
            new Error(
              `capacity table admission acknowledgement failed: ${ackError?.message ?? acknowledgement.reason ?? 'invalid contract'}`
            ),
            'Tournament.dynamic_expansion_table_handoff_ack_failed'
          );
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          return false;
        }
      }

      if (result.created) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Capacity authority created table ${createdTableId.slice(0, 8)} ` +
            `(Table ${Number(result.table_number) || '?'}, ${Number(result.table_capacity) || '?'} seats, ` +
            `${remainingDeficit} seat deficit remaining)`
        );
      }

      // Drain a bounded receipt backlog before this captured durable wake can
      // be acknowledged. Otherwise a process crash between wake-ack and the
      // next local pass could leave a committed table with no dealer.
      if (pendingTableCount > pendingTableIds.length) {
        if (i === TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE - 1) {
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          return false;
        }
        continue;
      }

      // A sufficient-capacity result is a successful no-op after all durable
      // table hand-offs have been admitted. A created table loops once more so
      // the locked authority, not this process, decides whether another is due.
      if (!result.created) break;
    }

    if (!admittedCapacity) return true;
    if (remainingDeficit > 0) this.requestEliminationSweep('capacity_deficit_remains');

    // Re-enter the manager after admitting real capacity so the fresh table
    // engines, durable wake acknowledgement, balancing and gameplay tail all
    // observe the database-committed registration hand-off.
    this.requestUrgentEliminationSweepAfter(0);

    // Now rebalance players across ALL tables using the same bounded snapshot
    // path as ordinary balancing; never return to two requests per table.
    const allTables = await this.loadBalancerTables([...this.tableEngines.keys()], 'postExpansion');
    if (!allTables) return false;

    // Calculate optimal moves to balance all tables
    let rebalanceComplete = true;
    if (this.tableBalancer.shouldRebalance(allTables)) {
      const moves = this.tableBalancer.calculateMoves(allTables);
      if (moves.length > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Post-expansion rebalance: ${moves.length} player moves`
        );
        // 2026-08-18: this was the one move site with no hand-boundary wait.
        // The table-break path (above) and the gap-rebalance path both wait,
        // with a comment saying why: executePlayerMoves reads table_seats.stack,
        // which is only written at settlement, so moving a player mid-hand
        // carries their PRE-hand stack to the new table while the old table
        // still pays out the pot. An all-in player moved this way is cloned —
        // their chips arrive at the new table and are also collected by whoever
        // wins the hand they left behind. Late registration overflowing table
        // capacity is exactly when this fires.
        const sourceTables = [...new Set(moves.map((m) => m.fromTableId))] as string[];
        const unsafeTables = new Set<string>();
        for (const t of sourceTables) {
          const safe = await this.waitForHandComplete(t);
          if (!this.eliminationMutationAllowed()) return false;
          if (!safe) unsafeTables.add(t);
        }
        const safeMoves = moves.filter((m) => !unsafeTables.has(m.fromTableId));
        if (unsafeTables.size > 0) {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Deferring ${moves.length - safeMoves.length} post-expansion move(s) - source table(s) still in-hand`
          );
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          rebalanceComplete = false;
        }
        if (safeMoves.length > 0) {
          const movedCount = await this.executePlayerMoves(safeMoves);
          if (!this.eliminationMutationAllowed()) return false;
          if (movedCount < safeMoves.length) {
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
            rebalanceComplete = false;
          }
        }
      }
    }

    if (newTableIds.length > 0) {
      await this.broadcast('table_expansion', {
        newTableIds,
        totalTables: this.tableEngines.size,
        totalPlayers: totalPlaying,
        reason: 'rebuy_reentry_overflow',
      });
    }
    if (remainingDeficit > 0 || !rebalanceComplete) return false;
    return true;
  }
}
