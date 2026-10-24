/**
 * CLASSIC PLO5 PLAYS AT A 50% VPIP FLOOR (Dan 2026-10-24).
 *
 * "just make the plo5 classic to 50% vpip and stop. thats it. then relaunch
 * the game." - every PLO5 Classic game.
 *
 * The floor is the template's (fn_cash_template_defaults); the floor trigger
 * copies it into every snapshot on every write, and fn_cash_apply_ruleset
 * projects it onto the tables. This reads the migration, as
 * vpipFloorIsTheTemplates.test.ts does, because a unit test cannot reach
 * production; the live result is asserted inside the migration itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const migrations = path.resolve(__dirname, '../../supabase/migrations');
const FILE = readdirSync(migrations).find((f) =>
  f.endsWith('_plo5_classic_plays_at_a_fifty_percent_vpip_floor.sql')
)!;
const SQL = readFileSync(path.join(migrations, FILE), 'utf8');

describe('Classic PLO5 at 50% VPIP', () => {
  it('changes the template, for Classic PLO5 only', () => {
    expect(SQL).toMatch(
      /'vpip_floor',CASE WHEN t='classic' AND v='plo5' THEN 50 WHEN t='classic' THEN 0 ELSE 40 END,'vpip_window',10/
    );
    // Every other floor is asserted unchanged before anything is written.
    expect(SQL).toMatch(/fn_cash_template_defaults\('classic','plo'\)->>'vpip_floor'\) <> '0'/);
    expect(SQL).toMatch(/fn_cash_template_defaults\('madness','plo5'\)->>'vpip_floor'\) <> '40'/);
  });

  it('guards the definitions it replaces and relies on', () => {
    expect(SQL).toMatch(/dff0793b509ab2a0ad3ce7214b4e8fef/);
    expect(SQL).toMatch(/3e958bf044bb7caeabc40e4ef82873b4/);
  });

  it('relaunches live games through the platform projection, never a hand-written table update', () => {
    expect(SQL).toMatch(/SET ruleset_snapshot = g\.ruleset_snapshot/);
    expect(SQL).toMatch(/public\.fn_cash_apply_ruleset\(v_game\.id\)/);
    expect(SQL).not.toMatch(/UPDATE public\.tables/);
    expect(SQL).toMatch(/did not take the 50%% floor/);
  });

  it('is one guarded transaction and not a repair job', () => {
    expect(SQL).toMatch(/^BEGIN;/m);
    expect(SQL).toMatch(/^COMMIT;/m);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '1s'/);
    expect(SQL).not.toMatch(/cron\.schedule|pg_cron/i);
  });
});
