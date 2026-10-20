/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A HORSE WITH NO CHIPS SPINS ITS DIAMONDS INTO CHIPS (Dan, 2026-10-18)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "A HORSE WITH NO CHIPS LEFT GRINDS THE DIAMOND ARENA AND USES ITS DIAMONDS
 * ON DIAMOND SPINS TO CONVERT TO CHIPS."
 *
 * This is the pure half: who is out of chips, how far it spins, how much each
 * spin costs and how it plays the bonus games the wheel deals it. No IO and
 * no clock. Every choice a person makes by hand - which card, which tile,
 * where to cash out a Crash - is a stable hash of ids here, so a test can
 * replay it and a reviewer can see that nothing reads a sealed outcome.
 *
 * WHAT A HORSE PLAYS IS THE PERSON'S WHEEL. The driver
 * (HorseDiamondSpinsDriver) sends every action through
 * `fn_horse_diamond_spins`, which runs the exact public function the
 * Diamond Spins page calls (migration 20261019023857). Prize table, seeds,
 * entry range, limits, bonus queue and payouts are the person's, unchanged
 * (CLAUDE.md 10.5). This module only decides what a player decides.
 *
 * WHEN IT STARTS. When the fleet can no longer seat the horse at the cheapest
 * cash game the host has open: its roll at that club - the wallet plus the
 * chips it already has on a cash table there - is under the bar below. That
 * is the fleet's own broke path (HorseBankroll `bestAffordableGame` answers
 * null, the fleet's `ladder_exhausted` gauge counts it), so a horse is never
 * left between "too poor to be seated" and "not poor enough to spin".
 * Phase 4 started at one buy-in (rule 7 as written) and left exactly that
 * gap: a gambler with 150 chips at a 4.00 minimum game was refused every seat
 * and never spun (Phase 5, 2026-10-19). Diamond Spins is the second way back,
 * beside freerolls and rakeback. It converts the horse's OWN Diamonds at the
 * wheel's price - a purchase, not a grant (StableHand section 8.8 still holds).
 *
 * WHEN IT STOPS. When that roll reaches the bar the fleet needs before it
 * will seat this horse at the cheapest open game again - the seat gate
 * (`rollSupportsStake`) and bankroll rule 1 (`canSit`), whichever is higher.
 * It also stops when its Diamonds fall to the reserve it keeps for the
 * Diamond Arena, where it grinds Diamonds back.
 */

import { horseHash } from './HorseBehavior.js';
import { bankrollPolicyFor, referenceBuyIn } from './HorseBankroll.js';
import { bi100, buyInsRequiredFor } from './StableHand.js';

/** The entries the wheel page offers (WheelCabinet), cheapest first. */
export const SPIN_ENTRIES = [25, 100, 500, 1000, 2500] as const;

/** Diamonds a horse never spins below: its stake for the Diamond Arena. */
export const DIAMOND_RESERVE = 10_000;

/** The wheel's price of a chip in Diamonds (every live host reads 100). */
export const DIAMONDS_PER_CHIP = 100;

/** The wheel pays back 0.80 of what it takes in (the wheel law). */
export const WHEEL_RETURN = 0.8;

/** Plinko drop values the server lists (fn_plinko_bonus_run). */
export const PLINKO_DROP_VALUES = [1, 2, 4, 5, 10, 20, 25, 50, 100, 250, 500] as const;

/** The one setting each choice game takes (fn_choice_mode). */
export const CHOICE_MODE: Record<'mines' | 'crossing', string> = {
  mines: '6',
  crossing: 'road',
};

/** Mines is a five-by-five board (fn_choice_act refuses cells outside 0..24). */
export const MINES_CELLS = 25;

export type BonusGame = 'plinko' | 'crash' | 'mines' | 'crossing';

export interface CheapestGame {
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
}

/** The cheapest cash game on offer, or null when the host has none open. */
export function cheapestGame(
  tables: ReadonlyArray<{ big_blind: unknown; min_buy_in: unknown; max_buy_in: unknown }>
): CheapestGame | null {
  let best: CheapestGame | null = null;
  for (const t of tables) {
    const bigBlind = Number(t.big_blind);
    const minBuyIn = Number(t.min_buy_in);
    const maxBuyIn = Number(t.max_buy_in);
    if (!(bigBlind > 0) || !(minBuyIn > 0)) continue;
    if (
      !best ||
      bigBlind < best.bigBlind ||
      (bigBlind === best.bigBlind && minBuyIn < best.minBuyIn)
    ) {
      best = { bigBlind, minBuyIn, maxBuyIn: maxBuyIn > 0 ? maxBuyIn : minBuyIn };
    }
  }
  return best;
}

