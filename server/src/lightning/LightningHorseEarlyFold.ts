/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HORSE FOLDS ITS TRASH EARLY, LIKE A PERSON (2026-10-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * In a fast-fold pool a person does not wait for the action to reach them
 * with 7-2: they press Lightning Fold the moment the cards land and are dealt
 * into the next hand. Measured on production, 2026-10-24, three hours of
 * Lightning: 130,681 horse seats, 101,314 horse folds, and ZERO of them early.
 * Every horse sat in every hand until its turn. A person who notices that
 * nobody at the table ever folds out of turn has found every horse.
 *
 * So a horse now takes the same early fold, through the same door a person
 * uses (LightningHandHost.handlePlayerAction 'fast_fold' with the hand's
 * action context, CLAUDE.md 10.5), with a person's delay, for exactly the
 * hands its own brain would fold anyway:
 *
 *   - STRENGTH is the brain's own preflop percentile for the variant
 *     (HorseLogic's call sites: omahaPreflopStrength, holdemPreflopScore,
 *     shortDeckPreflopStrength, pineapplePreflopStrength), without the
 *     decision jitter.
 *   - A hand qualifies only below its variant family's EARLY_FOLD_MAX, the
 *     ceiling measured by the parity harness (the real HandController and the
 *     real brain, mixed horse and random-human tables, every position and
 *     stack depth): below it the brain folded every first preflop decision it
 *     faced with a price to call. The margin under the weakest hand it ever
 *     played is recorded beside each number.
 *   - Never a blind (the big blind can check; the small blind completes
 *     cheaply), never a table with a VPIP floor (a Madness seat must play),
 *     never a seat the account's own client is driving, never once the
 *     horse's own turn has come (the brain decides then, as always).
 *   - Not every qualifying hand: a person sometimes waits. A qualifying hand
 *     folds early with EARLY_FOLD_RATE, after a delay drawn from a person's
 *     reaction (median about 1.3 s, never under 0.45 s or over 4 s).
 *
 * The decision is unchanged - these hands fold either way - only WHEN they
 * fold changes, which is the tell.
 */
import type { Card } from '../types.js';
import {
  holdemPreflopScore,
  omahaPreflopStrength,
  pineapplePreflopStrength,
  shortDeckPreflopStrength,
  variantInfo,
} from '../engine/HorseEval.js';

export type EarlyFoldFamily = 'holdem' | 'omaha' | 'shortdeck' | 'other';

/**
 * The strength ceiling below which the brain folds every first preflop
 * decision facing a price (parity harness; see the file header). Filled from
 * measurement; a family with no measured ceiling never folds early.
 */
export const EARLY_FOLD_MAX: Readonly<Record<EarlyFoldFamily, number>> = {
  // Measured 2026-10-24, 500 hands per variant (NLH, FLH; PLO4/5/6/8; Short
  // Deck), mixed horse and random-human 3-6 handed tables, every position and
  // 40-200bb stacks: 1,666 / 3,332 / 833 non-blind first decisions facing a
  // price. Weakest hand the brain ever continued: hold'em 0.188, Omaha 0.152,
  // Short Deck 0.174. The ceiling also clears the widest exploit bars the
  // brain can apply from a non-blind seat, which the harness (no reads) does
  // not exercise: the loose-opener flat bar strengthBarForTopShare(0.7) =
  // 0.174 and the button's isolation floor 0.27 - 0.12 = 0.15 (hold'em only),
  // each less the decision jitter of 0.03. 0.11 sits under every one of them.
  holdem: 0.11,
  omaha: 0.11,
  shortdeck: 0.11,
  other: 0,
};

/** Share of qualifying hands a horse folds early (a person sometimes waits). */
export const EARLY_FOLD_RATE = 0.8;

export function earlyFoldFamily(variant: string): EarlyFoldFamily {
  const vi = variantInfo(variant);
  if (vi.isOmaha) return 'omaha';
  if (vi.isShortDeck) return 'shortdeck';
  const v = String(variant || 'nlh').toLowerCase();
  if (v === 'nlh' || v === 'holdem' || v === 'flh' || v === 'lhe' || v === 'plh') return 'holdem';
  return 'other';
}

/** The brain's own preflop percentile for these cards, without jitter. */
export function horsePreflopStrength(cards: readonly Card[], variant: string): number {
  const vi = variantInfo(variant);
  const c = cards as Card[];
  if (vi.isOmaha) return omahaPreflopStrength(c, vi.isHiLo);
  if (c.length === 3) return pineapplePreflopStrength(c, vi.isShortDeck);
  if (c.length === 2)
    return vi.isShortDeck
      ? shortDeckPreflopStrength(c[0]!, c[1]!)
      : holdemPreflopScore(c[0]!, c[1]!, false);
  return Number.NaN;
}

export interface EarlyFoldSeat {
  cards: readonly Card[];
  variant: string;
  /** lightning_hand_player.blind_role: 'sb' | 'bb' | 'none' ... */
  blindRole: string | null | undefined;
  /** The table's VPIP floor in percent (0 = none). */
  vpipFloor: number;
  /** The account's own client is driving the seat. */
  clientControlled: boolean;
}

/** Does this hand qualify for an early fold at all (rate not applied)? Pure. */
export function qualifiesForEarlyFold(seat: EarlyFoldSeat): boolean {
  if (seat.clientControlled) return false;
  if (seat.vpipFloor > 0) return false;
  const role = String(seat.blindRole ?? 'none').toLowerCase();
  if (role !== 'none' && role !== '') return false;
  const ceiling = EARLY_FOLD_MAX[earlyFoldFamily(seat.variant)];
  if (!(ceiling > 0)) return false;
  const s = horsePreflopStrength(seat.cards, seat.variant);
  return Number.isFinite(s) && s < ceiling;
}

/** A person's reaction before pressing Lightning Fold, in ms. */
export function earlyFoldDelayMs(rnd: () => number): number {
  // Log-normal around 1.3 s (sigma 0.45), clamped to [450, 4000].
  const u1 = Math.max(1e-9, rnd());
  const u2 = rnd();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ms = 1300 * Math.exp(0.45 * z);
  return Math.round(Math.min(4000, Math.max(450, ms)));
}

/** The plan for one horse seat: fold early after `delayMs`, or null. */
export function planEarlyFold(seat: EarlyFoldSeat, rnd: () => number): { delayMs: number } | null {
  if (!qualifiesForEarlyFold(seat)) return null;
  if (rnd() >= EARLY_FOLD_RATE) return null;
  return { delayMs: earlyFoldDelayMs(rnd) };
}
