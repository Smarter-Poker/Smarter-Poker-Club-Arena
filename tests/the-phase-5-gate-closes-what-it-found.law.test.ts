/**
 * THE PHASE 5 GATE CLOSES WHAT IT FOUND (chip standard, 2026-09-05). Pinned on
 * the six migrations the gate applied, mirrored byte-exact from production.
 *
 * LAW 1 - A SPIN BOOKS ITS ENTRY WITH THE ESCROW LOCK FIRST (fn_spin_book_entry
 *   takes the tournament_escrow row before the spin_entry advisory lock; the
 *   registration path and the unbooked sweep held them in opposite orders and
 *   deadlocked, one to three a day since 09-02).
 * LAW 2 - EVERY NEW MONEY DOOR IS REGISTERED, AND NO SWEEP MOVES MONEY IN THE
 *   FREEZE (fn_cash_seat_move/swap_execute, fn_cash_cluster_tick,
 *   fn_union_clawback_promo_from_club registered after reading;
 *   fn_redrive_unbanked_rake returns empty while frozen).
 * LAW 3 - THE SPIN IS ENFORCED and its reserve_out is never refused (13,346
 *   spins measured: none paid before its draw, none beyond its bank); THE SEAT
 *   READS THE MONEY THAT ARRIVED (the target escrow's satellite_in comes from
 *   the pool_transfer leg; the fee row carries the fee only; the shadow agrees).
 * LAW 4 - A CASH ENTRANT WHO WINS A SEAT IS PAID THE SEAT IN CASH
 *   (fn_award_satellite_seat reports a seat with is_satellite_qualifier false
 *   as held_from_this_satellite false; railbirdd paid 200.00 under the place-2
 *   key; the satellite escrow at zero).
 * LAW 5 - A CANCELLED TARGET REFUNDS THE SATELLITE SEAT IT HOLDS
 *   (atomic_cancel_tournament and the deferred cancel guard read the
 *   pool_transfer leg for a qualifier; a cancel's fee reversal rows are
 *   attribution and never escrow money; an event with no cash entry apportions
 *   a refund by its own entry structure). Probed rolled back on a live target
 *   holding 43 qualifiers: 47 refunds, escrow 0.00 / 0.00 / 0.00.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const load = (re: RegExp): string => {
  const f = readdirSync(MIG).find((n) => re.test(n));
  if (!f) throw new Error(`not mirrored: ${re}`);
  return readFileSync(resolve(MIG, f), 'utf8');
};
const fn = (sql: string, name: string): string => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start));
};

describe('the Phase 5 gate closes what it found', () => {
  it('LAW 1: the spin takes the escrow row before the advisory lock', () => {
    const s = load(/^\d{14}_the_spin_books_its_entry_with_the_escrow_lock_first\.sql$/);
    const b = fn(s, 'fn_spin_book_entry');
    const a = b.indexOf(
      'FROM public.tournament_escrow WHERE tournament_id = p_tournament_id FOR UPDATE'
    );
    const adv = b.indexOf("pg_advisory_xact_lock(hashtextextended('spin_entry:'");
    expect(a).toBeGreaterThan(-1);
    expect(adv).toBeGreaterThan(a);
  });

  it('LAW 2: the four doors are registered with what they do and the redrive checks the freeze', () => {
    const s = load(/^\d{14}_phase_5_gate_every_new_door_is_registered_and_no_sweep_moves\.sql$/);
    for (const d of [
      'fn_cash_seat_move_execute',
      'fn_cash_seat_swap_execute',
      'fn_cash_cluster_tick',
      'fn_union_clawback_promo_from_club',
      'fn_redrive_unbanked_rake',
    ]) {
      expect(s).toMatch(new RegExp(`\\('${d}', 'approved'`));
    }
    expect(fn(s, 'fn_redrive_unbanked_rake')).toMatch(
      /IF public\.fn_platform_frozen\(\) THEN\s+RETURN jsonb_build_object\('ok', true, 'frozen', true/
    );
    expect(s).toMatch(/RAISE EXCEPTION 'money rpc drift is not zero: %'/);
  });

  it('LAW 3: spins are enforced with the reserve move exempt, and the seat reads the leg', () => {
    const s = load(/^\d{14}_phase_5_gate_the_spin_is_enforced_and_the_seat_reads_the_mon\.sql$/);
    const apply = fn(s, 'fn_ca_escrow_apply');
    expect(apply).toMatch(
      /v_outflow boolean := COALESCE\(p_prize_out, 0\) > 0 OR COALESCE\(p_bounty_out, 0\) > 0 OR COALESCE\(p_fee_out, 0\) > 0 OR COALESCE\(p_refund, 0\) > 0;/
    );
    expect(apply).not.toMatch(/OR COALESCE\(p_reserve_out, 0\) > 0;/);
    expect(apply).toMatch(/\(p_tournament_id, true,/);
    expect(s).toMatch(/UPDATE public\.tournament_escrow SET enforced = true WHERE NOT enforced;/);
    expect(s).toMatch(/spins were paid before their draw in 24h; not enforcing/);
    const rr = fn(s, 'fn_ca_escrow_on_rake_record');
    expect(rr).toMatch(/p_satellite_fee_in => v_fee, p_satellite_in => -v_fee/);
    expect(fn(s, 'fn_ca_escrow_on_seat_transfer_leg')).toMatch(
      /p_satellite_in => round\(NEW\.amount, 2\)/
    );
    expect(s).toMatch(
      /CREATE TRIGGER zz_ca_escrow_seat_transfer_leg AFTER INSERT ON public\.chip_ledger\s+FOR EACH ROW WHEN \(NEW\.to_type = 'prize_liability' AND NEW\.idempotency_key LIKE 'tourney:%:seat:%:pool_transfer'\)/
    );
    expect(fn(s, 'fn_ca_tournament_escrow')).toMatch(
      /round\(stl\.moved - rr\.fee_sat, 2\)\s+AS satellite_in/
    );
    expect(s).toMatch(/satellite targets hold a nominal that differs from what moved/);
  });

  it('LAW 4: a cash entrant who wins a seat is paid the seat in cash', () => {
    const s = load(/^\d{14}_a_cash_entrant_who_wins_a_seat_is_paid_the_seat_in_cash\.sql$/);
    const b = fn(s, 'fn_award_satellite_seat');
    expect(b).toMatch(
      /v_seated := CASE WHEN NOT v_existing_q THEN false\s+WHEN v_existing IS NULL THEN NULL\s+ELSE \(v_existing = p_satellite_id\) END;/
    );
    expect(b).toMatch(/'origin_unknown', \(v_existing_q AND v_existing IS NULL\)/);
    expect(s).toMatch(
      /fn_settle_tournament_obligation\(\s+'956383d2-96af-4f43-8fd2-ce6f1d9877c3', 'place', 2, '11758a4f-55bc-4758-861a-bee6830c70b8', 200\.00/
    );
    expect(s).toMatch(/the satellite escrow does not read zero after the payment/);
  });

  it('LAW 5: a cancelled target refunds the satellite seat it holds, and a fee reversal is never escrow money', () => {
    const s = load(/^\d{14}_a_cancelled_target_refunds_the_satellite_seat_it_holds\.sql$/);
    const c = fn(s, 'atomic_cancel_tournament');
    expect(c).toMatch(
      /IF v_gross = 0 AND v_player\.is_q AND v_player\.source_satellite_id IS NOT NULL THEN/
    );
    expect(c).toMatch(
      /l\.idempotency_key = 'tourney:' \|\| v_player\.source_satellite_id::text \|\| ':seat:' \|\| v_player\.user_id::text \|\| ':pool_transfer'/
    );
    const g = fn(s, 'trg_tournaments_cancel_must_refund');
    expect(g).toMatch(/\), seats AS \(/);
    expect(g).toMatch(/SELECT \* FROM paid UNION ALL SELECT \* FROM seats/);
    const rr = fn(s, 'fn_ca_escrow_on_rake_record');
    expect(rr).toMatch(
      /IF v_fee < 0 AND NEW\.source = 'atomic_cancel_tournament' THEN RETURN NULL; END IF;/
    );
    expect(fn(s, 'fn_ca_tournament_escrow')).toMatch(
      /AND NOT \(rake_amount < 0 AND source = 'atomic_cancel_tournament'\)/
    );
    expect(fn(s, 'fn_ca_escrow_apply')).toMatch(
      /CROSS JOIN LATERAL public\.fn_tournament_entry_split\(/
    );
  });
});
