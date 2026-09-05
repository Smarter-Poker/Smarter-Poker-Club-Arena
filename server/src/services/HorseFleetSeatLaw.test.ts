/**
 * The engine's cash tables obey Dan's seat law.
 *
 * On 2026-08-19 they did not. HorseFleetManager.DEFAULT_TABLES said PLO5
 * 8-max and PLO6 7-max while the law said 7 and 6, and ensureAllTablesExist()
 * re-created those tables on every boot - 83 PLO5 and 81 PLO6 rows had reached
 * production. The client guard (TableService.createTable) never saw them,
 * because it only guards the club's Create Table modal.
 *
 * These tests read the SHIPPED source rather than a copy of the numbers, so
 * they cannot drift away from what runs.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  maxSeatsForVariant,
  clampSeatsForVariant,
  isSeatCountLegal,
  DEFAULT_MAX_SEATS,
} from '../config/tableSeating.js';

const FLEET_SRC = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');

/** Every { name, maxPlayers, gameVariant } in DEFAULT_TABLES, from the source. */
function fleetConfigs(): Array<{ name: string; seats: number; variant: string }> {
  const block = /DEFAULT_TABLES:\s*TableConfig\[\]\s*=\s*\[([\s\S]*?)\n\];/.exec(FLEET_SRC);
  if (!block) throw new Error('DEFAULT_TABLES not found - this test is measuring nothing');
  return [
    ...block[1].matchAll(
      /name:\s*'([^']+)'[\s\S]*?maxPlayers:\s*(\d+)[\s\S]*?gameVariant:\s*'([^']+)'/g
    ),
  ].map((m) => ({ name: m[1], seats: Number(m[2]), variant: m[3] }));
}

describe('the seat law', () => {
  it('is what Dan said it is', () => {
    expect(maxSeatsForVariant('plo6')).toBe(6);
    expect(maxSeatsForVariant('plo5')).toBe(7);
    expect(maxSeatsForVariant('plo4')).toBe(8);
    expect(maxSeatsForVariant('plo8')).toBe(8);
    expect(maxSeatsForVariant('nlh')).toBe(DEFAULT_MAX_SEATS);
    expect(DEFAULT_MAX_SEATS).toBe(9);
  });

  it('is case-insensitive and survives a null variant', () => {
    expect(maxSeatsForVariant('PLO6')).toBe(6);
    expect(maxSeatsForVariant(null)).toBe(9);
    expect(maxSeatsForVariant(undefined)).toBe(9);
  });

  it('clamps down but never up - a ceiling, not a target', () => {
    expect(clampSeatsForVariant('plo6', 9)).toBe(6);
    expect(clampSeatsForVariant('plo5', 8)).toBe(7);
    expect(clampSeatsForVariant('plo6', 4)).toBe(4); // smaller table left alone
    expect(clampSeatsForVariant('nlh', 9)).toBe(9);
  });

  it('rejects nonsense seat counts rather than passing them through', () => {
    expect(clampSeatsForVariant('plo6', 0)).toBe(2);
    expect(clampSeatsForVariant('plo6', Number.NaN)).toBe(2);
    expect(isSeatCountLegal('plo6', 7)).toBe(false);
    expect(isSeatCountLegal('plo6', 6)).toBe(true);
    expect(isSeatCountLegal('plo6', 1)).toBe(false);
  });
});

describe('HorseFleetManager cash table configs', () => {
  const configs = fleetConfigs();

  it('parses the shipped config array (the test is not measuring an empty list)', () => {
    expect(configs.length).toBeGreaterThanOrEqual(8);
    expect(configs.map((c) => c.variant)).toContain('plo6');
    expect(configs.map((c) => c.variant)).toContain('plo5');
  });

  it('every config is within the law', () => {
    const illegal = configs
      .filter((c) => c.seats > maxSeatsForVariant(c.variant))
      .map(
        (c) => `${c.name}: ${c.seats} seats, ${c.variant} is ${maxSeatsForVariant(c.variant)}-max`
      );
    expect(illegal).toEqual([]);
  });

  it('the two that were wrong are now right', () => {
    expect(configs.find((c) => c.variant === 'plo5')?.seats).toBe(7);
    expect(configs.find((c) => c.variant === 'plo6')?.seats).toBe(6);
  });

  it('imports the law rather than restating the numbers', () => {
    expect(FLEET_SRC).toContain("from '../config/tableSeating.js'");
  });

  it('inserts no table itself, and the one game it can ask for is born clamped', () => {
    /* Moved 2026-09-05 for Gate 7. This used to count every
       `.from('tables').insert(` in the fleet and require a
       `max_players: clampSeatsForVariant(` beside each. The fleet has no table
       insert any more (OPORD 1.4 s2.11: a cash table is opened only by the
       cluster controller), so the count is pinned at ZERO, and the seat law is
       applied at the one door left: the Stable Hand's game order, whose
       handedness is clamped before fn_cash_game_ensure ever sees it. */
    const inserts = [...FLEET_SRC.matchAll(/\.from\(['"]tables['"]\)\s*\.insert\(/g)].length;
    expect(inserts).toBe(0);
    expect(FLEET_SRC).toMatch(/p_handedness:\s*clampSeatsForVariant\(variant, 9\)/);
    // and no raw config value reaches any write
    expect(FLEET_SRC).not.toMatch(/max_players:\s*config\.maxPlayers/);
    // the controller's law is where table birth is pinned now
    expect(
      existsSync(join(process.cwd(), 'src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts'))
    ).toBe(true);
  });

  it('says so out loud when a config disagrees, instead of silently clamping', () => {
    expect(FLEET_SRC).toContain('HorseFleet.seat_law_override');
  });
});
