/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MYSTERY BOUNTY — LOBBY AND RESULTS LOGIC (Dan sections 81.34 to 81.40)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every number the lobby, the results table and the result card show comes out
 * of three SECURITY DEFINER functions and is shaped by MysteryBountyService.
 * These pin the shaping, because the failure mode is silent: the three bounty
 * TABLES have RLS on with no select policy, so code that reads them directly
 * gets an empty array and no error, and a tournament with 200 chests in it
 * renders as a tournament with none.
 *
 * The fixtures below are the literal jsonb shapes the functions return.
 */

import { describe, it, expect } from 'vitest';
import {
  parseInventory,
  parseAwards,
  parseLeaderboard,
  playerTotalsFromAwards,
  largestAward,
  topBountyCents,
  remainingCents,
  awardedCents,
  chestCounts,
  activationStatusLine,
  formatCents,
} from '../../src/services/MysteryBountyService';
import { isHeadlineTier } from '../../src/config/mysteryBountyTiers';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** The ladder as drawn: one 5,000, one 2,000, four 750, ten 200, twenty 50. */
const INVENTORY_FRESH = {
  pool_cents: 4_000_00,
  stage: 'active',
  profile: 'balanced',
  activation: 'player_count',
  activation_value: 27,
  activated_players: 27,
  activated_at: '2026-08-25T20:00:00Z',
  tiers: [
    { tier: 'jackpot', amount_cents: 5_000_00, original: 1, awarded: 0, remaining: 1 },
    { tier: 'mega', amount_cents: 2_000_00, original: 1, awarded: 0, remaining: 1 },
    { tier: 'major', amount_cents: 750_00, original: 4, awarded: 0, remaining: 4 },
    { tier: 'medium', amount_cents: 200_00, original: 10, awarded: 0, remaining: 10 },
    { tier: 'base', amount_cents: 50_00, original: 20, awarded: 0, remaining: 20 },
  ],
};

/** The same event after the jackpot and one major have been opened. */
const INVENTORY_AFTER_TWO = {
  ...INVENTORY_FRESH,
  tiers: [
    { tier: 'jackpot', amount_cents: 5_000_00, original: 1, awarded: 1, remaining: 0 },
    { tier: 'mega', amount_cents: 2_000_00, original: 1, awarded: 0, remaining: 1 },
    { tier: 'major', amount_cents: 750_00, original: 4, awarded: 1, remaining: 3 },
    { tier: 'medium', amount_cents: 200_00, original: 10, awarded: 0, remaining: 10 },
    { tier: 'base', amount_cents: 50_00, original: 20, awarded: 0, remaining: 20 },
  ],
};

const AWARDS = {
  total: 3,
  rows: [
    {
      award_id: 'a3',
      amount_cents: 750_00,
      tier: 'major',
      is_jackpot: false,
      revealed_at: '2026-08-25T21:10:00Z',
      hand_id: 'h-303',
      table_id: 't-2',
      eliminated: { user_id: 'u-elim-3', username: 'Cara' },
      recipients: [{ user_id: 'u-2', username: 'Bob', amount_cents: 750_00 }],
    },
    {
      award_id: 'a2',
      amount_cents: 5_000_00,
      tier: 'jackpot',
      is_jackpot: true,
      revealed_at: '2026-08-25T21:05:00Z',
      hand_id: 'h-202',
      table_id: 't-1',
      eliminated: { user_id: 'u-elim-2', username: 'Dan' },
      recipients: [{ user_id: 'u-2', username: 'Bob', amount_cents: 5_000_00 }],
    },
    {
      /* A split knockout: two players all in against the busted stack, so the
         one chest pays two recipients. */
      award_id: 'a1',
      amount_cents: 200_00,
      tier: 'medium',
      is_jackpot: false,
      revealed_at: '2026-08-25T21:00:00Z',
      hand_id: 'h-101',
      table_id: 't-1',
      eliminated: { user_id: 'u-elim-1', username: 'Eve' },
      recipients: [
        { user_id: 'u-1', username: 'Ann', amount_cents: 100_00 },
        { user_id: 'u-2', username: 'Bob', amount_cents: 100_00 },
      ],
    },
  ],
};

