/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE TIER VOCABULARY, TWO CODEBASES (Dan section 50)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The server decides a chest's tier at seed time; the client says the words. The
 * server tsconfig sets `rootDir: ./src`, so neither side can import the other
 * and the mapping exists twice by necessity. This is the gate that stops the two
 * copies drifting.
 *
 * The failure it prevents is specific and nasty: a chest announced as a "Mega
 * Prize" on the tapper's screen and a "Major Prize" on everybody else's, because
 * the designated revealer's own tap goes straight to fn_mystery_bounty_reveal
 * and gets back a raw tier name, while every spectator reads the label off the
 * broadcast.
 */

import { describe, it, expect } from 'vitest';
import {
  MYSTERY_BOUNTY_TIER_ORDER,
  MYSTERY_BOUNTY_TIER_LABELS,
  mysteryBountyTierLabel,
  mysteryBountyTierColor,
  isHeadlineTier,
  tierRank,
} from '../../src/config/mysteryBountyTiers';
import {
  MYSTERY_BOUNTY_TIER_ORDER as SERVER_ORDER,
  formatBountyTier,
} from '../../server/src/config/mysteryBountySpec';
import { formatBountyTierLabel } from '../../src/components/tournament/MysteryBountyChest';

describe('client and server agree about mystery bounty tiers', () => {
  it('has the same tiers, in the same order', () => {
    expect([...MYSTERY_BOUNTY_TIER_ORDER]).toEqual([...SERVER_ORDER]);
  });

  it('says the same words for every one of them', () => {
    for (const tier of SERVER_ORDER) {
      expect(mysteryBountyTierLabel(tier)).toBe(formatBountyTier(tier));
    }
  });

  it('agrees with the chest animation, which has its own copy for the tapper path', () => {
    for (const tier of SERVER_ORDER) {
      expect(formatBountyTierLabel(tier)).toBe(mysteryBountyTierLabel(tier));
    }
  });

  it('capitalises the first letter of every word (CLAUDE.md 5.7)', () => {
    for (const label of Object.values(MYSTERY_BOUNTY_TIER_LABELS)) {
      for (const word of label.split(' ')) {
        expect(word[0]).toBe(word[0].toUpperCase());
      }
      expect(label).not.toMatch(/[—–―‒]/);
    }
  });
});

describe('tier helpers never throw on an unknown tier', () => {
  it('falls back to a plain word and a steel colour', () => {
    expect(mysteryBountyTierLabel('something_new')).toBe('Prize');
    expect(mysteryBountyTierLabel(null)).toBe('Prize');
    expect(mysteryBountyTierColor('something_new')).toBe('#6b7280');
  });

  it('sorts an unknown tier last rather than first', () => {
    expect(tierRank('jackpot')).toBe(0);
    expect(tierRank('base')).toBe(MYSTERY_BOUNTY_TIER_ORDER.length - 1);
    expect(tierRank('something_new')).toBe(MYSTERY_BOUNTY_TIER_ORDER.length);
  });
});

describe('headline tiers are the ones section 33 keeps visible when exhausted', () => {
  it('is jackpot, mega and major, and nothing below them', () => {
    expect(isHeadlineTier('jackpot')).toBe(true);
    expect(isHeadlineTier('mega')).toBe(true);
    expect(isHeadlineTier('major')).toBe(true);
    expect(isHeadlineTier('large')).toBe(false);
    expect(isHeadlineTier('base')).toBe(false);
  });
});
