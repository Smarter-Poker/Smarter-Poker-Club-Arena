/**
 * KILL POTS (kill-v1): A HAND THAT CARRIES kill_pot COMMITS ON A DATABASE THAT
 * DOES NOT HAVE THE COLUMN YET.
 *
 * logHandHistory puts `kill_pot` into p_hand_row only when the hand has kill
 * facts (handHistory.test.ts pins that). The row reaches the table through
 * fn_ca_commit_hand_settlement -> fn_ca_insert_hand_with_awards, and that
 * insert names ONLY the keys that are real hand_history columns:
 *
 *     SELECT string_agg(quote_ident(c.column_name), ...)
 *       FROM information_schema.columns c
 *      WHERE c.table_name = 'hand_history' AND p_row ? c.column_name;
 *     INSERT INTO public.hand_history (<those>) SELECT <those>
 *       FROM jsonb_populate_record(null::public.hand_history, $1)
 *
 * so before migration 20260924034010 the key is ignored and the hand commits
 * without it, and after it the key is stored. The engine therefore needs no
 * "is the column there" branch on the write path, and adding one would be a
 * second source of truth for the same fact. The live body is this one:
 * 20260918092329 pins md5(pg_get_functiondef) = e7f05bb7d61360be7424c5f429066047,
 * which is what this repository definition produces on PostgreSQL 16, and
 * scripts/ci/test-kill-pot-table-settings.py executes it both ways (cases
 * pre-install-unknown-hand-key-is-ignored and post-install-kill-pot-is-stored).
 *
 * This test pins the property on the repository's newest definition, so a
 * rewrite of the insert that named every key would fail here first.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const DEFINES = 'CREATE OR REPLACE FUNCTION public.fn_ca_insert_hand_with_awards(';

function newestDefinition(): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8').includes(DEFINES));
  const file = files[files.length - 1];
  const sql = readFileSync(resolve(MIGRATIONS, file), 'utf8');
  const start = sql.lastIndexOf(DEFINES);
  const end = sql.indexOf('END $fn$;', start);
  return { file, body: sql.slice(start, end) };
}

describe('the atomic hand insert names only real columns', () => {
  it('is defined last by the migration whose body the live pin matches', () => {
    expect(newestDefinition().file).toBe(
      '20260906113554_the_atomic_hand_insert_lets_the_defaults_apply_and_proves_it.sql'
    );
  });

  it('builds its column list from information_schema, filtered to the keys supplied', () => {
    const { body } = newestDefinition();
    expect(body).toMatch(/FROM information_schema\.columns c/);
    expect(body).toMatch(/c\.table_name\s*=\s*'hand_history'/);
    expect(body).toMatch(/AND p_row \? c\.column_name;/);
    // The insert and the populate both use that list and nothing else.
    expect(body).toMatch(/INSERT INTO public\.hand_history \(%1\$s\) /);
    expect(body).toMatch(
      /SELECT %1\$s FROM jsonb_populate_record\(null::public\.hand_history, \$1\)/
    );
    expect(body).not.toMatch(/SELECT \* FROM jsonb_populate_record/);
  });
});
