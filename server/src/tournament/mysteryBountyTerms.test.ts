/**
 * Dan 2026-10-22: "DON'T PAY ANY BOUNTIES UNTIL PLAYERS ARE 'IN THE MONEY' ALL
 * BOUNTIES ARE MYSTERY BOUNTY PRIZES ONLY" and "CHANGE IT TO THE 50/50 HALF
 * PAYOUT, HALF BOUNTY POOL."
 */
import { describe, expect, it } from 'vitest';
import {
  halfEntryBounty,
  isPaidMysteryMttRow,
  mysteryBountyDescription,
  withMysteryBountyTerms,
} from './mysteryBountyTerms.js';
import {
  isChestsOnlyMysteryRow,
  mysteryPoolCents,
  shouldActivateMysteryBounty,
} from './mysteryBountyActivation.js';

const midweekMystery = () => ({
  tournament_type: 'MTT',
  variant: 'mystery_bounty',
  is_bounty: true,
  is_mystery_bounty: true,
  is_pko: false,
  buy_in_amount: 18,
  buy_in_fee: 2,
  bounty_amount: 8,
  mystery_bounty_min: 4,
  mystery_bounty_max: 80,
  mystery_bounty_pool_percent: 50,
  mystery_bounty_regular_pool_percent: 50,
  mystery_bounty_activation: 'percent_field',
  mystery_bounty_activation_value: 15,
  short_description: '40% Of Each Entry Contribution Funds The Mystery Pool.',
});

describe('a mystery bounty is chests only, at the money, split 50/50', () => {
  it('puts half of the whole entry in the bounty; the fee comes out of the prize half', () => {
    // A 20 entry (18 + 2 fee): 10 to the bounty pool, 8 to the prize pool.
    const row = withMysteryBountyTerms(midweekMystery());
    expect(row.bounty_amount).toBe(10);
    expect(Number(row.buy_in_amount) - Number(row.bounty_amount)).toBe(8);
    expect(row.mystery_bounty_min).toBe(5);
    expect(row.mystery_bounty_max).toBe(100);
  });

  it('seals the whole bounty pool into chests and opens them at the money', () => {
    const row = withMysteryBountyTerms(midweekMystery());
    expect(row.mystery_bounty_pool_percent).toBe(100);
    expect(row.mystery_bounty_regular_pool_percent).toBe(0);
    expect(row.mystery_bounty_activation).toBe('at_the_money');
    expect(row.mystery_bounty_activation_value).toBeNull();
    expect(isChestsOnlyMysteryRow(row)).toBe(true);
    // Every cent of the bounty pool goes into the chests.
    expect(mysteryPoolCents(208_000, 100, 0, 0, 1)).toBe(208_000);
  });

  it('says so in its description', () => {
    expect(withMysteryBountyTerms(midweekMystery()).short_description).toBe(
      '50% Of Each Entry Funds The Mystery Bounty Pool. The Prize Pool Is The Rest, ' +
        'After The Fee. No Bounties Are Paid Before The Money. Once The Tournament Reaches ' +
        'The Money, Every Knockout Picks 1 Of 3 Mystery Chests.'
    );
    expect(mysteryBountyDescription(8, 20)).toMatch(/^40% Of Each Entry Funds The Mystery/);
  });

  it('keeps the bounty to whole chips, never a fraction', () => {
    // A 15 entry (13.50 + 1.50): 7 whole chips, not 7.50.
    expect(halfEntryBounty(13.5, 1.5)).toBe(7);
    expect(halfEntryBounty(225, 25)).toBe(125);
    expect(halfEntryBounty(4.5, 0.5)).toBe(2);
    // The advertised range scales in whole chips too.
    const row = withMysteryBountyTerms({
      ...midweekMystery(),
      buy_in_amount: 13.5,
      buy_in_fee: 1.5,
      bounty_amount: 6,
      mystery_bounty_min: 3,
      mystery_bounty_max: 61,
    });
    expect(row.bounty_amount).toBe(7);
    expect(Number.isInteger(row.mystery_bounty_min)).toBe(true);
    expect(Number.isInteger(row.mystery_bounty_max)).toBe(true);
  });

  it('leaves PKOs, satellites, freerolls, Sit & Gos and plain bounties alone', () => {
    for (const over of [
      { is_pko: true },
      { variant: 'satellite' },
      { buy_in_amount: 0, buy_in_fee: 0 },
      { tournament_type: 'SNG' },
      { is_mystery_bounty: false },
    ]) {
      const input = { ...midweekMystery(), ...over };
      expect(isPaidMysteryMttRow(input)).toBe(false);
      expect(withMysteryBountyTerms(input)).toBe(input);
    }
  });
});

describe('a chests-only field of ten or fewer still opens its chests at the money', () => {
  const base = {
    isMysteryBounty: true,
    stage: 'pending' as const,
    entryClosed: true,
    allTablesBetweenHands: true,
    playersRemaining: 3,
    totalEntries: 9,
    paidPlaces: 3,
    mode: 'at_the_money' as const,
    modeValue: null,
    mysteryPoolCents: 9_000,
  };

  it('opens two chests at three players left when the event is chests only', () => {
    expect(shouldActivateMysteryBounty({ ...base, chestsOnly: true })).toEqual({
      activate: true,
      reason: null,
      drawCount: 2,
    });
  });

  it('keeps the older small-field rule for an event created under the old terms', () => {
    expect(shouldActivateMysteryBounty(base).reason).toBe('small_field');
  });

  it('reads an unknown split as the old terms, never as chests only', () => {
    expect(isChestsOnlyMysteryRow({})).toBe(false);
    expect(isChestsOnlyMysteryRow({ mystery_bounty_regular_pool_percent: null })).toBe(false);
    expect(isChestsOnlyMysteryRow({ mystery_bounty_regular_pool_percent: '0' })).toBe(true);
  });
});
