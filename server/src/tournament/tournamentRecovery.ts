/**
 * Tournament cancellation + stuck-COMPLETING recovery helpers.
 *
 * Split out of the 4,096-line `src/GameServer.ts` monolith on 2026-07-28
 * (engine audit D21 — god-class decomposition). Behavior is preserved
 * line-for-line: the only edits are module boundaries, `private` widened to
 * `protected` where a member is reached across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { supabase } from '../services/supabase.js';
import { computePlacePrize } from './payoutMath.js';
import { resolvePayoutStructure } from './payoutStructure.js';
import { fieldIsStillLive } from './recoveryFieldGuard.js';
import { chipsCannotRank, noHandWasEverDealt } from './recoveryRankEvidence.js';
import { reportError } from '../services/errorReporter.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { settleTournamentObligation } from './settleObligation.js';
import { settleTournamentPlacesAtomically } from './atomicPlaceSettlement.js';
import { IN_LIST_CHUNK } from '../services/supabase/chunkedIn.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';

/**
 * TOURNEY-AUDIT 2026-07-24: Recover tournaments stuck in COMPLETING by PAYING
 * everything still owed, then completing. The previous recovery blind-flipped
 * COMPLETING → COMPLETED, permanently losing the winner's prize (and any
 * unpaid ITM places) whenever the process died between the COMPLETING claim
 * and the winner credit. Verified live: a COMPLETED bounty MTT with 8 players
 * stranded in 'playing' and only $40 of a $100 guaranteed pool ever paid.
 *
 * Recovery, per stuck tournament (idempotent — safe to re-run):
 *   1. Load tournament + players. Normalize the payout structure to 100%.
 *   2. Refuse an unresolved multi-survivor field. A lone survivor can be
 *      stamped winner; a field with complete standings needs no new ranking.
 *      Every read-only result gate runs before guarantee funding.
 *   3. The complete place-obligation set is prepared, then every place is
 *      paid and the tournament is marked COMPLETED in one database
 *      transaction. A refused leg pays nobody and leaves it COMPLETING.
 */
/**
 * TOURNEY-AUDIT 2026-07-24 (sweep 4): shared cleanup for every server-side
 * tournament CANCELLATION path (restart-orphaned SNG/Spins, >12h stale MTTs).
 * Verified live after sweep 3: cancels left tournament_players rows stranded
 * in 'playing'/'registered' forever (64 new stranded rows within an hour) and
 * left tournament tables open. This helper:
 *   1. Refunds every REAL (non-horse) entrant who hasn't already been paid a
 *      prize: full buy-in + fee, with a fee-reversal row in the rake ledger.
 *   2. Closes all tournament_players rows (playing/registered → eliminated).
 *   3. Closes the tournament's tables.
 * Idempotent: refunds key off rows still open at call time; re-running after
 * step 2 finds nothing left to refund.
 */
