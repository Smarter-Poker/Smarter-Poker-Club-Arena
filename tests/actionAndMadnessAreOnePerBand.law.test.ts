/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACTION AND MADNESS ARE ONE GAME PER BLIND CATEGORY (Dan, 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "WE NEED TO CONSOLIDATE 'ACTION' AND 'MADNESS' TO ONE GAME
 * PER BLIND CATEGORY. ONE MICRO, ONE SMALL, ONE MID, AND ONE HIGH PER GAME
 * TYPE. 'CLASSIC' SHOULD HAVE ALL THE GAME SAME STAKES IT HAS."
 *
 * The rule now lives in two places at once, which is the only reason it can
 * be enforced at all: `stakeBandForBigBlind` decides which horses may sit at
 * a table, and `public.fn_cash_stake_band` is the IMMUTABLE SQL twin a unique
 * index is built on. If those two ever disagree about a boundary, the fleet
 * and the schema disagree about what a band IS: a 0.50 game the engine calls
 * micro would occupy the database's `low` rung, and the duplicate the index
 * exists to refuse would be allowed straight back in.
 *
 * So this law pins the boundaries on BOTH sides, from the same table of big
 * blinds, and pins the index and the trigger that carry the rule.
 *
 * There is no database in vitest, so the SQL side is read as source text.
 * That is the point: the migration file is the artefact that reaches
 * production, and a boundary edited there without its twin is exactly the
 * drift this catches.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stakeBandForBigBlind } from '../server/src/services/HorseBehavior';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const MIGRATION =
  'supabase/migrations/20260906004318_action_and_madness_are_one_game_per_blind_category.sql';

/**
 * The band boundaries, stated once. Every big blind here is either a boundary
 * or the first value past one, so an off-by-one in either implementation
 * (`<` for `<=`, 0.5 for 0.05) moves at least one of these rows.
 */
const BANDS: ReadonlyArray<readonly [number, 'micro' | 'low' | 'mid' | 'high']> = [
  [0.02, 'micro'],
  [0.25, 'micro'],
  [0.5, 'micro'],
  [0.51, 'low'],
  [1, 'low'],
  [2, 'low'],
  [2.01, 'mid'],
  [5, 'mid'],
  [6, 'mid'],
  [6.01, 'high'],
  [10, 'high'],
  [20, 'high'],
  [50, 'high'],
];

/**
 * The SQL twin, evaluated from its own source. The CASE arms are read out of
 * the migration rather than restated here, so a threshold changed in the
 * migration changes what this function returns and the shared table below is
 * what fails.
 */
function sqlStakeBandFromMigrationSource(sql: string): (bb: number) => string {
  const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_stake_band'));
  const arms = [...body.matchAll(/WHEN\s+p_bb\s*<=\s*([\d.]+)\s*THEN\s*'(\w+)'/g)].map(
    (m) => [Number(m[1]), m[2]] as const
  );
  const elseArm = /ELSE\s+'(\w+)'/.exec(body);
  if (arms.length === 0 || !elseArm) throw new Error('fn_cash_stake_band CASE arms not parseable');
  return (bb: number) => {
    for (const [limit, band] of arms) if (bb <= limit) return band;
    return elseArm[1];
  };
}

