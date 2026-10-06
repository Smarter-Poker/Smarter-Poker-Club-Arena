/**
 * LAW: A SEAT ALREADY BOUGHT IS PAID IN CASH, FOR TWO SATELLITES
 * (2026-10-03, corrected 2026-10-04).
 *
 * WASP bought a Friday Night Feature seat with 30.00 of their own chips, then
 * won two heads-up satellites into the same event on 2026-09-03. The award
 * called the bought seat's origin unknown and paid nothing, so 30.00 stayed in
 * each satellite's prize_liability. The award itself was fixed on 2026-09-05
 * (20260905195011); this settles the two terminal events it could not reach.
 *
 * WHY THIS LAW WAS REWRITTEN. It first pinned 20261003132723, which paid each
 * 30.00 out of the satellite's OWN prize_liability with tournament_id NULL.
 * That migration merged and then refused itself on apply, every time:
 *   ERROR 55000: completed satellite transfer journal is immutable
 *   fn_satellite_transfer_ledger_is_immutable() line 74
 * The guard resolves the source satellite from from_entity_id whenever
 * from_type is prize_liability, exactly so a NULL tournament_id cannot route
 * around it, and refuses the INSERT while that satellite is terminal. So a
 * sealed satellite's prize_liability can never be debited again, and the shape
 * the old law demanded is unreachable while the guard stands.
 *
 * #6067 then amended that migration to reach it anyway: read the guard's own
 * source, inject a WASP-and-those-two-satellites exemption after its BEGIN,
 * EXECUTE the modified function inside the transaction, restore the byte-exact
 * original before COMMIT. However carefully it is restored, that is replacing
 * a money guard to let one write through. The owner's standing instruction for
 * this settlement forbids it, and it could not have applied in any case: it
 * admits only guard md5 b2affe52... or 5de9ef6b..., while the installed guard
 * reads f8311ad66092ee2c9c6c807fb9868d58, so its own pre-image refuses it.
 * Production was read on 2026-10-04: the file is absent from
 * schema_migrations and the installed guard carries no reference to WASP, to
 * either satellite, or to the satellite-seat-cash key.
 *
 * 20261004151352 pays the same 60.00 with no guard touched, through the door
 * the estate had already blessed for an event whose books are sealed
 * (20260926085132, 20261002082429, 20260926131530): the house pays outside the
 * event. Midway Union, which hosted both satellites and took their 2.00 fee
 * each, pays from its bank.
 *
 * What this pins now: the settlement pays from the union bank through the
 * platform's idempotent wallet door, never names a terminal tournament on a
 * key, wallet row, obligation or journal leg, leaves each sealed satellite's
 * 30.00 where it is, replaces or weakens no guard, asserts its pre-image and
 * post-image to the cent, closes exactly the four alerts, can be proved rolled
 * back, and the migration it replaces is marked so it can never run in either
 * of its two forms.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = '20261004151352_the_house_pays_wasp_the_two_seats_it_could_not_deliver';
const SUPERSEDED = '20261003132723_a_seat_already_bought_is_paid_in_cash_for_two_satellites';
const read = (stem: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', stem + '.sql'), 'utf8');
const MIG = read(FILE);
const OLD = read(SUPERSEDED);
const body = MIG.slice(MIG.indexOf('DO $mig$'));

const ALERTS = [
  '20abe32c-0c7c-479d-8783-7833d8743857',
  '2e2ecd9d-edb1-40f2-a328-b4078426c04a',
  '25399c02-7987-4840-a712-5c8b5ff624dd',
  '71b057a7-b0ff-43e7-8f9c-85564b3f8dc6',
];

describe('a seat already bought is paid in cash, for two satellites', () => {
  it('is one transaction with a live proof and a rolled-back probe', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    expect(MIG).toContain(
      `-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE context->'house_settlement'->>'migration' = '${FILE}') = 4`
    );
    expect(body).toContain("current_setting('ca.seat_cash_probe', true)");
    expect(body).toContain("RAISE EXCEPTION 'PROBE OK (rolled back)");
  });

  it('pays from the union bank that hosted the satellites, through the idempotent door', () => {
    expect(body).toContain(
      "PERFORM public.fn_ca_declare_ledger('settlement', 'union_bank', c_union, NULL, v_key, ARRAY['union_wallets']);"
    );
    expect(body).toContain("c_union   CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';");
    // The bank is debited only if it can cover the amount, and the debit is read back.
    expect(body).toContain('UPDATE public.union_wallets SET chip_balance = chip_balance - c_seat');
    expect(body).toContain('WHERE union_id = c_union AND chip_balance >= c_seat');
    expect(body).toContain(
      "v_ok := public.fn_credit_and_log(c_wasp, c_seat, v_key, 'settlement', v_desc, NULL);"
    );
    expect(body).toContain(
      "v_key := 'satellite-seat-cash:' || v_sat::text || ':' || c_wasp::text;"
    );
    expect(body).toContain('c_seat    CONSTANT numeric := 30.00;');
    expect(body).toContain(
      'public.fn_ca_adjustment_under_10_9(v_sat, c_wasp, c_seat, v_reason, c_mig,'
    );
    // One leg, and it is judged field by field rather than merely found.
    expect(body).toContain("IF v_leg_from <> 'union_bank' OR v_leg_to <> 'player_wallet'");
  });

  it('never names a terminal tournament where the evidence is immutable', () => {
    expect(body).not.toMatch(/'tourney:/);
    expect(body).not.toMatch(/fn_settle_tournament_obligation/);
    expect(body).not.toMatch(
      /INSERT\s+INTO\s+public\.(chip_ledger|wallet_transactions|tournament_\w+)/i
    );
    // The credit carries no related tournament, and the leg it writes has none.
    expect(body).toContain('OR v_leg_club IS DISTINCT FROM c_shark OR v_leg_tid IS NOT NULL');
    expect(body).toContain('AND w.related_entity_id IS NULL');
    // And it proves afterwards that it named neither sealed satellite, by every
    // witness the satellite guard itself reads.
    expect(body).toContain(
      "RAISE EXCEPTION 'seat cash post-image: this transaction wrote a journal leg naming a sealed satellite';"
    );
    expect(body).toContain(
      "RAISE EXCEPTION 'seat cash post-image: this transaction wrote a wallet row naming a sealed satellite';"
    );
  });

  it('replaces no guard, weakens none, and refuses to run if the guard it reasons about is gone', () => {
    for (const forbidden of [
      /CREATE\s+OR\s+REPLACE\s+FUNCTION/i,
      /pg_get_functiondef/i,
      /EXECUTE\s+v_guard/i,
      /DROP\s+TRIGGER/i,
      /DISABLE\s+TRIGGER/i,
      /ALTER\s+TABLE/i,
      /DROP\s+FUNCTION/i,
      /session_replication_role/i,
    ]) {
      expect(MIG, String(forbidden)).not.toMatch(forbidden);
    }
    expect(body).toContain("AND tg.tgname = 'satellite_transfer_ledger_is_immutable'");
    expect(body).toContain("AND NOT tg.tgisinternal AND tg.tgenabled = 'O') THEN");
    expect(body).toContain("AND tg.tgname = 'terminal_wallet_transaction_is_immutable'");
  });

  it('leaves the sealed satellites exactly as they are, and the two conservation checks agreeing', () => {
    // The retained 30.00 is the honest end state, asserted rather than tidied.
    expect(body).toContain(
      "RAISE EXCEPTION 'seat cash post-image: % prize_liability reads % and should still read 30.00', v_sat, v_in;"
    );
    expect(body).toContain('IF public.fn_tournament_conservation_delta(v_sat) <> 0.00 THEN');
    // A conservation baseline row is ADDED by the delta, so writing one here
    // would clear the satellite audit by breaking the delta. See
    // tests/the-two-conservation-checks-agree-on-a-seat.law.test.ts.
    // The header explains why none is written; the executable body never
    // mentions it at all, and nothing writes to the table.
    expect(body).not.toMatch(/tournament_conservation_baseline/i);
    expect(MIG).not.toMatch(/INSERT\s+INTO\s+public\.tournament_conservation_baseline/i);
    expect(MIG).not.toMatch(/UPDATE\s+public\.tournament_conservation_baseline/i);
  });

  it('asserts the case it settles before anything moves', () => {
    for (const clause of [
      "l.category = 'tournament_buyin' AND l.amount = c_seat",
      'IF v_in <> 40.00 OR v_out <> 10.00 THEN',
      'WHERE id = ANY (c_alerts) AND resolved IS NOT TRUE) <> 4 THEN',
      'IF public.fn_player_home_club(c_wasp, NULL) IS DISTINCT FROM c_shark THEN',
      'SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key = v_key',
      'IF v_fee <> 2.00 THEN',
      'IF v_bank_before IS NULL OR v_bank_before < c_total THEN',
    ]) {
      expect(body, clause).toContain(clause);
    }
  });

  it('proves the post-image to the cent and closes exactly four alerts', () => {
    expect(body).toContain('IF round(v_bal_after - v_bal_before, 2) <> c_total THEN');
    expect(body).toContain('IF round(v_bank_before - v_bank_after, 2) <> c_total THEN');
    expect(body).toContain('IF v_legs <> 2 OR v_sum <> c_total THEN');
    expect(body).toContain('IF v_n <> 4 THEN');
    for (const id of ALERTS) expect(body).toContain(`'${id}'`);
    expect(MIG).not.toContain('—');
  });

  it('marks the migration it replaces so that neither of its forms can ever run', () => {
    expect(OLD.split('\n')[0]).toBe(
      '-- SUPERSEDED BY 20261004151352 (the_house_pays_wasp_the_two_seats_it_could_not_deliver)'
    );
    expect(OLD).toContain('THIS FILE MUST NEVER RUN, IN EITHER OF ITS TWO FORMS.');
    expect(OLD).toContain('fn_satellite_transfer_ledger_is_immutable');
    // History is never deleted: both forms are still there under the notice,
    // including #6067's guard replacement, which the notice names as the second
    // reason this file must never run rather than quietly dropping it.
    expect(OLD).toContain(`-- ${SUPERSEDED}.sql`);
    expect(OLD).toContain(
      "PERFORM public.fn_ca_declare_ledger('settlement', 'prize_liability', v_sat, NULL, v_key, NULL);"
    );
    expect(OLD).toContain('EXECUTE v_guard_changed;');
    expect(OLD).toContain("RAISE EXCEPTION 'seat cash guard was not restored byte-exactly'");
    expect(OLD).toContain('replacing a');
    expect(OLD).toContain('f8311ad66092ee2c9c6c807fb9868d58');
  });
});