export async function refundAndCloseCancelledTournament(
  tournamentId: string,
  tournamentName: string | null,
  refundReason: string
): Promise<void> {
  try {
    const { data: fullT, error: fullTErr } = await supabase
      .from('tournaments')
      .select('buy_in_amount, buy_in_fee, club_id, name')
      .eq('id', tournamentId)
      .maybeSingle();
    // PAYOUT-INTEGRITY 2026-08-25: club_id comes from this row and it is what
    // gates the fee reversal below. A discarded error read as "no club_id", so
    // a transient failure here silently kept every entry fee on a CANCELLED
    // event instead of reversing it, with nothing logged to say so.
    if (fullTErr) {
      reportError(
        new Error(
          `[GameServer] Cancel refund: tournament row unreadable for ${tournamentId.slice(0, 8)}: ${fullTErr.message}`
        ),
        'GameServer.cancel_refund_tournament_unreadable'
      );
    }
    // AUDIT 2026-08-19 (rake/BBJ pass 2): refunds are EVIDENCE-BASED. The old
    // rule "horses paid nothing" became false the day
    // fn_register_horse_for_tournament started charging horses real chips --
    // skipping horses destroyed their buy-in + fee on every cancelled event,
    // and the flat buy_in+fee amount ignored rebuys/add-ons/re-entries. Each
    // open registration is now refunded exactly what that player actually paid
    // for THIS tournament (tournament_buyin debits minus refunds already
    // given), horse or human alike, and the player's un-reversed fee rows are
    // reversed in the rake ledger so a cancelled event's fees net to zero.

    // Open rows = not yet eliminated/paid. Only these are refund candidates.
    const { data: openRows, error: openRowsErr } = await supabase
      .from('tournament_players')
      .select('id, user_id, prize')
      .eq('tournament_id', tournamentId)
      .in('status', ['playing', 'registered']);

    /**
     * PAYOUT-INTEGRITY 2026-08-25: A FAILED QUERY MUST NEVER READ AS "NOBODY
     * IS LEFT" — the same rule the elimination sweep already enforces on its
     * counts, applied here, where the consequence is worse.
     *
     * The error was discarded and `openRows ?? []` turned an unreadable list
     * into an empty one. The refund loop then found nothing to refund, and the
     * code below went on to mark EVERY 'playing'/'registered' row 'eliminated'
     * and close the tables. Net effect of one timeout on a cancelled event:
     * every entrant's buy-in, rebuys and add-ons destroyed, every row closed
     * so the next run finds no candidates either, and not a line in the log.
     *
     * An unreadable list is UNKNOWN. Leave the rows open and leave the tables
     * alone; this helper is idempotent and every caller re-runs it.
     */
    if (openRowsErr) {
      reportError(
        new Error(
          `[GameServer] Cancel refund ABORTED for ${tournamentId.slice(0, 8)}: open-registration list unreadable (${openRowsErr.message}) - refunding nobody and closing nothing this pass`
        ),
        'GameServer.cancel_refund_open_rows_unreadable'
      );
      return;
    }

    for (const row of openRows ?? []) {
      if (Number(row.prize || 0) > 0) continue; // already paid a prize -- no refund on top

      // What did this player actually pay (net of refunds already issued)?
      const { data: txRows, error: txErr } = await supabase
        .from('wallet_transactions')
        .select('type, category, amount')
        .eq('user_id', row.user_id)
        .eq('related_entity_id', tournamentId)
        .in('category', ['tournament_buyin', 'rebuy', 'addon', 'refund']);
      if (txErr) {
        reportError(
          new Error(
            `[GameServer] Cancel refund: payment-evidence read failed for ${row.user_id} ` +
              `(${tournamentId.slice(0, 8)}): ${txErr.message}`
          ),
          'GameServer.cancel_refund_evidence_failed'
        );
        continue;
      }
      // PAYOUT-INTEGRITY 2026-08-20: rebuys and add-ons count as money paid
      // for THIS tournament and must come back on a cancellation. The filter
      // above used to list only 'tournament_buyin', so a player who had
      // rebought or taken an add-on was refunded their entry and silently lost
      // everything else -- despite the comment above this block already
      // stating that ignoring rebuys/add-ons/re-entries was the old bug.
      // (Re-entries are written with category 'rebuy'.)
      let gross = 0;
      let refunded = 0;
      for (const t of txRows ?? []) {
        if (
          t.type === 'debit' &&
          (t.category === 'tournament_buyin' || t.category === 'rebuy' || t.category === 'addon')
        ) {
          gross += Number(t.amount || 0);
        } else if (t.type === 'credit' && t.category === 'refund') {
          refunded += Number(t.amount || 0);
        }
      }
      gross = Math.round(gross * 100) / 100;
      refunded = Math.round(refunded * 100) / 100;
      if (gross <= 0) continue; // never paid (legacy free entry)
      if (gross - refunded <= 0) continue; // already refunded in full

      // ONE SETTLE PATH (2026-09-02): a user-keyed 'refund' obligation,
      // UNIQUE on (tournament, 'refund', user). Every cancel-refund path
      // (startup pre-start sweep, SNG lifecycle sweep, this helper) delegates
      // here and settles the same row, so a re-run refunds nobody twice - the
      // dedupe the old `cancelrefund:{row.id}` key gave, as a constraint.
      //
      // THE AMOUNT IS THE GROSS ENTITLEMENT, NOT THE NET (phase 1.5,
      // 2026-09-02). fn_settle_tournament_obligation takes the TOTAL owed and
      // pays the difference: when it first meets a refund obligation it seeds
      // amount_paid from this player's prior refund credits for this
      // tournament, exactly the credits subtracted above. Passing the net
      // (gross - prior refunds) as the total therefore counted every earlier
      // partial refund twice: gross 20, refunded 5 -> total 15, seeded paid 5
      // -> it paid 10, and the player was 5 short. The total is what the
      // player paid; the function already knows what came back.
      const refund = await settleTournamentObligation(supabase, {
        tournamentId,
        kind: 'refund',
        userId: row.user_id,
        amount: gross,
        source: 'engine.refundAndCloseCancelledTournament',
        memo: `${refundReason}: ${fullT?.name || tournamentName || 'tournament'}`,
      });
      if (!refund.ok) {
        reportError(
          new Error(
            `[GameServer] Cancel refund FAILED for ${row.user_id} (${tournamentId.slice(0, 8)}): ${refund.refused_reason}${refund.transport_error ? ` (${refund.transport_error})` : ''}`
          ),
          'GameServer.cancel_refund_failed'
        );
        continue;
      }

      // Reverse this player's un-reversed fee rows (registration + rebuy fees
      // minus prior reversals -- reversal rows carry the same metadata user_id,
      // so summing every row nets correctly).
      if (fullT?.club_id) {
        const { data: feeRows, error: feeErr } = await supabase
          .from('rake_records')
          .select('rake_amount')
          .eq('tournament_id', tournamentId)
          .eq('is_tournament', true)
          .contains('metadata', { user_id: row.user_id });
        // PAYOUT-INTEGRITY 2026-08-25: `feeRows ?? []` sums to 0 on a failed
        // read, which reads as "this player paid no fee" and skips the
        // reversal for good — the player is already refunded by then, so
        // nothing ever revisits it. Report and skip rather than pretend zero.
        if (feeErr) {
          reportError(
            new Error(
              `[GameServer] Cancel refund: fee-ledger read failed for ${row.user_id.slice(0, 8)} (${tournamentId.slice(0, 8)}): ${feeErr.message} - fee NOT reversed`
            ),
            'GameServer.cancel_refund_fee_read_failed'
          );
          continue;
        }
        const feePaid =
          Math.round((feeRows ?? []).reduce((s, r) => s + Number(r.rake_amount || 0), 0) * 100) /
          100;
        if (feePaid > 0) {
          const { error: revErr } = await supabase.from('rake_records').insert({
            hand_id: null,
            // AUDIT 2026-08-15: table_id has an FK to tables -- a tournament id
            // here violated it; the tournament is carried by tournament_id.
            table_id: null,
            club_id: fullT.club_id,
            rake_amount: -feePaid,
            pot_size: feePaid,
            num_players: 1,
            bbj_contribution: 0,
            is_tournament: true,
            tournament_id: tournamentId,
            source: 'GameServer.cancel_refund',
            metadata: { kind: 'tournament_fee_refund', user_id: row.user_id },
          });
          // LEDGER-INTEGRITY 2026-08-25: the reversal row IS the reversal. A
          // discarded error left the fee booked as club/union revenue on a
          // cancelled event with no trace, and the weekly rakeback basis sums
          // exactly these rows.
          if (revErr) {
            reportError(
              new Error(
                `[GameServer] Cancel refund: fee reversal INSERT failed for ${row.user_id.slice(0, 8)} (${tournamentId.slice(0, 8)}): ${revErr.message} - ${feePaid} still booked as rake`
              ),
              'GameServer.cancel_refund_fee_reversal_failed'
            );
          }
        }
      }
    }

    // Close the player rows so nothing is stranded in 'playing'/'registered'
    // PAYOUT-INTEGRITY 2026-08-25: results checked. This UPDATE is what the
    // whole helper exists to guarantee (sweep 3 left 64 rows stranded in an
    // hour); a silent failure here is indistinguishable from it never running.
    const { error: closeRowsErr } = await supabase
      .from('tournament_players')
      .update({ status: 'eliminated', eliminated_at: new Date().toISOString() })
      .eq('tournament_id', tournamentId)
      .in('status', ['playing', 'registered']);
    if (closeRowsErr) {
      reportError(
        new Error(
          `[GameServer] Cancel refund: could not close player rows for ${tournamentId.slice(0, 8)}: ${closeRowsErr.message} - registrations left stranded`
        ),
        'GameServer.cancel_refund_close_rows_failed'
      );
    }

    // Close the tournament's tables
    const { error: closeTablesErr } = await supabase
      .from('tables')
      .update({ status: 'closed', current_players: 0 })
      .eq('tournament_id', tournamentId)
      .neq('status', 'closed');
    if (closeTablesErr) {
      reportError(
        new Error(
          `[GameServer] Cancel refund: could not close tables for ${tournamentId.slice(0, 8)}: ${closeTablesErr.message}`
        ),
        'GameServer.cancel_refund_close_tables_failed'
      );
    }
  } catch (err) {
    reportError(err, 'GameServer.refundAndCloseCancelledTournament');
  }
}

