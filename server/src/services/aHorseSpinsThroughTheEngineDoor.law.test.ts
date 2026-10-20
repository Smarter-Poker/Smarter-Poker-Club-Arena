/**
 * LAW: A HORSE SPINS THROUGH THE ENGINE DOOR, ON THE PERSON'S WHEEL, AND NEVER
 * LOOKS AT A SEALED OUTCOME (Dan, 2026-10-18).
 *
 * "A HORSE WITH NO CHIPS LEFT GRINDS THE DIAMOND ARENA AND USES ITS DIAMONDS
 * ON DIAMOND SPINS TO CONVERT TO CHIPS."
 *
 * HorseDiamondSpinsDriver is the horse's input device for Diamond Spins
 * (CLAUDE.md 10.5). Four things make it an input device rather than a second
 * wheel or an advantage, and each is pinned here against the source:
 *
 *   1. ONE DOOR. Every action is `fn_horse_diamond_spins` (engine only, horse
 *      only, runs the person's own function). The driver calls no wheel, game
 *      or money function directly and writes no table.
 *   2. NO PEEKING. A person's screen never shows the crash point, the mine
 *      cells, the road roll, a server seed or the order of the three cards
 *      before they choose. The driver never selects any of them.
 *   3. THE FREEZE. Nothing is done during the hourly break (CLAUDE.md 13).
 *   4. IT RUNS. It is started and stopped with the leader-owned services in
 *      index.ts, so a standby never spins and a shutdown waits for the pass.
 *   5. IT HAS A READER (CLAUDE.md 10.83, Phase 5 2026-10-19). Its figures -
 *      horses the fleet cannot seat, spins, refusals, errors - are published
 *      on /health, and the trigger is the fleet's own "cannot be seated" bar,
 *      never only one buy-in.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = (p: string) => readFileSync(join(__dirname, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const DRIVER = strip(here('HorseDiamondSpinsDriver.ts'));
const RULES = strip(here('HorseDiamondSpins.ts'));
const INDEX = strip(here('../index.ts'));
const HEALTH = strip(here('../handlers/health.ts'));

describe('a horse spins through the engine door', () => {
  it('sends every action through fn_horse_diamond_spins and nothing else', () => {
    const rpcs = [...DRIVER.matchAll(/\.rpc\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect(rpcs).toEqual(['fn_horse_diamond_spins']);
  });

  it('writes nothing itself', () => {
    expect(DRIVER).not.toMatch(/\.from\([^)]*\)\s*\.(insert|update|upsert|delete)\(/);
    expect(RULES).not.toMatch(/supabase|\.rpc\(|\.from\(/);
  });

  it('asks only for actions the door knows', () => {
    const acts = [...DRIVER.matchAll(/act\(\s*h,\s*'([a-z_]+)'/g)].map((m) => m[1]);
    const door = new Set([
      'wheel_state',
      'wheel_commit',
      'wheel_spin',
      'game_commit',
      'bonus_state',
      'bonus_start',
      'choice_state',
      'choice_act',
      'crash_cashout',
      'crash_settle',
      'cards_pick',
    ]);
    expect(acts.length).toBeGreaterThan(5);
    for (const a of acts) expect(door.has(a), a).toBe(true);
  });
});

describe('a horse never looks at a sealed outcome', () => {
  it('selects no crash point, mine cell, road roll, seed, roll or card order', () => {
    const selects = [...DRIVER.matchAll(/\.select\(\s*'([^']*)'/g)].map((m) => m[1]).join(',');
    for (const sealed of [
      'crash_cents',
      'mine_cells',
      'road_roll',
      'server_seed',
      'permutation',
      'roll',
      'half_diamonds',
      'prizes',
      'cap_cents',
    ]) {
      expect(selects.split(/[\s,]+/), sealed).not.toContain(sealed);
    }
    expect(selects).not.toMatch(/\*/);
  });
});

describe('the freeze and the lifecycle', () => {
  it('checks the freeze before a pass and between actions', () => {
    const pass = DRIVER.slice(DRIVER.indexOf('export async function horseSpinPass'));
    expect(pass.indexOf('doors.frozen()')).toBeGreaterThan(-1);
    expect((pass.match(/doors\.frozen\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(DRIVER).toMatch(/frozen: \(\) => isMaintenanceFrozen\(\)/);
  });

  it('starts and stops with the leader-owned services', () => {
    const start = INDEX.slice(INDEX.indexOf('async function startLeaderOwnedServices'));
    expect(start.slice(0, start.indexOf('function stopLeaderOwnedServices'))).toMatch(
      /startHorseDiamondSpins\(\)/
    );
    expect(INDEX).toMatch(/\['HorseDiamondSpins', stopHorseDiamondSpins\]/);
  });
});

describe('the reader and the trigger', () => {
  it('publishes its figures on /health', () => {
    expect(HEALTH).toMatch(/deps\.horseDiamondSpins \?\? horseDiamondSpinsStatus/);
    expect(HEALTH).toMatch(/horseDiamondSpins \? \{ horseDiamondSpins \}/);
  });

  it('starts a horse spinning when the fleet cannot seat it, counting its chips on the felt', () => {
    expect(DRIVER).toMatch(/cannotBeSeated\(m\.userId, roll, game\)/);
    expect(DRIVER).toMatch(/const roll = m\.chips \+ m\.feltChips/);
    expect(DRIVER).not.toMatch(/isOutOfChips/);
  });
});
