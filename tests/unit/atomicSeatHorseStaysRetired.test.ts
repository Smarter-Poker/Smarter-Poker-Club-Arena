import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The retirement ran against production on 2026-08-31 and was recorded as
// schema_migrations version 20260831104745, but the file itself was carried out
// of main by the revert of #2143. A from-scratch replay of the migration
// directory therefore re-created a function that debits the frozen
// public.wallets pool - the pool holding 718,146,564 chips in horse hands. This
// pin fails if the file leaves the tree again, or if its two teeth are softened.
const migrationPath = join(
  __dirname,
  '../../supabase/migrations/20260831_retire_atomic_seat_horse_the_dead_minting_path.sql'
);

function liveSql(): string {
  return readFileSync(migrationPath, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('atomic_seat_horse stays retired in the migration history', () => {
  it('keeps the retirement file in the tree so a replay reaches the production schema', () => {
    expect(() => readFileSync(migrationPath, 'utf8')).not.toThrow();
  });

  it('drops the wallet-debiting seat path as live SQL, not as a comment', () => {
    expect(liveSql()).toContain(
      'DROP FUNCTION IF EXISTS public.atomic_seat_horse(uuid, uuid, integer, numeric, text, uuid)'
    );
  });

  it('refuses to apply if anything still calls it or wrote through it recently', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toContain('ABORT: % database function(s) actually CALL atomic_seat_horse');
    expect(migration).toContain(
      'ABORT: atomic_seat_horse wrote % row(s) in the last 30 days; it is not dead'
    );
    expect(migration).toContain('POST-APPLY: atomic_seat_horse still exists');
  });

  it('leaves the restore path recorded as comment only, never as live SQL', () => {
    const live = liveSql();
    expect(live).not.toContain('CREATE OR REPLACE FUNCTION public.atomic_seat_horse');
    expect(live).not.toContain('UPDATE wallets SET balance');
  });
});
