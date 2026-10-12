/**
 * THE CLUB RETIREMENT CORE IS A REGISTERED MONEY DOOR (2026-10-02)
 *
 * 20261002152925 renamed fn_retire_settled_club to
 * fn_retire_settled_club_core_20260906 behind a new wrapper. The registry row
 * kept the old name, so fn_ca_money_rpc_drift() reported the core and the
 * midway burn-in gate failed no_unregistered_money_rpcs = 1.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261002191630_the_club_retirement_core_is_a_registered_money_door.sql',
  ),
  'utf8',
);

describe('the club retirement core is a registered money door', () => {
  it('is one transaction', () => {
    expect(SQL).toMatch(/\nBEGIN;\n/);
    expect(SQL).toMatch(/\nCOMMIT;\n$/);
  });

  it('registers the renamed core as approved', () => {
    expect(SQL).toMatch(
      /INSERT INTO public\.ca_money_rpc_registry\(proname,status,notes\) VALUES \(\s*'fn_retire_settled_club_core_20260906','approved'/,
    );
    expect(SQL).toMatch(/ON CONFLICT\(proname\) DO UPDATE SET status=EXCLUDED\.status/);
  });

  it('refuses to register a core that is missing or exposed to a browser role', () => {
    expect(SQL).toMatch(/to_regprocedure\('public\.fn_retire_settled_club_core_20260906\(uuid,text,text\)'\) IS NULL/);
    expect(SQL).toMatch(/has_function_privilege\('anon',\s*'public\.fn_retire_settled_club_core_20260906\(uuid,text,text\)','EXECUTE'\)/);
    expect(SQL).toMatch(/has_function_privilege\('authenticated',\s*'public\.fn_retire_settled_club_core_20260906\(uuid,text,text\)','EXECUTE'\)/);
    expect(SQL).toContain("RAISE EXCEPTION 'CLUB_RETIREMENT_PRIVATE_CORE_EXPOSED'");
  });

  it('proves no fn_retire_settled_club* balance writer is left unregistered', () => {
    expect(SQL).toMatch(/p\.proname LIKE 'fn_retire_settled_club%'/);
    expect(SQL).toMatch(/public\.fn_ca_money_rpc_writes_balances\(p\.prosrc\)/);
    expect(SQL).toContain("RAISE EXCEPTION 'CLUB_RETIREMENT_MONEY_DOOR_UNREGISTERED'");
  });

  it('changes no function body and touches no ledger table', () => {
    expect(SQL).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
    expect(SQL).not.toMatch(/ALTER FUNCTION/i);
    expect(SQL).not.toMatch(/chip_ledger/i);
  });

  it('declares a live proof', () => {
    expect(SQL).toMatch(
      /^-- @live-proof: EXISTS \(SELECT 1 FROM public\.ca_money_rpc_registry WHERE proname = 'fn_retire_settled_club_core_20260906' AND status = 'approved'\)$/m,
    );
  });
});
