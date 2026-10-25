/**
 * A LIGHTNING HAND IS FOUND BY ITS HAND HISTORY ID (2026-10-25, migration
 * 20261025041900).
 *
 * fn_cash_earning_club asks, for every attributed player of every cash hand,
 * whether lightning_hand has a row with this hand_history_id and host table.
 * No index led with hand_history_id, so each probe was a parallel sequential
 * scan of the whole table (55,580 buffers, 230 ms at 291,641 rows, measured
 * 2026-10-25). The migration builds idx_lightning_hand_hand_history_id
 * CONCURRENTLY (lightning_hand is written every Lightning hand) in the
 * preamble the applier admits, and refuses an interrupted or misshapen index.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';

const FILE = '20261025041900_lightning_hand_is_found_by_its_hand_history_id.sql';
const SQL = readFileSync(resolve(__dirname, '..', 'supabase/migrations', FILE), 'utf8');

describe('a lightning hand is found by its hand history id', () => {
  it('the earning-club reader looks lightning_hand up by hand_history_id', () => {
    // fn_cash_earning_club's Lightning branch is installed by this migration
    // (an in-place edit of the definition, so latestDeclaring cannot see it).
    const reader = readFileSync(
      resolve(
        __dirname,
        '..',
        'supabase/migrations/20261018135018_lightning_rake_uses_original_pool_funding.sql'
      ),
      'utf8'
    );
    expect(reader).toContain('h.hand_history_id=p_hand_id AND h.host_table_id=p_table_id');
  });

  it('builds the index concurrently in the admitted preamble, and nothing else', () => {
    const split = splitConcurrentPreamble(SQL) as {
      ok: boolean;
      indexes?: Array<{ name: string; schema: string; table: string }>;
    };
    expect(split.ok).toBe(true);
    expect(split.indexes).toEqual([
      expect.objectContaining({
        name: 'idx_lightning_hand_hand_history_id',
        schema: 'public',
        table: 'lightning_hand',
      }),
    ]);
    expect(SQL).toMatch(
      /^CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lightning_hand_hand_history_id\n ON public\.lightning_hand \(hand_history_id\);$/m
    );
  });

  it('refuses an interrupted or differently shaped index, and changes nothing else', () => {
    const code = SQL.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code).toContain('i.indisvalid');
    expect(code).toContain('i.indisready');
    expect(code).toContain(
      "'CREATE INDEX idx_lightning_hand_hand_history_id ON public.lightning_hand USING btree (hand_history_id)'"
    );
    expect(code).toMatch(/SET LOCAL lock_timeout = '1s';/);
    expect(code).not.toMatch(
      /CREATE OR REPLACE FUNCTION|ALTER TABLE|DROP |INSERT |UPDATE |DELETE /
    );
    expect(code.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(code.match(/^COMMIT;$/gm)?.length).toBe(1);
  });

  it('carries its measurement', () => {
    expect(SQL).toMatch(/55,580 buffers and took 230 ms at 291,641 rows/);
  });
});
