/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MYSTERY BOUNTY DRAW — the shuffle, and the split knockout
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The shuffle is where the randomness of the whole format lives. Once the
 * inventory is shuffled and stored with sequence numbers, the per-knockout pick
 * in SQL is a plain `ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED` — race-free,
 * and still a cryptographic draw. So a shuffle that dropped or duplicated an
 * element would not merely be unfair; it would put the event permanently out of
 * balance, and it would look exactly like a correct inventory while doing it.
 */

import { describe, it, expect } from 'vitest';
import { shuffleChests, buildRecipientClaims } from './mysteryBountyDraw.js';
import { buildInventory } from './mysteryBountyPool.js';

describe('shuffleChests', () => {
  it('preserves every chest and the total, and numbers them 1..n', () => {
    const inventory = buildInventory(2_000_00, 120, 'classic');
    const shuffled = shuffleChests(inventory);

    expect(shuffled).toHaveLength(120);
    expect(shuffled.reduce((s, c) => s + c.amountCents, 0)).toBe(2_000_00);
    expect(new Set(shuffled.map((c) => c.seq))).toEqual(
      new Set(Array.from({ length: 120 }, (_, i) => i + 1))
    );

    // Same multiset of amounts, in some order.
    const before = inventory.map((c) => c.amountCents).sort((a, b) => a - b);
    const after = shuffled.map((c) => c.amountCents).sort((a, b) => a - b);
    expect(after).toEqual(before);
  });

  it('does not reorder the caller’s inventory', () => {
    // The inventory the caller holds is the audit record. secureShuffle mutates
    // in place, so a missing copy here would silently rewrite it.
    const inventory = buildInventory(1_000_00, 60, 'classic');
    const snapshot = inventory.map((c) => `${c.tier}:${c.amountCents}`);
    shuffleChests(inventory);
    expect(inventory.map((c) => `${c.tier}:${c.amountCents}`)).toEqual(snapshot);
  });

  it('actually shuffles - the jackpot does not sit at position 1 every time', () => {
    // A no-op shuffle would pass every other test in this file. Over twenty
    // runs of a 120-chest inventory, the chance of the jackpot landing first
    // every time by luck is (1/120)^20.
    const inventory = buildInventory(2_000_00, 120, 'classic');
    const firstPositions = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const shuffled = shuffleChests(inventory);
      firstPositions.add(shuffled.findIndex((c) => c.tier === 'jackpot'));
    }
    expect(firstPositions.size).toBeGreaterThan(1);
  });
});

describe('buildRecipientClaims', () => {
  // Sections 27 and 28: when a short stack busts against a side pot, more than
  // one player has a claim, in proportion to what each won out of the pot the
  // busted player's chips were in. There is still exactly ONE chest (section
  // 24), so it is divided rather than duplicated — and the division itself
  // happens inside fn_mystery_bounty_reserve, which is the only thing that
  // knows what the chest is worth.
  it('passes the weights through and shapes them for the reserve RPC', () => {
    const claims = buildRecipientClaims('a', [
      { userId: 'a', weight: 700 },
      { userId: 'b', weight: 300 },
    ]);
    expect(claims).toEqual([
      { user_id: 'a', weight: 700, is_designated_revealer: true },
      { user_id: 'b', weight: 300, is_designated_revealer: false },
    ]);
  });

  it('names exactly one designated revealer, and it is the knocker', () => {
    const claims = buildRecipientClaims('small', [
      { userId: 'small', weight: 1 },
      { userId: 'big', weight: 9 },
    ]);
    expect(claims.filter((c) => c.is_designated_revealer)).toHaveLength(1);
    // The knocker taps the chest even when a side pot winner has the larger
    // claim: they are the player the table just watched win the hand.
    expect(claims.find((c) => c.is_designated_revealer)!.user_id).toBe('small');
  });

  it('falls back to the largest claim when there is no identifiable knocker', () => {
    const claims = buildRecipientClaims('', [
      { userId: 'small', weight: 1 },
      { userId: 'big', weight: 9 },
    ]);
    expect(claims.find((c) => c.is_designated_revealer)!.user_id).toBe('big');
  });

  it('deduplicates a player holding two claims on one knockout', () => {
    // A stranded seat row or a re-sweep can present the same user twice.
    // Two rows with the same weight would give them twice the share.
    const claims = buildRecipientClaims('a', [
      { userId: 'a', weight: 4 },
      { userId: 'a', weight: 6 },
    ]);
    expect(claims).toHaveLength(1);
    expect(claims[0].weight).toBe(10);
  });

  it('always includes the knocker, even with no winners to read', () => {
    // A chest taken out of the inventory with nobody to pay would strand, and
    // the event could then never reconcile.
    const claims = buildRecipientClaims('knocker', []);
    expect(claims).toEqual([{ user_id: 'knocker', weight: 1, is_designated_revealer: true }]);
  });

  it('drops blank ids and negative weights rather than sending them on', () => {
    const claims = buildRecipientClaims('a', [
      { userId: '', weight: 100 },
      { userId: '  ', weight: 100 },
      { userId: 'b', weight: -5 },
      { userId: 'a', weight: 10 },
    ]);
    expect(claims.map((c) => c.user_id).sort()).toEqual(['a', 'b']);
    expect(claims.find((c) => c.user_id === 'b')!.weight).toBe(0);
  });
});
