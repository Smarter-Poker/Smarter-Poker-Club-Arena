/**
 * A PRUNED HAND IS NOT AN UNFINISHED ONE (2026-09-27)
 *
 * smarter_private.hand_submissions is immutable and outlives
 * public.hand_atomic_commits, which sp_prune_hand_history deletes for
 * horse-only hands at eight days. public.fn_ca_resume_hand_submission, asked
 * at every table admission, read a pruned commit as an unfinished retained
 * original and refused HAND_SUBMISSION_HANDOFF_STATE_CHANGED for ever, so live
 * tables could no longer be admitted from 2026-09-26 22:02 UTC on.
 *
 * These laws pin the replacement exactly:
 *   - the door is the 20260926091630 body plus ONE selector clause, and that
 *     clause skips only an EMPTY coordinate with a LATER commit on the same
 *     table that is not a 'reserved' permit;
 *   - retention keeps the last commit of every live table beside the F06
 *     boundary guard, inserted by asserted substitution;
 *   - the disposable-PostgreSQL regression that reproduces the refusal and
 *     proves the fix runs in CI.
 *
 * 20260927145821.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE = readFileSync(join(MIGRATIONS, '20260927145821_a_pruned_hand_is_not_an_unfinished_one.sql'), 'utf8');
const PREVIOUS = readFileSync(
  join(MIGRATIONS, '20260926091630_a_retained_hand_commits_past_a_seat_taken_after_its_deal.sql'),
  'utf8'
);
const CI = readFileSync(join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission');
  expect(start, 'the file defines the door').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  const close = sql.indexOf('$function$', open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const CLAUSE_START = '   -- A PRUNED HAND IS NOT AN UNFINISHED ONE (20260927145821).';
const CLAUSE_CODE = `   AND NOT (c.table_id IS NULL AND p.state IS DISTINCT FROM 'reserved'
     AND EXISTS(SELECT 1 FROM public.hand_atomic_commits later
       WHERE later.table_id=j.table_id AND later.hand_number>j.hand_number))
`;

describe('a pruned hand is not an unfinished one', () => {
  it('the door is the reviewed 20260926091630 body plus exactly one selector clause', () => {
    const next = body(FILE);
    const prev = body(PREVIOUS);
    expect(md5(prev)).toBe('828edb105fa8d69f089430d7945f5fb9');
    expect(md5(next)).toBe('1a6fefb7c5eeadfd70f4be08ad00e5a5');
    const a = next.indexOf(CLAUSE_START);
    const b = next.indexOf(CLAUSE_CODE);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    // Removing the inserted lines restores the previous body byte for byte.
    expect(next.slice(0, a) + next.slice(b + CLAUSE_CODE.length)).toBe(prev);
  });

  it('only an empty coordinate with a later commit and no reserved permit is skipped', () => {
    expect(CLAUSE_CODE).toContain('c.table_id IS NULL');
    expect(CLAUSE_CODE).toContain("p.state IS DISTINCT FROM 'reserved'");
    expect(CLAUSE_CODE).toContain('later.hand_number>j.hand_number');
    // The original selection is unchanged and still precedes the new clause.
    expect(body(FILE)).toContain(
      "WHERE j.table_id=p_table_id AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL\n   OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')\n"
    );
  });

  it('pins the pre-image and post-image of both functions', () => {
    expect(FILE).toContain("md5(p.prosrc) = '828edb105fa8d69f089430d7945f5fb9'");
    expect(FILE).toContain("md5(p.prosrc) = '1a6fefb7c5eeadfd70f4be08ad00e5a5'");
    expect(FILE).toContain("NOT IN ('f0334f1595384bb608a6c99af86b568a', 'f776fcb97431b343e7cb8f469f51aa42')");
    expect(FILE).toContain('carries % F06 boundary guard(s), expected 1');
  });

  it('retention keeps the last commit of a live table, beside the F06 guard', () => {
    expect(FILE).toContain('CREATE FUNCTION smarter_private.live_table_last_commit_retained(p_table_id uuid, p_hand_number bigint)');
    expect(FILE).toContain("lower(COALESCE(tb.status, '')) IN ('waiting', 'running')");
    expect(FILE).toContain('NOT COALESCE(tb.is_deleted, false)');
    expect(FILE).toContain(
      "AND NOT smarter_private.live_table_last_commit_retained(hh.table_id,hh.hand_number::bigint)'"
    );
    expect(FILE).toContain('EXECUTE replace(v_def, v_anchor, v_with);');
    // The retention boundary itself is not touched.
    expect(FILE).not.toMatch(/horse_retention_days\s*=/);
    expect(FILE).not.toMatch(/^\s*(UPDATE|DELETE FROM|INSERT INTO)\s+public\.hand_/m);
  });

  it('is one transaction', () => {
    expect(FILE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FILE.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('the disposable-PostgreSQL regression runs in CI', () => {
    expect(CI).toContain('python3 scripts/ci/test-pruned-hand-is-not-unfinished-postgres.py --pg-bin');
  });
});
