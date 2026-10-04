/**
 * JACKPOT FACTS NAME THEIR CALLER (2026-10-04).
 *
 * fn_bbj_pool_facts gated its caller by auth.role() only, so the ungated-money
 * detector (which recognises a gate by the authorization helpers and auth.uid)
 * paged a critical on a reporting-cache write. Migration 20261004135612 states
 * the same rule by identity; the detector is not weakened.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const M = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20261004135612_jackpot_facts_name_their_caller.sql'),
  'utf8'
);

describe('jackpot facts name their caller', () => {
  it('admits a signed-in user or the service, by identity', () => {
    expect(M).toContain(
      "IF auth.uid() IS NULL AND COALESCE(auth.role(), 'service_role') <> 'service_role' THEN"
    );
    expect(M).toContain("'99a822c978dc293b526abfa49c937393'");
  });

  it('proves the detector no longer flags it, inside the same transaction', () => {
    expect(M).toContain("FROM public.fn_ungated_money_rpcs() WHERE fn = 'fn_bbj_pool_facts'");
  });

  it('does not touch the detector', () => {
    expect(M).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_ungated_money_rpcs/i);
  });
});
