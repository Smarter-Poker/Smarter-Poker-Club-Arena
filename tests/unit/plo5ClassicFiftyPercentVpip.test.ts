/**
 * CLASSIC PLO5 PLAYS AT A 50% VPIP FLOOR (Dan 2026-10-24).
 *
 * "just make the plo5 classic to 50% vpip and stop. thats it. then relaunch
 * the game." - every PLO5 Classic game.
 *
 * The change itself was installed by 20261024213131 (PLO5 and PLO6 Classic,
 * 50% and a BB ante, a later owner instruction). 20261024212524 was superseded
 * before install and now only proves the outcome. These pin that it stays a
 * proof: if it ever replaced the template again it would undo the BB ante.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const migrations = path.resolve(__dirname, '../../supabase/migrations');
const FILE = readdirSync(migrations).find((f) =>
  f.endsWith('_plo5_classic_plays_at_a_fifty_percent_vpip_floor.sql')
)!;
const SQL = readFileSync(path.join(migrations, FILE), 'utf8');
const BODY = SQL.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

describe('Classic PLO5 at 50% VPIP', () => {
  it('only verifies: it writes nothing and replaces no function', () => {
    expect(BODY).not.toMatch(/CREATE OR REPLACE|UPDATE |INSERT |DELETE |fn_cash_apply_ruleset/i);
  });

  it('proves the template, every snapshot and every live table', () => {
    expect(BODY).toMatch(/fn_cash_template_defaults\('classic','plo5'\)->>'vpip_floor'\) <> '50'/);
    expect(BODY).toMatch(/have a floor other than 50/);
    expect(BODY).toMatch(/t\.maintain_percent_min = 50 AND t\.maintain_hands = 10/);
  });

  it('is one guarded transaction', () => {
    expect(SQL).toMatch(/^BEGIN;/m);
    expect(SQL).toMatch(/^COMMIT;/m);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '1s'/);
  });
});
