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
import { reportError } from '../services/errorReporter.js';

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
 *   2. Any still-'playing'/'registered' players are ranked by chip count and
 *      assigned the top remaining positions (1..N). Position 1 becomes the
 *      winner. Each gets their payout-structure prize credited + logged.
 *   3. Any already-eliminated ITM player whose recorded prize is 0 but whose
 *      position pays is topped up (covers busts recorded before the pool
 *      reached its final/guaranteed size).
 *   4. Tournament flips COMPLETING → COMPLETED (CAS-guarded).
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
          `[GameServer] Cancel refund ABORTED for ${tournamentId.slice(0, 8)}: open-registration list unreadable (${openRowsErr.message}) — refunding nobody and closing nothing this pass`
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
      let paid = 0;
      for (const t of txRows ?? []) {
        if (
          t.type === 'debit' &&
          (t.category === 'tournament_buyin' || t.category === 'rebuy' || t.category === 'addon')
        ) {
          paid += Number(t.amount || 0);
        } else if (t.type === 'credit' && t.category === 'refund') {
          paid -= Number(t.amount || 0);
        }
      }
      paid = Math.round(paid * 100) / 100;
      if (paid <= 0) continue; // never paid (legacy free entry) or already refunded

      // LEDGER-INTEGRITY 2026-08-22: credit and ledger row under one key.
      const { error: refErr } = await supabase.rpc('fn_credit_and_log', {
        p_user_id: row.user_id,
        p_amount: paid,
        // A3 FIX (2026-07-28): keyed on the tournament_players row id, in the
        // SAME format used by the startup pre-start sweep and the SNG lifecycle
        // sweep (both now delegate here), so every cancel-refund path dedupes.
        p_idempotency_key: `tourney:${tournamentId}:cancelrefund:${row.id}`,
        p_category: 'refund',
        p_description: `${refundReason}: ${fullT?.name || tournamentName || 'tournament'}`,
        p_related_entity_id: tournamentId,
      });
      if (refErr) {
        reportError(
          new Error(
            `[GameServer] Cancel refund FAILED for ${row.user_id} (${tournamentId.slice(0, 8)}): ${refErr.message}`
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
              `[GameServer] Cancel refund: fee-ledger read failed for ${row.user_id.slice(0, 8)} (${tournamentId.slice(0, 8)}): ${feeErr.message} — fee NOT reversed`
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
                `[GameServer] Cancel refund: fee reversal INSERT failed for ${row.user_id.slice(0, 8)} (${tournamentId.slice(0, 8)}): ${revErr.message} — ${feePaid} still booked as rake`
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
          `[GameServer] Cancel refund: could not close player rows for ${tournamentId.slice(0, 8)}: ${closeRowsErr.message} — registrations left stranded`
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
      .select('id, name, prize_pool, payout_structure, variant, tournament_type, spin_multiplier')
      .eq('status', 'COMPLETING');
    if (onlyTournamentId) q = q.eq('id', onlyTournamentId);
    const { data: stuck, error: stuckErr } = await q;
    // PAYOUT-INTEGRITY 2026-08-25: an unreadable list is not an empty one. The
    // discarded error made a failed scan indistinguishable from "nothing is
    // stuck", which is the one thing this watchdog exists to detect.
    if (stuckErr) {
      reportError(
        new Error(
          `[GameServer] recoverStuckCompleting (${reason}): COMPLETING scan failed: ${stuckErr.message} — recovered nothing this pass`
        ),
        'GameServer.recoverStuckCompleting_scan_failed'
      );
      return;
    }
    for (const t of stuck ?? []) {
      try {
        // SHORT-FIELD RESIDUAL 2026-08-27: the rescue must price by the same
        // structure a normal finish would, and a normal finish now trims the
        // structure to the size of the field so the residual lands on a place
        // somebody actually reached. A stuck tournament is COMPLETING, so
        // entry is long closed and this count can no longer move. Its own
        // query rather than the roster fetched below, because that fetch has
        // an error path which must keep reading exactly as it does; a failed
        // count here simply leaves the structure untrimmed, which is the
        // behaviour this rescue had before.
        const { count: fieldCount } = await supabase
          .from('tournament_players')
          .select('id', { count: 'exact', head: true })
          .eq('tournament_id', t.id);

        // Parse + normalize payout structure
        const payouts: Array<{ place: number; percentage: number }> =
          resolvePayoutStructure(
            t as any,
            typeof fieldCount === 'number' && fieldCount >= 1 ? fieldCount : undefined
          ) ?? [];
        // PAYOUT-INTEGRITY 2026-08-20: this used to be a THIRD independent
        // prize formula (alongside eliminatePlayer and finishTournament), so a
        // tournament rescued here could be paid a cent differently from one
        // that finished normally -- and differently again from what
        // fn_tournament_payout_reconcile expects, which would then report a
        // false overpay. All three now share computePlacePrize: normalise to
        // 100%, round each place, last paid place absorbs the residual.
        const prizeFor = (place: number): number =>
          computePlacePrize(Number(t.prize_pool || 0), payouts, place);

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
         * NOBODY and step 3 topped up nobody — and step 4 went right on to
         * flip COMPLETING -> COMPLETED. That is terminal: this watchdog only
         * ever looks at COMPLETING, so the tournament it just silently
         * emptied can never be rescued again, by it or by anything else. One
         * timeout permanently destroys the winner's prize and every unpaid
         * ITM place, on the exact code path written to stop that happening
         * (see this function's docblock: a COMPLETED bounty MTT that paid $40
         * of a $100 pool is what it was written for).
         *
         * Throw so the per-tournament catch reports it and the tournament
         * stays COMPLETING for the next pass. Every step below is idempotent,
         * so retrying costs nothing.
         */
        if (playersErr) {
          throw new Error(
            `player field unreadable for ${t.id.slice(0, 8)} "${t.name}": ${playersErr.message} — refusing to complete a tournament we cannot pay`
          );
        }
        const rows = players ?? [];

        const credit = async (
          userId: string,
          amount: number,
          desc: string,
          idempotencyKey: string
        ) => {
          if (amount <= 0) return;
          // P1 FIX (2026-07-24): idempotency key in the SAME format the main
          // elimination-prize path uses (`tourney:{id}:prize:place:{position}`)
          // so this recovery path and the main path dedupe against each other and
          // repeated recovery scans of a COMPLETING tournament cannot double-pay.
          // LEDGER-INTEGRITY 2026-08-22: this is the path that produced the
          // phantom rows. It shares its key with the normal finish path on
          // purpose, so it credits nothing when that path got there first —
          // and it used to write a "Tournament prize (recovery)" ledger row
          // anyway, 0.06s-0.7s after the real one. Both halves now sit under
          // the one key.
          const { error } = await supabase.rpc('fn_credit_and_log', {
            p_user_id: userId,
            p_amount: amount,
            p_idempotency_key: idempotencyKey,
            p_category: 'prize',
            p_description: desc,
            p_related_entity_id: t.id,
          });
          if (error) throw new Error(`credit failed for ${userId}: ${error.message}`);
        };

        // 2. Rank the still-alive players by chips and pay their places
        const alive = rows
          .filter((r) => r.status === 'playing' || r.status === 'registered')
          .sort((a, b) => Number(b.chips || 0) - Number(a.chips || 0));

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
         * for the reconciler or a human; every caller re-runs this watchdog.
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
              `[GameServer] recoverStuckCompleting: ${t.id.slice(0, 8)} "${t.name}" — ${alive.length} survivor(s) would be given place(s) already held by eliminated players: ${collisions.join(', ')}. Paying nobody; left COMPLETING for review.`
            ),
            'GameServer.recoverStuckCompleting_position_collision'
          );
          continue;
        }

        for (let i = 0; i < alive.length; i++) {
          const place = i + 1;
          const prize = prizeFor(place);
          await credit(
            alive[i].user_id,
            prize,
            `Tournament prize (recovery): position ${place} — ${t.name || 'tournament'}`,
            `tourney:${t.id}:prize:place:${place}`
          );
          // PAYOUT-INTEGRITY 2026-08-25: the credit is only half of it. When
          // this UPDATE was discarded, a paid survivor kept status='playing'
          // and prize=0, so the very next pass ranked them as ALIVE again and
          // could hand them a different place (the credit dedupes on the key,
          // the POSITION does not) — and step 3 read their prize as 0 forever.
          // Throwing leaves the tournament COMPLETING; the credit above is
          // idempotent, so the retry re-runs it for free.
          const { error: stampErr } = await supabase
            .from('tournament_players')
            .update({
              status: place === 1 ? 'winner' : 'eliminated',
              position: place,
              prize,
              eliminated_at: place === 1 ? null : new Date().toISOString(),
            })
            .eq('id', alive[i].id);
          if (stampErr) {
            throw new Error(
              `paid place ${place} to ${alive[i].user_id.slice(0, 8)} but could not record it: ${stampErr.message}`
            );
          }
        }

        // 3. Top up already-eliminated ITM players recorded with a zero prize
        for (const r of rows) {
          if (r.status !== 'eliminated' || !r.position) continue;
          const owed = prizeFor(r.position);
          const recorded = Number(r.prize || 0);
          if (owed > recorded) {
            const diff = Math.round((owed - recorded) * 100) / 100;
            await credit(
              r.user_id,
              diff,
              `Tournament prize top-up (recovery): position ${r.position} — ${t.name || 'tournament'}`,
              `tourney:${t.id}:prize:place:${r.position}`
            );
            // Same rule as the survivor stamp above: a top-up that is paid but
            // not recorded leaves prize < owed, so every later pass recomputes
            // the same shortfall and re-attempts it forever.
            const { error: topUpErr } = await supabase
              .from('tournament_players')
              .update({ prize: owed })
              .eq('id', r.id);
            if (topUpErr) {
              throw new Error(
                `topped up place ${r.position} for ${r.user_id.slice(0, 8)} but could not record it: ${topUpErr.message}`
              );
            }
          }
        }

        // 3.5 Settle the fee ledger. SETTLEMENT INTEGRITY 2026-08-26: this
        // path finishes tournaments whose engine died mid-finish — which is
        // exactly the population whose rake never landed (settleTournamentRake
        // only ran on the happy path). fn_settle_tournament_rake is
        // PK-claimed and idempotent, so calling it here can never double-pay
        // against a finish that already settled; it only closes the hole
        // where nobody did. Non-fatal: the sweep re-drives any failure.
        try {
          const { data: rakeRes, error: rakeErr } = await supabase.rpc(
            'fn_settle_tournament_rake',
            { p_tournament_id: t.id, p_source: 'recovery' }
          );
          if (rakeErr || !rakeRes?.ok) {
            reportError(
              new Error(
                `[GameServer] recoverStuckCompleting: rake settlement failed for ${t.id.slice(0, 8)}: ${rakeErr?.message || rakeRes?.reason} — sweep will re-drive`
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

        // 4. Complete (CAS-guarded)
        // PAYOUT-INTEGRITY 2026-08-25: the completion is the claim that
        // everything above landed. A discarded error printed "Recovered ..."
        // over a tournament still sitting in COMPLETING, so the log said the
        // watchdog had done its job on every single pass while it had not.
        const { error: completeErr } = await supabase
          .from('tournaments')
          .update({ status: 'COMPLETED', ended_at: new Date().toISOString() })
          .eq('id', t.id)
          .eq('status', 'COMPLETING');
        if (completeErr) {
          throw new Error(`could not mark COMPLETED: ${completeErr.message}`);
        }
        const { error: closeErr } = await supabase
          .from('tables')
          .update({ status: 'closed' })
          .eq('tournament_id', t.id)
          .neq('status', 'closed');
        if (closeErr) {
          reportError(
            new Error(
              `[GameServer] recoverStuckCompleting: ${t.id.slice(0, 8)} paid and COMPLETED but tables not closed: ${closeErr.message}`
            ),
            'GameServer.recoverStuckCompleting_close_tables_failed'
          );
        }
        console.log(
          `[GameServer] Recovered stuck COMPLETING tournament ${t.id.slice(0, 8)} "${t.name}" (${reason}): paid ${alive.length} remaining player(s)`
        );
      } catch (err) {
        reportError(err, 'GameServer.recoverStuckCompleting_per_tournament');
      }
    }
  } catch (err) {
    reportError(err, 'GameServer.recoverStuckCompleting');
  }
}
