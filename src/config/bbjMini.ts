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
  return {
    eligible: true,
    rule,
    shortLabel: hiLo
      ? 'Any Quads or better must lose to bigger Quads or better (high hand only)'
      : 'Any Quads or better must lose to bigger Quads or better',
    subLabel: 'Any four of a kind counts for the mini, not only Quad Kings.',
    variantLabel: q.label,
    minLosingHandCards: QUAD_DEUCES,
    qualifyingHandLabel: BBJ_MINI_QUALIFYING_LABELS[rule],
  };
}

/** The variants the qualifying-hands strip lists, in the main strip's order. */
export const BBJ_MINI_VARIANT_KEYS = ['nlh', 'plo4', 'plo8', 'plo5'] as const;
