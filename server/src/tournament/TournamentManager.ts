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
import { verifyF06MovementAdmission } from './f06MovementAdmission.js';
import {
  TournamentTableBreakRpc,
  TournamentTableBreakCapacityError,
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
import { requestSatelliteSettlementReceipt } from './satelliteSettlementRpc.js';
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
}

interface PendingTournamentSeatMoveOutcome {
  move: MoveInstruction;
  input: TournamentSeatMoveInput;
}

export class TournamentManager extends TournamentManagerEliminations {
  private static readonly MOVE_BOUNDARY_PROBE_MS = 1_000;
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
      if (!current() || error) throw new Error('f06_movement_admission_unproven');
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

  private rememberTournamentBreak(state: TournamentTableBreakState): void {
    if (state.state === 'acknowledged') {
      this.durableTournamentBreaks.delete(state.break_id);
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

  /** Discovery advances the server-owned cursor even when earlier entries refuse. */
  protected async discoverTournamentBreaks(): Promise<TournamentTableBreakState[] | null> {
    const page = await this.tableBreakRpc().discover(this.tournamentBreakCursorRevision, 1);
    // Receipt bookkeeping is safe after budget expiry; it grants no new authority.
    this.tournamentBreakCursorRevision = page.cursor_revision;
    if (!page.ok) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
      return null;
    }
    if (page.wrapped) {
      if (this.tournamentBreakTraversalStarted) this.tournamentBreakDiscoveryComplete = true;
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
    if (rejected) this.assertBreakMembership(rejected, exact);
    this.pendingTournamentBreakBegins.set(breakId, exact);
    let state: TournamentTableBreakState;
    try {
      state = await this.tableBreakRpc().begin(breakId, exact);
    } catch (error) {
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
    await this.runWithTournamentSeatMoveAuthority(async () => {
      // An unrelated unknown movement still invalidates this board's plan.
      if (this.pendingTournamentSeatMoveOutcomes.size > 0) return;
      const engine = this.tableEngines.get(state.source_table_id);
      if (
        !engine ||
        !this.retainTournamentBreakSource(state.break_id, state.source_table_id, engine)
      )
        return;
      for (const member of state.members) {
        if (member.winner_request_id) continue;
        if (
          !member.active_request_id ||
          !member.destination_table_id ||
          member.destination_seat_number === null
        )
          throw new Error('F06 active attempt has no exact destination');
        if (!this.eliminationMutationAllowed()) return;
        const move: MoveInstruction = {
          playerId: member.user_id,
          fromTableId: state.source_table_id,
          fromSeat: member.source_seat_number,
          toTableId: member.destination_table_id,
          toSeat: member.destination_seat_number,
          reason: 'table_break',
        };
        const boundary = await this.claimTournamentMoveBoundary(move, 'live_source');
        if (!boundary || !this.eliminationMutationAllowed()) return;
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
    });
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
    const engine = this.tableEngines.get(state.source_table_id);
    if (!engine || !this.retainTournamentBreakSource(state.break_id, state.source_table_id, engine))
      return null;
    const parked = await engine.parkForTournamentMove(
      this.tournamentMoveBoundaryOwner,
      TournamentManager.MOVE_BOUNDARY_PROBE_MS
    );
    if (
      !this.eliminationMutationAllowed() ||
      !parked ||
      this.tableEngines.get(state.source_table_id) !== engine ||
      !this.gameServer.ownsTournamentTableEngine(state.source_table_id, engine)
    )
      return null;
    const retained = this.pendingTournamentBreakBegins.get(state.break_id);
    if (retained) return this.beginTournamentBreak(state.break_id, state.source_table_id, retained);

    const { data, error } = await supabase
      .from('table_seats')
      .select('id, user_id, seat_number, stack, occupancy_id')
      .eq('table_id', state.source_table_id)
      .is('left_at', null);
    if (!this.eliminationMutationAllowed() || error || !data || data.length === 0) return null;
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
      return null;
    const others = await this.eligibleBreakDestinations(state.source_table_id, state.break_id);
    if (!this.eliminationMutationAllowed() || !others) return null;
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
      return null; // Existing capacity owner must supply legal space.
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
      this.tableEngines.get(state.source_table_id) !== engine ||
      !this.gameServer.ownsTournamentTableEngine(state.source_table_id, engine)
    )
      return null;
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
      this.assertBreakMembership(original, next.members);
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

  /** A refused prefix never prevents the next discovered operation being visited. */
  protected async visitTournamentBreakPage(
    visit: (state: TournamentTableBreakState) => Promise<void>
  ): Promise<boolean> {
    const page = await this.discoverTournamentBreaks();
    if (page === null) return false;
    // One durable page item per pass prevents a slow first item from forever
    // hiding the rest of a pre-advanced page. Alternate retained ACK cleanup
    // with discovery so a committed/lost ACK can release its local reservation.
    const retainedId = [...this.pendingTournamentCleanupKinds.keys()].find(
      (id) => !page.some((op) => op.break_id === id)
    );
    const retained = retainedId ? this.durableTournamentBreaks.get(retainedId) : undefined;
    this.tournamentBreakCleanupFirst = !this.tournamentBreakCleanupFirst;
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

  /** Exact original source kept through no-start, movement and final ACK. */
  private readonly stoppedOriginalBreaks = new Map<string, ServerTableEngine>();
  private readonly activeStoppedOriginalCustody = new Set<string>();
  private originalAdmissionCursor = 0;

  /** One original admission decision per RUNNING sweep; never a dealer restart. */
  protected async recoverF06OriginalAdmissions(): Promise<void> {
    const pendingContinuation = this.pendingNoStartContinuations.keys().next().value;
    if (pendingContinuation && (await this.replayNoStartContinuation(pendingContinuation))) return;
    const entries = [...this.tableEngines.entries()];
    if (!entries.length || !this.eliminationMutationAllowed()) return;
    const [tableId, engine] = entries[this.originalAdmissionCursor++ % entries.length];
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
      return;
    }
    const ticket = engine.getF06FailedAllocation?.();
    if (!ticket) return;
    const table = await this.tableBreakRpc().tableState(tableId);
    if (!current() || !table.ok || table.excluded) return;
    // Lease owns the epoch-to-admitted-lifecycle binding and verifies the
    // allocator response against that original lifecycle before publishing it.
    // A failed allocation can burn a number; no BEGIN identity is discarded.
    await engine.retryF06FailedAllocation(
      ticket,
      () => current() && this.gameServer.tournamentRetirementCustody.admissionAllowed(tableId)
    );
    if (!current()) throw new Error('F06 allocation recovery owner changed');
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
    }
  >();

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
          if (!(await this.tableBreakRpc().continueNoStartLastTable(state))) {
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
        return continued;
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
    if (await this.replayNoStartContinuation(state.break_id)) return;
    // Historical completion cannot select or stop whichever engine exists now.
    if (state.state === 'acknowledged') {
      await this.finishAcknowledgedTournamentBreak(state);
      return;
    }
    if (state.terminal_handoff_required) return;
    const stoppedOriginal = this.bindStoppedOriginalBreak(state);
    const managerLifecycle = this.captureLifecycleToken();
    if (stoppedOriginal && (!managerLifecycle || !this.lifecycleIsCurrent(managerLifecycle)))
      return;
    if (
      !stoppedOriginal &&
      state.state !== 'close_confirmed' &&
      (state.state !== 'begun' ||
        !state.members.length ||
        state.members.some((member) => !member.winner_request_id))
    )
      return;
    const generation = this.getTournamentLeaseGeneration();
    if (!generation || !this.eliminationMutationAllowed()) return;
    const rpc = this.tableBreakRpc();
    const fresh = await this.reconcileTournamentBreak(state);
    if (!fresh.ok || fresh.terminal_handoff_required || !this.eliminationMutationAllowed()) return;
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
    await host.withRetirementCustody(
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
                // The last physical table cannot move its roster elsewhere.
                // SQL accepts only the original immutable never-started outcome.
                this.pendingNoStartContinuations.set(owned.break_id, {
                  state: owned,
                  engine,
                  binding,
                });
                try {
                  if (!(await rpc.continueNoStartLastTable(owned))) {
                    this.pendingNoStartContinuations.delete(owned.break_id);
                    throw new Error('F06 original placement remains pending');
                  }
                } catch (error) {
                  if (error instanceof TournamentNoStartContinuationRefusedError)
                    this.pendingNoStartContinuations.delete(owned.break_id);
                  throw error;
                }
                custody.assertCurrent();
                continued = true;
                return;
              }
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
          if (!this.gameServer.unregisterTournamentTableEngine(binding.tableId, custody.engine))
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
    if (!this.eliminationMutationAllowed() || error || !data) return null;
    const eligible = data.map((row) => String(row.id)).filter((id) => id !== sourceId);
    return this.loadBalancerTables(eligible, 'breakReplacement', breakId);
  }

  protected async repairTournamentBreakDestinations(
    state: TournamentTableBreakState
  ): Promise<TournamentTableBreakState> {
    let current = state;
    for (const member of state.members) {
      if (member.winner_request_id) continue;
      if (!this.eliminationMutationAllowed()) return current;
      const destinations = await this.eligibleBreakDestinations(
        state.source_table_id,
        state.break_id
      );
      if (!destinations || !this.eliminationMutationAllowed()) return current;
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
    }
    return current;
  }

  protected async recoverTournamentBreak(state: TournamentTableBreakState): Promise<void> {
    if (state.state === 'acknowledged') {
      await this.finishAcknowledgedTournamentBreak(state);
      return;
    }
    let current = await this.reconcileTournamentBreak(state);
    if (!this.eliminationMutationAllowed() || !current.ok) return;
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
      if (!begun || !begun.ok || !this.eliminationMutationAllowed()) return;
      current = begun;
    }
    if (current.state === 'begun') {
      current = await this.repairTournamentBreakDestinations(current);
      if (!current.ok || !this.eliminationMutationAllowed()) return;
      await this.dispatchTournamentBreakMembers(current);
      if (!this.eliminationMutationAllowed()) return;
      current = await this.reconcileTournamentBreak(current);
    }
    if (this.eliminationMutationAllowed()) await this.retireTournamentBreak(current);
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

  /** One manager generation has exactly one seat-move authority at a time. */
  private tournamentSeatMoveSerialTail: Promise<void> = Promise.resolve();
  /** One break per pass; retain its exact generation across ambiguous closes. */
  private pendingTableBreakRetirement: {
    tableId: string;
    engine: ServerTableEngine;
    movedPlayers: number;
  } | null = null;

  private runWithTournamentSeatMoveAuthority<T>(operation: () => Promise<T>): Promise<T> {
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

    if (!this.gameServer.unregisterTournamentTableEngine(tableId, engine)) {
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
          if (
            this.tableEngines.has(item.input.sourceTableId) ||
            this.gameServer.getTableEngine(item.input.sourceTableId)
          ) {
            return false;
          }
          boundary = { sourceMode: 'closed_orphan', engine: null };
        } else {
          const sourceEngine = engine ?? this.tableEngines.get(item.input.sourceTableId) ?? null;
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
        if (stillPending || this.retainsTournamentBreakSource(tableId, engine)) return false;
        engine.releaseTournamentMovePause(this.tournamentMoveBoundaryOwner);
        return !engine.hasClaimedTournamentMoveBoundary();
      }

      if (this.pendingTournamentSeatMoveOutcomes.size > 0) return false;
      if (this.retainedTournamentBreakSources.size > 0) return false;
      for (const sourceEngine of this.tableEngines.values()) {
        sourceEngine.releaseTournamentMovePause(this.tournamentMoveBoundaryOwner);
        if (sourceEngine.hasClaimedTournamentMoveBoundary()) return false;
      }
      return true;
    });
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

    // ── STEP 1: Check if any table should be broken (merged into others) ──
    for (const bt of balancerTables) {
      if (this.tableBalancer.shouldBreakTable(bt, balancerTables)) {
        const otherTables = balancerTables.filter((t) => t.tableId !== bt.tableId);
        const breakMoves = this.tableBalancer.breakTable(bt, otherTables);

        // The balancer says this table should close but cannot yet place its
        // full roster. That is outstanding work, not a balanced state. Keep a
        // single coalesced retry due without reviving the old per-manager poll.
        // Empty-source retirement is discovered through its original durable
        // operation above; emptiness never creates a new whole-break intent.
        if (bt.playerCount > 0 && breakMoves.length !== bt.playerCount) {
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          continue;
        }

        if (breakMoves.length === bt.playerCount && bt.playerCount > 0) {
          const requested = await this.requestTournamentBreakPark(bt.tableId);
          if (!this.eliminationMutationAllowed()) return;
          if (requested?.ok) await this.recoverTournamentBreak(requested);
          this.breakOccurredThisCycle = true;
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          // Preserve the current admitted sweep's continuation only after this
          // exact durable operation acknowledged cleanup. A park request or an
          // unresolved move/close is not a retired table.
          if (
            requested?.ok &&
            this.eliminationMutationAllowed() &&
            !this.durableTournamentBreaks.has(requested.break_id) &&
            !this.tableEngines.has(bt.tableId) &&
            !this.gameServer.getTableEngine(bt.tableId)
          )
            return { kind: 'table-retired', tableId: bt.tableId };
          break; // Rebuild board after the new durable source exclusion.
        }
      }
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
            if (!safe) unsafeTables.add(t);
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
