/**
 * A COUNT THAT HAS NOT CHANGED IS NOT A WRITE.
 *
 * `fn_sync_club_table_counts` fires AFTER INSERT, AFTER DELETE and AFTER
 * UPDATE OF (status, is_deleted, club_id, union_id, tournament_id) on
 * public.tables, and recomputed a denormalised `table_count` onto the club
 * row every time. The engine cycles every live table between 'waiting' and
 * 'running' continuously, and each of those transitions fired it - but
 * `fn_live_table_count` counts
 *
 *     status NOT IN ('closed', 'deleted')
 *
 * so both of those statuses count and the total does not move. The UPDATE was
 * assigning the value the row already held.
 *
 * Measured on production 2026-09-29 04:10 UTC: all five clubs had
 * `table_count` exactly equal to a fresh `fn_live_table_count`, so every one
 * of those writes was a no-op - and there were 128,715 UPDATEs against ten
 * live rows in eleven hours, leaving 95 percent dead tuples in 756 pages. The
 * table population says the same: 328,237 rows are 'closed' and about 765 are
 * 'waiting' or 'running'.
 *
 * A no-op UPDATE is not free here. It writes a new version of the club
 * settings row, runs the fifteen triggers that fire on a clubs UPDATE, and
 * takes an exclusive lock on that single row held until the writing
 * transaction commits. The engine changes table status inside the hand loop,
 * so that lock was held for the rest of the hand and every other hand in the
 * club queued behind it. public.clubs was the most contended tuple behind
 * Lock/transactionid.
 *
 * After it shipped, clubs UPDATEs went from 3.10/s to 0.000/s over 90 seconds
 * of live play, and neither clubs nor club_wallets appears in the
 * Lock/transactionid contention set at all.
 *
 * Every pin below is one of those facts:
 *
 *  1. Both writes are conditional. The recount still happens; only the store
 *     is guarded.
 *  2. The recount is NOT removed, so the column still ends every call holding
 *     exactly fn_live_table_count(id) - no reader can tell the difference.
 *  3. All three triggers stay bound, or the count silently stops tracking.
 *  4. The function keeps SECURITY DEFINER and its pinned search_path. A
 *     CREATE OR REPLACE that forgets them is a silent privilege change.
 *  5. Nothing is backfilled (10.12): the stored counts were already correct.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (needle: string) => {
  const f = files.find((x) => x.includes(needle));
  if (!f) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, f), 'utf8');
};

describe('a count that has not changed is not a write', () => {
  const sql = read('a_count_that_has_not_changed_is_not_a_write');
  const fnBody = sql.split('AS $function$')[1].split('$function$')[0];

  it('guards both stores, so an unchanged count writes nothing', () => {
    expect(fnBody.match(/table_count IS DISTINCT FROM/g)).toHaveLength(2);
    expect(fnBody.match(/UPDATE clubs c/g)).toHaveLength(2);
  });

  it('still recomputes the count, so the column never goes stale', () => {
    expect(fnBody.match(/fn_live_table_count\(t\.id\)/g)).toHaveLength(2);
  });

  it('still covers both sides of a move, and the union fan-out', () => {
    expect(fnBody).toContain('v_clubs');
    expect(fnBody).toContain('v_unions');
    expect(fnBody).toContain('SELECT club_id FROM union_clubs WHERE union_id = ANY(v_unions)');
  });

  it('keeps SECURITY DEFINER and its pinned search_path', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    expect(sql).toContain("p.proconfig = ARRAY['search_path=public, pg_temp']");
  });

  it('pins the body and refuses to land if a trigger came unbound', () => {
    expect(sql).toContain('CLUB_TABLE_COUNT_POSTIMAGE_DRIFT');
    expect(sql).toContain('CLUB_TABLE_COUNT_WRITES_UNCONDITIONALLY');
    expect(sql).toContain('CLUB_TABLE_COUNT_TRIGGERS_MISSING');
    expect(sql).toMatch(/md5\(p\.prosrc\) = '[0-9a-f]{32}'/);
  });

  it('backfills nothing: the stored counts were already correct', () => {
    expect(sql).not.toMatch(/cron\.schedule/i);
    expect(sql).not.toMatch(/\b(backfill|back_pay|backpay|repair|redrive|catchup|resweep)\b/i);
    expect(fnBody).not.toMatch(
      /UPDATE\s+clubs\s+SET\s+table_count\s*=\s*fn_live_table_count\(id\)\s*WHERE\s+id\s*=\s*ANY/
    );
  });

  it('is proven both ways on a disposable cluster', () => {
    const harness = readFileSync(
      join(__dirname, '..', 'scripts', 'ci', 'test-rake-does-not-lock-the-club-row.py'),
      'utf8'
    );
    expect(harness).toContain('before-a-status-flip-rewrites-the-club-row');
    expect(harness).toContain('after-a-status-flip-does-not-touch-the-club-row');
    expect(harness).toContain('the-count-is-still-maintained-when-it-really-changes');
  });
});
