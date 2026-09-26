/**
 * A RECEIPTED CHIP IS MOVEMENT EVIDENCE (2026-09-26)
 *
 * A parked tournament table re-admitted after a restart takes its movement
 * proof from smarter_private.f06_movement_prior, which required every seat to
 * hold exactly the last sealed hand's stack. Committed purchases, receipted
 * arrivals, a break its dead generation BEGAN without an admission, and a
 * recorded bust on a claimed park all refused tables whose every chip was
 * accounted for. 20260926091645 (applied 2026-09-26) reads those durable
 * receipts; it also replaces 20260926092954, which fixed the begun-break
 * case another way and could never apply once this landed.
 *
 * These laws pin the installed bodies (the @live-proof md5s production
 * carries), the begun-break branch of the admission, and the shape of the
 * migration.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const SQL = readFileSync(
  join(MIGRATIONS, '20260926091645_a_receipted_chip_is_movement_evidence.sql'),
  'utf8'
);

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
function tagged(tag: string): string {
  const a = SQL.indexOf(tag) + tag.length;
  const z = SQL.indexOf(tag, a);
  expect(z).toBeGreaterThan(a);
  return SQL.slice(a, z);
}

const PRIOR = tagged('$movement_prior$');
const ADMIT = tagged('$movement_admit$');
const GUARD = tagged('$movement_guard$');

describe('a receipted chip is movement evidence', () => {
  it('installs exactly the bodies production carries', () => {
    expect(md5(PRIOR)).toBe('b69098029169b71482e827e9a59ed55b');
    expect(md5(ADMIT)).toBe('b77d5c53decccf1b0579ce08ef492a63');
    expect(md5(GUARD)).toBe('be484837a5103b3c0ac78a1d6d5d0bf2');
    for (const m of [
      'b69098029169b71482e827e9a59ed55b',
      'b77d5c53decccf1b0579ce08ef492a63',
      'be484837a5103b3c0ac78a1d6d5d0bf2',
    ])
      expect(SQL).toMatch(new RegExp(`^-- @live-proof: .*${m}`, 'm'));
  });

  it('admits a begun break only with a proof that names that break', () => {
    expect(ADMIT).toContain(
      "IF NOT ((o.state='park_requested' AND o.manifest IS NULL) OR (o.state='begun' AND o.manifest IS NOT NULL)) THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING'"
    );
    expect(ADMIT).toContain(
      "IF o.state='begun' AND proof#>>'{receipts,break_id}' IS DISTINCT FROM p_break_id::text THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING'"
    );
  });

  it('replaces the begun-break migration that could never apply', () => {
    expect(
      existsSync(
        join(
          MIGRATIONS,
          '20260926092954_a_break_its_dead_generation_began_is_finished_by_its_successor.sql'
        )
      )
    ).toBe(false);
  });

  it('is one transaction with explicit grants and private helpers', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).not.toMatch(/CONCURRENTLY|VACUUM|break_window_migration_override/);
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.f06_movement_prior(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint) TO service_role;'
    );
  });
});
