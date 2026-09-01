/**
 * TWO INSTRUMENTS THAT LIED, BOTH FOUND ON 2026-09-01.
 *
 * ── 1. The squeeze branch was unsatisfiable ──
 *
 * V18 shipped a squeeze response on 2026-08-26: hero opens, someone calls,
 * a 3-bet arrives, and because squeeze ranges are polarised toward air the
 * opener defends wider (fourBetThresh -0.03, callThresh -0.02).
 *
 * It has never fired. The test was `raises === 2 && callers >= 1`, and
 * `callers` is reset to 0 by every raise - including the 3-bet that CREATES
 * the squeeze. At the moment the opener is asked to respond, `callers` is
 * always 0.
 *
 * The league said so from the first run: `v18_squeeze_response` returns
 * 0.00 bb/100 with a stderr of 0.00 over 12,000 hands. Not a small effect -
 * an IDENTICAL one, because both arms play the same when the flag can never
 * turn on. Nobody read it, which is why the daily audit now raises
 * `league_matchup_inert` on exactly that shape. This is its first catch.
 *
 * ── 2. Both self-tuner feeds paged over a non-unique sort key ──
 *
 * `horse_daily_nets` is keyed (horse_user_id, day, game_variant, format) and
 * `horse_review_rollup` (horse_user_id, day, game_variant). Both were paged
 * 1,000 rows at a time ordered by (horse_user_id, day) alone: 2,589 and 3,413
 * tied groups respectively in a seven-day window. Postgres does not promise a
 * stable order within ties, and LIMIT/OFFSET over an unstable order silently
 * drops rows.
 *
 * MEASURED: two horses with 2,141 and 2,332 cash hands in the window - both
 * past the 1,500-hand bar - came out under it and were logged with the -9999
 * "no real sample" sentinel, so their dials were tuned from frequency
 * estimates instead of settlement truth. The leak-tag feed has the same bug,
 * and those counts drive tightness, aggression and bluffFreq directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const logicSrc = readFileSync(join(__dirname, 'HorseLogic.ts'), 'utf8');
const tunerSrc = readFileSync(join(__dirname, '..', 'services', 'HorseSelfTuner.ts'), 'utf8');

describe('the squeeze branch can actually fire', () => {
  it('reads the callers of the OPEN, not the callers of the 3-bet', () => {
    const at = logicSrc.indexOf('squeezed:');
    expect(at).toBeGreaterThan(-1);
    const branch = logicSrc.slice(at, at + 900).replace(/\/\/.*$/gm, '');
    expect(branch).toContain('callersOfPreviousRaise >= 1');
    // The old test. If this ever comes back the layer is dead again and the
    // league will report 0.00 +/- 0.00 forever.
    expect(branch).not.toMatch(/\bcallers >= 1\b/);
  });

  it('the count is captured before the raise resets it', () => {
    const loop = logicSrc.slice(
      logicSrc.indexOf('if (isAggr) {'),
      logicSrc.indexOf('lastRaiserSeat = a.seat;')
    );
    const capture = loop.indexOf('callersOfPreviousRaise = callers');
    const reset = loop.indexOf('callers = 0');
    expect(capture).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(-1);
    // Order matters and is the entire fix.
    expect(capture).toBeLessThan(reset);
  });

  it('still keeps the rest of the squeeze shape', () => {
    const at = logicSrc.indexOf('squeezed:');
    const branch = logicSrc.slice(at, at + 900);
    expect(branch).toContain('raises === 2');
    // Hero must have made the FIRST raise - a squeeze is something done TO
    // the opener, not something the cold-caller experiences.
    expect(branch).toContain('a.userId === player.user_id');
  });
});

describe('the self-tuner pages over a unique sort key', () => {
  const feeds: Array<[string, string[]]> = [
    // table, the columns that make a row unique
    ['horse_daily_nets', ['horse_user_id', 'day', 'game_variant', 'format']],
    ['horse_review_rollup', ['horse_user_id', 'day', 'game_variant']],
  ];

  for (const [table, key] of feeds) {
    it(`${table} is ordered by its full key before .range()`, () => {
      const at = tunerSrc.indexOf(`.from('${table}')`);
      expect(at, `${table} read not found`).toBeGreaterThan(-1);
      const block = tunerSrc.slice(at, tunerSrc.indexOf('.range(', at));
      for (const col of key) {
        expect(block, `${table} must order by ${col} or pagination drops rows`).toContain(
          `.order('${col}'`
        );
      }
    });
  }

  it('every paged read in the tuner uses .range with an order', () => {
    // A guard against the next one: any new 1,000-row loop that forgets to
    // order deterministically reintroduces exactly this class of bug.
    const ranges = tunerSrc.split('.range(').length - 1;
    const orders = tunerSrc.split(".order('").length - 1;
    expect(ranges).toBeGreaterThan(0);
    expect(orders).toBeGreaterThanOrEqual(ranges * 2);
  });
});
