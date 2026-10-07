import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const migration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261007030307_the_diamond_arena_does_not_open_a_chip_wallet.sql'
  ),
  'utf8'
);
const qualification = readFileSync(
  resolve(__dirname, '../scripts/ci/test-club-welcome-package.py'),
  'utf8'
);
describe('canonical chip wallet asset boundary', () => {
  it('changes only the pinned owner and verifies reverse substitution and authority', () => {
    expect(migration).toContain('3d5c7f2002a00b8802e124213b53efaf');
    expect(migration).toContain("IF NEW.asset = ''diamonds'' THEN RETURN NEW; END IF;");
    expect(migration).toContain(
      'replace(pg_get_functiondef(v_oid),v_new,v_old) IS DISTINCT FROM v_before'
    );
    expect(migration).toContain('IS DISTINCT FROM v_metadata');
    expect(migration).toContain('IS DISTINCT FROM v_guards');
  });
  it('preserves the chip insertion and introduces no wallet backfill or guard rewrite', () => {
    expect(migration).toContain('INSERT INTO public.club_wallets(club_id) VALUES(NEW.id)');
    expect(migration).not.toMatch(
      /(?:UPDATE|DELETE FROM|TRUNCATE) public\.(?:clubs|club_wallets|profiles)/
    );
    expect(migration).not.toMatch(/(?:ALTER|DROP|DISABLE) TRIGGER/i);
  });
  it('runs the regression in the existing native owning qualification', () => {
    for (const name of [
      'diamond-wallet-before-source-fix',
      'diamond-wallet-after-source-fix',
      'chip-wallet-after-source-fix',
      'diamond-wallet-direct-insert-still-refused',
    ])
      expect(qualification).toContain(name);
    expect(qualification).toContain(
      "run('install-diamond-wallet-asset-boundary',DIAMOND_WALLET_MIGRATION.read_text())"
    );
  });
});
