/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  hand_history IS NOT TOO BIG, IT IS TOO EMPTY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Measured on production 2026-08-26: the heap was 8700 MB across 1,113,604
 * pages holding 1,493,194 rows -- 1.34 live tuples per page. 400 randomly
 * probed pages found 302 of them (75.5%) completely empty, while the pages
 * that DID hold rows were 94% full. So ~6.6 GB is empty pages, and the rows
 * themselves are packed fine.
 *
 * The pruner keeps up (only ~2,200 rows were past the 7-day retention), so
 * this was never a growth problem. It is a high-water mark that VACUUM cannot
 * give back, because VACUUM only returns space by truncating empty pages at
 * the TAIL.
 *
 * These tests pin the two properties that make the compactor safe to run
 * against a live table: it never deletes anything, and the UPDATE it issues
 * cannot be observed by any consumer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceBetween } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const COMPACT = read('supabase/migrations/20260826020000_hand_history_compact_the_empty_pages.sql');
const RESUME = read('supabase/migrations/20260826021000_compaction_resumes_where_it_stopped.sql');

describe('The compactor cannot lose a hand', () => {
  it('only ever UPDATEs hand_history, never DELETEs from it', () => {
    // The entire safety case rests on this. A compactor that can delete is a
    // pruner with no retention policy.
    for (const sql of [COMPACT, RESUME]) {
      expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.hand_history/i);
      expect(sql).not.toMatch(/TRUNCATE\s+TABLE/i);
    }
  });

  it('writes a column back to its own value, so nothing changes', () => {
    // SET reported = reported rewrites the tuple without altering it. That is
    // the whole mechanism: a new tuple version the free space map can place
    // in one of the empty low pages.
    expect(RESUME).toContain('SET reported = reported');
  });

  it('refuses to run if an UPDATE trigger ever appears on the table', () => {
    // The three triggers on hand_history are all AFTER INSERT today. Moving a
    // row past an UPDATE trigger would re-run the club stats trigger and
    // double-count somebody's profit, so the compactor stops instead.
    expect(RESUME).toContain('update_trigger_present');
    expect(RESUME).toMatch(/tgtype\s*&\s*16/);
  });

  it('refuses to run if the table is ever added to a publication', () => {
    // An UPDATE on a replicated table is a broadcast to every subscriber.
    expect(RESUME).toContain('table_is_published');
    expect(RESUME).toContain('pg_publication_rel');
  });
});

describe('The compactor cannot run away', () => {
  it('has a kill switch that is checked before anything else', () => {
    const body = sliceBetween(RESUME, 'GUARD 1', 'GUARD 2');
    expect(body).toContain("'disabled'");
    expect(RESUME).toContain('hand_history_compaction_policy');
  });

  it('stops when the table is already packed, rather than churning for nothing', () => {
    expect(RESUME).toContain('already_compact');
    expect(RESUME).toContain('headroom_factor');
  });

  it('stops when a batch moves no rows', () => {
    expect(RESUME).toContain('no_progress');
  });

  it('is bounded by a wall-clock budget, not a row count', () => {
    expect(RESUME).toContain('p_budget_seconds');
    expect(RESUME).toContain('clock_timestamp() >= v_deadline');
  });
});

describe('The compactor advances instead of re-sweeping its own tail', () => {
  it('remembers the page it stopped at', () => {
    // Without this every call restarts at relpages, re-scans the same window
    // and never reaches further down -- busy forever, progress never.
    // Measured before the fix: run 1 stopped at page 937,604 and run 2 began
    // again at 1,113,604.
    expect(RESUME).toContain('resume_page');
    expect(RESUME).toContain('v_hi := LEAST(COALESCE(v_resume, v_relpages), v_relpages)');
  });

  it('clears the watermark once a sweep reaches the target', () => {
    // so the next sweep starts from the (by then truncated) tail
    expect(RESUME).toContain('CASE WHEN v_hi <= v_target THEN NULL ELSE v_hi END');
  });

  it('works the tail downwards, because only the tail can be truncated', () => {
    expect(RESUME).toContain('v_lo := GREATEST(v_target, v_hi - GREATEST(p_window_pages, 1))');
  });
});

describe('The migration records what was measured, not what was assumed', () => {
  it('states the page occupancy that justifies the whole exercise', () => {
    expect(COMPACT).toContain('1,113,604');
    expect(COMPACT).toContain('75.5%');
  });

  it('says why VACUUM FULL was rejected', () => {
    expect(COMPACT).toContain('ACCESS EXCLUSIVE');
  });

  it('carries a ROLLBACK section', () => {
    for (const sql of [COMPACT, RESUME]) {
      expect(sql).toContain('ROLLBACK');
    }
  });
});
