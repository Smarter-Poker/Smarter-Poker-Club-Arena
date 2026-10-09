import { describe, expect, it } from 'vitest';
import {
  CONDITION_B_WITHDRAWAL_REASON,
  conditionBVerdict,
  packCalibrationAdequacy,
  selectedPacks,
} from './ConditionBMonitor.js';
import { HUMAN_CALIBRATION_MINIMUMS } from './HumanCalibratedPopulation.js';

const adequate = { family: 'omaha' as const, adequate: true, reasons: [] };
const arm = (lower99: number) => ({
  bbPer100: lower99 + 5,
  lower99,
  upper99: lower99 + 10,
  profiles: [],
});
const NOW = '2026-11-20T00:00:00.000Z';

describe('post-launch condition (b) monitoring can only withdraw', () => {
  it('lists committed, unwithdrawn selections only', () => {
    const packs = selectedPacks([
      {
        phase: 'phase10',
        variant: 'plo4',
        selection: { packVersion: 'p4', approvalGeneration: 1, withdrawn: null },
      },
      { phase: 'phase11', variant: 'plo5', selection: null },
      {
        phase: 'phase11',
        variant: 'plo8',
        selection: {
          packVersion: 'p8',
          approvalGeneration: 1,
          withdrawn: { at: NOW, reason: 'x' },
        },
      },
    ]);
    expect(packs).toEqual([
      { phase: 'phase10', variant: 'plo4', packVersion: 'p4', approvalGeneration: 1 },
    ]);
  });

  it('withdraws on an adequate calibration when the after-rake lower bound is below zero', () => {
    const v = conditionBVerdict(
      { adequacy: adequate, candidate: arm(-0.5), conditionB: 'not_met' },
      NOW
    );
    expect(v.action).toBe('withdraw');
    expect(v.withdrawn).toEqual({ at: NOW, reason: CONDITION_B_WITHDRAWAL_REASON });
  });

  it('keeps the pack when the lower bound is not below zero', () => {
    for (const lower of [0, 0.01, 12])
      expect(
        conditionBVerdict({ adequacy: adequate, candidate: arm(lower), conditionB: 'met' }, NOW)
          .action
      ).toBe('keep');
  });

  it('decides nothing on an inadequate calibration or an incomplete run', () => {
    expect(
      conditionBVerdict(
        {
          adequacy: { ...adequate, adequate: false, reasons: ['distinct_humans_5_below_20'] },
          candidate: arm(-50),
          conditionB: 'unavailable_external_input',
        },
        NOW
      )
    ).toMatchObject({ action: 'no_decision', withdrawn: null });
    expect(
      conditionBVerdict({ adequacy: adequate, candidate: null, conditionB: 'incomplete' }, NOW)
        .action
    ).toBe('no_decision');
    expect(
      conditionBVerdict(
        { adequacy: adequate, candidate: arm(Number.NaN), conditionB: 'not_met' },
        NOW
      ).action
    ).toBe('no_decision');
  });

  it('reads the committed calibration as inadequate today, and a tournament pack as unavailable', () => {
    const plo4 = {
      phase: 'phase10' as const,
      variant: 'plo4',
      packVersion: 'p4',
      approvalGeneration: 1,
    };
    expect(packCalibrationAdequacy(plo4).adequate).toBe(false);
    const market = {
      distinctHumans: HUMAN_CALIBRATION_MINIMUMS.distinctHumans,
      topHumanShare: 0.1,
    };
    // Even with enough accounts, the Omaha family's committed seat-hands are below the minimum.
    expect(
      packCalibrationAdequacy(plo4, market).reasons.some((r) => r.startsWith('seat_hands_'))
    ).toBe(true);
    expect(
      packCalibrationAdequacy({ ...plo4, phase: 'phase8', variant: 'nlh' }, market).reasons
    ).toContain('no_human_calibrated_tournament_contract');
  });
});
