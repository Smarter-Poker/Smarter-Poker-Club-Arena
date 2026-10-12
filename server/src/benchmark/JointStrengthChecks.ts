/**
 * P13.2 per-hand independent checks and divergence street for the joint
 * multiway strength matrix (Horse Brain Phase 13).
 *
 * The shared league (Plo4PolicyLeague.playPlo4PolicyHand) calls
 * `jointIndependentHandChecks` for a joint profile in contract-check mode
 * instead of the Omaha or Phase 12 single-board readings, which cannot read a
 * second or third board and have no NLH ranking. The controller's result is
 * compared with the Phase 13 offline multiboard reference
 * (JointBoardReference.settleJointBoardReference: every physical board
 * settled pot by pot from independently built contribution layers and
 * refunds, ranked by the independent Omaha or remaining-game references) on
 * the same contributions and cards, and its rake and BBJ drop with the rake
 * specification the database implements, on the contested pot. Nothing here
 * reads a production scorer, pot builder or winner helper.
 */
import type { Card, HandConfig } from '../types.js';
import { contributionLayers } from './OmahaReference.js';
import { settleJointBoardReference, type JointReferenceVariant } from './JointBoardReference.js';
import { effectiveBbjDrop, effectiveRake } from '../config/rakeSpec.js';
import {
  JOINT_DIVERGENCE_STREETS,
  type JointDivergenceStreet,
  type JointStrengthVariant,
} from './JointStrengthContract.js';

/** The fields of a finished controller state the check reads. */
export interface JointEndState {
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
  communityCards2?: Card[];
  communityCards3?: Card[];
  dealerSeat: number;
  actionHistory: { seat: number; action: string; amount?: number; stage: string }[];
}
export interface JointHandChecks {
  trace: string[];
  settlementMismatches: number;
  deductionMismatches: number;
  showdownChecked: boolean;
  foldWinChecked: boolean;
  /** Set only when the independent reference awarded a low half (PLO8, FLO8). */
  lowHalfChecked?: boolean;
  /** Set when the showdown was settled on two or three physical boards. */
  multiBoardChecked?: boolean;
  /** Pineapple discards in the trace (never betting decisions). */
  discards: number;
}

/**
 * Independent settlement and deduction checks for one finished joint-profile
 * hand. `boardCount` is the controller's activated board count; exactly that
 * many boards must exist, each complete at a showdown, and none beyond it.
 * `knownDeadCards` are the Pineapple discards the controller retained
 * privately; they and the third card of a seat that folded before the discard
 * are checked as physical dead cards, never scored.
 */
export function jointIndependentHandChecks(
  variant: JointStrengthVariant,
  input: {
    end: JointEndState;
    startStack: number;
    rake: number;
    bbj: number;
    config: Pick<HandConfig, 'bigBlind' | 'smallBlind'>;
    publishedRake: boolean;
    tableSeats: number;
    boardCount: number;
    knownDeadCards?: Card[];
  }
): JointHandChecks {
  const { end } = input;
  const checks: JointHandChecks = {
    trace: end.actionHistory.map((a) => `${a.seat}:${a.action}:${a.amount ?? 0}:${a.stage}`),
    settlementMismatches: 0,
    deductionMismatches: 0,
    showdownChecked: false,
    foldWinChecked: false,
    discards: end.actionHistory.filter((a) => a.action === 'discard').length,
  };
  const cents = (n: number) => Math.round(n * 100);
  try {
    if (![1, 2, 3].includes(input.boardCount)) throw new Error('joint_check_board_count');
    const allBoards = [end.communityCards, end.communityCards2 ?? [], end.communityCards3 ?? []];
    const boards = allBoards.slice(0, input.boardCount);
    // A board beyond the activated count must never have been dealt.
    if (allBoards.slice(input.boardCount).some((b) => b.length > 0))
      throw new Error('joint_check_extra_board');
    const dead: Card[] = [...(input.knownDeadCards ?? [])];
    const players = end.players.map((p) => {
      let cards = p.cards;
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
    } else if (boards.every((b) => b.length === 5)) {
      checks.showdownChecked = true;
      if (boards.length > 1) checks.multiBoardChecked = true;
      const reference = settleJointBoardReference({
        variant: variant as JointReferenceVariant,
        players,
        boards,
        knownDeadCards: dead,
        chipUnit: 0.01,
        dealerSeat: end.dealerSeat,
      });
      let shortfall = 0;
      for (const p of players) {
        const gross = cents(reference.totals[p.id] ?? 0) + cents(reference.refunds[p.id] ?? 0);
        const got = received.get(p.id)!;
        // One cent of tolerance per board for a different odd-chip seat order.
        if (got > gross + boards.length || (gross === 0 && got !== 0))
          checks.settlementMismatches++;
        shortfall += gross - got;
      }
      if (Math.abs(shortfall - deductions) > boards.length) checks.settlementMismatches++;
      if (reference.awards.some((a) => a.half === 'low')) checks.lowHalfChecked = true;
    } else checks.settlementMismatches++;
  } catch {
    checks.settlementMismatches++;
  }
  return checks;
}

/** Street of the first action at which two arms' traces differ. A Pineapple
 * discard belongs to the flop, where it is made; any other stage refuses. */
export function jointDivergenceStreet(
  a: readonly string[],
  b: readonly string[]
): JointDivergenceStreet {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const raw = (a[i] ?? b[i]).split(':')[3];
    const stage = raw === 'pineapple_discard' ? 'flop' : raw;
    if (!(JOINT_DIVERGENCE_STREETS as readonly string[]).includes(stage) || stage === 'none')
      throw new Error(`Unknown divergence stage ${raw}`);
    return stage as JointDivergenceStreet;
  }
  return 'none';
}
