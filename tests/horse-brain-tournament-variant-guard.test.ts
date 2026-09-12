import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOURNAMENT_GAME_VARIANTS } from '../src/config/tournamentVariants';
import { SPIN_GAME_TYPES } from '../src/config/spinSpec';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260912044409_remaining_tournament_variant_allowlist.sql'
  ),
  'utf8'
);
describe('database tournament launch catalog matches the actual creator', () => {
  it('requires the same eight tournament games and four Spin games as the product', () => {
    const lists = [...migration.matchAll(/gameVariant' NOT IN \(([^)]+)\)/g)].map((m) =>
      [...m[1].matchAll(/'([^']+)'/g)].map((v) => v[1]).sort()
    );
    expect(lists).toEqual([
      [...new Set(Object.values(TOURNAMENT_GAME_VARIANTS))].sort(),
      [...SPIN_GAME_TYPES].sort(),
    ]);
    expect(lists.flat()).not.toContain('PINEAPPLE');
  });
  it('pins the exact creator and wrapper, with verified postimage, metadata preservation and idempotence', () => {
    expect(migration).toContain("md5(v_source)<>'ef2671b3cb67a8c710a7fbe3f0431ef6'");
    expect(migration).toContain("md5(v_source)='d00caa094f988ca352b6f7038f660c19' THEN RETURN");
    expect(migration).toContain('IS DISTINCT FROM v_metadata');
    expect(migration).toContain("'16305fb3739f13e64af6a1e8eb3bf165'");
  });
});
