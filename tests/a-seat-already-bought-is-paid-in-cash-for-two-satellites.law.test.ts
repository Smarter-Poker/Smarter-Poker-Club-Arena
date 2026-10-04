/**
 * LAW: A SEAT ALREADY BOUGHT IS PAID IN CASH, FOR TWO SATELLITES (2026-10-03).
 *
 * WASP bought a Friday Night Feature seat with 30.00 of their own chips, then
 * won two heads-up satellites into the same event on 2026-09-03. The award
 * called the bought seat's origin unknown and paid nothing, so 30.00 stayed in
 * each satellite's prize_liability. The award itself was fixed on 2026-09-05
 * (20260905195011); this settles the two terminal events it could not reach.
 *
 * What this pins: the settlement pays from each satellite's own
 * prize_liability through the platform's idempotent wallet door, never names
 * a terminal tournament on a key, wallet row or obligation, asserts its
 * pre-image and post-image to the cent, closes exactly the four alerts, and
 * can be proved rolled back.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = '20261003132723_a_seat_already_bought_is_paid_in_cash_for_two_satellites';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE + '.sql'), 'utf8');
const body = MIG.slice(MIG.indexOf('DO $mig$'));

describe('a seat already bought is paid in cash, for two satellites', () => {
  it('is one transaction with a live proof and a rolled-back probe', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    expect(MIG).toContain(
      `-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE context->'settlement'->>'migration' = '${FILE}') = 4`
    );
    expect(body).toContain("current_setting('ca.seat_cash_probe', true)");
    expect(body).toContain("RAISE EXCEPTION 'PROBE OK (rolled back)");
  });

  it('opens only the two exact adjustment-backed legs and restores the terminal guard', () => {
    expect(body).toContain(
      "SELECT pg_get_functiondef('public.fn_satellite_transfer_ledger_is_immutable()'::regprocedure)"
    );
    expect(body).toContain("v_guard_md5 NOT IN ('b2affe52c4e95101c985c30c483d5127',");
    expect(body).toContain('AND NEW.from_entity_id = ANY (ARRAY[');
    expect(body).toContain("AND NEW.to_entity_id = 'a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8'::uuid");
    expect(body).toContain(
      "AND NEW.idempotency_key = 'satellite-seat-cash:' || NEW.from_entity_id::text"
    );
    expect(body).toContain('WHERE a.id = NEW.correlation_id');
    expect(body).toContain("AND a.status = 'approved'");
    expect(body).toContain(
      "AND a.decision_note = 'migration 20261003132723_a_seat_already_bought_is_paid_in_cash_for_two_satellites'"
    );
    expect(body).toContain("AND a.asset = 'chips'");
    expect(body).toContain('EXECUTE v_guard_source;');
    expect(body).toContain("RAISE EXCEPTION 'seat cash guard was not restored byte-exactly'");
    expect(body).not.toMatch(/DISABLE\s+TRIGGER/i);
  });

  it('pays from each satellite’s own prize_liability through the idempotent door', () => {
    expect(body).toContain(
      "PERFORM public.fn_ca_declare_ledger('settlement', 'prize_liability', v_sat, NULL, v_key, NULL);"
    );
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
  });

  it('never names a terminal tournament where the evidence is immutable', () => {
    expect(body).not.toMatch(/'tourney:/);
    expect(body).not.toMatch(/fn_settle_tournament_obligation/);
    expect(body).not.toMatch(
      /INSERT\s+INTO\s+public\.(chip_ledger|wallet_transactions|tournament_\w+)/i
    );
    // The credit carries no related tournament, and the leg it writes has none.
    expect(body).toContain('AND l.tournament_id IS NULL');
  });

  it('asserts the case it settles before anything moves', () => {
    for (const clause of [
      "l.category = 'tournament_buyin' AND l.amount = 30.00",
      'IF v_in <> 40.00 OR v_out <> 10.00 THEN',
      'WHERE id = ANY (c_alerts) AND resolved IS NOT TRUE) <> 4 THEN',
      'IF public.fn_player_home_club(c_wasp, NULL) IS DISTINCT FROM c_shark THEN',
      'SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key = v_key',
    ]) {
      expect(body, clause).toContain(clause);
    }
  });

  it('proves the post-image to the cent and closes exactly four alerts', () => {
    expect(body).toContain('IF round(v_bal_after - v_bal_before, 2) <> 60.00 THEN');
    expect(body).toContain(
      "RAISE EXCEPTION 'seat cash post-image: % prize_liability still reads %', v_sat, v_in;"
    );
    expect(body).toContain('IF v_n <> 4 THEN');
    for (const id of [
      '20abe32c-0c7c-479d-8783-7833d8743857',
      '2e2ecd9d-edb1-40f2-a328-b4078426c04a',
      '25399c02-7987-4840-a712-5c8b5ff624dd',
      '71b057a7-b0ff-43e7-8f9c-85564b3f8dc6',
    ]) {
      expect(body).toContain(`'${id}'`);
    }
    expect(MIG).not.toContain('—');
  });
});