/**
 * The chips a horse needs behind it before the fleet will seat it at the
 * cheapest open game: the higher of the seat gate and bankroll rule 1. It is
 * both where a horse starts spinning (under it) and where it stops (at it).
 */
export function spinTargetChips(horseId: string, game: CheapestGame): number {
  const policy = bankrollPolicyFor(horseId);
  return targetFor(policy.buyInsToSit, game);
}

/**
 * The fleet can no longer seat this horse at the cheapest open game: its roll
 * (wallet plus chips on a cash table at that club) is under the bar. Below
 * one buy-in is the deepest case of it, never the only one.
 */
export function cannotBeSeated(horseId: string, rollChips: number, game: CheapestGame): boolean {
  return rollChips < spinTargetChips(horseId, game);
}

function targetFor(buyInsToSit: number, game: CheapestGame): number {
  const gate = buyInsRequiredFor(buyInsToSit) * bi100(game.bigBlind);
  const ref = referenceBuyIn(game.bigBlind, game.minBuyIn, game.maxBuyIn);
  return Math.ceil(Math.max(gate, ref * buyInsToSit) * 100) / 100;
}

/** The most buy-ins any temperament sits on (the nit's 40). */
export const MOST_BUYINS_TO_SIT = 40;

/** The highest chip target any temperament can have at this game - the read
 *  bound for memberships that may still be mid-session. */
export function maxSpinTargetChips(game: CheapestGame): number {
  return targetFor(MOST_BUYINS_TO_SIT, game);
}

/** The biggest entry a temperament takes on one spin. */
export function entryCapFor(horseId: string): number {
  switch (bankrollPolicyFor(horseId).temperament) {
    case 'nit':
      return 500;
    case 'gambler':
      return 2500;
    default:
      return 1000;
  }
}

/**
 * How much the next spin costs, or null when it should not spin.
 *
 * The biggest wheel entry that is within the temperament's cap, within the
 * Diamonds above the reserve, and no bigger than what the gap still needs at
 * the wheel's return - so a horse a few chips short does not take a 2,500
 * Diamond shot to close it.
 */
export function chooseEntry(args: {
  horseId: string;
  chips: number;
  targetChips: number;
  diamonds: number;
}): number | null {
  const { horseId, chips, targetChips, diamonds } = args;
  if (!(chips < targetChips)) return null;
  const spendable = Math.floor(diamonds) - DIAMOND_RESERVE;
  if (spendable < SPIN_ENTRIES[0]) return null;
  const needed = Math.ceil(((targetChips - chips) * DIAMONDS_PER_CHIP) / WHEEL_RETURN);
  const ceiling = Math.min(entryCapFor(horseId), spendable, Math.max(SPIN_ENTRIES[0], needed));
  let pick: number | null = null;
  for (const e of SPIN_ENTRIES) if (e <= ceiling) pick = e;
  return pick;
}

/** The drop value a horse plays a Plinko award with: the smallest listed
 *  value that plays every Diamond in at most twenty drops. */
export function plinkoDropValue(total: number): number {
  for (const d of PLINKO_DROP_VALUES) {
    if (total % d === 0 && total / d >= 1 && total / d <= 20) return d;
  }
  return total;
}

/** Where a horse sets its Crash auto cash-out, in cents of multiplier. The
 *  server refuses anything under 126 (1.26x). */
export function crashCashoutCents(horseId: string, awardId: string): number {
  const band: Record<string, [number, number]> = {
    nit: [140, 180],
    standard: [170, 260],
    gambler: [220, 400],
  };
  const [lo, hi] = band[bankrollPolicyFor(horseId).temperament];
  const span = hi - lo + 1;
  return lo + (horseHash(`crash:${horseId}:${awardId}`) % span);
}

/** How many tiles or streets a horse takes before it cashes a choice game. */
export function choiceMovesWanted(horseId: string, roundId: string, maxSteps: number): number {
  const base: Record<string, number> = { nit: 1, standard: 2, gambler: 3 };
  const t = bankrollPolicyFor(horseId).temperament;
  const wobble = horseHash(`moves:${horseId}:${roundId}`) % 2; // 0 or +1
  return Math.max(1, Math.min(maxSteps, base[t] + wobble));
}

/** The next Mines tile: a stable shuffle of the board, skipping opened ones. */
export function mineCell(horseId: string, roundId: string, picked: readonly number[]): number {
  const taken = new Set(picked);
  const order = [...Array(MINES_CELLS).keys()].sort(
    (a, b) =>
      horseHash(`cell:${horseId}:${roundId}:${a}`) - horseHash(`cell:${horseId}:${roundId}:${b}`) ||
      a - b
  );
  const next = order.find((c) => !taken.has(c));
  return next ?? 0;
}

