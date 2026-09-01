import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260901004500_opening_club_bank_is_not_drift.sql'),
  'utf8'
);
const certification = readFileSync(resolve(root, 'scripts/ci/certify-club-create.mjs'), 'utf8');

describe('New Club Opening Bank Ledger', () => {
  it('removes the obsolete owner-wallet grant', () => {
    expect(migration).toContain(
      "EXECUTE 'DROP TRIGGER trg_first_club_creation_bonus ON public.club_members'"
    );
    expect(migration).toContain('New-club funding belongs exclusively in clubs.chip_treasury');
  });

  it('accepts an idempotent duplicate only when the canonical mint exists', () => {
    expect(migration).toContain("f.sqlstate = '23505'");
    expect(migration).toContain('ux_chip_ledger_idempotency_key');
    expect(migration).toContain("l.idempotency_key = 'club-opening-grant:' || f.club_id::text");
    expect(migration).toContain("l.from_type = 'system_mint'");
    expect(migration).toContain("l.to_type = 'club_treasury'");
    expect(migration).toContain('l.amount = 100000');
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
