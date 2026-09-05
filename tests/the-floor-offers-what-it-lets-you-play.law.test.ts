/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FLOOR OFFERS WHAT IT LETS YOU PLAY, AND IS SIZED FOR THE HOUR
 *  2026-09-05
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two defects with one shape: a number decided in one file that another file
 * had already contradicted, with nothing in between to make them argue.
 *
 * ── 1. A TABLE NOBODY MAY SIT AT ──────────────────────────────────────────
 *
 * `PHASE_MAX_BB` was 2 - "NOTHING sits above 1/2 this phase, however rich the
 * wallet" - while `HorseFleetManager.DEFAULT_TABLES` built 2/5 tables and
 * Dan's own ceiling (2026-09-03) was "close any tables over 2/5", a sentence
 * that only means something if 2/5 is playable.
 *
 * Sixteen 2/5 tables were live on 2026-09-05, ninety-nine seats, and NOT ONE
 * horse had ever sat at any of them - not rarely, zero, since creation. The
 * seeder logged `No available horses ... band mid` at them every cycle
 * forever, because no rung of STAKE_LADDER mapped to 5.00, so no bankroll
 * window and no tag could name it.
 *
 * The clamp was the stale one, and the fleet can afford the rung: bankrolls
 * across the 1,000 horses that day were median 73,873, p90 385,614, max
 * 5,626,482, and at the 20-buy-in rule 2/5 costs 10,000 - so 822 of 1,000
 * clear it. The old note's own worked example (10,000 chips licensing 2/5) is
 * now the fleet median times seven.
 *
 * ── 2. A FLOOR SPREAD TOO THIN TO LOOK ALIVE ──────────────────────────────
 *
 * Dan, 2026-09-04: "fewer tables, more players at each table. late night
 * shouldn't have any 2-3 handed games." It was implemented for the NIGHT
 * WINDOW only.
 *
 * The occupancy curve caps BODIES by the hour, and at 10:44 Chicago on
 * 2026-09-05 that was 202 bodies of 964 eligible - spread across 152 open
 * cash tables. The head count was exactly what the curve asked for and every
 * table still looked empty: Dan's night complaint, happening at eleven in the
 * morning, with no rule to catch it.
 *
 * The principle was never nocturnal. `tablesNeededForHour` sizes the floor at
 * EVERY hour from the same arithmetic, and CHANGES NO PERCENTAGE OF THE
 * CURVE - the curve still decides how many horses are awake, this decides how
 * thinly they are spread.
 *
 * Registry: docs/laws.d/the-floor-offers-what-it-lets-you-play.md
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAY_MIN_OPEN_TABLES,
  EXOTIC_MAX_BB,
  NIGHT_MIN_OPEN_TABLES,
  NIGHT_MIN_PLAYERS,
  PHASE_MAX_BB,
  STAKE_LADDER,
  isNightWindow,
  minPlayersForHour,
  nightCap,
  nightTablesNeeded,
  stakeBandOf,
  stakeIsLegalThisPhase,
  tablesNeededForHour,
} from '../server/src/services/StableHand.js';

const ROOT = join(__dirname, '..');
const LADDER_BBS = STAKE_LADDER.map((s) => s.bb);

