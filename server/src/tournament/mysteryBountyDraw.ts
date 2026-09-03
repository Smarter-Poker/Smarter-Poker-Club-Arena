/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MYSTERY BOUNTY — THE DRAW
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Draw without replacement, from a CSPRNG, decided at the moment of the
 * knockout and not one second earlier.
 *
 * WHAT THIS REPLACES. Until now a player's mystery bounty was rolled inside
 * `fn_register_for_tournament` with Postgres `random()` and written to
 * `tournament_players.mystery_bounty_value` at REGISTRATION. Three things were
 * wrong with that and all three are money:
 *
 *   1. `random()` is a seeded PRNG, not a CSPRNG. Postgres exposes `setseed()`
 *      to any session, and the sequence is reproducible from the seed.
 *   2. The value existed in a readable row for the entire tournament. Anyone
 *      with read access to `tournament_players` knew which head was worth
 *      chasing before the first hand.
 *   3. Drawing at registration is drawing WITH replacement. Every player's
 *      roll was independent, so the amounts paid out bore no relation to the
 *      pool that funded them — the event could pay out more than it collected
 *      or (far more often) far less, and nothing anywhere noticed.
 *
 * The inventory model fixes all three: a fixed set of chests is built once
 * from the pool (`mysteryBountyPool.buildInventory`), shuffled here with
 * `secureShuffle`, and handed out one at a time in that order. The order is
 * fixed at seed time and stored as `tournament_bounty_chests.seq`, so the
 * per-knockout pick in SQL is a plain `ORDER BY seq LIMIT 1 FOR UPDATE SKIP
 * LOCKED` — race-free, and still a cryptographic draw, because the randomness
 * was spent on the shuffle rather than on the pick.
 *
 * Doing it the other way round — `ORDER BY random()` on every knockout — would
 * have been a PRNG draw and, with two knockouts landing together, a lock
 * ordering nobody can reason about.
 */

import { secureShuffle } from '../engine/CryptoRandom.js';
import type { MysteryChest } from './mysteryBountyPool.js';
import { assertInventory } from './mysteryBountyPool.js';

export interface SeededChest extends MysteryChest {
  /** 1-based position in the draw order. Chest `seq` 1 is handed out first. */
  readonly seq: number;
}

/**
 * Shuffle an inventory into its draw order and stamp the sequence numbers.
 *
 * The shuffle is a Fisher-Yates over `secureRandomInt`, which is
 * rejection-sampled and therefore unbiased; a modulo shuffle would make the
 * early positions very slightly more likely to hold the chests that started
 * near the front, and the chest that starts at index 0 is the jackpot.
 *
 * `assertInventory` runs on the way out as well as the way in. A shuffle that
 * dropped or duplicated an element would be invisible — the array would still
 * look like an inventory — and it would put the event permanently out of
 * balance, so it is cheaper to check than to trust.
 */
export function shuffleChests(chests: readonly MysteryChest[]): SeededChest[] {
  const poolCents = chests.reduce((s, c) => s + c.amountCents, 0);
  assertInventory(chests, poolCents, chests.length);

  // secureShuffle mutates in place and returns void, so copy first — the
  // caller's inventory is the audit record and must not be reordered under it.
  const shuffled = chests.slice();
  secureShuffle(shuffled);
  const seeded = shuffled.map((c, i) => ({ tier: c.tier, amountCents: c.amountCents, seq: i + 1 }));

  assertInventory(seeded, poolCents, chests.length);
  const seqs = new Set(seeded.map((c) => c.seq));
  if (seqs.size !== seeded.length) {
    throw new Error('mystery bounty draw produced duplicate sequence numbers');
  }
  return seeded;
}

/**
 * Turn a hand's winners into the claim list `fn_mystery_bounty_reserve` splits
 * the chest by.
 *
 * Sections 27 and 28: when a short stack busts against a side pot, more than
 * one player has a claim on the bounty, in proportion to what each of them won
 * out of the pot the busted player's chips were in. There is still exactly ONE
 * chest — section 24 says one bounty per eliminated player, not one per
 * claimant — so the chest is divided rather than duplicated.
 *
 * THE ARITHMETIC OF THE SPLIT IS NOT HERE. It is inside the reserve RPC,
 * because it has to happen in the same transaction as the chest being taken,
 * and because that function is the only thing that knows what the chest is
 * worth (the reserve call deliberately does not tell the engine — section 19).
 * A TypeScript copy of the same largest-remainder rule would be a second
 * source of truth for how money is divided, which is the exact failure this
 * whole feature exists to undo.
 *
 * What IS here is the part the engine owns: who has a claim, how big it is,
 * and which of them taps the chest.
 */
export interface RecipientWeight {
  readonly userId: string;
  readonly weight: number;
}

export interface RecipientClaim {
  readonly user_id: string;
  readonly weight: number;
  is_designated_revealer: boolean;
}

export function buildRecipientClaims(
  knockerUserId: string,
  claimants: readonly RecipientWeight[]
): RecipientClaim[] {
  // Deduplicate: the same player holding two claims on one knockout (a
  // stranded seat row, a re-swept elimination) must not appear twice, because
  // two rows with the same weight would give them twice the share.
  const merged = new Map<string, number>();
  for (const c of claimants) {
    const id = String(c?.userId ?? '').trim();
    if (!id) continue;
    merged.set(id, (merged.get(id) ?? 0) + Math.max(0, Number(c.weight) || 0));
  }

  // The knocker is always a claimant. A knockout whose winners array could not
  // be read would otherwise have nobody to pay, and the chest would strand —
  // taken out of the inventory and never awarded, so the event could not
  // reconcile.
  if (knockerUserId && !merged.has(knockerUserId)) merged.set(knockerUserId, 1);

  const claims: RecipientClaim[] = Array.from(merged.entries()).map(([user_id, weight]) => ({
    user_id,
    weight,
    is_designated_revealer: false,
  }));
  if (claims.length === 0) return claims;

  // Someone has to be the player who taps the chest. It should be the knocker;
  // failing that (a knockout with no identifiable knocker) it is the largest
  // claim, and ties go to the first entry so the choice is the same on a
  // replay.
  let revealer = claims.findIndex((c) => c.user_id === knockerUserId);
  if (revealer < 0) {
    revealer = 0;
    for (let i = 1; i < claims.length; i++) {
      if (claims[i].weight > claims[revealer].weight) revealer = i;
    }
  }
  claims[revealer].is_designated_revealer = true;
  return claims;
}
