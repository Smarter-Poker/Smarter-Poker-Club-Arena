/**
 * LAW: THE FELT COUNTS AN INSURED HAND (2026-10-12).
 *
 * A cash hand settles in two transactions. The commit moves the seats by
 * inflow - rake - bbj; the post-commit obligations then post the rake leg, the
 * jackpot drop legs and the insurance bank's leg. Between the two halves the
 * journal says the felt holds rake + bbj - inflow that no seat holds.
 * 20261011200421 taught the ledger replay's felt reader to count the rake and
 * the drop (incident 9294e359: +9.76 and +4.10, one hand's fees each, caught
 * between its halves). This law holds the reader to the whole quantity, read
 * from the stack result the seats were moved by, which is exactly what the
 * per-transaction ledger invariant (fn_ca_tally_balance_move, 20261001231409)
 * carries for the same hand. One definition of the felt, not two.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(process.cwd(), 'supabase/migrations');
const FILE = readdirSync(DIR).filter((f) => f.endsWith('_the_felt_counts_an_insured_hand.sql'));
const SQL = FILE.length === 1 ? readFileSync(resolve(DIR, FILE[0]), 'utf8') : '';
const BODY = SQL.replace(/--[^\n]*/g, '');

const READER =
  "public.fn_ca_account_balance('table_stack', '00000000-0000-0000-0000-0000000fe17e'::uuid, NULL, 'table_seats.stack')";
const WHOLE =
  /COALESCE\(\(c\.stack_result->>'rake'\)::numeric, 0\)\s+\+ COALESCE\(\(c\.stack_result->>'bbj'\)::numeric, 0\)\s+- COALESCE\(\(c\.stack_result->>'inflow'\)::numeric, 0\)/g;
const OLD_ANCHOR =
  /\$a\$ {8}\+ \(SELECT COALESCE\(sum\(COALESCE\(\(c\.post_commit_payload->'rake'->>'amount'\)::numeric, 0\)\n {31}\+ COALESCE\(\(c\.post_commit_payload->'bbj_contribution'->>'amount'\)::numeric, 0\)\), 0\)\n\$a\$,/;

describe('the felt counts an insured hand', () => {
  it('ships as exactly one recorded migration', () => {
    expect(FILE).toHaveLength(1);
    expect(FILE[0].replace(/\.sql$/, '').length).toBeLessThanOrEqual(60);
  });

  it('one transaction, a live proof, a pinned preimage, one anchor and a proof block', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '5s';/);
    expect(SQL).toMatch(/^-- @live-proof: /m);
    expect(SQL).toContain('INSURED_FELT_PREIMAGE_CHANGED');
    expect(SQL).toMatch(/v_n <> 1 THEN\s*RAISE EXCEPTION 'INSURED_FELT_ANCHOR_CHANGED/);
    expect(SQL).toMatch(/DO \$prove\$/);
    expect(BODY).not.toMatch(/\b(?:DROP|GRANT|REVOKE)\b/);
    expect(BODY).not.toMatch(/\bcron\.(?:schedule|alter_job|unschedule)\b/i);
  });

  it('replaces the payload rake and drop with the stack result rake + bbj - inflow', () => {
    expect(SQL).toMatch(OLD_ANCHOR);
    // once in the reader, once in the proof
    expect(BODY.match(WHOLE)).toHaveLength(2);
    // the replacement text carries no payload read of the fees
    const replacement = SQL.split(OLD_ANCHOR)[1]?.split("'unposted hand'")[0] ?? '';
    expect(replacement).toContain("c.stack_result->>'inflow'");
    expect(replacement).not.toContain('post_commit_payload');
  });

  it('the proof holds the reader to seats + add-ons + the whole owed amount in one statement', () => {
    expect(SQL).toContain(READER);
    expect(SQL).toContain('IF v_fn IS DISTINCT FROM v_seats + v_addons + v_owed THEN');
  });

  it('the felt is not rebaselined: the proof refuses while an insured hand is between its halves', () => {
    expect(SQL).not.toMatch(/INSERT INTO/);
    expect(SQL).toMatch(/IF v_inflow <> 0 THEN\s+RAISE EXCEPTION 'INSURED_FELT_RESULT_CHANGED/);
  });
});