/** Which of the three Diamond cards (1..3) a horse turns over. */
export function cardChoice(horseId: string, awardId: string): number {
  return 1 + (horseHash(`card:${horseId}:${awardId}`) % 3);
}

/* ------------------------------------------------------------------ */
/* What to do next                                                     */
/* ------------------------------------------------------------------ */

export interface PendingCard {
  id: string;
  clubId: string;
}
export interface PendingAward {
  id: string;
  clubId: string;
  game: BonusGame;
  baseDiamonds: number;
  createdAt: string;
}
export interface OpenCrashRound {
  id: string;
  clubId: string;
}
export interface OpenChoiceRound {
  id: string;
  clubId: string;
  game: 'mines' | 'crossing';
  picked: number[];
  maxSteps: number;
}

export interface HorseSpinState {
  horseId: string;
  clubId: string;
  /** The roll at this club: the wallet plus chips on a cash table there. */
  chips: number;
  diamonds: number;
  targetChips: number;
  /** The fleet cannot seat it at the cheapest open game (`cannotBeSeated`). */
  inSession: boolean;
  cards: PendingCard[];
  awards: PendingAward[];
  crashRounds: OpenCrashRound[];
  choiceRounds: OpenChoiceRound[];
}

export type HorseSpinStep =
  | { kind: 'pick_card'; awardId: string; card: number }
  | { kind: 'crash_settle'; roundId: string }
  | {
      kind: 'choice_move';
      roundId: string;
      action: 'pick' | 'cashout';
      cell: number | null;
      expectedStep: number;
    }
  | { kind: 'start_bonus'; award: PendingAward }
  | { kind: 'spin'; entry: number }
  | { kind: 'rest' };

/**
 * One action at a time, in the order the server requires: a card waiting to
 * be turned, then a round already in play, then the earliest unplayed prize
 * (fn_wheel_next_unplayed), and only then another spin. A won prize is always
 * played, whatever the wallet now reads - a person cannot walk away from one
 * mid-queue either, and the next spin would be refused until it is.
 */
export function nextStep(s: HorseSpinState): HorseSpinStep {
  const card = s.cards.find((c) => c.clubId === s.clubId);
  if (card) return { kind: 'pick_card', awardId: card.id, card: cardChoice(s.horseId, card.id) };

  const crash = s.crashRounds.find((r) => r.clubId === s.clubId);
  if (crash) return { kind: 'crash_settle', roundId: crash.id };

  const choice = s.choiceRounds.find((r) => r.clubId === s.clubId);
  if (choice) {
    const wanted = choiceMovesWanted(s.horseId, choice.id, choice.maxSteps);
    const n = choice.picked.length;
    if (n < wanted) {
      const cell = choice.game === 'crossing' ? n : mineCell(s.horseId, choice.id, choice.picked);
      return { kind: 'choice_move', roundId: choice.id, action: 'pick', cell, expectedStep: n };
    }
    return {
      kind: 'choice_move',
      roundId: choice.id,
      action: 'cashout',
      cell: null,
      expectedStep: n,
    };
  }

  const award = [...s.awards]
    .filter((a) => a.clubId === s.clubId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  if (award) return { kind: 'start_bonus', award };

  if (!s.inSession) return { kind: 'rest' };
  const entry = chooseEntry({
    horseId: s.horseId,
    chips: s.chips,
    targetChips: s.targetChips,
    diamonds: s.diamonds,
  });
  return entry === null ? { kind: 'rest' } : { kind: 'spin', entry };
}

/** The pause before a horse's next action, in ms: a person's rhythm, never a
 *  machine's. The server's own three-second gap between spins still binds. */
export function paceMs(horseId: string, step: HorseSpinStep['kind'], nonce: number): number {
  const h = horseHash(`pace:${horseId}:${step}:${nonce}`);
  switch (step) {
    case 'crash_settle':
      return 3_000 + (h % 2_000);
    case 'choice_move':
    case 'pick_card':
      return 3_000 + (h % 5_000);
    case 'start_bonus':
      return 4_000 + (h % 6_000);
    case 'spin':
      return 6_000 + (h % 12_000);
    default:
      return 60_000;
  }
}

/** Refusals the wheel answers with by design, and how long to leave them. */
export function backoffForRefusal(error: string): number | null {
  const e = error.toLowerCase();
  if (e.includes('one moment')) return 5_000;
  if (e.includes('daily') || e.includes('today') || e.includes('limit')) return 2 * 60 * 60_000;
  if (e.includes('host') || e.includes('fund') || e.includes('cover')) return 30 * 60_000;
  if (e.includes('maintenance')) return 6 * 60_000;
  if (e.includes('diamond') && (e.includes('enough') || e.includes('not have'))) return 60 * 60_000;
  return null;
}
