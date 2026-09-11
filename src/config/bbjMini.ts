/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE MINI JACKPOT'S RULES, AS THE CLIENT STATES THEM
 *  BBJ programme phase 2 of 5 (Dan 2026-09-09 / 2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Mirrors `detectMiniBBJHit` in server/src/config/RakeConfig.ts, which is the
 * one place the rule is enforced. Dan's design, signed off 2026-09-07:
 *
 *   hold'em family   ACES FULL OR BETTER must lose
 *   PLO family       QUADS OR BETTER must lose
 *
 * and in both, the winner still holds QUADS OR BETTER - aces full losing to a
 * bigger boat is a cooler, not a bad beat. The mini keeps every floor the main
 * has (pot, players dealt, no double board, variant eligibility) and drops the
 * main's two technicalities: the Ace-in-the-hole and the both-cards-play rule.
 * The engine picks the family the same way this file does - by the MAIN rule's
 * hand rank for the variant (`full_house` means hold'em, anything else means
 * Omaha) - so the two cannot disagree about which bar a table is under.
 * `tests/the-mini-is-seen-and-discoverable.law.test.ts` pins that mirror.
 *
 * The amounts are NOT here. A mini pays a flat amount per stakes tier out of
 * the backup reserve, and that comes from `bbj_mini_tiers` through
 * `fn_bbj_mini_for_club` (lib/bbjMiniFeed) so a change Dan makes to a tier is
 * on every surface without a deploy.
 */

import { BBJ_QUALIFYING_HANDS, normalizeVariantKey } from './RakeConfig';
import type { Card as DeckCard } from '../components/table/CardImage';

export type BBJMiniRule = 'holdem_aces_full' | 'plo_quads';

export interface BBJMiniQualifyingInfo {
  eligible: boolean;
  rule: BBJMiniRule | null;
  /** One line, the bar. */
  shortLabel: string;
  /** What is dropped from the main rule, so a player understands the difference. */
  subLabel: string;
  variantLabel: string;
  /** The minimum losing hand as five cards for the card strip (CardImage suits: s h c d). Suits are illustrative. */
  minLosingHandCards: DeckCard[];
  /** The engine's own label for this bar (`qualifyingHandLabel` on the mini hit). */
  qualifyingHandLabel: string;
}

/** The engine's `qualifyingHandLabel` for each mini rule - pinned against the server. */
export const BBJ_MINI_QUALIFYING_LABELS: Record<BBJMiniRule, string> = {
  holdem_aces_full: 'Aces Full Or Better',
  plo_quads: 'Quads Or Better',
};

/** 50 / 25 / 25, the same split as the main jackpot (fn_bbj_mini_payout). */
export const BBJ_MINI_SPLIT = { loser: 0.5, winner: 0.25, table: 0.25 } as const;

/**
 * The percentage a surface PRINTS beside each share, derived from the split
 * above rather than typed next to it. Three surfaces used to carry "50%" and
 * "25%" as literals beside a figure computed from `BBJ_MINI_SPLIT`, so retuning
 * the split would have left the words describing the old one - a caption
 * quietly disagreeing with the number under it.
 */
export const BBJ_MINI_SPLIT_PERCENT: Record<keyof typeof BBJ_MINI_SPLIT, string> = {
  loser: `${Math.round(BBJ_MINI_SPLIT.loser * 100)}%`,
  winner: `${Math.round(BBJ_MINI_SPLIT.winner * 100)}%`,
  table: `${Math.round(BBJ_MINI_SPLIT.table * 100)}%`,
};

/**
 * WHY A MINI IS NOT PAYING, said the same way everywhere.
 *
 * `payable` on a tier is the database's single answer to "would the payout RPC
 * accept this right now", and it folds three separate causes together:
 * `pool.mini_enabled AND tier.enabled AND backup - parked - amount >= floor`.
 * A surface that reports only the last of those tells a club that switched the
 * mini off that its reserve is empty, which is a false statement about money.
 * These two functions unfold it once, from the snapshot every surface already
 * holds, so no surface has to guess.
 */
export type BBJMiniPauseReason = 'club_switch_off' | 'no_tier_enabled' | 'reserve_at_floor';

export const BBJ_MINI_PAUSE_TEXT: Record<BBJMiniPauseReason, string> = {
  club_switch_off: 'Turned Off For This Club',
  no_tier_enabled: 'Turned Off',
  reserve_at_floor: 'Reserve At Its Floor - The Mini Pays Again When It Refills',
};

/**
 * Null when the mini IS paying at this tier. `tier` may be omitted to ask only
 * whether the mini is on at all (the lobby, which has no stake).
 */
export function miniPauseReason(
  snapshot: {
    enabled: boolean;
    clubSwitch: boolean;
    tiers: ReadonlyArray<{ enabled: boolean; payable: boolean }>;
  } | null,
  tier?: { enabled: boolean; payable: boolean } | null
): BBJMiniPauseReason | null {
  if (!snapshot) return null;
  if (!snapshot.enabled) {
    return snapshot.clubSwitch ? 'no_tier_enabled' : 'club_switch_off';
  }
  if (tier) {
    if (!tier.enabled) return 'no_tier_enabled';
    return tier.payable ? null : 'reserve_at_floor';
  }
  /* No stake in hand - the lobby. `enabled` only says the club switch is on
     and SOME tier is enabled; it says nothing about the reserve. Measured on
     production 2026-09-11: three of the five live pools hold 0.00 backup
     against a 5,000 floor, so "enabled with nothing payable" is the ordinary
     state and answering null here would have printed "Off" with no reason. */
  return snapshot.tiers.some((t) => t.enabled && t.payable) ? null : 'reserve_at_floor';
}

const ACES_FULL_OF_DEUCES: DeckCard[] = [
  { rank: 'A', suit: 's' },
  { rank: 'A', suit: 'h' },
  { rank: 'A', suit: 'c' },
  { rank: '2', suit: 'd' },
  { rank: '2', suit: 'c' },
];

const QUAD_DEUCES: DeckCard[] = [
  { rank: '2', suit: 's' },
  { rank: '2', suit: 'h' },
  { rank: '2', suit: 'c' },
  { rank: '2', suit: 'd' },
  { rank: '3', suit: 's' },
];

export function miniRuleForVariantKey(key: string): BBJMiniRule | null {
  const q = BBJ_QUALIFYING_HANDS[key] || BBJ_QUALIFYING_HANDS.nlh;
  if (q.eligible === false || !q.handRank) return null;
  return q.handRank === 'full_house' ? 'holdem_aces_full' : 'plo_quads';
}

/** Per-variant mini info for the felt plate, the popup and the rules page. */
export function getBBJMiniQualifyingInfo(
  gameType: string | null | undefined
): BBJMiniQualifyingInfo {
  const key = normalizeVariantKey(gameType);
  const q = BBJ_QUALIFYING_HANDS[key] || BBJ_QUALIFYING_HANDS.nlh;
  const rule = miniRuleForVariantKey(key);
  if (!rule) {
    return {
      eligible: false,
      rule: null,
      shortLabel: 'Mini Bad Beat Jackpot not available for ' + q.label,
      subLabel: '',
      variantLabel: q.label,
      minLosingHandCards: [],
      qualifyingHandLabel: '',
    };
  }
  if (rule === 'holdem_aces_full') {
    return {
      eligible: true,
      rule,
      shortLabel: 'Aces full or better must lose to Quads or better',
      subLabel: 'No Ace-in-the-hole rule and no both-cards-must-play rule for the mini.',
      variantLabel: q.label,
      minLosingHandCards: ACES_FULL_OF_DEUCES,
      qualifyingHandLabel: BBJ_MINI_QUALIFYING_LABELS[rule],
    };
  }
  const hiLo = key === 'plo8' || key === 'flo8' || key === 'plo_hilo';
  /* WHAT THE MINI LOWERS THE BAR FROM, per variant - never a fixed phrase.
     This line used to read "not only Quad Kings" for every Omaha variant. It
     is true of PLO4/PLO8/FLO8 (main bar KKKK2) and FALSE of PLO5, whose main
     bar is an 8-high straight flush, so a PLO5 player was told the mini
     relaxes a rule their game does not have. Read from the variant's own main
     rank instead, so a retuned main bar cannot leave this sentence behind. */
  const mainBar =
    q.handRank === 'straight_flush'
      ? 'a straight flush'
      : q.handRank === 'four_of_a_kind'
        ? 'Quad Kings'
        : q.label;
  return {
    eligible: true,
    rule,
    shortLabel: hiLo
      ? 'Any Quads or better must lose to bigger Quads or better (high hand only)'
      : 'Any Quads or better must lose to bigger Quads or better',
    subLabel: `Any four of a kind counts for the mini, not only ${mainBar}.`,
    variantLabel: q.label,
    minLosingHandCards: QUAD_DEUCES,
    qualifyingHandLabel: BBJ_MINI_QUALIFYING_LABELS[rule],
  };
}
