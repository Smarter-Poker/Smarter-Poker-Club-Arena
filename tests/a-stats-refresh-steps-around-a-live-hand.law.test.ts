/**
 * A STATS REFRESH STEPS AROUND A LIVE HAND (2026-10-03).
 *
 * Pinned on migration 20261003032438. refresh-player-stats-hourly died as the
 * deadlock victim against the per-hand player_stats writers. The refresh now
 * locks existing rows in key order with SKIP LOCKED, writes only what it
 * locked plus new keys in key order, and retries a deadlocked block.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261003032438_a_stats_refresh_steps_around_a_live_hand.sql'
  ),
  'utf8'
);

describe('a stats refresh steps around a live hand', () => {
  it('is one transaction that edits only the pinned function text', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^-- @live-proof: /m);
    expect(sql).toContain(
      "'public.fn_refresh_player_stats(timestamp with time zone)',\n  'a823ee7a6d52db8a948af9d12033f73d', '7b24a8ea05c7fb76becf6a214dc8bf69',"
    );
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\./);
  });

  it('locks existing rows in key order and skips the ones a live hand holds', () => {
    expect(sql).toMatch(/ORDER BY ps\.user_id, ps\.club_id\n\s+FOR UPDATE OF ps SKIP LOCKED;/);
    expect(sql).toMatch(
      /ORDER BY p\.user_id, p\.club_id\n\s+ON CONFLICT \(user_id, club_id\) DO UPDATE/
    );
  });

  it('retries a deadlocked block and still fails loudly on the third', () => {
    expect(sql).toMatch(/FOR v_try IN 1 \.\. 3 LOOP/);
    expect(sql).toMatch(
      /EXCEPTION WHEN deadlock_detected THEN\n\s+IF v_try >= 3 THEN RAISE; END IF;/
    );
  });
});
