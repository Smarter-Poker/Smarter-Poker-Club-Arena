/**
 * V53 PRESSURE is LIVE BY DEFAULT for every horse (Dan, 2026-10-24: "THIS MUST
 * BE ACTIVATED AND USED BY EVERY SINGLE HORSE ACROSS ALL GAMES"). The live
 * table engine and Lightning send no option overrides (ServerTableEngineTurns
 * builds the decision snapshot with the horse's own style and mods only), so
 * production is the arm below that passes NO v53Pressure option at all.
 *
 * Real HandController hands against the measured aggressive-human model
 * (HorseAggressiveHumanPressure.test-support): with the default options the
 * horses 3-bet the human's open more often than with the layer ablated, and
 * the layer's own telemetry proves it decided.
 */
import { describe, expect, it, vi } from 'vitest';
import { playPressureArm } from './HorseAggressiveHumanPressure.test-support.js';
import { HorseLogic } from './HorseLogic.js';

describe('pressure behavior evidence uses the accepted horse action', () => {
  it('refuses an illegal horse raise instead of measuring a substituted call', () => {
    const decide = vi.spyOn(HorseLogic, 'decide').mockReturnValue({
      action: 'raise',
      amount: -1,
      thinkTime: 0,
    });
    try {
      expect(() => playPressureArm('plo5', 1, 41, {})).toThrow(/horse decision rejected/);
    } finally {
      decide.mockRestore();
    }
  });
});

describe('V53 pressure is on for every horse by default, in every Omaha game', () => {
  for (const variant of ['plo4', 'plo5', 'plo6'] as const) {
    it(`${variant}: default options 3-bet the aggressive human more, and the layer fires`, () => {
      const on = playPressureArm(variant, 110, 5, {});
      const off = playPressureArm(variant, 110, 5, { v53Pressure: false });
      expect(on.fires.v53_pressure_preflop ?? 0).toBeGreaterThan(0);
      expect(off.fires.v53_pressure_preflop ?? 0).toBe(0);
      expect(on.vsOpen.raise).toBeGreaterThan(off.vsOpen.raise);
      expect(on.vsOpen.call).toBeLessThan(off.vsOpen.call);
    }, 300_000);
  }
});

describe("V53: a horse that opened stops flatting the aggressive human's 3-bet", () => {
  it("plo5: fewer flats and more 4-bets of the human's 3-bet than with the layer ablated", () => {
    const on = playPressureArm('plo5', 220, 41, {});
    const off = playPressureArm('plo5', 220, 41, { v53Pressure: false });
    expect(on.fires.v53_pressure_four_bet ?? 0).toBeGreaterThan(0);
    expect(on.vsThreeBet.call).toBeLessThan(off.vsThreeBet.call);
    expect(on.vsThreeBet.raise).toBeGreaterThan(off.vsThreeBet.raise);
  }, 300_000);
});
