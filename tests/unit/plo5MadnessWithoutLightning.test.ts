/**
 * PLO5 1/2 MADNESS WITHOUT LIGHTNING (Dan 2026-10-24)
 *
 * "A 1/2 PLO5 MADNESS GAME WHILE THE BUGS ARE BEING WORKED OUT FOR LIGHTNING
 * GAMES. START IT NOW, 50% VPIP BB ANTE."
 *
 * The Madness template is Lightning Games (20261023230807), so this game is a
 * Classic must-move game carrying one named rules profile that the floor
 * trigger turns into the Madness promise at 50%. These pins keep the profile
 * narrow: it must never reach a Lightning game, never change any other game,
 * and the migration must stay one guarded transaction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const migrations = path.join(root, 'supabase/migrations');
const FILE = readdirSync(migrations).find((f) =>
  f.endsWith('_plo5_one_two_madness_without_lightning.sql')
)!;
const SQL = readFileSync(path.join(migrations, FILE), 'utf8');
const TRIGGER = SQL.slice(
  SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_game_floor_from_template'),
  SQL.indexOf('DO $open$')
);

describe('the madness_without_lightning profile', () => {
  it('is honoured only on a Classic game that is not Lightning', () => {
    expect(TRIGGER).toMatch(/NEW\.template_name = 'classic'/);
    expect(TRIGGER).toMatch(/NOT coalesce\(NEW\.lightning_enabled, false\)/);
    expect(TRIGGER).toMatch(/rules_profile' = 'madness_without_lightning'/);
  });

  it('takes the Madness promise with the owner floor of 50', () => {
    expect(TRIGGER).toMatch(/fn_cash_template_defaults\('madness', NEW\.variant\)/);
    expect(TRIGGER).toMatch(/'vpip_floor', 50/);
  });

  it('still replaces all four promised fields on every write, bombs whole', () => {
    for (const k of ['vpip_floor', 'vpip_window', 'regular_ante', 'bombs']) {
      expect(TRIGGER).toContain(`'${k}',`);
    }
  });

  it('refuses to overwrite a trigger body it has not seen', () => {
    expect(SQL).toMatch(/md5\(pg_get_functiondef\('public\.fn_cash_game_floor_from_template\(\)'/);
  });
});

describe('the game it opens', () => {
  it('is Midway, PLO5 1/2, six-handed, must-move, Lightning off', () => {
    expect(SQL).toMatch(/'PLO5 1\/2 Madness', 'classic', 'plo5', 1\.00, 2\.00, 6/);
    expect(SQL).toMatch(/v_snap, c_owner, true, false\)/);
    expect(SQL).toContain("'fade0000-0000-0000-0000-000000000001'");
  });

  it('opens Main 1 through the cluster writer and projects through the ruleset', () => {
    expect(SQL).toMatch(/fn_cash_cluster_open_table\(v_game, 'main', 1, 'live', c_owner\)/);
    expect(SQL).toMatch(/PERFORM public\.fn_cash_apply_ruleset\(v_game\)/);
  });

  it('asserts the projected table carries the promise and aborts otherwise', () => {
    expect(SQL).toMatch(/tb\.maintain_percent_min = 50/);
    expect(SQL).toMatch(/tb\.big_blind_ante_enabled/);
    expect(SQL).toMatch(/tb\.bomb_pot_enabled/);
    expect(SQL).toMatch(/RAISE EXCEPTION 'PLO5 1\/2 Madness table did not project the promise'/);
  });

  it('is idempotent: a second run finds the game instead of opening another', () => {
    expect(SQL).toMatch(/IF v_game IS NULL THEN/);
  });

  it('is one short transaction with no em dashes', () => {
    expect(SQL.match(/^BEGIN;/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;/gm)?.length).toBe(1);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '1s'/);
    expect(SQL).not.toContain('—');
  });
});
