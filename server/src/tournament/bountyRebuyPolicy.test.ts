/**
 * Dan 2026-10-21: "NO BOUNTY OR MYSTERY BOUNTY TOURNAMENT SHOULD BE A
 * FREEZEOUT, THEY SHOULD ALL HAVE REBUY TILL THE END OF REGISTRATION."
 */
import { describe, expect, it } from 'vitest';
import { isBountyMttRow, withBountyRebuyUntilRegistrationCloses } from './bountyRebuyPolicy.js';

const freezeoutMystery = () => ({
  tournament_type: 'MTT',
  variant: 'mystery_bounty',
  is_bounty: true,
  is_mystery_bounty: true,
  is_pko: false,
  buy_in_amount: 18,
  buy_in_fee: 2,
  starting_chips: 25000,
  late_reg_levels: 9,
  is_rebuy: false,
  is_reentry: false,
  rebuy_cost: null,
  rebuy_chips: null,
  rebuy_levels: null,
  max_rebuys: 0,
});

describe('a bounty MTT is never a freezeout', () => {
  it('turns a freezeout mystery bounty into a rebuy event until registration closes', () => {
    const row = withBountyRebuyUntilRegistrationCloses(freezeoutMystery());
    expect(row.is_rebuy).toBe(true);
    expect(row.is_reentry).toBe(true);
    expect(row.rebuy_levels).toBe(9);
    expect(row.rebuy_cost).toBe(20);
    expect(row.rebuy_chips).toBe(25000);
    expect(row.max_rebuys).toBeNull();
  });

  it('applies to a fixed bounty and a progressive knockout as well', () => {
    for (const flags of [
      { is_bounty: true, is_pko: false, is_mystery_bounty: false, variant: 'bounty' },
      { is_bounty: true, is_pko: true, is_mystery_bounty: false, variant: 'progressive_bounty' },
    ]) {
      const row = withBountyRebuyUntilRegistrationCloses({ ...freezeoutMystery(), ...flags });
      expect(row.is_rebuy).toBe(true);
      expect(row.rebuy_levels).toBe(9);
    }
  });

  it('keeps a rebuy price and chips the schedule already set', () => {
    const row = withBountyRebuyUntilRegistrationCloses({
      ...freezeoutMystery(),
      is_rebuy: true,
      rebuy_cost: 30,
      rebuy_chips: 20000,
      rebuy_levels: 4,
    });
    expect(row.rebuy_cost).toBe(30);
    expect(row.rebuy_chips).toBe(20000);
    // The window is registration's, whatever the schedule said.
    expect(row.rebuy_levels).toBe(9);
  });

  it('leaves satellites, Sit & Gos, Spins, freerolls and non-bounty MTTs alone', () => {
    const cases = [
      { ...freezeoutMystery(), variant: 'satellite' },
      { ...freezeoutMystery(), satellite_target_id: 'x' },
      { ...freezeoutMystery(), tournament_type: 'SNG' },
      { ...freezeoutMystery(), tournament_type: 'SPIN' },
      { ...freezeoutMystery(), buy_in_amount: 0, buy_in_fee: 0 },
      { ...freezeoutMystery(), is_bounty: false, is_mystery_bounty: false, variant: 'freezeout' },
    ];
    for (const input of cases) {
      expect(isBountyMttRow(input)).toBe(false);
      expect(withBountyRebuyUntilRegistrationCloses(input)).toBe(input);
    }
  });
});
