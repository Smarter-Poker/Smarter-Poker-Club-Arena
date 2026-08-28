/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND-FOR-HAND COUNTS THE PLACES THE PAYOUT PATH WOULD ACTUALLY HONOUR
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The bubble-protection block in TournamentManagerEliminations used to parse
 * `payout_structure` itself:
 *
 *     try { payouts = JSON.parse(payouts); } catch { payouts = []; }
 *     if (Array.isArray(payouts)) payoutCount = payouts.length;
 *
 * Two failures in four lines. An unreadable column became `payoutCount = 0`
 * with no log and no alert - and since the only exit from hand-for-hand for a
 * running tournament is `playingNow <= payoutCount`, a column that went bad
 * mid-bubble left the event dealing in lock-step through the money to the
 * finish. And counting the length of "whatever parsed" disagreed with every
 * site that PAYS, all of which resolve through payoutStructure.ts and reject a
 * structure with no place 1 or percentages summing to zero.
 *
 * These pin the contract the bubble now relies on. They assert what the
 * function RETURNS, deliberately not how any caller is formatted - a guard test
 * in this repo has already been broken once by prettier rewrapping a signature.
 */

import { describe, it, expect } from 'vitest';
import { parsePayoutStructure } from '../../server/src/tournament/payoutStructure.js';

describe('parsePayoutStructure: unusable is null, never an empty structure', () => {
  it('returns null for a string that is not JSON, so the caller can tell UNKNOWN from zero', () => {
    expect(parsePayoutStructure('{not json')).toBeNull();
  });

  it('returns null for an array with no place 1 - the payout path would not honour it either', () => {
    expect(
      parsePayoutStructure('[{"place":2,"percentage":60},{"place":3,"percentage":40}]')
    ).toBeNull();
  });

  it('returns null when every percentage is zero', () => {
    expect(parsePayoutStructure([{ place: 1, percentage: 0 }])).toBeNull();
  });

  it('returns null for an empty array and for a non-array', () => {
    expect(parsePayoutStructure([])).toBeNull();
    expect(parsePayoutStructure({ place: 1, percentage: 100 })).toBeNull();
    expect(parsePayoutStructure(null)).toBeNull();
  });

  it('parses a stored structure and reports how many places are paid', () => {
    const parsed = parsePayoutStructure(
      '[{"place":1,"percentage":40},{"place":2,"percentage":25},{"place":3,"percentage":18},{"place":4,"percentage":10},{"place":5,"percentage":7}]'
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(5);
    expect(parsed![0]).toEqual({ place: 1, percentage: 40 });
  });

  it('accepts an already-parsed array identically to its string form', () => {
    const asArray = parsePayoutStructure([
      { place: 1, percentage: 70 },
      { place: 2, percentage: 30 },
    ]);
    const asString = parsePayoutStructure(
      '[{"place":1,"percentage":70},{"place":2,"percentage":30}]'
    );
    expect(asArray).toEqual(asString);
    expect(asArray!.length).toBe(2);
  });
});
