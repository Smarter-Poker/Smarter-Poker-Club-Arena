/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A LIGHTNING HAND IS ON THE HORSE SCOREBOARD (2026-10-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A physical table's hand reaches `recordHorseHandReviews` after its commit:
 * that one call files the horse's exact net (horse_daily_nets, rake and jackpot
 * drop included), its play frequencies (horse_daily_play) and a reviewed row
 * for every 20bb swing (horse_hand_reviews). A Lightning hand never made the
 * call. Production, 2026-10-24: 7,535 Lightning hands in one hour, 0 horse
 * reviews, so there was no number anywhere saying whether the horses win in
 * Lightning, by game or by stake.
 *
 * This builds the same review input from the settled Lightning hand and files
 * it under its own results bucket, `lightning_<bb>bb` (lightningReviewFormat).
 * That bucket is the Lightning scoreboard - net, rake and drop per horse, per
 * day, per game and per stake - and because the cash tuner reads only `cash`
 * and `hu_cash`, Lightning results can never quietly move the cash tuner.
 *
 * It runs after the money is committed and is never awaited by the hand.
 */
import { noteFire } from '../engine/BrainTelemetry.js';
import {
  lightningReviewFormat,
  recordHorseHandReviews,
  type HorseReviewInput,
} from '../services/HorseHandReview.js';

export interface LightningSettledHand {
  handHistoryId: string;
  hostTableId: string;
  rules: Record<string, unknown>;
  playedAtMs: number;
  potSize: number;
  board: readonly string[];
  holeCards: ReadonlyMap<string, { seat: number; cards: readonly unknown[] }>;
  /** Settlement's per-player results: what each put in. */
  results: ReadonlyArray<{ playerId: string; contributed: number }>;
  winners: ReadonlyArray<{ userId: string; amount: number }>;
  actions: ReadonlyArray<Record<string, unknown>>;
  participants: ReadonlyArray<{ playerId: string; isHorse: boolean }>;
  rake: number;
  bbj: number;
  buttonSeat: number | null;
}

/** The table's VPIP floor in percent, read exactly as the physical engine reads it. */
export function lightningVpipFloor(rules: Record<string, unknown>): number {
  if (rules.nit_game !== true) return 0;
  const min = Number(rules.maintain_percent_min ?? 0);
  return Number.isFinite(min) && min > 0 ? min : 0;
}

/** The review input a physical table would build for this hand. Pure. */
export function buildLightningReviewInput(hand: LightningSettledHand): HorseReviewInput {
  const bigBlind = Number(hand.rules.big_blind) || 0;
  return {
    handId: hand.handHistoryId,
    tableId: hand.hostTableId,
    clubId: typeof hand.rules.club_id === 'string' ? hand.rules.club_id : null,
    tournamentId: null,
    gameVariant: String(hand.rules.game_variant || 'nlh'),
    bigBlind,
    playedAt: new Date(hand.playedAtMs).toISOString(),
    potSize: hand.potSize,
    board: hand.board.length ? [...hand.board] : null,
    boards: hand.board.length ? [[...hand.board]] : null,
    holeCardsAll: new Map(
      [...hand.holeCards].map(([id, v]) => [id, { seat: v.seat, cards: [...v.cards] }])
    ),
    contributions: new Map(hand.results.map((r) => [r.playerId, r.contributed])),
    winners: hand.winners.map((w) => ({ userId: w.userId, amount: w.amount })),
    actions: hand.actions.map((a) => ({ ...a })) as HorseReviewInput['actions'],
    roster: hand.participants.map((p) => ({ userId: p.playerId, isHorse: p.isHorse })),
    rakeAmount: hand.rake,
    bbjAmount: hand.bbj,
    buttonSeat: hand.buttonSeat,
    vpipFloor: lightningVpipFloor(hand.rules),
    format: lightningReviewFormat(bigBlind),
    seatTouch: false,
  };
}

/** File the settled hand on the horse scoreboard. Never throws or rejects. */
export async function recordLightningHorseResults(
  hand: LightningSettledHand,
  record: (input: HorseReviewInput) => Promise<void> = recordHorseHandReviews,
  report: (error: unknown, where: string) => void = () => {}
): Promise<void> {
  try {
    await record(buildLightningReviewInput(hand));
    noteFire('lightning_hand_scoreboard_filed');
  } catch (error) {
    noteFire('lightning_hand_scoreboard_failed');
    report(error, 'LightningHorseResults.record');
  }
}