async function closeRecoveredTournamentTablesAndSeats(tournamentId: string): Promise<boolean> {
  let tableRows: Array<{ id: string }>;
  try {
    const { data, error } = await supabase
      .from('tables')
      .select('id')
      .eq('tournament_id', tournamentId);
    if (error || !data) {
      reportError(
        new Error(
          `[GameServer] recoverStuckCompleting: could not list tables for committed ${tournamentId.slice(0, 8)}: ${error?.message ?? 'no rows returned'}`
        ),
        'GameServer.recoverStuckCompleting_table_list_failed'
      );
      return false;
    }
    tableRows = data as Array<{ id: string }>;
  } catch (error) {
    reportError(error, 'GameServer.recoverStuckCompleting_table_list_threw');
    return false;
  }

  const tableIds = tableRows.map(({ id }) => id).filter(Boolean);
  const leftAt = new Date().toISOString();
  let complete = true;
  for (let offset = 0; offset < tableIds.length; offset += IN_LIST_CHUNK) {
    try {
      const { error } = await supabase
        .from('table_seats')
        .update({ left_at: leftAt })
        .in('table_id', tableIds.slice(offset, offset + IN_LIST_CHUNK))
        .is('left_at', null);
      if (error) {
        complete = false;
        reportError(
          new Error(
            `[GameServer] recoverStuckCompleting: committed ${tournamentId.slice(0, 8)} seat release failed: ${error.message}`
          ),
          'GameServer.recoverStuckCompleting_seat_release_failed'
        );
      }
    } catch (error) {
      complete = false;
      reportError(error, 'GameServer.recoverStuckCompleting_seat_release_threw');
    }
  }

  if (!complete) return false;

  try {
    const { error } = await supabase
      .from('tables')
      .update({ status: 'closed', current_players: 0 })
      .eq('tournament_id', tournamentId);
    if (error) {
      complete = false;
      reportError(
        new Error(
          `[GameServer] recoverStuckCompleting: committed ${tournamentId.slice(0, 8)} table closure failed: ${error.message}`
        ),
        'GameServer.recoverStuckCompleting_close_tables_failed'
      );
    }
  } catch (error) {
    complete = false;
    reportError(error, 'GameServer.recoverStuckCompleting_close_tables_threw');
  }

  if (!complete) return false;

  try {
    const [{ data: terminalTables, error: tableProofError }, seatProof] = await Promise.all([
      supabase
        .from('tables')
        .select('id, status, current_players')
        .eq('tournament_id', tournamentId),
      tableIds.length > 0
        ? supabase
            .from('table_seats')
            .select('id', { count: 'exact', head: true })
            .in('table_id', tableIds)
            .is('left_at', null)
        : Promise.resolve({ count: 0, error: null }),
    ]);
    const nonterminal = (terminalTables ?? []).filter(
      (table) => table.status !== 'closed' || Number(table.current_players ?? 0) !== 0
    );
    if (
      tableProofError ||
      !terminalTables ||
      terminalTables.length !== tableRows.length ||
      nonterminal.length > 0 ||
      seatProof.error ||
      seatProof.count !== 0
    ) {
      reportError(
        new Error(
          `[GameServer] recoverStuckCompleting: committed ${tournamentId.slice(0, 8)} cleanup proof failed: ${tableProofError?.message ?? seatProof.error?.message ?? `${nonterminal.length} nonterminal table(s), ${seatProof.count ?? 'unknown'} live seat(s)`}`
        ),
        'GameServer.recoverStuckCompleting_cleanup_proof_failed'
      );
      return false;
    }
  } catch (error) {
    reportError(error, 'GameServer.recoverStuckCompleting_cleanup_proof_threw');
    return false;
  }
  return complete;
}

