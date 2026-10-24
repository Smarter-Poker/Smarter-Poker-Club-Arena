/**
 * LAW: CLUB DATA AND UNION DATA READ EACH WINDOW ONCE (2026-10-22).
 *
 * Migration 20261022165130. Union Data month to date took 12 to 31 s because
 * the per-club list read the whole window once per club, and Club Data held
 * locks on the hot tables for up to 5.6 s because its newest-games page ranked
 * every game of the window to pick 100. Both now read each window once, and
 * the page walks the newest tournaments and answers only when it can prove its
 * rows are the page core's (otherwise the page core is read as before).
 *
 * This pins those shapes so a later replacement cannot quietly put the seconds
 * back, and pins that the figures still come from the same readers. Every
 * output is proved equal before and after by
 * scripts/ci/test-club-data-reads-each-window-once.py on native Postgres.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SQL = readFileSync(
  join(ROOT, 'supabase/migrations/20261022165130_club_data_and_union_data_read_each_window_once.sql'),
  'utf8'
);
const CI = readFileSync(join(ROOT, '.github/workflows/club-data-reads-each-window-once.yml'), 'utf8');
const squash = (s: string) => s.replace(/\s+/g, ' ');

const body = (fn: string): string => {
  const at = SQL.indexOf(`FUNCTION public.${fn}(`);
  expect(at, fn).toBeGreaterThan(-1);
  const open = SQL.indexOf('$function$', at);
  return squash(SQL.slice(open, SQL.indexOf('$function$', open + 10)));
};

describe('Club Data and Union Data read each window once', () => {
  it('is one transaction with a lock budget and creates no table, index or trigger', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.trim().endsWith('COMMIT;')).toBe(true);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '3s';/);
    expect(SQL).not.toMatch(/CREATE (UNIQUE )?INDEX|CREATE TABLE|CREATE TRIGGER|ALTER TABLE|LOCK TABLE/);
    expect(SQL).toContain("RAISE EXCEPTION 'Club Data window reader already installed'");
  });

  it('replaces only pinned production definitions', () => {
    for (const [sig, pin] of [
      ['public.ca_club_data_screen(uuid,date,date,text,text,text,integer)', '33922bec7a85906e3a3925aeb269d0ce'],
      ['public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer)', '01dde673050f62c1290ad3b74a138c4c'],
      ['public.ca_rake_snapshot_v2(text,uuid,uuid,date,date,uuid,integer,integer,text,text)', 'f9d7e19f531145a8aea60af103aa95ed'],
      ['public.fn_ca_club_data_hand_count(uuid,date,date,text,text,text)', '81e9ebcdd7cce5ff2d08b858f9ce25d8'],
      ['public.fn_ca_rake_by_club_v2(uuid[],date,date,integer,integer,text,text)', '135f2c29ffd5ed7ad0440add76577fbd'],
      ['public.fn_ca_rake_window_v2(uuid[],date,date)', '29d518cdc9d32b7f923c758f569c9dc5'],
      ['public.fn_ca_rake_series_v2(uuid[],date,date,text)', '0c0f44a3b1626605af48d347b65b6499'],
    ]) {
      expect(SQL).toContain(`('${sig}', '${pin}')`);
    }
  });

  it('reads the union window and every club window in one pass', () => {
    expect(body('fn_ca_rake_window_v2')).toContain("fn_ca_rake_windows_v3(p_clubs, p_start, p_end, false)->'all'");
    const byClub = body('fn_ca_rake_by_club_v2');
    expect(byClub).toContain("fn_ca_rake_windows_v3(p_clubs, p_start, p_end, true)->'clubs'");
    expect(byClub).not.toContain('CROSS JOIN LATERAL');
    expect(body('fn_ca_rake_windows_v3')).toContain('FROM public.ca_club_data_game_ct d');
    expect(body('fn_ca_rake_series_v2')).toContain('FROM public.ca_club_data_game_ct d');
  });

  it('the union snapshot computes its window once', () => {
    const b = body('ca_rake_snapshot_v2');
    expect(b).toContain('fn_ca_rake_windows_v3(');
    expect(b).toContain('fn_ca_rake_by_club_from(');
  });

  it('plans the hand count with its values', () => {
    expect(SQL).toMatch(
      /FUNCTION public\.fn_ca_club_data_hand_count\([^)]*\)[\s\S]{0,300}SET plan_cache_mode TO 'force_custom_plan'/
    );
  });

  it('the newest-games walk falls back to the page core whenever it cannot prove its rows', () => {
    const b = body('ca_club_data_snapshot_v2');
    const walk = b.indexOf('fn_ca_club_game_recent_rows(p_club_id,v_start,v_end,v_lim)');
    const core = b.indexOf("ca_club_game_page_core_20261006(p_club_id,v_start,v_end,v_game,v_stakes,v_q,'recent',NULL,v_lim)");
    expect(walk).toBeGreaterThan(-1);
    expect(core).toBeGreaterThan(walk);
    expect(body('fn_ca_club_game_recent_rows')).toContain('ORDER BY tr.start_time DESC OFFSET 20000 LIMIT 1');
  });

  it('keeps scope and authorization: the new internal readers are callable by no client', () => {
    for (const sig of [
      'fn_ca_rake_windows_v3(uuid[],date,date,boolean)',
      'fn_ca_rake_by_club_from(uuid[],jsonb,integer,integer,text,text)',
      'fn_ca_club_game_recent_rows(uuid,date,date,integer)',
    ]) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(SQL).not.toMatch(new RegExp(`GRANT [^;]*${sig.replace(/[()[\]]/g, '\\$&')}`));
    }
  });

  it('never filters horses out of a figure', () => {
    expect(SQL.replace(/--[^\n]*/g, '')).not.toMatch(/is_horse/);
  });

  it('is qualified natively on every change to it', () => {
    expect(CI).toContain('scripts/ci/test-club-data-reads-each-window-once.py');
    expect(CI).toContain('supabase/migrations/20261022165130_club_data_and_union_data_read_each_window_once.sql');
    expect(CI).toContain('postgresql-17');
  });
});
