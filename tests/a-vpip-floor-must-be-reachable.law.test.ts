/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A VPIP FLOOR MUST BE REACHABLE (Dan, 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "MAYBE WE CHANGE THE VPIP TO 30% FOR ACTION AND 50% FOR MADNESS."
 *
 * NIT Game stands a seat up when its VPIP over the last ten hands is under the
 * table floor. `fn_cash_template_defaults` set that floor per template AND per
 * family - action 30/40/35, madness 60/70/65 - and the madness tier sat above
 * anything any strategy reaches. Measured on ca_hand_facts from 2026-09-04
 * 22:00 UTC, after the vpipFloorMul layer deployed in #3034:
 *
 *   floor 30 -> horses played 46.7  (+16.7)     floor 60 -> 41.7  (-18.3)
 *   floor 35 -> horses played 57.9  (+22.9)     floor 65 -> 51.0  (-14.0)
 *   floor 40 -> horses played 47.2   (+7.2)     floor 70 -> 37.8  (-32.2)
 *
 * Every floor at or under 40 is cleared with room; every floor at or over 60 is
 * missed, and missing it means the seat is stood up at hand eleven. The cause
 * is arithmetic, not a horse defect: vpipFloorMul clamps its widening at
 * FLOOR_MUL = 0.35 of normal tightness, and a preflop bar at a third of its
 * height still tops out near 50% VPIP. A 70% floor asks for a strategy that is
 * no longer poker, so a Madness table emptied and reseeded every ten hands.
 *
 * THE LAW. A floor this product can set must be one the widening layer can
 * actually reach, and the tiers stay flat across families - the per-family
 * spread had it backwards, making PLO (the loosest game there is, most players
 * seeing most flops) carry the HARDEST floor.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vpipFloorMul } from '../server/src/engine/HorseLogic.js';

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260905030225_action_is_thirty_and_madness_is_fifty.sql'
  ),
  'utf8'
);

/** The observed ceiling of the fleet's own preflop width at full widening. */
const FLEET_BASE_VPIP = 0.28;
const CLAMP = 0.35;

describe('a VPIP floor must be reachable', () => {
  it('the template function sets action 30 and madness 50, flat across families', () => {
    expect(MIGRATION).toMatch(/WHEN 'action'\s+THEN 30/);
    expect(MIGRATION).toMatch(/ELSE\s+50 END/);
    // The per-family CASE is gone, not merely re-numbered.
    expect(MIGRATION).not.toMatch(/WHEN 'action'\s+THEN CASE v_family/);
  });

  it('migrates every live table off a floor that is neither 30 nor 50', () => {
    expect(MIGRATION).toMatch(/maintain_percent_min IN \(35, 40\)/);
    expect(MIGRATION).toMatch(/maintain_percent_min IN \(60, 65, 70\)/);
    // And refuses to commit if one is left behind.
    expect(MIGRATION).toMatch(/NOT IN \(0, 30, 50\)/);
    expect(MIGRATION).toMatch(/RAISE EXCEPTION/);
  });

  it('50 leaves the widening layer real room, and 70 did not', () => {
    // The prior multiplier is BASE / (floor + 10pt cushion). Above the clamp
    // means the layer can still steer; at the clamp it is pinned and the floor
    // is unreachable however long the horse sits there.
    const priorMulFor = (floorPct: number) =>
      Math.max(CLAMP, Math.min(1, FLEET_BASE_VPIP / Math.min(0.95, floorPct / 100 + 0.1)));

    expect(priorMulFor(70)).toBeCloseTo(CLAMP, 5); // pinned - the old Madness
    expect(priorMulFor(50)).toBeGreaterThan(CLAMP); // has room - the new one
    expect(priorMulFor(30)).toBeGreaterThan(CLAMP);
  });

  it('vpipFloorMul only ever widens, and never past its clamp', () => {
    for (const floor of [0, 30, 50, 70, 95]) {
      for (const own of [null, 0, 10, 40, 60, 100]) {
        const mul = vpipFloorMul({
          vpipFloor: floor,
          ownVpip: own === null ? undefined : { hands: 50, vpip: own },
        });
        expect(mul).toBeLessThanOrEqual(1);
        expect(mul).toBeGreaterThanOrEqual(CLAMP);
      }
    }
  });

  it('a table with no floor is left completely alone', () => {
    expect(vpipFloorMul({ vpipFloor: 0 })).toBe(1);
    expect(vpipFloorMul({})).toBe(1);
  });

  it('a horse already over the floor gets its own style back', () => {
    // Floor 30 -> target 40. A horse judged at 55 is comfortably over.
    expect(vpipFloorMul({ vpipFloor: 30, ownVpip: { hands: 40, vpip: 55 } })).toBe(1);
  });

  it('a horse under the floor is widened, and more the further under it is', () => {
    const near = vpipFloorMul({ vpipFloor: 50, ownVpip: { hands: 40, vpip: 55 } });
    const far = vpipFloorMul({ vpipFloor: 50, ownVpip: { hands: 40, vpip: 20 } });
    expect(far).toBeLessThan(near);
    expect(far).toBeGreaterThanOrEqual(CLAMP);
  });
});
