/**
 * PLO5 AND PLO6 CLASSIC: 50% VPIP AND A BB ANTE, EVERY STAKE (Dan 2026-10-24)
 *
 * "MAKE THIS ADJUSTMENT NOW TO ALL PLO5 AND PLO6 CLASSIC GAMES. 50% VPIP AND
 * BB ANTE FOR ALL STAKES."
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const migrations = path.join(root, 'supabase/migrations');
const FILE = readdirSync(migrations).find((f) =>
  f.endsWith('_plo5_plo6_classic_fifty_vpip_bb_ante.sql')
)!;
const SQL = readFileSync(path.join(migrations, FILE), 'utf8');

describe('the Classic promise for PLO5 and PLO6', () => {
  it('is a BB ante and a 50% floor, only for plo5 and plo6', () => {
    expect(SQL).toContain(
      "'regular_ante',CASE WHEN t='classic' AND v NOT IN ('plo5','plo6') THEN 'none' ELSE 'bb' END,"
    );
    expect(SQL).toContain(
      "'vpip_floor',CASE WHEN t='classic' AND v IN ('plo5','plo6') THEN 50 WHEN t='classic' THEN 0 ELSE 40 END,"
    );
  });

  it('adds no bomb pots and leaves every other game as it was', () => {
    expect(SQL).not.toMatch(/'bombs',CASE/);
    expect(SQL).toMatch(/fn_cash_template_defaults\('classic', 'plo4'\)->>'vpip_floor'\) <> '0'/);
    expect(SQL).toMatch(/fn_cash_template_defaults\('madness', 'plo5'\)->>'vpip_floor'\) <> '40'/);
  });

  it('edits both functions by md5-guarded anchors, never retyped', () => {
    expect(SQL).toMatch(/md5\(s\) <> 'dff0793b509ab2a0ad3ce7214b4e8fef'/);
    expect(SQL).toMatch(/md5\(s\) <> '7254da1baec76082f8de928199f58c48'/);
  });
});

describe('a floor turned on mid-sitting judges only what follows it', () => {
  it('starts the maintain window at the later of the join and vpip_floor_since', () => {
    expect(SQL).toMatch(
      /v_since := GREATEST\(v_since, \(SELECT \(g\.ruleset_snapshot->>'vpip_floor_since'\)::timestamptz/
    );
    expect(SQL).toMatch(
      /jsonb_build_object\('vpip_floor_since', to_jsonb\(clock_timestamp\(\)\)\)/
    );
  });

  it('projects every open game through fn_cash_apply_ruleset and asserts the tables', () => {
    expect(SQL).toMatch(/PERFORM public\.fn_cash_apply_ruleset\(r\.id\)/);
    expect(SQL).toMatch(/did not project 50%% and the BB ante/);
  });

  it('is one short transaction with no em dashes', () => {
    expect(SQL.match(/^BEGIN;/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;/gm)?.length).toBe(1);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '1s'/);
    expect(SQL).not.toContain('—');
  });
});
