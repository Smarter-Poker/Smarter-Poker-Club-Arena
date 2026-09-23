import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrationCorpus } from './helpers/migrationCorpus';

const root = resolve(__dirname, '..');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260901004500_opening_club_bank_is_not_drift.sql'),
  'utf8'
);
const certification = readFileSync(resolve(root, 'scripts/ci/certify-club-create.mjs'), 'utf8');

/** The newest migration's restatement of `fn`: what a rebuild installs. */
const newestDefinition = (fn: string): string => {
  const create = `CREATE OR REPLACE FUNCTION public.${fn}(`;
  const newest = migrationCorpus()
    .filter((m) => m.sql.includes(create))
    .pop();
  if (!newest) return '';
  const rest = newest.sql.slice(newest.sql.indexOf(create));
  const open = rest.indexOf('$function$');
  return rest.slice(0, rest.indexOf('$function$', open + '$function$'.length));
};

describe('New Club Opening Bank Ledger', () => {
  it('removes the obsolete owner-wallet grant', () => {
    expect(migration).toContain(
      "EXECUTE 'DROP TRIGGER trg_first_club_creation_bonus ON public.club_members'"
    );
    expect(migration).toContain('New-club funding belongs exclusively in clubs.chip_treasury');
  });

  it('accepts an idempotent duplicate only when the canonical mint exists', () => {
    /* 2026-09-23: the grant has journalled from issuance_reserve since
       2026-09-03, so an exemption matching l.from_type = 'system_mint' alone
       was dead for every newer club. The detectors that carry it today (the
       newest definitions, not this 2026-09-01 file) accept both shapes. */
    for (const fn of ['fn_ca_quick_reconcile', 'fn_chip_integrity_report']) {
      const body = newestDefinition(fn);
      expect(body, fn).toContain("f.sqlstate = '23505'");
      expect(body, fn).toContain('ux_chip_ledger_idempotency_key');
      expect(body, fn).toContain("l.idempotency_key = 'club-opening-grant:' || f.club_id::text");
      expect(body, fn).toContain("l.from_type IN ('system_mint', 'issuance_reserve')");
      expect(body, fn).not.toContain("l.from_type = 'system_mint'");
      expect(body, fn).toContain("l.to_type = 'club_treasury'");
      expect(body, fn).toContain('l.amount = 100000');
    }
  });

  it('limits Drift Incidents to Midway Union without limiting global club fixes', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_is_midway_scope');
    expect(migration).toContain("'fade0000-0000-0000-0000-000000000001'::uuid");
    expect(migration).toContain('IF NOT public.fn_ca_is_midway_scope(');
    expect(migration).toContain('p_union_id, p_club_id, p_table_id, p_tournament_id, p_metadata');
    expect(migration).toContain('fn_ca_is_midway_scope(NULL, f.club_id');
    expect(migration).not.toContain('WHERE c.id = p_club_id AND c.id =');
  });

  it('certifies the bank and owner wallet independently', () => {
    expect(certification).toContain('Number(membership?.chip_balance) !== 0');
    expect(certification).toContain('Number(storedClub?.chip_treasury) !== 100000');
  });
});
