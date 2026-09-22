/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AUTO RUN - the one decision a runner makes, and nothing else
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Plinko's Auto Drop and Crash's Auto Play press the same plate a thumb would
 * press, N times, one round after another. This is the whole of what they
 * decide: given a run and the page's own readiness, do nothing yet, press
 * now (after a pause so the last result can be read), stop because the page
 * would refuse, or finish because the run is done. A runner never decides an
 * outcome, never skips a commit, never presses while the page is busy, and
 * stops the moment the page would stop a thumb (10.12: the guard is the
 * page's own blocker, not a watch around it).
 *
 * THE WHEEL'S RUN ACCUMULATES (owner ruling 2026-09-21, R18). Its runner is
 * the same `autoRunVerdict`; what differs is what a landed spin does. It no
 * longer opens a reveal or a game: every instant prize, every bonus game and
 * every Diamonds card pick is added to the run's tally (`tallyWheelRun`) and
 * shown once, together, when the run ends. The tally is a record of receipts
 * the server has already settled; it never awards anything itself.
 */

import type {
  WheelBonusAward,
  WheelCardAward,
  WheelSpinResult,
} from '../services/DiamondWheelService';

/** The runs on offer to Crash; 0 is Off. */
export const AUTO_RUN_SIZES = [0, 5, 10, 25, 50] as const;
export type AutoRunSize = (typeof AUTO_RUN_SIZES)[number];

/** The wheel's runs: 5, 10 or 25 spins (owner ruling 2026-09-21, R1 and R18: "5/10/25"). */
export const WHEEL_RUN_SIZES = [0, 5, 10, 25] as const;
export type WheelRunSize = (typeof WHEEL_RUN_SIZES)[number];

export interface AutoRun {
  total: number;
  done: number;
}

export type AutoRunVerdict =
  | { kind: 'wait' }
  | { kind: 'go'; delayMs: number }
  | { kind: 'finished' }
  | { kind: 'blocked'; why: string };

/** The next size on the plate: Off, 5, 10, 25, (50,) Off. */
export function cycleRunSize(current: number, sizes: readonly number[] = AUTO_RUN_SIZES): number {
  const i = sizes.indexOf(current);
  return sizes[(i + 1) % sizes.length];
}

export function autoRunVerdict(
  run: AutoRun | null,
  page: {
    /** A round is in flight (a ball falling, a curve climbing, a request out). */
    busy: boolean;
    /** What the page would print instead of letting a thumb press: the reason to stop. */
    blocker: string | null;
    /** The page would let a thumb press right now (commit in hand, pause served). */
    ready: boolean;
  },
  pauseMs: number
): AutoRunVerdict {
  if (!run || page.busy) return { kind: 'wait' };
  if (run.done >= run.total) return { kind: 'finished' };
  if (page.blocker) return { kind: 'blocked', why: page.blocker };
  if (!page.ready) return { kind: 'wait' };
  return { kind: 'go', delayMs: run.done === 0 ? 0 : pauseMs };
}

/** One instant prize a run's spin landed on, as the summary lists it. */
export interface WheelRunPrize {
  spinId: string;
  /** The prize's own kind: chips, diamonds, throwables, time_bank, rabbit_hunt. */
  kind: WheelSpinResult['outcome']['kind'];
  /** The prize as the player reads it (wheelPrizeTitle). */
  title: string;
  valueChips: number;
  /** Landed on the upgrade ring rather than the main wheel. */
  upgraded: boolean;
}

/** A wheel run the player started: the server's run id, its count, and everything it has won. */
export interface WheelRun extends AutoRun {
  runId: string;
  prizes: WheelRunPrize[];
  games: WheelBonusAward[];
  /** The Diamonds card picks it won and has not made yet (R15). */
  cards: WheelCardAward[];
}

/**
 * Record a landed spin on the run: one more done, and its prize, its bonus
 * game or its card pick on the tally. The receipt is the server's; the tally
 * only reads it. A spin that won nothing still counts as done.
 *
 * A DIAMONDS SPIN IS NOT AN INSTANT PRIZE ANY MORE (owner ruling 2026-09-21,
 * R15). When the receipt seals a three-card award nothing has been paid yet,
 * so it joins the card queue exactly as a bonus game joins the game queue,
 * and the summary offers it. A Diamonds receipt with no card award - an older
 * server, or one already picked - is still the instant prize it used to be.
 */
export function tallyWheelRun(
  run: WheelRun,
  result: WheelSpinResult,
  title: (prize: WheelSpinResult['outcome']) => string
): WheelRun {
  const outcome = result.secondary?.outcome ?? result.outcome;
  const sealed =
    !result.secondary && result.outcome.cards?.status === 'pending' ? result.outcome.cards : null;
  const prizes =
    sealed || outcome.kind === 'nothing' || outcome.kind === 'bonus' || outcome.kind === 'upgrade'
      ? run.prizes
      : [
          ...run.prizes,
          {
            spinId: result.spin_id,
            kind: outcome.kind,
            title: title(outcome),
            valueChips: outcome.value_chips,
            upgraded: Boolean(result.secondary),
          },
        ];
  const games = result.bonus ? [...run.games, result.bonus] : run.games;
  const cards = sealed
    ? [
        ...run.cards,
        { id: sealed.award_id, spin_id: result.spin_id, risk_diamonds: sealed.risk_diamonds },
      ]
    : run.cards;
  return { ...run, done: run.done + 1, prizes, games, cards };
}

/** The strip shown while a run turns: what it has won so far, in one line. */
export function wheelRunSoFar(run: WheelRun): string {
  const parts: string[] = [];
  const chips = run.prizes.filter((p) => p.kind === 'chips').reduce((s, p) => s + p.valueChips, 0);
  const diamonds = run.prizes.filter((p) => p.kind === 'diamonds').length;
  const rewards =
    run.prizes.length - run.prizes.filter((p) => p.kind === 'chips').length - diamonds;
  if (chips > 0)
    parts.push(
      `${chips.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${chips === 1 ? 'Chip' : 'Chips'}`
    );
  if (diamonds > 0) parts.push(`${diamonds} Diamond ${diamonds === 1 ? 'Prize' : 'Prizes'}`);
  if (rewards > 0) parts.push(`${rewards} ${rewards === 1 ? 'Reward' : 'Rewards'}`);
  if (run.cards.length > 0)
    parts.push(`${run.cards.length} Card ${run.cards.length === 1 ? 'Pick' : 'Picks'}`);
  if (run.games.length > 0)
    parts.push(`${run.games.length} Bonus ${run.games.length === 1 ? 'Game' : 'Games'}`);
  return parts.length ? parts.join(', ') : 'Nothing Yet';
}
