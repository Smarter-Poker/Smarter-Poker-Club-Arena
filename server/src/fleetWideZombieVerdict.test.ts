import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isFleetWideStall,
  FLEET_WIDE_ZOMBIE_FLOOR,
  FLEET_WIDE_ZOMBIE_SHARE_DIVISOR,
} from './fleetWideZombieVerdict.js';

describe('a verdict against the whole fleet is a verdict against itself', () => {
  it('condemns the measured event: 464 of about 500 in one minute', () => {
    // 2026-09-18 03:03Z, from engine_recovery_events. The fleet did not break
    // 464 separate times inside sixty seconds; the maintenance break parked it
    // and the sweep that closes the break window condemned what it had parked.
    expect(isFleetWideStall(464, 500)).toBe(true);
    expect(isFleetWideStall(249, 500)).toBe(true);
  });

  it('leaves an ordinary minority stall alone - that is what the sweep is for', () => {
    // The whole per-table recovery chain exists for these. One wedged table in
    // a live fleet must still be rebuilt within its 180 seconds.
    expect(isFleetWideStall(1, 500)).toBe(false);
    expect(isFleetWideStall(25, 500)).toBe(false);
    expect(isFleetWideStall(166, 500)).toBe(false);
  });

  it('draws the line at a third', () => {
    // Exactly a third is NOT fleet-wide: the comparison is strict, so a fleet
    // can lose a clean third to independent faults and still have every one of
    // them rebuilt.
    expect(isFleetWideStall(100, 300)).toBe(false);
    expect(isFleetWideStall(101, 300)).toBe(true);
    expect(FLEET_WIDE_ZOMBIE_SHARE_DIVISOR).toBe(3);
  });

  it('keeps a small fleet on the ordinary path', () => {
    // On a three-table board, or any test fleet, one broken table IS a third
    // or more of it - and rebuilding it is correct, not a stampede. The floor
    // is what stops the share arithmetic swallowing the small case.
    expect(isFleetWideStall(1, 2)).toBe(false);
    expect(isFleetWideStall(3, 3)).toBe(false);
    expect(isFleetWideStall(FLEET_WIDE_ZOMBIE_FLOOR - 1, FLEET_WIDE_ZOMBIE_FLOOR - 1)).toBe(false);
    expect(isFleetWideStall(FLEET_WIDE_ZOMBIE_FLOOR, FLEET_WIDE_ZOMBIE_FLOOR)).toBe(true);
  });

  it('refuses nothing on a degenerate or unreadable population', () => {
    // Fail towards the existing behaviour: if the denominator is not a real
    // population, this control says nothing and the sweep proceeds as it
    // always did. A brake that engages on garbage is worse than no brake.
    expect(isFleetWideStall(0, 0)).toBe(false);
    expect(isFleetWideStall(50, 0)).toBe(false);
    expect(isFleetWideStall(50, -1)).toBe(false);
    expect(isFleetWideStall(Number.NaN, 500)).toBe(false);
    expect(isFleetWideStall(50, Number.NaN)).toBe(false);
    expect(isFleetWideStall(Number.POSITIVE_INFINITY, 500)).toBe(false);
  });
});

describe('the sweep judges its verdicts as a whole, and says so when it stands down', () => {
  const SRC = readFileSync(resolve(import.meta.dirname, 'GameServer.ts'), 'utf8');

  it('collects the verdicts before applying any of them', () => {
    // Applied one at a time inside the loop, nothing could see how many there
    // were - which is how 464 tables were destroyed in a minute.
    expect(SRC).toContain('const zombieVerdicts: Array<[string, ServerTableEngine]> = []');
    expect(SRC).toMatch(/zombieVerdicts\.push\(\[id, engine\]\)/);
    expect(SRC).toContain('isFleetWideStall(zombieVerdicts.length, zombieCandidates)');
  });

  it('a refusal is reported by name, never a silent stand-down', () => {
    // A sweep that quietly does nothing is indistinguishable from a healthy
    // one. This is the fault it exists to survive, so it has to be legible.
    expect(SRC).toContain('GameServer.fleet_wide_zombie_refusal');
    expect(SRC).toContain('poker_fleet_wide_zombie_refusals_total');
    expect(SRC).toContain('fleetWideZombieRefusals: this.fleetWideZombieRefusals');
  });

  it('the per-table condemnation path is unchanged', () => {
    // Standing down removes no recovery: the minority path still fences the
    // exact engine and still tells a tournament table's owner to replace it.
    expect(SRC).toContain("engine.fenceForEngineLeaseLoss('tournament_table_zombie', true)");
    expect(SRC).toContain("engine.fenceForEngineLeaseLoss('cash_table_zombie', false)");
    expect(SRC).toContain('GameServer.zombie_engine_rebuilt');
  });
});
