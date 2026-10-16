/**
 * LAW: an owner floor park is not an outage, and a park never hides one for
 *      longer than its lease.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-10-15 16:53 to 18:10 UTC the owner parked every cash table for a horse
 * wallet reset (operation 3d9c1ba1). HorseCashActionsStopped,
 * EngineTableCountAnomaly, HorseFleetCollapsed and SLOHandsAreNotBeingDealt
 * paged for a stop he had scheduled, because the fleet rules honoured the
 * hourly break and knew nothing of a park.
 *
 * The rules that measure how much of the floor is dealing now carry
 * `unless on() max_over_time(poker_operator_floor_park_share[6m]) >= 0.5`
 * beside their break guard. This law pins:
 *   1. every one of them carries it, with `unless on()` (a bare `unless`
 *      matches on the exact label set and guards nothing) and the derived 0.5;
 *   2. the share has a producer in the engine, published on the always-on
 *      registry, which falls to 0 (silences nothing) when it cannot read;
 *   3. the rules a park can NOT explain stay unguarded: seated players dealt
 *      nothing (EngineHandsStopped, EngineHandsPerSecDropped) is a stall
 *      whatever the floor holds;
 *   4. the threshold the engine uses for ClubArenaFleetFloorLost is the same
 *      0.5.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

const ROOT = join(__dirname, '..');
const DIR = join(ROOT, 'infra/monitoring');
const PARK_GUARD = /unless on\(\) max_over_time\(poker_operator_floor_park_share\[6m\]\) >= 0\.5/;
const ANY_PARK_GUARD = /poker_operator_floor_park_share/;

type Rule = { alert?: string; expr?: string };

function rules(file: string): Rule[] {
  const doc = YAML.parse(readFileSync(join(DIR, file), 'utf8')) as { groups?: { rules?: Rule[] }[] };
  return (doc.groups ?? []).flatMap((g) => g.rules ?? []).filter((r) => r.alert);
}

const ALL = [
  ...rules('alert-rules.yml'),
  ...rules('slo-alerts.yml'),
  ...rules('engine-freeze-rules.yml'),
];
const byName = (name: string) => {
  const r = ALL.find((x) => x.alert === name);
  expect(r, name).toBeTruthy();
  return r!;
};

const GUARDED = [
  'EngineTableCountAnomaly',
  'HorseFleetCollapsed',
  'HorseFleetThroughputRelativeDrop',
  'HorseCashActionsStopped',
  'HorseFleetNotSeated',
  'SLOHandsAreNotBeingDealt',
];
const NEVER_GUARDED = ['EngineHandsStopped', 'EngineHandsPerSecDropped'];

describe('an owner floor park is not an outage', () => {
  it('every fleet-floor rule stands down for a park of half the floor or more', () => {
    for (const name of GUARDED) {
      const r = byName(name);
      expect(r.expr, name).toMatch(PARK_GUARD);
      // It sits beside the break guard, never instead of it.
      expect(r.expr, name).toMatch(/max_over_time\(poker_maintenance_break_active\[6m\]\) == 1/);
    }
  });

  it('a stall with seated players is never the park', () => {
    for (const name of NEVER_GUARDED) expect(byName(name).expr, name).not.toMatch(ANY_PARK_GUARD);
  });

  it('only the reviewed rules read the park share', () => {
    const readers = ALL.filter((r) => ANY_PARK_GUARD.test(r.expr ?? '')).map((r) => r.alert);
    expect(readers.sort()).toEqual([...GUARDED].sort());
  });

  it('the share has an engine producer that silences nothing when it cannot read', () => {
    const src = readFileSync(join(ROOT, 'server/src/services/FloorParkWatch.ts'), 'utf8');
    expect(src).toContain("alwaysOnRegistry.gauge(\n  'poker_operator_floor_park_share'");
    expect(src).toContain("rpc('fn_ca_operator_floor_park_share')");
    expect(src).toMatch(/export const FLEET_STANDS_DOWN_AT_PARK_SHARE = 0\.5;/);
    expect(src).toMatch(/export const FLOOR_PARK_MAX_AGE_MS = 120_000;/);
    // A stale or failed read publishes 0.
    expect(src).toMatch(/nowMs - lastReadAtMs > FLOOR_PARK_MAX_AGE_MS\) return 0;/);
    expect(src).toMatch(/shareGauge\.set\(0\);\s*knownGauge\.set\(0\);/);
  });

  it('ClubArenaFleetFloorLost stands down on the same fresh read, inside the below-floor branch only', () => {
    const src = readFileSync(join(ROOT, 'server/src/services/DealRateVerifier.ts'), 'utf8');
    const floor = src.indexOf('if (tableIds.length < FLEET_FLOOR_TABLES)');
    const park = src.indexOf('if (fleetIsParkedByOwner())');
    const raise = src.indexOf("alertname: 'ClubArenaFleetFloorLost'");
    expect(floor).toBeGreaterThan(0);
    expect(park).toBeGreaterThan(floor);
    expect(raise).toBeGreaterThan(park);
    expect(src).toContain('startFloorParkWatch();');
    expect(src).toContain('stopFloorParkWatch();');
  });
});