export async function recoverStuckCompletingTournaments(
  reason: string,
  onlyTournamentId?: string
): Promise<void> {
  try {
    let q = supabase
      .from('tournaments')
      // variant / tournament_type / spin_multiplier: a rescued Spin whose
      // payout_structure is unreadable would otherwise pay NOBODY (an empty
      // structure makes computePlacePrize return 0 for every place). The spec
      // rebuilds it from the multiplier. Same rule as the two live payout
      // sites — see payoutStructure.ts.
      // started_at: NO RESULT WITHOUT A HAND (2026-09-01) needs to know how old
      // the event is before it trusts an empty hand_history - see
      // recoveryRankEvidence.ts on the 7-day horse-only prune.
      .select(
        'id, name, status, prize_pool, guaranteed_prize, prize_pool_finalized, payout_structure, variant, tournament_type, satellite_target_id, spin_multiplier, started_at'
      );
    // The periodic sweep stays bounded to active recovery work. An explicit
    // tournament recovery also accepts COMPLETED so an operator can re-drive
    // only the idempotent table/seat closure after a lost settlement receipt.
    q = onlyTournamentId
      ? q.eq('id', onlyTournamentId).in('status', ['COMPLETING', 'COMPLETED'])
      : q.eq('status', 'COMPLETING');
    const { data: stuck, error: stuckErr } = await q;
    // PAYOUT-INTEGRITY 2026-08-25: an unreadable list is not an empty one. The
    // discarded error made a failed scan indistinguishable from "nothing is
    // stuck", which is the one thing this watchdog exists to detect.
    if (stuckErr) {
      reportError(
        new Error(
          `[GameServer] recoverStuckCompleting (${reason}): COMPLETING scan failed: ${stuckErr.message} - recovered nothing this pass`
        ),
        'GameServer.recoverStuckCompleting_scan_failed'
      );
      return;
    }
    for (const t of stuck ?? []) {
      try {
        if ((t as { status?: string }).status === 'COMPLETED') {
          const cleanupComplete = await closeRecoveredTournamentTablesAndSeats(t.id);
          if (!cleanupComplete) {
            throw new Error(
              `durably completed tournament ${t.id.slice(0, 8)} could not prove table and seat cleanup`
            );
          }
          continue;
        }
        // Recovery holds service_role, which deliberately bypasses the SQL
        // maintenance trigger. Completed cleanup above is non-financial; a
        // COMPLETING row below can fund a guarantee and settle real chips, so
        // it waits intact for the first recovery pass after thaw.
        if (isMaintenanceFrozen()) continue;
        /**
         * ═══════════════════════════════════════════════════════════════════
         *  A SATELLITE PAYS SEATS, NOT CASH — AND THIS PATH DID NOT KNOW
         *  (2026-08-29)
         * ═══════════════════════════════════════════════════════════════════
         *
         * Both live payout sites refuse to pay per-place cash on a satellite:
         * `eliminatePlayer` checks `variant === 'satellite'` before pricing,
         * and `finishTournament` does the same. This rescue never did, though
         * it selects `variant` (for the Spin structure rebuild) and had it in
         * hand the whole time.
         *
         * The consequence is a race for real money. A satellite stuck in
         * COMPLETING gets paid cash from `payout_structure` under
         * `tourney:{id}:prize:place:{N}` -- the IDENTICAL key
         * `processSatelliteAwards` uses to pay the ticket value. Whichever
         * path runs first wins, the second silently credits nothing, and the
         * two amounts are different: a player receives either the seat's worth
         * or the structure prize depending on which lost the race. If this
         * path wins, the seats are never awarded at all and the target
         * tournament's field is never funded.
         *
         * Leaving it COMPLETING is the safe outcome: processSatelliteAwards is
         * the only thing that should finish it, and it is driven separately.
         */
        if (
          String((t as { variant?: string }).variant ?? '').toLowerCase() === 'satellite' ||
          String((t as { tournament_type?: string }).tournament_type ?? '').toUpperCase() ===
            'SATELLITE' ||
          Boolean((t as { satellite_target_id?: string | null }).satellite_target_id)
        ) {
          /**
           * A STUCK SATELLITE MUST GO SOMEWHERE (2026-08-30).
           *
           * "Left COMPLETING for processSatelliteAwards" was a promise nobody
           * kept: a COMPLETING tournament is not RUNNING, so discovery never
           * resumes a manager for it, and processSatelliteAwards only runs
           * inside a manager's finish path. Observed live: one satellite sat
           * with 3 players still 'playing' and another with its ENTIRE
           * 24-player field alive and zero hands dealt — both looping through
           * this skip forever, no manager, no felt, no exit.
           *
           * The rule that resolves it: a satellite that is NOT decided is not
           * completing. Two or more entrants alive means play remains — flip
           * it back to RUNNING and discovery resumes a manager within a cycle;
           * the event then finishes through the normal path, awards included.
           * A DECIDED satellite (fewer than two alive) is left COMPLETING and
           * reported, as before, for the awards pass its manager owes it —
           * flipping that one would deal cards at a settled event.
           */
          const { count: aliveCount, error: aliveErr } = await supabase
            .from('tournament_players')
            .select('id', { count: 'exact', head: true })
            .eq('tournament_id', t.id)
            .in('status', ['playing', 'registered']);
          if (!aliveErr && typeof aliveCount === 'number' && aliveCount >= 2) {
            const { error: reviveErr } = await supabase
              .from('tournaments')
              .update({ status: 'RUNNING' })
              .eq('id', t.id)
              .eq('status', 'COMPLETING');
            reportError(
              new Error(
                `[GameServer] recoverStuckCompleting (${reason}): ${t.id.slice(0, 8)} is an UNDECIDED satellite (${aliveCount} alive) stuck in COMPLETING - ${reviveErr ? `revive failed: ${reviveErr.message}` : 'flipped back to RUNNING for discovery to resume'}`
              ),
              'GameServer.recoverStuckCompleting_satellite_revived'
            );
            continue;
          }
          /**
           * A DECIDED SATELLITE MUST ALSO GO SOMEWHERE (2026-08-31, phase 5).
           *
           * The 2026-08-30 rule above resolved the UNDECIDED case and left
           * this one exactly as it found it: reported, then `continue`, on
           * every recovery cycle, forever. The comment two blocks up already
           * admits why that is terminal - "a COMPLETING tournament is not
           * RUNNING, so discovery never resumes a manager for it, and
           * processSatelliteAwards only runs inside a manager's finish path."
           * Nothing else drives it. Grepped: no pg_cron job, no edge
           * function, no workflow, no other caller anywhere transitions a
           * COMPLETING satellite. The pool was collected and the seats are
           * never awarded.
           *
           * Worse, leaving the row COMPLETING is not merely inert, it is
           * ACTIVELY BLOCKING: finishTournament claims the event with
           * `.eq('status', 'RUNNING')`, so even if a manager did resume, the
           * claim would return no row and the awards pass would be skipped.
           *
           * Three outcomes, and every stuck satellite now takes one:
           *
           *   ALREADY AWARDED  -> COMPLETED. Phase 3's payout record is what
           *     makes "did this satellite already pay?" answerable at all;
           *     before it there was nothing to ask. A seat carrying this
           *     satellite's id in the target counts too, for events that ran
           *     before the record existed.
           *
           *   ONE SURVIVOR     -> RUNNING. The manager resumes, the
           *     elimination sweep sees remainingCount <= 1 on its first tick
           *     and runs the finish path, awards included. It cannot deal a
           *     card on the way: minPlayersToDeal() is 2 for a tournament
           *     table, so the loop parks in `idle_not_enough_players`. That
           *     answers the "flipping that one would deal cards at a settled
           *     event" worry in the block above - measured, not assumed.
           *     The survivor holds no position yet, so stamping them first
           *     cannot collide with an existing place.
           *
           *   NOBODY ALIVE, NOTHING AWARDED -> a CRITICAL alert, and it stays
           *     COMPLETING. Here the engine would fall back to treating the
           *     LAST ELIMINATED player as the winner, which in a normal
           *     finish is second place. Guessing a winner and then moving
           *     money on the guess is not a repair. A human decides this one.
           *
           * Idempotent if it re-drives: every cash leg is keyed
           * `tourney:{id}:prize:place:{n}` (or `:satremainder:{user}:{n}`)
           * and the seat leg dedupes on the target's unique registration, so
           * a satellite that already paid pays nobody twice.
           */
          const [{ count: recordCount }, { count: seatCount }] = await Promise.all([
            supabase
              .from('tournament_payouts')
              .select('id', { count: 'exact', head: true })
              .eq('tournament_id', t.id),
            supabase
              .from('tournament_players')
              .select('id', { count: 'exact', head: true })
              .eq('source_satellite_id', t.id),
          ]);
          const alreadyAwarded = (recordCount ?? 0) > 0 || (seatCount ?? 0) > 0;

          if (alreadyAwarded) {
            const { error: closeErr } = await supabase
              .from('tournaments')
              .update({ status: 'COMPLETED', ended_at: new Date().toISOString() })
              .eq('id', t.id)
              .eq('status', 'COMPLETING');
            reportError(
              new Error(
                `[GameServer] recoverStuckCompleting (${reason}): ${t.id.slice(0, 8)} is a DECIDED satellite that ALREADY AWARDED (${recordCount ?? 0} payout record(s), ${seatCount ?? 0} seat(s)) - ${closeErr ? `close failed: ${closeErr.message}` : 'closed COMPLETING -> COMPLETED'}`
              ),
              'GameServer.recoverStuckCompleting_satellite_closed'
            );
            continue;
          }

          if (typeof aliveCount === 'number' && aliveCount === 1) {
            const { error: reviveErr } = await supabase
              .from('tournaments')
              .update({ status: 'RUNNING' })
              .eq('id', t.id)
              .eq('status', 'COMPLETING');
            reportError(
              new Error(
                `[GameServer] recoverStuckCompleting (${reason}): ${t.id.slice(0, 8)} is a DECIDED satellite with ONE SURVIVOR and no awards - ${reviveErr ? `revive failed: ${reviveErr.message}` : 'flipped back to RUNNING so its manager can run processSatelliteAwards'}`
              ),
              'GameServer.recoverStuckCompleting_satellite_revived_decided'
            );
            continue;
          }

          await raiseFinancialAlert(
            'critical',
            'Satellite.stuck_completing_unawarded',
            'A satellite is stuck COMPLETING with no survivor and no seats or payouts awarded. Its pool was collected and nobody has been paid. Deciding the winner is a human call: the engine would fall back to the LAST ELIMINATED player, which in a normal finish is second place.',
            {
              tournament_id: t.id,
              tournament_name: (t as { name?: string }).name ?? null,
              reason,
              alive_count: aliveCount ?? null,
              prize_pool: (t as { prize_pool?: number }).prize_pool ?? null,
              satellite_target_id:
                (t as { satellite_target_id?: string }).satellite_target_id ?? null,
            }
          );
          reportError(
            new Error(
              `[GameServer] recoverStuckCompleting (${reason}): ${t.id.slice(0, 8)} is a SATELLITE - it awards seats, not structure cash. Decided, nothing awarded, no survivor to re-drive: left COMPLETING and raised a critical alert.`
            ),
            'GameServer.recoverStuckCompleting_satellite_skipped'
          );
          continue;
        }

        /**
         * A CHOPPED EVENT HAS ALREADY AGREED ITS OWN PAYOUTS (2026-08-29).
         *
         * `settleFinalTableDeal` pays under `tourney:{id}:ftd:{user}`, a
         * namespace this path never writes -- so nothing dedupes. Step 3 below
         * tops up any eliminated player whose STRUCTURE prize exceeds their
         * agreed chop share, which is brand new money on top of a deal the
         * players negotiated. The emitting side already knows this rescue can
         * reach a dealt event; the guard belongs on this side too.
         */
        const [dealPayouts, dealObligations] = await Promise.all([
          supabase
            .from('tournament_payouts')
            .select('id')
            .eq('tournament_id', t.id)
            .eq('source', 'final_table_deal')
            .limit(1),
          supabase
            .from('tournament_obligations')
            .select('id')
            .eq('tournament_id', t.id)
            .eq('kind', 'final_table_deal')
            .limit(1),
        ]);

        if (dealPayouts.error || dealObligations.error) {
          // Unreadable is UNKNOWN. Paying structure cash over a deal that may
          // exist is exactly the thing this guard is for.
          reportError(
            new Error(
              `[GameServer] recoverStuckCompleting (${reason}): could not tell whether ${t.id.slice(0, 8)} was chopped (${dealPayouts.error?.message ?? dealObligations.error?.message}) - skipped rather than risk paying over a deal`
            ),
            'GameServer.recoverStuckCompleting_deal_check_failed'
          );
          continue;
        }

        if ((dealPayouts.data?.length ?? 0) > 0 || (dealObligations.data?.length ?? 0) > 0) {
          // The event may have completed after this sweep selected its stale
          // COMPLETING snapshot. A committed deal authorizes table/seat
          // cleanup, never the structure-payment path below it.
          const { data: committed, error: committedError } = await supabase
            .from('tournaments')
            .select('status')
            .eq('id', t.id)
            .maybeSingle();
          if (committedError) {
            reportError(
              new Error(
                `[GameServer] recoverStuckCompleting (${reason}): deal evidence exists for ${t.id.slice(0, 8)} but terminal status is unreadable (${committedError.message}); refusing structure money and leaving cleanup for retry`
              ),
              'GameServer.recoverStuckCompleting_deal_status_unreadable'
            );
            continue;
          }
          if (committed?.status === 'COMPLETED') {
            const cleanupComplete = await closeRecoveredTournamentTablesAndSeats(t.id);
            if (!cleanupComplete) {
              throw new Error(
                `durably completed final-table deal ${t.id.slice(0, 8)} could not prove table and seat cleanup`
              );
            }
            console.log(
              `[GameServer] recoverStuckCompleting (${reason}): ${t.id.slice(0, 8)} has a durably completed final-table deal; closed its seats/tables without entering the structure money path`
            );
            continue;
          }
          reportError(
            new Error(
              `[GameServer] recoverStuckCompleting (${reason}): ${t.id.slice(0, 8)} settled by a final-table deal - structure prizes would be new money on top of it. Skipped.`
            ),
            'GameServer.recoverStuckCompleting_chopped_skipped'
          );
          continue;
        }

        /* Everything through the collision check is evidence gathering only.
           The guarantee RPC can debit a treasury and finalize the pool, so it
           must not run until this recovery has proved that it has a result it
           is authorized to settle. */
        const { data: players, error: playersErr } = await supabase
          .from('tournament_players')
          .select('id, user_id, status, position, prize, chips')
          .eq('tournament_id', t.id);

        /**
         * PAYOUT-INTEGRITY 2026-08-25: THE WORST INSTANCE OF "A FAILED QUERY
         * READ AS NOBODY IS LEFT" IN THIS ESTATE.
         *
         * The error was discarded and `players ?? []` turned an unreadable
         * field into an empty one. `alive` was then empty, so step 2 paid
         * NOBODY and step 3 topped up nobody - and step 4 went right on to
         * flip COMPLETING -> COMPLETED. That is terminal: this watchdog only
         * ever looks at COMPLETING, so the tournament it just silently
         * emptied can never be rescued again, by it or by anything else. One
         * timeout permanently destroys the winner's prize and every unpaid
         * ITM place, on the exact code path written to stop that happening.
         *
         * Throw so the per-tournament catch reports it and the tournament
         * stays COMPLETING for the next pass. Every step below is idempotent,
         * so retrying costs nothing.
         */
        if (playersErr) {
          throw new Error(
            `player field unreadable for ${t.id.slice(0, 8)} "${t.name}": ${playersErr.message} - refusing to complete a tournament we cannot pay`
          );
        }
        const rows = players ?? [];

        // SHORT-FIELD RESIDUAL 2026-08-27: the rescue must price by the same
        // structure a normal finish would, and a normal finish now trims the
        // structure to the size of the field so the residual lands on a place
        // somebody actually reached. A stuck tournament is COMPLETING, so
        // entry is long closed and this count can no longer move. The fully
        // checked roster above is the authoritative field. A second
        // count used to discard its own error and silently fall back to an
        // untrimmed structure; that made a read failure change real prizes.
        const fieldCount = rows.length;

        // Parse + normalize payout structure
        const payouts: Array<{ place: number; percentage: number }> =
          resolvePayoutStructure(t as any, fieldCount >= 1 ? fieldCount : undefined) ?? [];

        /**
         * ═══════════════════════════════════════════════════════════════════
         *  A TOURNAMENT WITH MORE SURVIVORS THAN PRIZES IS NOT FINISHING
         *  (2026-08-30)
         * ═══════════════════════════════════════════════════════════════════
         *
         * This rescue exists for a tournament that crashed BETWEEN the
         * COMPLETING claim and the payout — the finish had happened, the money
         * had not. It ranks whoever is left by chip count and pays the
         * structure. That is right for a finish, and catastrophic for a
         * tournament that was merely still being played when the engine died,
         * because it has no idea which of the two it is looking at.
         *
         * On 2026-08-30 it paid a 20,880 prize pool to the top nine by
         * chipstack on the Sunday $200 Deep Stack. That event was at LEVEL 7
         * of twelve late-registration levels with NINETY players still holding
         * 2,730,654 chips. Nothing was finishing. Supabase had gone into
         * RESIZING, the engine died mid-flight, the tournament was left in
         * COMPLETING, and this function — which runs on EVERY boot, via
         * `recoverStuckCompletingTournaments('startup-cleanup')` — settled it
         * on the way back up. The places were chip counts, not results.
         *
         * The sibling sweep thirty lines above it in GameServer already knows
         * how to ask this question ("found recent hands in last hour (still
         * active) — skipping"). That guard was simply never given to this path.
         *
         * WHY THIS TEST AND NOT A TIME-BASED ONE. "Dealt a hand recently" does
         * not separate the two cases: a tournament that crashes during
         * finishTournament also dealt its last hand seconds earlier, so any
         * recency window short enough to catch a live event would also block
         * the legitimate rescue this function exists to perform. The structural
         * question has no such overlap — an event at its finish cannot have
         * more players left than it has places to pay. Ninety survivors against
         * eighteen paid places is not a close call, and it needs no clock.
         *
         * REFUSING IS THE SAFE SIDE. A refusal leaves the tournament in
         * COMPLETING, which is where it already was; every step below is
         * idempotent, the next pass retries, and the alert names the numbers so
         * a human can settle it deliberately. Paying wrongly moves real chips
         * out of the club to players who did not win them, and today that took
         * an approved reversal to undo.
         */
        const livePlayers = rows.filter((r) => r.status === 'playing').length;
        const paidPlaces = payouts.length;
        if (fieldIsStillLive({ livePlayers, paidPlaces })) {
          reportError(
            new Error(
              `[GameServer] recoverStuckCompleting (${reason}): ${t.id.slice(0, 8)} "${t.name}" ` +
                `has ${livePlayers} player(s) still playing against ${paidPlaces} paid place(s) - ` +
                'that is a tournament that was still being PLAYED when its engine died, not one ' +
                'that was finishing. Refusing to rank it by chipstack and pay the structure; left ' +
                'in COMPLETING for a live engine to resume or an operator to settle.'
            ),
            'GameServer.recoverStuckCompleting_field_still_live'
          );
          continue;
        }

        // 2. Rank the still-alive players by chips. Do not move money here:
        // every result must be durable before the atomic settlement begins.
        const alive = rows
          .filter((r) => r.status === 'playing' || r.status === 'registered')
          .sort((a, b) => Number(b.chips || 0) - Number(a.chips || 0));

        /**
         * A recovery snapshot can prove a champion only when one survivor is
         * left. With two or more, chip count is merely the current order, not
         * final finishing evidence, even when every stack is distinct and the
         * payout ladder is deep enough to include them all. Stamping that
         * order also creates a non-atomic series of result writes whose retry
         * collides with the positions it wrote before a process exit.
         *
         * Existing complete standings have no survivors and pass through.
         * One survivor may safely be stamped winner after every other
         * read-only proof below succeeds. Anything larger requires resumed
         * play or an operator-supplied result, so leave it COMPLETING without
         * funding the guarantee.
         */
        if (alive.length > 1) {
          reportError(
            new Error(
              `[GameServer] recoverStuckCompleting (${reason}): ${t.id.slice(0, 8)} "${t.name}" has ${alive.length} survivors. Chip stacks do not prove their final order, so recovery will not invent multiple finishing places. No payout or guarantee funding is authorized; left COMPLETING for resumed play or operator review.`
            ),
            'GameServer.recoverStuckCompleting_multiple_survivors_unresolved'
          );
          continue;
        }

        /**
         * ═══════════════════════════════════════════════════════════════════
         *  YOU CANNOT RANK A PODIUM OUT OF PLAYERS WHO NEVER SAT (2026-08-31)
         * ═══════════════════════════════════════════════════════════════════
         *
         * `alive` deliberately includes `registered` rows, because a genuine
         * late registrant can still be waiting on ensureLateRegSeated when a
         * decided game is recovered, and that player is owed their place.
         *
         * But when EVERY alive row is `registered`, nobody in that set has
         * been dealt a card in this event. They all hold the same starting
         * stack, so the `chips` sort that assigns places 1..N is not a
         * ranking at all — it is arbitrary order, and the recovery pays the
         * whole published structure against it.
         *
         * MEASURED LIVE. Sunday $200 Deep Stack dfae9288 on 2026-08-30 at
         * 19:47 UTC — 73 minutes BEFORE its own start — was walked through
         * this path and paid places 1..9 (20,880 chips) to registered
         * entrants. Two of them, be61d864 and 484d22c4, were handed 1st and
         * 2nd; when the event actually ran they finished 107th and 87th. The
         * real podium was then paid a second time by
         * fn_tournament_payout_reconcile at 02:32, whose key is
         * `...:prize:{user}:{place}:reconcile` and so does not dedupe against
         * this path's `...:prize:place:{N}`. The event disbursed 62,841.60
         * against a 44,640.00 pool — 141%.
         *
         * A tournament with no `playing` row is not a decided tournament, it
         * is one that never dealt. Pay nobody, say so, and leave it COMPLETING
         * for human review or a future evidence-driven recovery — the same stance this function
         * already takes for a position collision below.
         */
        const anyDealtIn = alive.some((r) => r.status === 'playing');
        if (alive.length > 0 && !anyDealtIn) {
          reportError(
            new Error(
              `[GameServer] recoverStuckCompleting: ${t.id.slice(0, 8)} "${t.name}" - all ${alive.length} surviving entrant(s) are still 'registered', so none of them has been dealt a card in this event. Ranking them by chips would invent a podium. Paying nobody; left COMPLETING for review.`
            ),
            'GameServer.recoverStuckCompleting_no_dealt_in_survivor'
          );
          continue;
        }

        /**
         * ═══════════════════════════════════════════════════════════════════
         *  NO RESULT WITHOUT A HAND (2026-09-01)
         * ═══════════════════════════════════════════════════════════════════
         *
         * The guard directly above asks whether any survivor is 'playing' and
         * reads that as "somebody was dealt a card". It is a proxy for the real
         * question and it is the wrong one: an event promotes its whole field
         * to 'playing' the moment it starts, before a card exists. Seven events
         * between 2026-08-15 and 2026-08-30 were ranked end to end here with
         * `hand_history` empty and every survivor holding exactly
         * `starting_chips` - 313 and 326 entrants in two of them - and 775.00
         * chips were paid against those invented podiums. The full table, and
         * why `fieldIsStillLive` abstained on a 313-player field, are in
         * recoveryRankEvidence.ts.
         *
         * Two independent tests, because they fail in different weather.
         *
         * ONE - THE SORT MUST ACTUALLY SORT. `alive` is ordered by chips and
         * places are handed out 1..N against that order. If every survivor
         * holds the same stack to the chip, that order is whatever Postgres
         * returned, not a result. This costs no query: the chips are already
         * in `rows`, it is immune to the hand-history prune, and a genuine
         * crash-at-finish never trips it (one survivor is skipped by design,
         * and a real finish has a chip leader).
         *
         * TWO - AND NO HAND WAS DEALT AT ALL. Stated outright rather than
         * inferred, for the case where stacks differ for some reason that is
         * not poker. Bounded to events younger than the horse-only retention
         * window, because past that an empty `hand_history` means the prune
         * ran, not that nothing happened.
         *
         * REFUSING IS THE SAFE SIDE, exactly as for the two guards above: the
         * tournament stays COMPLETING, which is where it already was, every
         * step below is idempotent, the next pass retries, and the alert names
         * the numbers so a human can settle it deliberately.
         */
        if (chipsCannotRank(alive)) {
          reportError(
            new Error(
              `[GameServer] recoverStuckCompleting: ${t.id.slice(0, 8)} "${t.name}" - all ${alive.length} survivor(s) hold an identical stack of ${Math.floor(Number(alive[0]?.chips) || 0)} chips, so ranking them by chips would hand out places in arbitrary order. Paying nobody; left COMPLETING for review.`
            ),
            'GameServer.recoverStuckCompleting_chips_cannot_rank'
          );
          continue;
        }

        const { data: anyHand, error: handErr } = await supabase
          .from('hand_history')
          .select('id')
          .eq('tournament_id', t.id)
          .limit(1)
          .maybeSingle();
        // An unreadable hand list is UNKNOWN, and UNKNOWN never authorizes a
        // payout on this path. Same stance as the player-field read above.
        if (handErr) {
          reportError(
            new Error(
              `[GameServer] recoverStuckCompleting: ${t.id.slice(0, 8)} "${t.name}" - hand list unreadable (${handErr.message}), so we cannot tell a finished event from one that never dealt. Paying nobody; left COMPLETING.`
            ),
            'GameServer.recoverStuckCompleting_hand_evidence_unreadable'
          );
          continue;
        }
        if (
          noHandWasEverDealt({
            startedAt: (t as { started_at?: string | null }).started_at ?? null,
            anyHandDealt: Boolean(anyHand),
          })
        ) {
          reportError(
            new Error(
              `[GameServer] recoverStuckCompleting: ${t.id.slice(0, 8)} "${t.name}" - not one hand was ever dealt in this event, so it has no result to pay. Ranking its ${alive.length} entrant(s) would invent one. Paying nobody; left COMPLETING for review.`
            ),
            'GameServer.recoverStuckCompleting_no_hand_ever_dealt'
          );
          continue;
        }

        /**
         * PAYOUT-INTEGRITY 2026-08-25: places must be DISTINCT here too.
         *
         * The survivors are handed places 1..alive.length unconditionally,
         * with no regard for what the already-eliminated rows hold. A row that
         * busted while the field was small can be sitting on one of those same
         * places, and then two different users hold it. The wallet key is
         * `tourney:{id}:prize:{user}:{place}` — it dedupes a repeated USER, not
         * a repeated PLACE — so both are paid in full and the pool pays out
         * over 100%. It is the identical shape as the `Math.max(2, ...)` clamp
         * that cost 11 tournaments 12 extra payments in the bust sweep.
         *
         * A collision means we genuinely do not know who is owed which place,
         * and guessing moves money. Report and leave the tournament COMPLETING
         * for human review or a future evidence-driven recovery; every caller re-runs this watchdog.
         */
        /* 2026-08-29: this tested `status === 'eliminated'` only, and
           finishTournament stamps the champion `status: 'winner', position: 1`.
           So if the process died between that stamp and the COMPLETED flip --
           the exact window this watchdog exists for -- the winner was INVISIBLE
           to the collision check, place 1 read as free, and the lone surviving
           player was handed it. The credit dedupes against the real winner's
           payment under the same place-scoped key, so nobody is paid twice;
           what happens instead is worse to diagnose: the survivor is stamped
           'winner' with first prize and receives NOTHING, and the place they
           actually finished in is never paid to anybody.

           Any row holding a finishing place claims it, whatever its status. */
        const claimed = new Map<number, string>();
        for (const r of rows) {
          const pos = Number(r.position);
          if (
            (r.status === 'eliminated' || r.status === 'winner') &&
            Number.isFinite(pos) &&
            pos > 0
          ) {
            claimed.set(pos, r.user_id);
          }
        }
        const collisions = alive
          .map((_, i) => i + 1)
          .filter((place) => claimed.has(place))
          .map((place) => `${place} (held by ${String(claimed.get(place)).slice(0, 8)})`);
        if (collisions.length > 0) {
          reportError(
            new Error(
              `[GameServer] recoverStuckCompleting: ${t.id.slice(0, 8)} "${t.name}" - ${alive.length} survivor(s) would be given place(s) already held by eliminated players: ${collisions.join(', ')}. Paying nobody; left COMPLETING for review.`
            ),
            'GameServer.recoverStuckCompleting_position_collision'
          );
          continue;
        }

        /* All ranking and result evidence is now proven. Close the same
           guarantee-funding window as the live finish path through the
           canonical idempotent transaction, then re-read the authoritative
           row. No amount-dependent result may be written unless the stored
           pool is final, covers the advertised floor and agrees with the RPC. */
        if (isMaintenanceFrozen()) continue;
        const { data: guaranteeData, error: guaranteeErr } = await supabase.rpc(
          'fn_apply_prize_guarantee',
          { p_tournament_id: t.id, p_source: 'engine.recoverStuckCompleting' }
        );
        const guarantee = (guaranteeData ?? {}) as {
          ok?: boolean;
          reason?: string;
          prize_pool?: number | string;
        };
        if (guaranteeErr || guarantee.ok !== true) {
          throw new Error(
            `could not fund/finalize prize pool for ${t.id.slice(0, 8)}: ${guaranteeErr?.message ?? guarantee.reason ?? 'unknown refusal'}`
          );
        }

        const { data: fundedRow, error: fundedReadErr } = await supabase
          .from('tournaments')
          .select('prize_pool, guaranteed_prize, prize_pool_finalized')
          .eq('id', t.id)
          .maybeSingle();
        const fundedPool = Number(fundedRow?.prize_pool);
        const fundedGuarantee = Number(fundedRow?.guaranteed_prize ?? 0);
        const rpcPool = Number(guarantee.prize_pool);
        if (
          fundedReadErr ||
          !fundedRow ||
          !Number.isFinite(fundedPool) ||
          !Number.isFinite(rpcPool) ||
          fundedRow.prize_pool_finalized !== true ||
          fundedPool + 0.005 < fundedGuarantee ||
          Math.abs(fundedPool - rpcPool) >= 0.005
        ) {
          throw new Error(
            `funded prize pool is not provably final for ${t.id.slice(0, 8)} (${fundedReadErr?.message ?? `rpc=${rpcPool}, row=${fundedPool}, guarantee=${fundedGuarantee}, finalized=${String(fundedRow?.prize_pool_finalized)}`})`
          );
        }
        (t as { prize_pool?: number }).prize_pool = fundedPool;
        (t as { guaranteed_prize?: number }).guaranteed_prize = fundedGuarantee;
        (t as { prize_pool_finalized?: boolean }).prize_pool_finalized = true;

        /* Stamp only the one survivor the read-only evidence proved. Prize is
           deliberately zero here: final chronology must be normalized before
           any entitlement is derived from a position. */
        for (let i = 0; i < alive.length; i++) {
          const place = i + 1;
          const { data: stamped, error: stampErr } = await supabase
            .from('tournament_players')
            .update({
              status: place === 1 ? 'winner' : 'eliminated',
              position: place,
              prize: 0,
              eliminated_at: place === 1 ? null : new Date().toISOString(),
            })
            .eq('id', alive[i].id)
            .select('id')
            .maybeSingle();
          if (stampErr || !stamped) {
            throw new Error(
              `could not record place ${place} for ${alive[i].user_id.slice(0, 8)} before settlement: ${stampErr?.message ?? 'row not found'}`
            );
          }
        }

        /* Publish the complete chronology in one database transaction before
           using any position to calculate money. A prior process may have
           left a provisional late-registration ladder that is contiguous yet
           wrong; the RPC compares every row to canonical bust-time order and
           refuses if historical payout evidence contradicts that result. */
        const { data: normalizedData, error: normalizedErr } = await supabase.rpc(
          'fn_normalize_tournament_final_standings',
          { p_tournament_id: t.id }
        );
        const normalized = (normalizedData ?? {}) as {
          ok?: boolean;
          reason?: string;
          detail?: string;
        };
        if (normalizedErr || normalized.ok !== true) {
          throw new Error(
            `atomic final-standings normalization refused for ${t.id.slice(0, 8)}: ${normalizedErr?.message ?? normalized.reason ?? 'unknown'}${normalized.detail ? ` (${normalized.detail})` : ''}`
          );
        }

        const { data: normalizedRows, error: normalizedRowsErr } = await supabase
          .from('tournament_players')
          .select('id, user_id, status, position, prize')
          .eq('tournament_id', t.id);
        if (normalizedRowsErr || !normalizedRows || normalizedRows.length !== fieldCount) {
          throw new Error(
            `could not re-read the normalized final field for ${t.id.slice(0, 8)}: ${normalizedRowsErr?.message ?? `expected ${fieldCount} rows, read ${normalizedRows?.length ?? 0}`}`
          );
        }

        // PAYOUT-INTEGRITY 2026-08-20: derive every exact-cent entitlement
        // only from the normalized final positions and the funded pool.
        const prizeFor = (place: number): number =>
          computePlacePrize(Number(t.prize_pool || 0), payouts, place);
        for (const row of normalizedRows) {
          if (
            (row.status !== 'eliminated' && row.status !== 'winner') ||
            !Number.isInteger(Number(row.position))
          ) {
            throw new Error(`normalized result row ${row.id} is not terminal and ranked`);
          }
          const place = Number(row.position);
          const owed = prizeFor(place);
          if (Math.abs(owed - Number(row.prize || 0)) < 0.005) continue;
          const { data: updated, error: entitlementErr } = await supabase
            .from('tournament_players')
            .update({ prize: owed })
            .eq('id', row.id)
            .select('id')
            .maybeSingle();
          if (entitlementErr || !updated) {
            throw new Error(
              `could not record final entitlement for place ${place} (${row.user_id.slice(0, 8)}) before settlement: ${entitlementErr?.message ?? 'row not found'}`
            );
          }
        }

        // 3.5 Settle the fee ledger. SETTLEMENT INTEGRITY 2026-08-26: this
        // path finishes tournaments whose engine died mid-finish — which is
        // exactly the population whose rake never landed (settleTournamentRake
        // only ran on the happy path). fn_settle_tournament_rake is
        // PK-claimed and idempotent, so calling it here can never double-pay
        // against a finish that already settled; it only closes the hole
        // where nobody did. Non-fatal: the sweep re-drives any failure.
        if (isMaintenanceFrozen()) continue;
        try {
          const { data: rakeRes, error: rakeErr } = await supabase.rpc(
            'fn_settle_tournament_rake',
            { p_tournament_id: t.id, p_source: 'recovery' }
          );
          if (rakeErr || !rakeRes?.ok) {
            reportError(
              new Error(
                `[GameServer] recoverStuckCompleting: rake settlement failed for ${t.id.slice(0, 8)}: ${rakeErr?.message || rakeRes?.reason} - sweep will re-drive`
              ),
              'GameServer.recoverStuckCompleting_rake_settle_failed'
            );
          } else if (!rakeRes.already_settled && Number(rakeRes.amount) > 0) {
            console.log(
              `[GameServer] recoverStuckCompleting: rake settled for ${t.id.slice(0, 8)}: ${rakeRes.amount} -> ${rakeRes.destination}`
            );
          }
        } catch (rakeEx) {
          reportError(rakeEx, 'GameServer.recoverStuckCompleting_rake_settle_threw');
        }

        // 4. Commit every place payment and COMPLETING -> COMPLETED as one
        // database transaction. Prepare runs first and commits the exact
        // obligation set, so a process exit or retry resumes from durable
        // obligations. A refusal/partial payment rolls every place back and
        // leaves the tournament COMPLETING.
        if (isMaintenanceFrozen()) continue;
        const settlement = await settleTournamentPlacesAtomically(
          supabase,
          t.id,
          'engine.recoverStuckCompleting'
        );
        let durableCompletionAcceptedAfterLostReceipt = false;
        if (!settlement.ok || !settlement.completed) {
          // All responses can be lost after the transaction commits. Re-read
          // durable truth before treating a transport result as a rollback.
          const { data: committed, error: committedError } = await supabase
            .from('tournaments')
            .select('status')
            .eq('id', t.id)
            .maybeSingle();
          if (committedError || committed?.status !== 'COMPLETED') {
            throw new Error(
              `atomic place settlement did not complete ${t.id.slice(0, 8)}: ${settlement.reason || (settlement.ok ? 'success response omitted completion proof' : 'unknown')}${settlement.detail ? ` (${settlement.detail})` : ''}${settlement.transport_error ? ` (${settlement.transport_error})` : ''}${committedError ? `; completion proof read failed (${committedError.message})` : ''}`
            );
          }
          durableCompletionAcceptedAfterLostReceipt = true;
          console.warn(
            `[GameServer] recoverStuckCompleting: ${t.id.slice(0, 8)} atomic place receipt was lost after commit; durable COMPLETED accepted`
          );
        }

        // Tables close only after the database has confirmed that every place
        // landed and the tournament is terminal.
        const cleanupComplete = await closeRecoveredTournamentTablesAndSeats(t.id);
        if (!cleanupComplete) {
          throw new Error(
            `atomic place settlement committed for ${t.id.slice(0, 8)}, but table and seat cleanup could not be proven`
          );
        }
        if (durableCompletionAcceptedAfterLostReceipt) {
          console.log(
            `[GameServer] Recovered stuck COMPLETING tournament ${t.id.slice(0, 8)} "${t.name}" (${reason}): durable COMPLETED accepted and table/seat cleanup proven after a lost atomic receipt; place/payment counts unavailable`
          );
        } else {
          console.log(
            `[GameServer] Recovered stuck COMPLETING tournament ${t.id.slice(0, 8)} "${t.name}" (${reason}): atomically settled ${settlement.places} place(s), moved ${settlement.paid}`
          );
        }
      } catch (err) {
        reportError(err, 'GameServer.recoverStuckCompleting_per_tournament');
      }
    }
  } catch (err) {
    reportError(err, 'GameServer.recoverStuckCompleting');
  }
}