/** What fn_mystery_bounty_leaderboard says about the same three awards. */
const LEADERBOARD = {
  rows: [
    { user_id: 'u-1', username: 'Ann', bounties_won: 1, earnings_cents: 100_00 },
    { user_id: 'u-2', username: 'Bob', bounties_won: 3, earnings_cents: 5_850_00 },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// 34. THE LOBBY SHOWS ALL ORIGINAL TIERS
// ═══════════════════════════════════════════════════════════════════════════════

describe('34. the lobby shows every tier that was drawn', () => {
  it('keeps every tier from the inventory, highest first', () => {
    const inv = parseInventory(INVENTORY_FRESH);
    expect(inv.tiers).toHaveLength(5);
    expect(inv.tiers.map((t) => t.tier)).toEqual(['jackpot', 'mega', 'major', 'medium', 'base']);
    expect(inv.tiers.map((t) => t.amountCents)).toEqual([500000, 200000, 75000, 20000, 5000]);
  });

  it('keeps every tier once they are exhausted too (section 33)', () => {
    const inv = parseInventory(INVENTORY_AFTER_TWO);
    expect(inv.tiers).toHaveLength(5);
    const jackpot = inv.tiers.find((t) => t.tier === 'jackpot')!;
    expect(jackpot.remaining).toBe(0);
    expect(jackpot.original).toBe(1);
    /* A major bounty at zero remaining is never hidden. That is the whole rule,
       and it is what the panel's visibility filter keys off. */
    expect(isHeadlineTier(jackpot.tier)).toBe(true);
  });

  it('advertises a TOP bounty that actually exists (section 10)', () => {
    expect(topBountyCents(parseInventory(INVENTORY_FRESH))).toBe(500000);
    /* Still 5,000 after it is won: the event DID run with a 5,000 chest, and
       rewriting the advertisement once it is claimed is a lie about the past. */
    expect(topBountyCents(parseInventory(INVENTORY_AFTER_TWO))).toBe(500000);
  });

  it('reads a tournament with no chests drawn yet as an empty ladder, not a crash', () => {
    const inv = parseInventory({ pool_cents: 0, stage: 'pending', tiers: [] });
    expect(inv.tiers).toEqual([]);
    expect(inv.stage).toBe('pending');
    expect(topBountyCents(inv)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 35. REMAINING QUANTITIES   /   36. THEY DECREASE AFTER AN AWARD
// ═══════════════════════════════════════════════════════════════════════════════

describe('35 and 36. remaining quantities, and what an award does to them', () => {
  it('carries original, awarded and remaining for every tier', () => {
    const major = parseInventory(INVENTORY_FRESH).tiers.find((t) => t.tier === 'major')!;
    expect(major.original).toBe(4);
    expect(major.awarded).toBe(0);
    expect(major.remaining).toBe(4);
  });

  it('drops the remaining count and raises awarded when a chest is opened', () => {
    const before = parseInventory(INVENTORY_FRESH);
    const after = parseInventory(INVENTORY_AFTER_TWO);

    const majorBefore = before.tiers.find((t) => t.tier === 'major')!;
    const majorAfter = after.tiers.find((t) => t.tier === 'major')!;
    expect(majorAfter.remaining).toBe(majorBefore.remaining - 1);
    expect(majorAfter.awarded).toBe(majorBefore.awarded + 1);
    /* The ORIGINAL never moves. It is what the event advertised. */
    expect(majorAfter.original).toBe(majorBefore.original);

    const jackpotAfter = after.tiers.find((t) => t.tier === 'jackpot')!;
    expect(jackpotAfter.remaining).toBe(0);
  });

  it('totals the money three ways and they reconcile', () => {
    const after = parseInventory(INVENTORY_AFTER_TWO);
    expect(awardedCents(after)).toBe(500000 + 75000);
    expect(remainingCents(after)).toBe(200000 + 3 * 75000 + 10 * 20000 + 20 * 5000);
    expect(chestCounts(after)).toEqual({ original: 36, awarded: 2, remaining: 34 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 37. THE WINNER IS RECORDED
// ═══════════════════════════════════════════════════════════════════════════════

describe('37. the winner of each bounty is recorded', () => {
  it('names the recipient and the player they knocked out', () => {
    const { rows } = parseAwards(AWARDS);
    const jackpot = rows.find((r) => r.tier === 'jackpot')!;
    expect(jackpot.isJackpot).toBe(true);
    expect(jackpot.amountCents).toBe(500000);
    expect(jackpot.recipients.map((r) => r.username)).toEqual(['Bob']);
    expect(jackpot.eliminated.username).toBe('Dan');
    expect(jackpot.handId).toBe('h-202');
  });

  it('records BOTH winners of a split knockout, with their own amounts', () => {
    const { rows } = parseAwards(AWARDS);
    const split = rows.find((r) => r.awardId === 'a1')!;
    expect(split.recipients).toHaveLength(2);
    expect(split.recipients.map((r) => r.amountCents)).toEqual([10000, 10000]);
    /* The chest is worth what it is worth; the split divides it, it does not
       duplicate it. */
    expect(split.recipients.reduce((s, r) => s + r.amountCents, 0)).toBe(split.amountCents);
  });

  it('finds the largest bounty of the event and who took it', () => {
    const { rows } = parseAwards(AWARDS);
    const biggest = largestAward(rows)!;
    expect(biggest.amountCents).toBe(500000);
    expect(biggest.award.recipients[0].username).toBe('Bob');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 38. A PLAYER'S BOUNTY TOTAL INCREASES CORRECTLY
// ═══════════════════════════════════════════════════════════════════════════════

describe("38. a player's bounty total", () => {
  it('adds up count, earnings and the largest single chest', () => {
    const totals = playerTotalsFromAwards(parseAwards(AWARDS).rows);
    const bob = totals.get('u-2')!;
    expect(bob.bountiesWon).toBe(3);
    expect(bob.earningsCents).toBe(500000 + 75000 + 10000);
    expect(bob.largestCents).toBe(500000);

    const ann = totals.get('u-1')!;
    expect(ann.bountiesWon).toBe(1);
    expect(ann.earningsCents).toBe(10000);
    expect(ann.largestCents).toBe(10000);
  });

  it('counts a split knockout as one bounty for each recipient, not one between them', () => {
    const totals = playerTotalsFromAwards(parseAwards({ total: 1, rows: [AWARDS.rows[2]] }).rows);
    expect(totals.get('u-1')!.bountiesWon).toBe(1);
    expect(totals.get('u-2')!.bountiesWon).toBe(1);
  });

  it('agrees with what the server leaderboard says, to the cent', () => {
    /* Section 69. Two independent server aggregates over the same rows; if the
       client shaping of either drifted, the lobby and the result card would
       report different money for the same player. */
    const fromAwards = playerTotalsFromAwards(parseAwards(AWARDS).rows);
    for (const row of parseLeaderboard(LEADERBOARD)) {
      const derived = fromAwards.get(row.userId)!;
      expect(derived.bountiesWon).toBe(row.bountiesWon);
      expect(derived.earningsCents).toBe(row.earningsCents);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 39. THE LEADERBOARD SORTS CORRECTLY
// ═══════════════════════════════════════════════════════════════════════════════

describe('39. the leaderboard', () => {
  it('sorts by EARNINGS, not by number of bounties', () => {
    const rows = parseLeaderboard({
      rows: [
        /* Deliberately arriving in the wrong order, and with the player who has
           the MOST bounties earning the least - a count sort would put Zed
           first and it must not. */
        { user_id: 'u-z', username: 'Zed', bounties_won: 9, earnings_cents: 90_00 },
        { user_id: 'u-a', username: 'Ann', bounties_won: 1, earnings_cents: 5_000_00 },
        { user_id: 'u-b', username: 'Bob', bounties_won: 3, earnings_cents: 750_00 },
      ],
    });
    expect(rows.map((r) => r.username)).toEqual(['Ann', 'Bob', 'Zed']);
    expect(rows[0].earningsCents).toBe(500000);
  });

  it('breaks a tie on the username so the order is stable across reloads', () => {
    const rows = parseLeaderboard({
      rows: [
        { user_id: 'u-2', username: 'Bob', bounties_won: 1, earnings_cents: 100_00 },
        { user_id: 'u-1', username: 'Ann', bounties_won: 1, earnings_cents: 100_00 },
      ],
    });
    expect(rows.map((r) => r.username)).toEqual(['Ann', 'Bob']);
  });

  it('is an empty list, not a crash, before anybody has won one', () => {
    expect(parseLeaderboard({ rows: [] })).toEqual([]);
    expect(parseLeaderboard(null)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 40. A RELOADED LOBBY RECONSTRUCTS EVERY TOTAL FROM SERVER STATE
// ═══════════════════════════════════════════════════════════════════════════════

describe('40. a reload reconstructs everything from server state', () => {
  it('produces identical totals from the RPC payloads alone, with no broadcast history', () => {
    /* This is the whole of section 69 in one assertion. Nothing below has seen
       a single `mystery_bounty_revealed` broadcast: it is the three function
       payloads and nothing else, which is exactly what a hard refresh has. */
    const inv = parseInventory(INVENTORY_AFTER_TWO);
    const awards = parseAwards(AWARDS).rows;
    const board = parseLeaderboard(LEADERBOARD);

    expect(chestCounts(inv).awarded).toBe(2);
    expect(awardedCents(inv)).toBe(575000);

    const totals = playerTotalsFromAwards(awards);
    expect(totals.get('u-2')!.earningsCents).toBe(585000);
    expect(board[0].username).toBe('Bob');
    expect(board[0].earningsCents).toBe(585000);
    expect(largestAward(awards)!.amountCents).toBe(500000);
  });

  it('survives a payload with fields missing rather than rendering NaN', () => {
    const inv = parseInventory({ tiers: [{ tier: 'major' }] });
    expect(inv.tiers[0]).toEqual({
      tier: 'major',
      amountCents: 0,
      original: 0,
      awarded: 0,
      remaining: 0,
    });
    const awards = parseAwards({ rows: [{}] });
    expect(awards.rows[0].amountCents).toBe(0);
    expect(awards.rows[0].eliminated.username).toBe('Player');
    expect(awards.rows[0].recipients).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRESENTATION — cents in, chips out, and the pre-activation copy
// ═══════════════════════════════════════════════════════════════════════════════

describe('cents are formatted, never floated', () => {
  it('renders whole amounts whole and grouped', () => {
    expect(formatCents(500000)).toBe('5,000');
    expect(formatCents(75000)).toBe('750');
    expect(formatCents(0)).toBe('0');
  });

  it('keeps a genuine sub-chip remainder rather than rounding it away', () => {
    expect(formatCents(12345)).toBe('123.45');
  });
});

describe('73. before the mystery phase opens, the lobby says why', () => {
  it('names the rebuy and add-on close for every activation mode', () => {
    for (const mode of ['at_the_money', 'percent_field', 'player_count', null]) {
      const line = activationStatusLine(
        parseInventory({ stage: 'pending', activation: mode, activation_value: 27, tiers: [] })
      );
      expect(line).toContain('Mystery Bounties Begin After The Rebuy And Add-On Period Ends');
    }
  });

  it('adds the money threshold for an at-the-money event', () => {
    const line = activationStatusLine(
      parseInventory({ stage: 'pending', activation: 'at_the_money', tiers: [] })
    );
    expect(line).toBe(
      'Mystery Bounties Begin After The Rebuy And Add-On Period Ends And The Tournament Reaches The Money'
    );
  });

  it('adds the player count for a player_count event', () => {
    const line = activationStatusLine(
      parseInventory({
        stage: 'pending',
        activation: 'player_count',
        activation_value: 27,
        tiers: [],
      })
    );
    expect(line).toContain('And 27 Players Remain');
  });

  it('says it is live once the stage is active, and nothing about waiting', () => {
    const line = activationStatusLine(parseInventory(INVENTORY_FRESH));
    expect(line).toBe('Mystery Bounties Are Live');
    expect(line).not.toContain('Begin After');
  });

  it('never uses an em dash, and capitalises every word (CLAUDE.md 5.7)', () => {
    const lines = [
      activationStatusLine(parseInventory({ stage: 'pending', activation: null, tiers: [] })),
      activationStatusLine(parseInventory(INVENTORY_FRESH)),
      activationStatusLine(parseInventory({ ...INVENTORY_FRESH, stage: 'complete' })),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/[—–―‒]/);
      for (const word of line.split(' ')) {
        if (/^[a-z]/.test(word)) {
          throw new Error(`lower-case word in UI copy: "${word}" in "${line}"`);
        }
      }
    }
  });
});
