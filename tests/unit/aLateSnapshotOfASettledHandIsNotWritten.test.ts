import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 2026-10-06: a snapshot flush delayed by a database stall arrived six seconds
 * after its hand had settled and re-opened it. The event's last table was then
 * refused admission for two hours and through a restart. The writer now asks
 * whether the hand is settled, under a lock it shares with the settlement.
 */
const sql = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    'supabase',
    'migrations',
    '20261006081157_a_late_snapshot_of_a_settled_hand_is_not_written.sql'
  ),
  'utf8'
);

describe('a late snapshot of a settled hand is not written', () => {
  it('the writer returns before its insert when the hand is at or below a commit', () => {
    const guard = sql.indexOf('AND a.hand_number >= p_hand_number');
    const ret = sql.indexOf('RETURN;', guard);
    const insert = sql.indexOf("|| E'  INSERT INTO hand_state_snapshots (';", ret);
    expect(guard).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(guard);
    expect(insert).toBeGreaterThan(ret);
  });

  it('the writer and the settlement acknowledgement take the same per-table lock', () => {
    expect(sql).toContain(
      "PERFORM pg_advisory_xact_lock(hashtextextended(''hand-snapshot:'' || p_table_id::text, 0));"
    );
    const ackLock = sql.indexOf(
      "PERFORM pg_advisory_xact_lock(hashtextextended(''hand-snapshot:'' || s.table_id::text, 0));"
    );
    expect(ackLock).toBeGreaterThan(-1);
    // The lock is taken before the acknowledgement's completing UPDATE.
    expect(sql.indexOf('|| v_old;', ackLock)).toBeGreaterThan(ackLock);
  });

  it('both functions are pinned by md5 and the change is one transaction', () => {
    expect(sql).toContain('06129a019e7e1f758c867c2ab6f24981');
    expect(sql).toContain('24cad0448c0686c890152f2a314b6f54');
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('removes only an incomplete snapshot of a hand that has a commit', () => {
    const del = sql.slice(sql.indexOf('DELETE FROM public.hand_state_snapshots s'));
    expect(del).toContain('WHERE NOT s.is_complete');
    expect(del).toContain('a.hand_number = s.hand_number');
    expect(del).toContain('a.hand_id IS NOT NULL');
  });
});
