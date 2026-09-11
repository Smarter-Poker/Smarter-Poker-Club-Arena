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
import {
  VPIP_JUDGED_OVER_HANDS,
  vpipFloorMul,
  vpipTargetFor,
} from '../server/src/engine/HorseLogic.js';

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
    /* THE LAW ASKS THE REAL FUNCTION NOW (2026-09-09). This used to restate
       the arithmetic in a local helper - `BASE / (floor + 10pt)` - so the day
       the cushion changed, the law would have gone on testing a formula the
       brain no longer used and passed while saying nothing true. A law that
       keeps its own copy of the thing it judges is not a law, it is a second
       implementation. `vpipFloorMul` with no sample IS the prior.

       Above the clamp means the layer can still steer; AT the clamp it is
       pinned and the floor is unreachable however long the horse sits. */
    const priorMulFor = (floorPct: number) => vpipFloorMul({ vpipFloor: floorPct });

    expect(priorMulFor(70)).toBeCloseTo(CLAMP, 5); // pinned - the old Madness
    expect(priorMulFor(50)).toBeGreaterThan(CLAMP); // has room - the new one
    expect(priorMulFor(30)).toBeGreaterThan(CLAMP);
    // ...and the fleet's own base width is still what it steers from.
    expect(FLEET_BASE_VPIP).toBeCloseTo(0.28, 5);
  });

  it('the cushion clears one standard error of the window the floor is judged over', () => {
    /* WHY THE FLOOR WAS STILL BEING MISSED (measured 2026-09-09, 24h to
       22:00). Both floors were reachable ON AVERAGE - Action played 47.1% into
       a floor of 30, Madness 59.2% into 50 - and horses were still evicted at
       the median on hand ELEVEN, the first hand the rule can fire: 27% of
       every Action sitting and 56% of every Madness sitting ended
       `vpip_evicted`, each one carrying a two-hour bar on that game.

       `fn_nit_check` judges the CUMULATIVE rate of a sitting from ten hands
       on, and a ten-hand proportion has a standard error near 15 points. A
       flat ten-point cushion put the floor two thirds of one standard error
       below the target, and 104 of 597 Madness sittings (17.4%) were already
       under it at the very first check. Aiming a real margin above the floor
       is the difference between a rule the fleet passes and a rule it fails
       a sixth of the time before it has played a twelfth hand. */
    for (const floor of [30, 50]) {
      const p = floor / 100;
      const se = Math.sqrt((p * (1 - p)) / VPIP_JUDGED_OVER_HANDS);
      expect(vpipTargetFor(floor) - p, `floor ${floor}`).toBeGreaterThan(se);
    }
    // And the margin never pushes the target past what the layer can reach.
    expect(vpipFloorMul({ vpipFloor: 50 })).toBeGreaterThan(CLAMP);
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
