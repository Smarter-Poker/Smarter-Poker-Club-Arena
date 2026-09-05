/**
 * THE ESCROW IS A BALANCE (chip standard Phase 5.1, 2026-09-04). Pinned on
 * the two migrations mirrored byte-exact from production: part one
 * (the_escrow_becomes_a_balance) and part two (the_escrow_goes_live).
 *
 * LAW 1 - A TOURNAMENT'S MONEY IS A BALANCE, NOT A COUNTER. tournament_escrow
 *   holds prize, bounty and fee banks derived from their own components and
 *   maintained in the same transaction as every operational row the shadow
 *   trusts (wallet_transactions, rake_records, overlay legs, satellite seats,
 *   fee settlements), by triggers.
 * LAW 2 - AN EVENT PAYS ONLY WHAT IT HOLDS. An outflow that would take a bank
 *   below zero is refused inside the write that paid it (the wallet credit
 *   and the escrow debit stand or fall together), and
 *   fn_settle_tournament_obligation reads the balance before it credits and
 *   refuses with escrow_short; the counter cap survives only for an event
 *   the balance has never seen.
 * LAW 3 - FIRST SIGHT OPENS FROM THE SHADOW. An event that began before the
 *   balance existed is opened from fn_ca_tournament_escrow on its first row,
 *   and the live events were opened together with the triggers inside the
 *   platform freeze.
 * LAW 4 - THE CLOSE IS JUDGED. Reaching COMPLETED with prize or bounty left
 *   files a settlement_error incident (R5 reported); the hourly shadow
 *   compares itself to the balance and files on disagreement.
 * LAW 5 - SPINS ARE TRACKED, NOT REFUSED (their prize is the reserve's; 5.2).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const find = (re: RegExp): string => {
  const f = readdirSync(MIG).find((n) => re.test(n));
  if (!f) throw new Error(`no migration matches ${re}`);
  return readFileSync(resolve(MIG, f), 'utf8');
};
const a = find(/^\d{14}_phase_5_1_the_escrow_becomes_a_balance\.sql$/);
const b = find(/^\d{14}_phase_5_1_part_two_the_escrow_goes_live\.sql$/);

describe('LAW 1: a balance, not a counter', () => {
  it('the banks are derived from their components on every write', () => {
    expect(a).toMatch(/CREATE TABLE IF NOT EXISTS public\.tournament_escrow/);
    expect(a).toMatch(
      /prize_balance\s+= round\(\(gross_in - fee_entries_in - bounty_in\) \+ overlay_in \+ satellite_in - prize_out - refund_prize, 2\)/
    );
    expect(a).toMatch(/bounty_balance = round\(bounty_in - bounty_out - refund_bounty, 2\)/);
    expect(a).toMatch(
      /fee_balance\s+= round\(fee_entries_in \+ satellite_fee_in - fee_out - refund_fee, 2\)/
    );
  });
  it('one door, five feeders, all in the row transaction', () => {
    expect(a).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_escrow_apply\(/);
    for (const fn of [
      'fn_ca_escrow_on_wallet_tx',
      'fn_ca_escrow_on_rake_record',
      'fn_ca_escrow_on_overlay_leg',
      'fn_ca_escrow_on_seat_payout',
      'fn_ca_escrow_on_rake_settlement',
    ]) {
      expect(a).toContain(`CREATE OR REPLACE FUNCTION public.${fn}()`);
    }
    expect(b).toMatch(
      /CREATE TRIGGER zz_ca_escrow_wallet_tx AFTER INSERT ON public\.wallet_transactions/
    );
    expect(b).toMatch(
      /CREATE TRIGGER zz_ca_escrow_rake_record AFTER INSERT ON public\.rake_records/
    );
    expect(b).toMatch(
      /CREATE TRIGGER zz_ca_escrow_overlay_leg AFTER INSERT ON public\.chip_ledger/
    );
    expect(b).toMatch(
      /CREATE TRIGGER zz_ca_escrow_seat_payout AFTER INSERT ON public\.tournament_payouts/
    );
    expect(b).toMatch(
      /CREATE TRIGGER zz_ca_escrow_rake_settlement AFTER INSERT OR UPDATE OF settled_at ON public\.tournament_rake_settlements/
    );
    expect(b).toMatch(/IF v_n <> 6 THEN RAISE EXCEPTION 'expected 6 escrow triggers/);
  });
});

describe('LAW 2: an event pays only what it holds', () => {
  it('an outflow below zero is refused inside the write', () => {
    expect(a).toMatch(
      /IF v\.enforced AND v_outflow\s+AND \(v\.prize_balance < -0\.005 OR v\.bounty_balance < -0\.005 OR v\.fee_balance < -0\.005\) THEN/
    );
    expect(a).toMatch(/RAISE EXCEPTION 'escrow_short: tournament % cannot pay this %/);
  });
  it('the settle function reads the balance first and keeps the counter cap only for an unknown event', () => {
    expect(a).toMatch(
      /v_can := public\.fn_ca_escrow_can_pay\(p_tournament_id, v_row_kind, v_pay\);/
    );
    expect(a).toMatch(/IF \(v_can->>'known'\)::boolean AND NOT \(v_can->>'ok'\)::boolean THEN/);
    expect(a).toMatch(
      /IF v_row_kind = ANY \(v_pool_kinds\) AND NOT \(v_can->>'known'\)::boolean THEN/
    );
  });
});

describe('LAW 3: first sight opens from the shadow', () => {
  it('an unknown event is opened from fn_ca_tournament_escrow, row included, deltas not applied', () => {
    expect(a).toMatch(/SELECT \* INTO e FROM public\.fn_ca_tournament_escrow\(p_tournament_id\);/);
    expect(a).toMatch(/'shadow at first sight \(' \|\| p_what \|\| '\)'/);
  });
  it('the live events are opened in the same transaction as the triggers, inside the freeze', () => {
    expect(b).toMatch(/PERFORM public\.fn_ca_escrow_apply\(r\.id, 'opened at promotion'\);/);
    expect(b).toMatch(/Applied inside the :55 platform freeze/);
  });
});

describe('LAW 4: the close is judged, the shadow keeps checking', () => {
  it('COMPLETED with prize or bounty left is an incident', () => {
    expect(a).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_escrow_on_close\(\)/);
    expect(a).toMatch(/'escrow-close:' \|\| NEW\.id::text/);
    expect(b).toMatch(
      /CREATE TRIGGER zz_ca_escrow_close AFTER UPDATE OF status ON public\.tournaments/
    );
  });
  it('the hourly shadow compares itself to the balance', () => {
    expect(a).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_ca_escrow_balance_drift\(p_hours integer DEFAULT 3\)/
    );
    expect(a).toMatch(/'escrow-balance-drift:' \|\| r\.tournament_id::text/);
    expect(a).toMatch(/SELECT \(public\.fn_ca_escrow_balance_drift\(3\)\)::text;/);
  });
});

describe('LAW 5: spins are tracked, not refused', () => {
  it('a spin opens with enforced = false', () => {
    expect(a).toMatch(
      /SELECT \(COALESCE\(t\.variant, ''\) = 'spin' OR COALESCE\(t\.is_premium_spin, false\)\) INTO v_spin/
    );
    expect(a).toMatch(/\(p_tournament_id, NOT v_spin,/);
  });
});
