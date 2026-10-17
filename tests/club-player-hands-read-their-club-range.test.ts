/**
 * The Club Data player readers sum hands from one range read of the scoped
 * clubs, not one index probe per attributed player (2026-10-17). The per-player
 * loop timed out the Players page on about 21% of production calls; the range
 * read returned identical rows in a single snapshot (12 of 12 cases).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261017005207_club_player_hands_read_their_club_range.sql'
  ),
  'utf8'
);
const NEW_HANDS = SQL.match(/\$new_hands\$([\s\S]*?)\$new_hands\$/)?.[1] ?? '';
const OLD_HANDS = SQL.match(/\$old_hands\$([\s\S]*?)\$old_hands\$/)?.[1] ?? '';

describe('club player hands read their club range', () => {
  it('patches exactly the three player readers from measured live preimages', () => {
    for (const signature of [
      'public.ca_club_player_breakdown(uuid,date,date,integer)',
      'public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)',
      'public.ca_club_player_export_start(uuid,date,date,text,uuid)',
    ])
      expect(SQL).toContain(signature);
    for (const hash of [
      '121a71892c21a33fcccde7099337d2c0',
      'a9cb30a01d41b5b5d1d6c4b815229933',
      'ce83a312514da0262ecead6ef1d49da8',
      'eeae15ae895151d2194c5962f2247b1d',
      '4c5af1a0f2c251df57e02d18a048b9fc',
      'a16b4b91e70e7bdd9df55dd5c605022f',
    ])
      expect(SQL).toContain(hash);
    expect(SQL.match(/^-- @live-proof:/gm)).toHaveLength(3);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('replaces the per-player join with one materialized range read of the same scope', () => {
    expect(OLD_HANDS).toContain('JOIN att_club a ON a.user_id=s.user_id');
    expect(OLD_HANDS).toContain('JOIN hand_clubs hc ON hc.club_id=s.club_id');
    expect(NEW_HANDS).toContain('), hands AS MATERIALIZED (');
    expect(NEW_HANDS).toContain('WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)');
    expect(NEW_HANDS).toContain('AND s.stat_date BETWEEN v_start AND v_end');
    expect(NEW_HANDS).toContain('GROUP BY s.user_id');
    expect(NEW_HANDS).not.toContain('att_club');
    // Players outside att_club never surface: merged still left-joins hands
    // FROM att_club, and the postimage guard insists on it.
    expect(SQL).toContain(
      "position('LEFT JOIN hands h ON h.user_id=a.user_id' IN v_definition) = 0"
    );
  });

  it('keeps every security, horse-privacy and export guard', () => {
    expect(SQL).toContain("v_owner IS DISTINCT FROM 'postgres'");
    expect(SQL).toContain('v_security_definer IS DISTINCT FROM true');
    expect(SQL).toContain('v_acl IS DISTINCT FROM v_row.acl');
    expect(SQL).toContain("'{postgres=X/postgres}'::text");
    expect(SQL).toContain(
      "position('public.fn_can_see_horse_flag(p_club_id)' IN v_definition) = 0"
    );
    expect(SQL).toContain("position('pg_try_advisory_xact_lock' IN v_definition) = 0");
    expect(SQL).toContain("position('FOR UPDATE OF stale_row SKIP LOCKED' IN v_definition) = 0");
  });

  it('adds no index on a per-hand column (the write-path law)', () => {
    expect(SQL).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
  });
});
