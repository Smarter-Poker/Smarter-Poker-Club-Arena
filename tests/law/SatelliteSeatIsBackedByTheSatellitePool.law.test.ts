/**
 * ===========================================================================
 *  LAW: A SATELLITE SEAT IS BACKED BY THE SATELLITE'S OWN POOL (2026-09-02)
 * ===========================================================================
 *
 * Chip Accounting Standard, section 3.2 step 9, Lane G. Measured on production
 * over 14 days: 23 seats were awarded and every one of them credited the
 * target's prize_pool and total_rake (4,600 chips in all) with no debit from
 * anybody, while the satellites that "paid" them kept their full collected
 * pools. The seat value was minted.
 *
 * `fn_award_satellite_seat` now moves the seat value (target buy_in + fee)
 * out of the satellite's prize_pool in the same transaction that credits the
 * target, and writes ONE chip_ledger row saying so. This test pins the text
 * of the migration that carries that rule so it cannot be quietly reverted by
 * a later CREATE OR REPLACE that starts from an older mirror.
 *
 * What it deliberately does NOT pin: any refusal. Dan's rule for this swarm
 * is that nothing which could refuse a seat award or strand a satellite
 * finish may be built. The transfer is best-effort by design; a pool that
 * cannot cover the seat moves what it holds and files a warning.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MIGRATION =
  'supabase/migrations/20260903020000_a_satellite_seat_is_paid_from_the_satellites_own_pool.sql';
const SQL = read(MIGRATION);

/** The body of one CREATE OR REPLACE FUNCTION block, by name. */
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined in ${MIGRATION}`).toBeGreaterThan(-1);
  const end = sql.indexOf('$$;', start);
  return sql.slice(start, end);
}

const AWARD = functionBody(SQL, 'fn_award_satellite_seat');
const AUDIT = functionBody(SQL, 'fn_satellite_conservation_audit');

/**
 * NEGATIVE CONTROL: the last FULL body of fn_award_satellite_seat before this
 * lane (the 2026-08-31 door-closing fix that followed it was a substring
 * patch, so it carries no body to compare). Every pin below must FAIL against
 * it, or the pin is not measuring the rule.
 */
const PREVIOUS = read(
  'supabase/migrations/20260831192927_a_satellite_seat_is_a_payout_and_an_unknown_origin_is_not_a_no.sql'
);

describe('the seat value leaves the satellite pool', () => {
  it('the satellite row is locked and its prize_pool debited by the seat value', () => {
    expect(AWARD).toMatch(
      /SELECT prize_pool INTO v_sat_pool\s+FROM public\.tournaments\s+WHERE id = p_satellite_id\s+FOR UPDATE;/
    );
    expect(AWARD).toMatch(/v_moved := LEAST\(GREATEST\(v_sat_pool, 0\), v_value\);/);
    expect(AWARD).toMatch(
      /SET prize_pool = round\(COALESCE\(prize_pool, 0\) - v_moved, 2\)\s+WHERE id = p_satellite_id;/
    );
  });

  it('the target is still credited exactly as before (the seat is the payout)', () => {
    expect(AWARD).toMatch(
      /prize_pool\s+= COALESCE\(prize_pool, 0\) \+ COALESCE\(v_t\.buy_in_amount, 0\)/
    );
    expect(AWARD).toMatch(
      /total_rake\s+= COALESCE\(total_rake, 0\) \+ COALESCE\(v_t\.buy_in_fee, 0\)/
    );
  });

  it('negative control: the previous body debited nobody', () => {
    expect(PREVIOUS).not.toMatch(/v_sat_pool/);
    expect(PREVIOUS).not.toMatch(/pool_transfer/);
    expect(PREVIOUS).not.toMatch(/prize_liability/);
  });
});

describe('one ledger row declares the movement', () => {
  it('prize_liability(satellite) -> prize_liability(target), tournament_buyin, keyed per seat', () => {
    expect(AWARD).toMatch(/INSERT INTO public\.chip_ledger/);
    expect(AWARD).toMatch(/'prize_liability', p_satellite_id, 'tournaments\.prize_pool',/);
    expect(AWARD).toMatch(/'prize_liability', p_target_id, 'tournaments\.prize_pool\+total_rake',/);
    expect(AWARD).toMatch(/v_moved, 'tournament_buyin', v_t\.club_id, p_satellite_id,/);
    expect(AWARD).toMatch(
      /'tourney:' \|\| p_satellite_id::text \|\| ':seat:' \|\| p_user_id::text \|\| ':pool_transfer'/
    );
    expect(AWARD).toMatch(
      /ON CONFLICT \(idempotency_key\) WHERE idempotency_key IS NOT NULL DO NOTHING;/
    );
  });

  it('the vocabulary it relies on is asserted after apply', () => {
    expect(SQL).toMatch(/LIKE '%''tournament_buyin''%'/);
    expect(SQL).toMatch(/LIKE '%''prize_liability''%'/);
    expect(SQL).toMatch(/ux_chip_ledger_idempotency_key/);
  });
});

describe('a seat is never refused and never unseated by its bookkeeping', () => {
  it('the transfer block catches everything and files the failure', () => {
    const block = AWARD.slice(AWARD.indexOf('SELECT prize_pool INTO v_sat_pool'));
    expect(block).toMatch(
      /EXCEPTION WHEN OTHERS THEN\s+GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;/
    );
    expect(block).toMatch(/INSERT INTO public\.ca_ledger_write_failures/);
    expect(block).toMatch(/satellite_seat_transfer_failed/);
  });

  it('an unbacked seat is a WARNING with the shortfall, not a refusal', () => {
    expect(AWARD).toMatch(
      /IF v_short > 0 THEN\s+PERFORM public\.fn_raise_server_financial_alert\(\s+'warning', 'satellite_seat_unbacked'/
    );
    expect(AWARD).toMatch(/'shortfall', v_short/);
    // No branch in the function returns a refusal because of the pool.
    expect(AWARD).not.toMatch(/'reason', 'satellite_pool_short'/);
    expect(AWARD).not.toMatch(/'reason', 'unbacked'/);
  });

  it('every pre-existing refusal reason is still there, unchanged', () => {
    for (const reason of ['target_not_found', 'target_closed', 'target_full']) {
      expect(AWARD).toContain(`'reason', '${reason}'`);
      expect(PREVIOUS).toContain(`'reason', '${reason}'`);
    }
    // Added by the 2026-08-31 door-closing patch, which rewrote the live body
    // by substring; it must survive a full CREATE OR REPLACE.
    const DOOR = read(
      'supabase/migrations/20260831210000_a_satellite_seat_closes_when_every_other_door_closes.sql'
    );
    expect(AWARD).toContain("'reason', 'target_pool_finalized'");
    expect(DOOR).toContain("'reason', 'target_pool_finalized'");
    expect(AWARD).toMatch(/COALESCE\(v_t\.current_level, 0\) >= v_cap/);
    expect(AWARD).toContain("'held_from_this_satellite', v_seated");
    expect(AWARD).toContain("'origin_unknown', (v_existing IS NULL)");
  });
});

describe('the audit reads the collected pool, not the depleted counter', () => {
  it('adds the ledgered seat transfers back to prize_pool', () => {
    expect(AUDIT).toMatch(
      /round\(s\.prize_pool::numeric\s+\+ COALESCE\(\(SELECT sum\(l\.amount\) FROM chip_ledger l/
    );
    expect(AUDIT).toMatch(
      /l\.idempotency_key LIKE 'tourney:' \|\| s\.id::text \|\| ':seat:%:pool_transfer'/
    );
  });

  it('negative control: the previous audit read the bare counter', () => {
    const OLD_AUDIT = read(
      'supabase/migrations/20260830211704_fn_satellite_conservation_audit.sql'
    );
    expect(OLD_AUDIT).toMatch(/s\.prize_pool::numeric pool,/);
    expect(OLD_AUDIT).not.toMatch(/pool_transfer/);
  });
});

describe('access is unchanged', () => {
  it('service_role only, SECURITY DEFINER, search_path pinned', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_award_satellite_seat\(uuid, uuid, uuid, text, integer\) FROM PUBLIC, anon, authenticated;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_award_satellite_seat\(uuid, uuid, uuid, text, integer\) TO service_role;/
    );
    expect(AWARD).toMatch(/SECURITY DEFINER\s+SET search_path TO 'public'/);
  });
});
