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
import { supabase } from '../services/supabase.js';
import { type BalancerTable, type MoveInstruction } from '../engine/TableBalancer.js';
import type { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { reportError } from '../services/errorReporter.js';
import { selectInChunks } from '../services/supabase/chunkedIn.js';
import { tableStateHub } from '../transport/TableStateHub.js';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { requestSatelliteSettlementReceipt } from './satelliteSettlementRpc.js';
import type { VerifiedSatelliteSettlementReceipt } from './satelliteSettlementReceipt.js';
import {
  moveTournamentPlayerAtomically,
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
  /** One manager generation has exactly one seat-move authority at a time. */
  private tournamentSeatMoveSerialTail: Promise<void> = Promise.resolve();

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
    label: string
  ): Promise<BalancerTable[] | null> {
    if (!this.eliminationMutationAllowed()) return null;
    const tableRead = await selectInChunks<{ id: string; max_players: number | null }>(
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
    return tableIds.map((tableId) => {
      const seats = seatsByTable.get(tableId) ?? [];
      return {
        tableId,
        playerCount: seats.length,
        maxSeats: tableById.get(tableId)?.max_players || 9,
        buttonSeat: this.tableEngines.get(tableId)?.getCurrentButtonSeat() ?? 0,
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
   * engine.  The already-empty table is a deterministic break candidate on
   * the next shared scheduler pass, so the exact operation is retried without
   * a fleet sweep or a timer owned by this manager.
   */
  protected async closeBrokenTableAndReleaseEngine(
    tableId: string,
    engine: ServerTableEngine
  ): Promise<boolean> {
    if (this.tableEngines.get(tableId) !== engine) return false;

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
    return true;
  }

  /**
   * Own the exact source-table generation before a seat can be vacated.
   * Closed-orphan recovery is the sole no-engine mode; its database function
   * independently proves that the source table is closed or deleted.
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
        this.tableEngines.has(input.sourceTableId) ||
        this.gameServer.getTableEngine(input.sourceTableId)
      ) {
        return Promise.reject(new Error('closed-orphan source boundary is no longer exact'));
      }
      return moveTournamentPlayerAtomically(input, { outcomeWasAlreadyUnknown });
    }
    if (
      input.sourceMode !== 'live_source' ||
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
    for (const [requestId, pending] of this.pendingTournamentSeatMoveOutcomes) {
      if (!this.eliminationMutationAllowed()) return false;
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
        if (releaseBoundary && boundary.engine) {
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
        if (stillPending) return false;
        engine.releaseTournamentMovePause(this.tournamentMoveBoundaryOwner);
        return !engine.hasClaimedTournamentMoveBoundary();
      }

      if (this.pendingTournamentSeatMoveOutcomes.size > 0) return false;
      for (const sourceEngine of this.tableEngines.values()) {
        sourceEngine.releaseTournamentMovePause(this.tournamentMoveBoundaryOwner);
        if (sourceEngine.hasClaimedTournamentMoveBoundary()) return false;
      }
      return true;
    });
  }

  protected async checkTableBalance(): Promise<void> {
    if (!this.eliminationMutationAllowed()) return;
    if (!(await this.redrivePendingTournamentSeatMoveOutcomes())) return;
    // Check for final table (table_size or fewer players remaining, 2026-08-22
    // parity: was hardcoded 9) — only announce once
    if (!this.isFinalTable) {
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
          await this.broadcast('final_table', { playerCount: remainingPlayers });
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
        // An empty table is already fully moved and must proceed to the durable
        // close. Treating its intentionally-empty move plan as failure left a
        // table whose prior close response was lost stuck forever.
        if (bt.playerCount > 0 && breakMoves.length !== bt.playerCount) {
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
          continue;
        }

        if (breakMoves.length === bt.playerCount) {
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Breaking table ${bt.tableId.slice(0, 8)} - moving ${breakMoves.length} players`
          );

          // AUDIT FIX 2026-07-19: wait for the source table's current hand to
          // finish (so the accepted-hand transaction has persisted final stacks) BEFORE moving
          // players. Previously executePlayerMoves ran first and read the
          // pre-hand stack, so a player who won/lost the in-flight hand arrived
          // at the new table with the wrong stack (chips created/destroyed).
          const engine = this.tableEngines.get(bt.tableId);
          if (engine) {
            const safe = await this.waitForHandComplete(bt.tableId);
            if (!this.eliminationMutationAllowed()) return;
            if (!safe) {
              // TOURNEY-AUDIT 2026-07-24 (sweep 4): never move players mid-hand.
              console.warn(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Table ${bt.tableId.slice(0, 8)} still in-hand after 60s - deferring break to next balance cycle`
              );
              this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
              continue;
            }
          }

          const movedCount = await this.executePlayerMoves(breakMoves);
          if (!this.eliminationMutationAllowed()) return;

          // LIVE E2E FIX 2026-08-15: the table was previously closed even when
          // some moves FAILED — the unmoved players kept 'playing' status and
          // chips but pointed at a closed table no balance pass ever looks at
          // again (checkTableBalance iterates tableEngines only). Seen live on
          // 3 frozen tournaments + "Late Night Grind", where the stall ended in
          // a force-complete that paid 1st place to an already-eliminated
          // player. Close ONLY when every player actually arrived; otherwise
          // keep the table alive and let the next cycle retry the remainder.
          if (movedCount !== breakMoves.length) {
            console.warn(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Table break of ${bt.tableId.slice(0, 8)} incomplete - ${movedCount}/${breakMoves.length} moved. Deferring close to next balance cycle.`
            );
            this.breakOccurredThisCycle = true;
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
            break;
          }

          if (!engine) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] cannot retire broken table ${bt.tableId.slice(0, 8)} because its exact engine generation is missing`
              ),
              'Tournament.broken_table_engine_missing'
            );
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
            continue;
          }

          const retired = await this.closeBrokenTableAndReleaseEngine(bt.tableId, engine);
          if (!this.eliminationMutationAllowed()) return;
          if (!retired) {
            // The stopped generation remains in both registries and in the
            // hand-for-hand roster. The next scheduler pass sees the empty
            // table and retries this exact durable close; no successor may
            // overlap an unproved retirement.
            this.breakOccurredThisCycle = true;
            this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);
            break;
          }

          await this.broadcast('table_rebalance', {
            closedTableId: bt.tableId,
            movedPlayers: breakMoves.length,
            reason: 'table_break',
          });
          if (!this.eliminationMutationAllowed()) return;

          // Round 51 RE-RUN-2: signal expansion to skip this cycle so we
          // don't immediately re-create the table we just broke.
          this.breakOccurredThisCycle = true;

          // One break per pass is intentional because balancerTables is now
          // stale. Re-enter promptly with fresh rows (also announces a final
          // table immediately when this break collapsed the field to one).
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.BALANCE_REDRIVE_MS);

          break; // One break per cycle to avoid stale data
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

    const { duplicateSeat, noChips } = describeUnmovableOrphans(
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
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Atomic move ${receipt.requestId.slice(0, 8)} certified for ${move.playerId.slice(0, 8)}: table ${move.fromTableId.slice(0, 8)} seat ${receipt.sourceSeatNumber} to table ${move.toTableId.slice(0, 8)} seat ${receipt.destinationSeatNumber}`
          );
        } catch (moveErr) {
          if (moveErr instanceof TournamentSeatMoveOutcomeUnknownError) {
            this.pendingTournamentSeatMoveOutcomes.set(requestId, { move, input });
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
        if (boundary?.engine && !retainedUnknownSources.has(sourceTableId)) {
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
