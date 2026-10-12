/**
 * P12.2 per-hand independent checks and divergence street for the Phase 12
 * packs (Short Deck, Crazy Pineapple, FLH, FLO8).
 *
 * The shared league (Plo4PolicyLeague.playPlo4PolicyHand) calls
 * `remainingVariantIndependentHandChecks` for a Phase 12 profile instead of
 * the Omaha reading, which has no Short Deck, Pineapple or FLH rules. The
 * controller's result is compared with the Phase 12 independent reference
 * (settleRemainingReference: its own scorer, contribution layers, refunds and
 * button-relative odd chips; FLO8 through the exact-two/exact-three Omaha
 * reference, which settles high and low halves) on the same contributions and
 * cards, and its rake and BBJ drop with the rake specification the database
 * implements, on the contested pot. Nothing here reads a production scorer,
 * pot builder or winner helper.
 */
import type { Card, HandConfig } from '../types.js';
import type { RemainingPolicyVariant } from '../engine/remainingVariants/RemainingVariantPolicyPack.js';
import { contributionLayers } from './OmahaReference.js';
import { settleRemainingReference } from './RemainingVariantReference.js';
import { effectiveBbjDrop, effectiveRake } from '../config/rakeSpec.js';
import {
  REMAINING_VARIANT_DIVERGENCE_STREETS,
  type RemainingVariantDivergenceStreet,
} from './RemainingVariantStrengthContract.js';

/** The fields of a finished controller state the check reads. */
export interface RemainingVariantEndState {
  players: {
    user_id: string;
    seat: number;
    cards: Card[];
    stack: number;
    totalInvested: number;
    is_folded: boolean;
    is_sitting_out: boolean;
  }[];
  communityCards: Card[];
  dealerSeat: number;
  actionHistory: { seat: number; action: string; amount?: number; stage: string }[];
}
export interface RemainingVariantHandChecks {
  trace: string[];
  settlementMismatches: number;
  deductionMismatches: number;
  showdownChecked: boolean;
  foldWinChecked: boolean;
  /** Set only when the independent reference awarded a low half (FLO8). */
  lowHalfChecked?: boolean;
  /** Pineapple discards in the trace (never betting decisions). */
  discards: number;
}

/**
 * Independent settlement and deduction checks for one finished Phase 12 hand.
 * `knownDeadCards` are the Pineapple discards the controller retained
 * privately (every seat's); they and the third card of a seat that folded
 * before the discard are checked as physical dead cards, never scored.
 */
export function remainingVariantIndependentHandChecks(
  variant: RemainingPolicyVariant,
  input: {
    end: RemainingVariantEndState;
    startStack: number;
    rake: number;
    bbj: number;
    config: Pick<HandConfig, 'bigBlind' | 'smallBlind'>;
    publishedRake: boolean;
    tableSeats: number;
    knownDeadCards?: Card[];
  }
): RemainingVariantHandChecks {
  const { end } = input;
  const checks: RemainingVariantHandChecks = {
    trace: end.actionHistory.map((a) => `${a.seat}:${a.action}:${a.amount ?? 0}:${a.stage}`),
    settlementMismatches: 0,
    deductionMismatches: 0,
    showdownChecked: false,
    foldWinChecked: false,
    discards: end.actionHistory.filter((a) => a.action === 'discard').length,
  };
  const cents = (n: number) => Math.round(n * 100);
  try {
    const dead: Card[] = [...(input.knownDeadCards ?? [])];
    const players = end.players.map((p) => {
      let cards = p.cards;
      // A Pineapple seat that folded before the flop discard still holds three
      // cards. It is never scored; its third card is checked as a dead card.
      if (variant === 'pineapple' && p.cards.length === 3 && p.is_folded) {
        cards = p.cards.slice(0, 2);
        dead.push(p.cards[2]);
      }
      return {
        id: p.user_id,
        seat: p.seat,
        cards,
        contributed: cents(p.totalInvested) / 100,
        folded: p.is_folded,
      };
    });
    const received = new Map(
      end.players.map((p) => [p.user_id, cents(p.stack - input.startStack + p.totalInvested)])
    );
    const { refunds } = contributionLayers(players, 0.01);
    const contributed = players.reduce((s, p) => s + cents(p.contributed), 0);
    const refunded = Object.values(refunds).reduce((s, v) => s + cents(v), 0);
    const pot = (contributed - refunded) / 100;
    const sawFlop = end.communityCards.length >= 3;
    const playersDealt = end.players.filter((p) => !p.is_sitting_out).length;
    if (input.publishedRake) {
      const rake = effectiveRake({
        bb: input.config.bigBlind,
        sb: input.config.smallBlind,
        pot,
        playersDealt,
        sawFlop,
        seats: input.tableSeats,
      }).rake;
      const bbj = effectiveBbjDrop({
        bb: input.config.bigBlind,
        sb: input.config.smallBlind,
        playersDealt,
        sawFlop,
        variant,
        pot,
        rake,
      });
      if (cents(rake) !== cents(input.rake) || cents(bbj) !== cents(input.bbj))
        checks.deductionMismatches++;
    }
    const deductions = cents(input.rake) + cents(input.bbj);
    const live = end.players.filter((p) => !p.is_folded);
    if (live.length === 1) {
      checks.foldWinChecked = true;
      for (const p of end.players) {
        const expected = p === live[0] ? contributed - deductions : 0;
        if (Math.abs(received.get(p.user_id)! - expected) > 1) checks.settlementMismatches++;
      }
    } else if (end.communityCards.length === 5) {
      checks.showdownChecked = true;
      const reference = settleRemainingReference({
        variant,
        players,
        board: end.communityCards,
        knownDeadCards: dead,
        chipUnit: 0.01,
        dealerSeat: end.dealerSeat,
      });
      let shortfall = 0;
      for (const p of players) {
        const gross = cents(reference.totals[p.id] ?? 0) + cents(reference.refunds[p.id] ?? 0);
        const got = received.get(p.id)!;
        // One cent of tolerance for a different odd-chip seat order.
        if (got > gross + 1 || (gross === 0 && got !== 0)) checks.settlementMismatches++;
        shortfall += gross - got;
      }
      if (Math.abs(shortfall - deductions) > 1) checks.settlementMismatches++;
      if (
        reference.awards.some((a) => (a as { half?: string }).half === 'low') &&
        variant === 'flo8'
      )
        checks.lowHalfChecked = true;
    } else checks.settlementMismatches++;
  } catch {
    checks.settlementMismatches++;
  }
  return checks;
}

/** Street of the first action at which two arms' traces differ. A Pineapple
 * discard belongs to the flop, where it is made; any other stage refuses. */
export function remainingVariantDivergenceStreet(
  a: readonly string[],
  b: readonly string[]
): RemainingVariantDivergenceStreet {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const raw = (a[i] ?? b[i]).split(':')[3];
    const stage = raw === 'pineapple_discard' ? 'flop' : raw;
    if (
      !(REMAINING_VARIANT_DIVERGENCE_STREETS as readonly string[]).includes(stage) ||
      stage === 'none'
    )
      throw new Error(`Unknown divergence stage ${raw}`);
    return stage as RemainingVariantDivergenceStreet;
  }
  return 'none';
}