describe('the floor offers what it lets you play', () => {
  it('every stake the ladder carries is legal this phase, and vice versa', () => {
    for (const bb of LADDER_BBS) expect(stakeIsLegalThisPhase(bb)).toBe(true);
    expect(Math.max(...LADDER_BBS)).toBe(PHASE_MAX_BB);
    expect(stakeIsLegalThisPhase(PHASE_MAX_BB + 0.01)).toBe(false);
  });

  it('the ladder reaches Dan’s 25/50 cap - the tables the fleet actually builds', () => {
    // Dan 2026-09-03: "ADD THE HIGHER STAKES FOR MIDWAY UNION, CAP IT AT 25-50"
    for (const bb of [5, 10, 20, 50]) expect(LADDER_BBS).toContain(bb);
    expect(STAKE_LADDER.find((s) => s.bb === 5)).toEqual({ sb: 2, bb: 5 });
    expect(STAKE_LADDER.find((s) => s.bb === 50)).toEqual({ sb: 25, bb: 50 });
    expect(Math.max(...LADDER_BBS)).toBe(50);
    expect(stakeIsLegalThisPhase(100)).toBe(false);
  });

  it('every stake the FLEET CONFIG builds is a rung of the ladder', () => {
    /* This is the assertion that would have caught the original defect on the
       day it was introduced. A table the config can build and the ladder
       cannot name is a table that will sit empty forever. */
    const src = readFileSync(join(ROOT, 'server/src/services/HorseFleetManager.ts'), 'utf8');
    const cfg = src.slice(src.indexOf('const DEFAULT_TABLES'), src.indexOf('function '));
    const built = [...cfg.matchAll(/bigBlind:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    expect(built.length).toBeGreaterThan(5);
    for (const bb of new Set(built)) {
      expect(LADDER_BBS, `the config builds ${bb} but no ladder rung names it`).toContain(bb);
      expect(stakeIsLegalThisPhase(bb)).toBe(true);
    }
  });

  it('the exotic ceiling is its own, stricter number', () => {
    // Short deck and pineapple stay at 1/2 even though the phase now allows
    // 2/5. Two caps that differ on purpose, not by drift.
    expect(EXOTIC_MAX_BB).toBe(2);
    expect(EXOTIC_MAX_BB).toBeLessThan(PHASE_MAX_BB);
    /* And `stakeBandOf` did not follow the clamp up either: a 'top' band
       spanning 1 through 50 would let one label point a horse at both, which
       is the scatter the one-stake-level ruling forbids. The high rungs are
       reached by the bankroll, not by a band. */
    expect(stakeBandOf(2)).toBe('top');
    expect(stakeBandOf(50)).toBeNull();
  });
});

describe('the floor is sized for the hour', () => {
  it('sizes every hour, not only the night', () => {
    for (let h = 0; h < 24; h++) {
      expect(tablesNeededForHour(100, h)).toBeGreaterThan(0);
    }
  });

  it('is identical to the night rule inside the night window', () => {
    // The night behaviour and its own law test must not have moved.
    for (const h of [3, 4, 5, 6, 7]) {
      expect(isNightWindow(h)).toBe(true);
      expect(tablesNeededForHour(nightCap(584), h)).toBe(nightTablesNeeded(nightCap(584), h));
    }
  });

  it('keeps a much higher floor by day than by night', () => {
    expect(DAY_MIN_OPEN_TABLES).toBeGreaterThan(NIGHT_MIN_OPEN_TABLES);
    expect(tablesNeededForHour(0, 14)).toBe(DAY_MIN_OPEN_TABLES);
    expect(tablesNeededForHour(0, 4)).toBe(NIGHT_MIN_OPEN_TABLES);
  });

  it('grows with the hour, because the body cap does', () => {
    // Peak must license more tables than mid-morning, or the curve is being
    // fought rather than followed.
    const midMorning = tablesNeededForHour(200, 10);
    const peak = tablesNeededForHour(430, 19);
    expect(peak).toBeGreaterThan(midMorning);
  });

  it('the smallest tolerated table is Dan’s four at night, three by day', () => {
    expect(minPlayersForHour(4)).toBe(NIGHT_MIN_PLAYERS);
    expect(minPlayersForHour(4)).toBe(4);
    expect(minPlayersForHour(14)).toBe(3);
  });

  it('the controller parks on the hour’s numbers, not on the night window', () => {
    const src = readFileSync(join(ROOT, 'server/src/services/StableHandController.ts'), 'utf8');
    const park = src.slice(src.indexOf('EVERY HOUR, NOT ONLY THE NIGHT'));
    expect(park).toContain('tablesNeededForHour(occ.max, snap.chicagoHour)');
    expect(park).toContain('minPlayersForHour(snap.chicagoHour)');
    // The three protections survive: a human seated, a human waiting, a cluster.
    expect(park).toContain('t.humansSeated === 0 && t.humansWaiting === 0 && !t.clusterId');
  });

  it('changes no percentage of Dan’s occupancy curve', () => {
    const src = readFileSync(join(ROOT, 'server/src/services/StableHand.ts'), 'utf8');
    const curve = src.slice(
      src.indexOf('export const OCCUPANCY_CURVE_PCT'),
      src.indexOf('export const NIGHT_MIN_PLAYERS')
    );
    // The hourly percentages and the 5% night cap are Dan's, and this change
    // must be readable as untouched.
    expect(curve).toContain('18: 40,');
    expect(curve).toContain('19: 40,');
    expect(curve).toContain('20: 40,');
    expect(src).toContain('export const NIGHT_CAP_PCT = 0.05;');
  });
});
