/**
 * THE JOURNAL WINDOW IS A SNAPSHOT, NOT A CLOCK (2026-09-10).
 *
 * A 100.00 buy-in leg stamped created_at 09:34:39 committed after the
 * 09:34:41 replay reading. The next reading windowed the journal from
 * 09:34:41 by created_at, never counted the leg, and filed -100 on the wallet
 * and +100 on the felt as CRITICAL drift. Balances are read under a snapshot
 * (commit order); a journal windowed by insert-time clocks can never agree
 * with them at a boundary. Every reading now records its snapshot and the
 * next reading counts a leg iff it was not visible in that snapshot.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const sorted = () =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const migrationNamed = (slug: string): string => {
  const hit = sorted().filter((f) => f.endsWith(`_${slug}.sql`));
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
};
const latestDefinitionOf = (fn: string): { file: string; body: string } | null => {
  const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\(`, 'i');
  for (const f of sorted().reverse()) {
    const body = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    if (re.test(body)) return { file: f, body };
  }
  return null;
};

const M = migrationNamed('the_journal_window_is_a_snapshot_not_a_clock');

describe('the journal window is a snapshot, not a clock', () => {
  it('every reading records the snapshot it read under, from the same statement', () => {
    expect(M).toContain('ADD COLUMN IF NOT EXISTS read_snapshot text');
    expect(M).toContain('v_read_at, pg_current_snapshot()::text');
  });

  it('a leg is counted iff it was not visible in the previous snapshot; created_at only bounds the scan', () => {
    expect(M).toContain(
      'AND NOT pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin), p_prev_snapshot)'
    );
    expect(M).toContain("l.created_at > p_prev_at - interval '15 minutes'");
  });

  it('restores the epoch of a 32-bit xmin before judging it', () => {
    expect(M).toContain('WHEN x <= cur32 THEN (epoch << 32) + x');
    expect(M).toContain('ELSE ((epoch - 1) << 32) + x');
  });

  it('a change of basis is not drift: v4 rebaselines, and only a reading with a snapshot is judged', () => {
    expect(M).toContain("v_basis text := 'one-snapshot-v4'");
    expect(M).toContain('WHERE prev_at IS NOT NULL AND prev_snapshot IS NOT NULL LOOP');
    expect(M).toContain('(p.prev_at IS NULL OR p.prev_snapshot IS NULL)');
  });

  it('proves itself against the very leg that fell through', () => {
    expect(M).toContain("'4706a571-17e3-4db1-a55a-044c206fb236'");
    expect(M).toContain('fn_ca_xid8 misjudges a committed leg as invisible');
  });

  it('the newest definition of fn_ca_ledger_replay on disk still windows by snapshot', () => {
    const live = latestDefinitionOf('fn_ca_ledger_replay');
    expect(live).not.toBeNull();
    expect(live!.body, `${live!.file} redefines the replay without the snapshot window`).toContain(
      'fn_ca_leg_accounts_since_snapshot('
    );
  });
});
