/**
 * Dan 2026-10-21: "ALL MYSTERY BOUNTY TOURNAMENTS NEED TO HAVE THE 'MYSTERY
 * BOUNTY' AMOUNTS DISPLAYED IN THE REWARDS". The projection is the engine's own
 * ladder computed early, so it must add up to the pool exactly and draw the
 * chest count the activation rule will draw.
 */
import { describe, expect, it } from 'vitest';
import {
  projectMysteryBountyLadder,
  projectedDrawCount,
} from '../../src/lib/mysteryBountyProjection';

const midweekMystery = {
  bountyPool: '2080.00',
  bountyPoolPaid: '0',
  mysteryPercent: '50',
  regularPercent: '50',
  topPercent: '20',
  profile: 'classic',
  activation: 'at_the_money',
  activationValue: null,
  paidPlaces: 33,
  totalEntries: 260,
  unitCents: 1,
};

describe('the mystery bounty ladder before the mystery phase opens', () => {
  it('projects the ladder from the pool so far, every cent on a chest', () => {
    const p = projectMysteryBountyLadder(midweekMystery);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.poolCents).toBe(104000);
    // At the money: 33 players left, one chest per elimination still to come.
    expect(p.drawCount).toBe(32);
    const chests = p.tiers.reduce((n, t) => n + t.count, 0);
    const cents = p.tiers.reduce((n, t) => n + t.count * t.amountCents, 0);
    expect(chests).toBe(32);
    expect(cents).toBe(104000);
    // Highest amount first.
    for (let i = 1; i < p.tiers.length; i++) {
      expect(p.tiers[i - 1].amountCents).toBeGreaterThanOrEqual(p.tiers[i].amountCents);
    }
  });

  it('draws the count each activation mode will draw', () => {
    expect(projectedDrawCount('at_the_money', null, 33, 260)).toBe(32);
    expect(projectedDrawCount('player_count', 27, 33, 260)).toBe(26);
    expect(projectedDrawCount('percent_field', 15, 33, 260)).toBe(38);
  });

  it('shows nothing it cannot honestly promise', () => {
    expect(projectMysteryBountyLadder({ ...midweekMystery, bountyPool: 0 })).toBeNull();
    // Ten or fewer entries pay flat bounties only.
    expect(projectMysteryBountyLadder({ ...midweekMystery, totalEntries: 10 })).toBeNull();
    expect(projectMysteryBountyLadder({ ...midweekMystery, paidPlaces: 0 })).toBeNull();
  });

  it('projects a chests-only event: the whole bounty pool, small fields included', () => {
    const chestsOnly = { ...midweekMystery, mysteryPercent: '100', regularPercent: '0' };
    expect(projectMysteryBountyLadder(chestsOnly)!.poolCents).toBe(208000);
    const small = projectMysteryBountyLadder({
      ...chestsOnly,
      bountyPool: '90.00',
      totalEntries: 10,
      paidPlaces: 3,
    });
    expect(small).not.toBeNull();
    expect(small!.drawCount).toBe(2);
    expect(small!.tiers.reduce((n, t) => n + t.count * t.amountCents, 0)).toBe(9000);
  });

  it('cuts every chip chest in whole chips, never a fraction', () => {
    const p = projectMysteryBountyLadder({ ...midweekMystery, bountyPool: '2083.57' });
    expect(p).not.toBeNull();
    expect(p!.poolCents % 100).toBe(0);
    for (const t of p!.tiers) expect(t.amountCents % 100).toBe(0);
  });

  it('keeps a Diamond ladder on whole Diamonds', () => {
    const p = projectMysteryBountyLadder({ ...midweekMystery, bountyPool: '20800.00', unitCents: 100 });
    expect(p).not.toBeNull();
    for (const t of p!.tiers) expect(t.amountCents % 100).toBe(0);
  });
});
