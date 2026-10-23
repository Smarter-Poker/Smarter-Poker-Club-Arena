/**
 * Dan 2026-10-22: "DON'T PAY ANY BOUNTIES UNTIL PLAYERS ARE 'IN THE MONEY' ALL
 * BOUNTIES ARE MYSTERY BOUNTY PRIZES ONLY." The lobby says so for a
 * chests-only event and keeps the older wording for events that started
 * under the older terms.
 */
import { describe, expect, it } from 'vitest';
import {
  activationStatusLine,
  CHESTS_ONLY_NOTE,
  isChestsOnlyInventory,
  parseInventory,
  SMALL_FIELD_NOTE,
} from '../../src/services/MysteryBountyService';

const pending = (extra: Record<string, unknown> = {}) =>
  parseInventory({ stage: 'pending', activation: 'at_the_money', tiers: [], ...extra });

describe('a chests-only mystery event', () => {
  it('reads the split the server reports', () => {
    expect(isChestsOnlyInventory(pending({ regular_pool_percent: 0 }))).toBe(true);
    expect(isChestsOnlyInventory(pending({ regular_pool_percent: 50 }))).toBe(false);
    expect(isChestsOnlyInventory(pending())).toBe(false);
  });

  it('says no bounty is paid before the money, and drops the small-field note', () => {
    const line = activationStatusLine(pending({ regular_pool_percent: 0 }));
    expect(line).toBe(
      'No Bounties Are Paid Before The Money. Mystery Bounties Begin After The Rebuy And ' +
        'Add-On Period Ends And The Tournament Reaches The Money'
    );
    expect(line.startsWith(CHESTS_ONLY_NOTE)).toBe(true);
    expect(line).not.toContain(SMALL_FIELD_NOTE);
  });

  it('keeps the older wording for an event on the older terms', () => {
    expect(activationStatusLine(pending({ regular_pool_percent: 50 }))).toContain(
      SMALL_FIELD_NOTE
    );
  });
});