describe('fn_cash_stake_band is the SQL twin of stakeBandForBigBlind', () => {
  const sql = read(MIGRATION);
  const sqlBand = sqlStakeBandFromMigrationSource(sql);

  it.each(BANDS)('a %s big blind is in the %s band on both sides', (bb, band) => {
    expect(stakeBandForBigBlind(bb)).toBe(band);
    expect(sqlBand(bb)).toBe(band);
  });

  it('the four cut points are the ones Dan named: micro, small (low), mid, high', () => {
    const sqlSrc = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_stake_band'));
    expect(sqlSrc).toMatch(/p_bb\s*<=\s*0\.5\s+THEN\s+'micro'/);
    expect(sqlSrc).toMatch(/p_bb\s*<=\s*2\s+THEN\s+'low'/);
    expect(sqlSrc).toMatch(/p_bb\s*<=\s*6\s+THEN\s+'mid'/);
    expect(sqlSrc).toMatch(/ELSE\s+'high'/);
    // IMMUTABLE is not decoration: a unique index cannot be built on a
    // function without it, so losing it silently removes the guarantee.
    expect(sqlSrc).toContain('IMMUTABLE');
  });

  it('a big blind that is not a number is never silently banded high', () => {
    // stakeBandForBigBlind answers 'low' for garbage rather than throwing, and
    // the SQL twin answers NULL, which a partial unique index treats as
    // distinct. Neither may answer 'high' - a nonsense stake must not land on
    // the rung the fleet reserves for its largest games.
    expect(stakeBandForBigBlind(Number.NaN)).not.toBe('high');
    expect(stakeBandForBigBlind(0)).not.toBe('high');
    expect(stakeBandForBigBlind(-1)).not.toBe('high');
    expect(sql).toMatch(/WHEN\s+p_bb\s+IS\s+NULL\s+THEN\s+NULL/);
  });
});

describe('the shape is held by the schema, not by an operator remembering it', () => {
  const sql = read(MIGRATION);

  it('a partial unique index covers (club, style, variant, band)', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX');
    expect(sql).toContain('cash_games_one_per_band_action_madness');
    const idx = sql.slice(sql.indexOf('CREATE UNIQUE INDEX'));
    expect(idx).toMatch(
      /ON\s+public\.cash_games\s*\(\s*club_id,\s*template_name,\s*variant,\s*public\.fn_cash_stake_band\(bb\)\s*\)/
    );
  });

  it("the index predicate names 'action' and 'madness' and NOT 'classic'", () => {
    const idx = sql.slice(sql.indexOf('CREATE UNIQUE INDEX'));
    const predicate = /WHERE\s+enabled\s+AND\s+template_name\s+IN\s*\(([^)]*)\)/.exec(idx);
    expect(predicate, 'the index must stay partial - a full index would cover classic').not.toBe(
      null
    );
    expect(predicate![1]).toContain("'action'");
    expect(predicate![1]).toContain("'madness'");
    // Classic keeps all 87 of its games across 13 stake levels. Dan said so.
    expect(predicate![1]).not.toContain("'classic'");
  });

  it('the index is built CONCURRENTLY, outside the transaction', () => {
    // The first apply deadlocked: the controller writes cash_games.last_tick_at
    // on ~120 rows every five seconds and a plain CREATE UNIQUE INDEX waits on
    // a lock those writes will not yield. Nothing applied at all.
    expect(sql).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
    const commit = sql.lastIndexOf('COMMIT;');
    expect(sql.indexOf('CREATE UNIQUE INDEX CONCURRENTLY')).toBeGreaterThan(commit);
  });

  it('a BEFORE trigger says ONE_GAME_PER_BLIND_CATEGORY in words a human reads', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fn_guard_one_game_per_blind_category');
    expect(sql).toContain('ONE_GAME_PER_BLIND_CATEGORY');
    expect(sql).toMatch(
      /CREATE TRIGGER zz_one_game_per_blind_category\s+BEFORE INSERT OR UPDATE OF [^\n]*\s+ON public\.cash_games/
    );
    const guard = sql.slice(sql.indexOf('fn_guard_one_game_per_blind_category'));
    // Only the two styles, and only while enabled: a disabled row is history.
    expect(guard).toMatch(/NEW\.template_name NOT IN \('action', 'madness'\)/);
    expect(guard).toMatch(/IF NOT NEW\.enabled/);
    // It must not fire on the row being edited, or every UPDATE fails.
    expect(guard).toContain('g.id <> NEW.id');
  });

  it('retiring a game disables it - it never deletes the row and never moves a chip', () => {
    expect(sql).toMatch(/SET\s+enabled = false,\s*\n\s*closed_at = now\(\)/);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.cash_games/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.(club_members|table_seats|wallets)/i);
  });
});
