/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HAND FUZZER — randomized whole-hand driver + chip-conservation oracle
 * ═══════════════════════════════════════════════════════════════════════════════
 * D24 (engine optimization report, "highest leverage"): the engine has ~90 unit
 * tests that each pin one hand-shaped example. None of them can answer the only
 * question that actually matters for a card room:
 *
 *     across EVERY reachable sequence of legal actions, does the engine ever
 *     create or destroy a chip?
 *
 * This module drives HandController through complete randomized hands — random
 * variant, seat count, stack distribution, blinds, antes, straddles, bomb pots,
 * dead blinds, rake config and BBJ config — choosing a uniformly random LEGAL
 * action for whoever is to act, and asserting the conservation invariants after
 * every single mutation. It is the engine's property test.
 *
 * INVARIANTS (checked after every action, every street transition, and at the
 * end of the hand):
 *
 *   INV-1  sum(stacks) + pot === startingChips           [during the hand]
 *          Every chip movement in HandController is a matched triple
 *          `totalInvested += x; stack -= x; pot += x`, and returnUncalledBet()
 *          is its exact inverse. Nothing else may move chips.
 *   INV-2  pot === sum(totalInvested)                    [during the hand]
 *          Same triple, viewed per player. Catches a pot credited without a
 *          matching debit (the shape of the 2026-08 live chip mint).
 *   INV-3  sum(calculatePots()) === pot                  [during the hand]
 *          Side-pot construction must partition the pot exactly. A side-pot
 *          bug is invisible to INV-1/2 because it only mis-splits at showdown.
 *   INV-4  sum(stacks) + rake + bbjFee === startingChips [after HAND_COMPLETE]
 *          The whole point: the pot is distributed in full, less exactly the
 *          rake and jackpot fee the engine reported taking.
 *   INV-5  every chip value is a whole number of cents, and no stack, pot or
 *          totalInvested is ever negative.
 *   INV-6  no player ever invests more than they sat down with.
 *
 * A violation throws ChipConservationError carrying a complete, human-readable
 * replay (config, hole cards, board, every action) so the failure is
 * reproducible from the message alone — the deck is cryptographically shuffled
 * and deliberately NOT seedable, so the replay IS the repro.
 *
 * Used by src/engine/ChipConservation.property.test.ts (runs on every deploy,
 * see .github/workflows/auto-deploy-hetzner.yml) and runnable as a long soak:
 *
 *     CHIP_CONSERVATION_HANDS=1000000 npx vitest run ChipConservation
 */

import { HandController } from './HandController.js';
import { calculatePots, cardsToString } from './PokerEngine.js';
import {
  isPotLimitVariant,
  isFixedLimitVariant,
  isFixedLimitCapped,
  fixedLimitBetSize,
  fixedLimitStreetBounds,
} from './BettingStructure.js';

import type { ActionType, GameVariant, HandConfig, SeatPlayer } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic PRNG — only the ACTION stream is seeded. The deck is not
// seedable (secureShuffle), which is correct: conservation must hold for every
// board, and the replay dump makes a failure reproducible regardless.
// ─────────────────────────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** Tolerance for float sum drift. Chip values are whole cents; 1e-6 is nine
 *  orders of magnitude below a cent and far above IEEE 754 summation drift. */
const EPS = 1e-6;

// ─────────────────────────────────────────────────────────────────────────────
// Failure type — carries the full replay
// ─────────────────────────────────────────────────────────────────────────────

export class ChipConservationError extends Error {
  constructor(
    public invariant: string,
    public detail: string,
    public replay: string
  ) {
    super(`${invariant}: ${detail}\n${replay}`);
    this.name = 'ChipConservationError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Random table configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Deck size and cards dealt per player, per variant — used to keep the random
 *  table inside what the deck can physically supply (deal() throws otherwise). */
const VARIANT_CARDS: Record<
  GameVariant,
  { perPlayer: number; deckSize: number; maxSeats: number }
> = {
  nlh: { perPlayer: 2, deckSize: 52, maxSeats: 9 },
  plo4: { perPlayer: 4, deckSize: 52, maxSeats: 9 },
  plo5: { perPlayer: 5, deckSize: 52, maxSeats: 7 },
  plo6: { perPlayer: 6, deckSize: 52, maxSeats: 6 },
  plo8: { perPlayer: 4, deckSize: 52, maxSeats: 9 },
  pineapple: { perPlayer: 3, deckSize: 52, maxSeats: 9 },
  short_deck: { perPlayer: 2, deckSize: 36, maxSeats: 9 },
  // 2026-08-23: fixed-limit variants deal exactly like their no-limit and
  // pot-limit counterparts — only the BETTING differs — so the card maths is
  // nlh's and plo4's. Including them here is deliberate: the fuzzer is the only
  // thing that will ever drive a capped street into the chip-conservation
  // invariant, and a capped street is where a wrong clamp would silently
  // create or destroy chips.
  flh: { perPlayer: 2, deckSize: 52, maxSeats: 9 },
  flo8: { perPlayer: 4, deckSize: 52, maxSeats: 9 },
};

export const VARIANTS = Object.keys(VARIANT_CARDS) as GameVariant[];
const BLIND_LEVELS: [number, number][] = [
  [0.01, 0.02],
  [0.05, 0.1],
  [0.5, 1],
  [1, 2],
  [2, 5],
  [5, 10],
  [25, 50],
  [100, 200],
];

export interface FuzzConfig {
  config: HandConfig;
  seats: SeatPlayer[];
  dealerSeat: number;
}

export function randomTable(rnd: () => number): FuzzConfig {
  const variant = VARIANTS[Math.floor(rnd() * VARIANTS.length)];
  const spec = VARIANT_CARDS[variant];
  // Physical bound: perPlayer * seats + 5 board cards must fit the deck.
  const cardBound = Math.floor((spec.deckSize - 5) / spec.perPlayer);
  const maxSeats = Math.max(2, Math.min(spec.maxSeats, cardBound));
  const playerCount = 2 + Math.floor(rnd() * (maxSeats - 1));

  const [sb, bb] = BLIND_LEVELS[Math.floor(rnd() * BLIND_LEVELS.length)];

  // Stack distribution mode. Short and micro stacks are the interesting ones:
  // they force side pots, forced-partial blinds and all-in runouts.
  const mode = rnd();
  const stackFor = (): number => {
    if (mode < 0.25) return cents(bb * 100); // everyone even
    if (mode < 0.6) return cents(bb * (1 + Math.floor(rnd() * 300))); // wide spread
    if (mode < 0.85) return cents(bb * (0.2 + rnd() * 8)); // short-stack table
    return cents(Math.max(0.01, bb * rnd() * 1.5)); // micro: below one blind
  };

  // Non-contiguous seat numbers on purpose — FIX 165 was a real bug here.
  const allSeats = Array.from({ length: 9 }, (_, i) => i + 1);
  for (let i = allSeats.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [allSeats[i], allSeats[j]] = [allSeats[j], allSeats[i]];
  }
  const seatNumbers = allSeats.slice(0, playerCount).sort((a, b) => a - b);

  // REVIEW FIX 2026-08-20: is_sitting_out was hard-coded false, and
  // HandController branches on it in 16 places — dealHoleCards, the ante loop,
  // getNextActiveSeat, getActivePlayers, isSeatActionable, the bbOnlyPosts and
  // straddle guards, and (money-relevant) the playerCount feeding
  // playerCountCaps and the playersDealt feeding the BBJ eligibility gate.
  // Dropping any one of those filters was undetectable. Never sit out so many
  // that fewer than two players remain.
  const maxSittingOut = Math.max(0, playerCount - 2);
  let sittingOut = 0;
  const seats: SeatPlayer[] = seatNumbers.map((seat, i) => {
    const sitOut = sittingOut < maxSittingOut && rnd() < 0.08;
    if (sitOut) sittingOut++;
    return {
      seat,
      user_id: `u${i + 1}`,
      username: `P${i + 1}`,
      stack: stackFor(),
      bet: 0,
      totalInvested: 0,
      deadInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: sitOut,
    };
  });

  const dealerSeat = seatNumbers[Math.floor(rnd() * seatNumbers.length)];

  const config: HandConfig = {
    tableId: 'fuzz-table',
    handNumber: 1,
    gameVariant: variant,
    smallBlind: sb,
    bigBlind: bb,
    rakeConfig: {
      // REVIEW FIX 2026-08-20: RakeConfig.percent is in WHOLE-PERCENT units
      // ("7.5 means 7.5%", src/config/RakeConfig.ts) and every live level uses
      // 10. The old array [0, 0.01 ... 0.1] tested a rake regime 100x lighter
      // than production: measured p99 of 0.11% of the pot against a real 5-10%,
      // so the rake-exceeds-pot clamp and the winner-scaling loops were only
      // ever exercised with a negligible deduction.
      percent: [0, 1, 3, 5, 10][Math.floor(rnd() * 5)],
      cap: cents(bb * [0, 1, 3, 5, 25][Math.floor(rnd() * 5)]),
      noFlopNoDrop: rnd() < 0.8,
      ...(rnd() < 0.25
        ? {
            playerCountCaps: [
              { players: 2, cap: cents(bb) },
              { players: 5, cap: cents(bb * 2) },
            ],
          }
        : {}),
    },
  };

  // Optional forced money. Each is independently sampled so combinations
  // (ante + straddle + dead blind on a micro-stack table) actually occur.
  if (rnd() < 0.25) config.ante = cents(bb * [0.1, 0.2, 0.5][Math.floor(rnd() * 3)]);
  if (rnd() < 0.15) {
    config.bigBlindAnte = true;
    config.ante = config.ante ?? cents(bb);
  }
  if (rnd() < 0.15) {
    const straddleSeat = seatNumbers[Math.floor(rnd() * seatNumbers.length)];
    config.straddles = [{ seat: straddleSeat, amount: cents(bb * 2) }];
  }
  if (rnd() < 0.08) {
    // Round 2 (2026-08-20): multi-board bomb pots ride the standing
    // chip-conservation corpus, not just their own test file. TRIPLE-BOARD
    // 2026-08-28: the mix is now one third each of 1, 2 and 3 boards, and a
    // quarter of bomb hands use the FIXED-ante mode instead of the BB
    // multiple. HandController downgrades itself when the deck cannot cover
    // the requested boards.
    const boardCount = ([1, 2, 3] as const)[Math.floor(rnd() * 3)];
    config.bombPot = {
      anteMultiplier: [1, 2, 5][Math.floor(rnd() * 3)],
      boardCount,
      doubleBoard: boardCount >= 2,
      anteFixed: rnd() < 0.25 ? cents(bb * (1 + rnd() * 4)) : undefined,
    };
  }
  if (rnd() < 0.12) {
    config.deadBlinds = [{ seat: seatNumbers[Math.floor(rnd() * seatNumbers.length)] }];
  }
  if (rnd() < 0.12) {
    config.bbOnlyPosts = [{ seat: seatNumbers[Math.floor(rnd() * seatNumbers.length)] }];
  }
  if (rnd() < 0.4) {
    config.bbjConfig = {
      enabled: true,
      feeBB: [0.1, 0.25, 0.5][Math.floor(rnd() * 3)],
      minPotBB: [0, 5, 10][Math.floor(rnd() * 3)],
      minPlayersDealt: [2, 3, 4][Math.floor(rnd() * 3)],
    };
  }

  return { config, seats, dealerSeat };
}

// ─────────────────────────────────────────────────────────────────────────────
// The oracle
// ─────────────────────────────────────────────────────────────────────────────

export interface FuzzHandResult {
  seed: number;
  variant: GameVariant;
  players: number;
  startingChips: number;
  finalChips: number;
  rake: number;
  bbjFee: number;
  actions: number;
  checks: number;
  reachedShowdown: boolean;
  allInRunout: boolean;
  sidePots: number;
  replay: string;
}

interface Ctx {
  hc: HandController;
  startingChips: number;
  seatStart: Map<number, number>;
  log: string[];
  cfg: FuzzConfig;
  seed: number;
  checks: number;
  maxSidePots: number;
}

function replayOf(ctx: Ctx): string {
  const st = (ctx.hc as any).state;
  const lines: string[] = [];
  lines.push('── REPLAY ' + '─'.repeat(60));
  lines.push(`seed:    ${ctx.seed}`);
  lines.push(`config:  ${JSON.stringify(ctx.cfg.config)}`);
  lines.push(`dealer:  seat ${ctx.cfg.dealerSeat}`);
  lines.push('seats:');
  for (const p of ctx.cfg.seats) {
    lines.push(`  seat ${p.seat} ${p.user_id} start=${ctx.seatStart.get(p.seat)}`);
  }
  lines.push(`board:   ${cardsToString(st.communityCards ?? [])}`);
  for (const p of st.players ?? []) {
    lines.push(
      `  seat ${p.seat} cards=[${cardsToString(p.cards ?? [])}] stack=${p.stack} ` +
        `bet=${p.bet} invested=${p.totalInvested} dead=${p.deadInvested ?? 0} ` +
        `folded=${p.is_folded} allin=${p.is_all_in}`
    );
  }
  lines.push(`pot:     ${st.pot}   stage: ${st.stage}`);
  lines.push('actions:');
  for (const l of ctx.log) lines.push('  ' + l);
  lines.push('─'.repeat(70));
  return lines.join('\n');
}

function fail(ctx: Ctx, invariant: string, detail: string): never {
  throw new ChipConservationError(invariant, detail, replayOf(ctx));
}

/**
 * INV-10 — an INDEPENDENT side-pot partition, written from the rules rather
 * than from the code under test.
 *
 * REVIEW FIX 2026-08-20. INV-3 only proved that calculatePots() SUMS to the
 * pot, and INV-7 read its cap out of `state.pots` — the very array
 * determineWinners was handed. So both were blind to a WRONG eligibility set:
 * widening eligibility raises the cap and makes INV-7 pass by construction.
 *
 * Demonstrated with two mutants of calculatePots. Making folded players
 * eligible was caught (1.4% of hands). Making DEAD money count toward side-pot
 * eligibility — the exact regression PokerEngine documents as previously
 * shipped, where a player all-in for a 5-chip ante could win a 205 pot — was
 * NOT caught at all: zero invariant failures over 10,000 hands.
 *
 * This rebuilds the partition from the stated rules:
 *   - side-pot LEVELS include live investment and individual antes, while
 *     shared BBA and dead-small-blind money stay outside contribution caps
 *   - a level's amount is (level - previousLevel) x everyone who reached it,
 *     folded contributors included — their chips stay in the pot
 *   - only NON-FOLDED players may be eligible to win it
 *   - dead money forms its own pot at the bottom, contested by every
 *     non-folded player who put anything in
 *   - a level whose every eligible player folded is uncontested dead money and
 *     joins the main pot
 * and asserts the engine agrees on both the amounts and the eligible sets.
 */
function expectedPots(players: SeatPlayer[]): { amount: number; eligiblePlayers: string[] }[] {
  const r = (n: number) => Math.round(n * 100) / 100;
  // Reference model counts the FULL individual ante in contribution levels.
  // Matched-contribution cap tests independently bound each player's maximum.
  const live = (p: SeatPlayer) =>
    Math.max(
      0,
      r((p.totalInvested ?? 0) - (p.deadInvested ?? 0) + (p.individualAnteInvested ?? 0))
    );
  const active = players.filter((p) => !p.is_folded);
  if (active.length === 0) return [];

  const deadTotal = r(
    players.reduce((sum, p) => sum + (p.deadInvested ?? 0) - (p.individualAnteInvested ?? 0), 0)
  );
  const contributors = players.filter((p) => live(p) > 0);
  if (contributors.length === 0) {
    return deadTotal > 0
      ? [{ amount: deadTotal, eligiblePlayers: active.map((p) => p.user_id) }]
      : [];
  }

  const levels = [...new Set(contributors.map(live))].sort((a, b) => a - b);
  const pots: { amount: number; eligiblePlayers: string[] }[] = [];
  let previous = 0;
  let orphaned = 0;
  for (const level of levels) {
    if (level === 0) continue;
    const contribution = level - previous;
    const reached = contributors.filter((p) => live(p) >= level).length;
    const eligible = active.filter((p) => live(p) >= level);
    if (reached > 0 && eligible.length > 0) {
      pots.push({
        amount: contribution * reached,
        eligiblePlayers: eligible.map((p) => p.user_id),
      });
    } else if (reached > 0) {
      orphaned = r(orphaned + contribution * reached);
    }
    previous = level;
  }
  if (orphaned > 0 && pots.length > 0) {
    pots[0].amount = r(pots[0].amount + orphaned);
    orphaned = 0;
  }
  const deadPool = r(deadTotal + orphaned);
  if (pots.length > 0 && deadPool > 0) {
    pots.unshift({
      amount: deadPool,
      eligiblePlayers: active
        .filter((p) => (p.totalInvested ?? p.bet ?? 0) > 0)
        .map((p) => p.user_id),
    });
  }
  if (pots.length === 0) {
    return deadPool > 0
      ? [{ amount: deadPool, eligiblePlayers: active.map((p) => p.user_id) }]
      : [];
  }
  const merged = [pots[0]];
  for (let i = 1; i < pots.length; i++) {
    const last = merged[merged.length - 1];
    if (JSON.stringify(last.eligiblePlayers) === JSON.stringify(pots[i].eligiblePlayers)) {
      last.amount += pots[i].amount;
    } else {
      merged.push(pots[i]);
    }
  }
  return merged;
}

/** INV-1, INV-2, INV-3, INV-5, INV-6 — everything checkable mid-hand. */
function checkMidHand(ctx: Ctx, where: string): void {
  const st = (ctx.hc as any).state;
  const players: SeatPlayer[] = st.players;
  ctx.checks++;

  let stackSum = 0;
  let investedSum = 0;
  for (const p of players) {
    if (p.stack < -EPS)
      fail(ctx, 'INV-5', `negative stack at ${where}: seat ${p.seat} = ${p.stack}`);
    if ((p.totalInvested ?? 0) < -EPS) {
      fail(ctx, 'INV-5', `negative totalInvested at ${where}: seat ${p.seat} = ${p.totalInvested}`);
    }
    for (const [label, v] of [
      ['stack', p.stack],
      ['bet', p.bet],
      ['totalInvested', p.totalInvested ?? 0],
    ] as [string, number][]) {
      if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) {
        fail(ctx, 'INV-5', `sub-cent ${label} at ${where}: seat ${p.seat} = ${v}`);
      }
    }
    const start = ctx.seatStart.get(p.seat) ?? 0;
    if ((p.totalInvested ?? 0) > start + EPS) {
      fail(
        ctx,
        'INV-6',
        `seat ${p.seat} invested ${p.totalInvested} but sat down with ${start} (at ${where})`
      );
    }
    stackSum += p.stack;
    investedSum += p.totalInvested ?? 0;
  }

  if (st.pot < -EPS) fail(ctx, 'INV-5', `negative pot at ${where}: ${st.pot}`);

  const total = stackSum + st.pot;
  if (Math.abs(total - ctx.startingChips) > EPS) {
    fail(
      ctx,
      'INV-1',
      `chips ${total > ctx.startingChips ? 'CREATED' : 'DESTROYED'} at ${where}: ` +
        `sum(stacks)=${stackSum} + pot=${st.pot} = ${total}, expected ${ctx.startingChips} ` +
        `(delta ${cents(total - ctx.startingChips)})`
    );
  }

  if (Math.abs(investedSum - st.pot) > EPS) {
    fail(
      ctx,
      'INV-2',
      `pot ${st.pot} != sum(totalInvested) ${investedSum} at ${where} ` +
        `(delta ${cents(st.pot - investedSum)})`
    );
  }

  const pots = calculatePots(players);
  if (pots.length > ctx.maxSidePots) ctx.maxSidePots = pots.length;
  const potsSum = pots.reduce((s, p) => s + p.amount, 0);
  if (Math.abs(potsSum - st.pot) > EPS) {
    fail(
      ctx,
      'INV-3',
      `side pots sum to ${potsSum} but pot is ${st.pot} at ${where} ` +
        `(delta ${cents(potsSum - st.pot)}); pots=${JSON.stringify(pots.map((p) => p.amount))}`
    );
  }

  // INV-10: the partition itself, against an independent construction.
  const expected = expectedPots(players);
  const norm = (ps: { amount: number; eligiblePlayers: string[] }[]) =>
    ps.map((p) => `${cents(p.amount)}|${[...p.eligiblePlayers].sort().join(',')}`);
  const got = norm(pots);
  const want = norm(expected);
  if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
    // A folded player among the eligible is the single most dangerous shape,
    // so name it explicitly when that is what differs.
    const foldedIds = new Set(players.filter((p) => p.is_folded).map((p) => p.user_id));
    const foldedEligible = pots.flatMap((p) => p.eligiblePlayers).filter((id) => foldedIds.has(id));
    fail(
      ctx,
      'INV-10',
      `side-pot partition disagrees with the rules at ${where}` +
        (foldedEligible.length
          ? ` - FOLDED player(s) ${JSON.stringify([...new Set(foldedEligible)])} are eligible to win`
          : '') +
        `\n  engine:   ${JSON.stringify(got)}` +
        `\n  expected: ${JSON.stringify(want)}`
    );
  }
}

/** Choose a legal amount for a bet/raise, or null if none is representable. */
function amountFor(
  hc: HandController,
  player: SeatPlayer,
  action: 'bet' | 'raise',
  rnd: () => number
): number | null {
  const st = (hc as any).state;
  const cfg = (hc as any).config as HandConfig;
  const isPotLimit = isPotLimitVariant(cfg.gameVariant);
  const toCall = st.currentBet - player.bet;
  const minRaise = Math.max(cfg.bigBlind, st.lastRaise || cfg.bigBlind);
  const plCap = isPotLimit ? st.pot + toCall : Infinity;

  // 2026-08-23: fixed limit has no range to sample — there is exactly one legal
  // wager per street. Returning a random size here would make the fuzzer report
  // its own illegal amounts as engine failures. Null when the stack cannot
  // cover the fixed bet; the caller then picks a different action, which is the
  // same escape it already uses for a pot-limit cap below a full raise.
  if (isFixedLimitVariant(cfg.gameVariant)) {
    const streetBet = fixedLimitBetSize(cfg.bigBlind, st.stage);
    if (isFixedLimitCapped(st.actionHistory, st.stage, streetBet)) return null;
    const betSize = fixedLimitStreetBounds(
      st.actionHistory,
      st.stage,
      streetBet,
      st.currentBet
    ).raiseSize;
    if (action === 'bet') {
      return player.stack + EPS < betSize ? null : cents(betSize);
    }
    const raiseTo = cents(st.currentBet + betSize);
    return player.bet + player.stack + EPS < raiseTo ? null : raiseTo;
  }

  if (action === 'bet') {
    const lo = minRaise;
    const hi = Math.min(player.stack, plCap);
    if (hi + EPS < lo) return null;
    return cents(lo + rnd() * Math.max(0, hi - lo));
  }
  // raise: `amount` is the raise-TO level.
  const lo = cents(st.currentBet + minRaise);
  const hi = Math.min(player.bet + player.stack, st.currentBet + plCap);
  if (hi + EPS < lo) return null;
  return cents(lo + rnd() * Math.max(0, hi - lo));
}

export function fuzzOneHand(seed: number): FuzzHandResult {
  const rnd = mulberry32(seed);
  const cfg = randomTable(rnd);
  const hc = new HandController(cfg.config, cfg.seats, cfg.dealerSeat);

  const seatStart = new Map<number, number>();
  let startingChips = 0;
  for (const p of cfg.seats) {
    seatStart.set(p.seat, p.stack);
    startingChips += p.stack;
  }
  startingChips = cents(startingChips);

  const ctx: Ctx = {
    hc,
    startingChips,
    seatStart,
    log: [],
    cfg,
    seed,
    checks: 0,
    maxSidePots: 0,
  };

  let rake = 0;
  let bbjFee = 0;
  let complete = false;
  let runoutPending = false;
  let reachedShowdown = false;
  let pineappleSeats: number[] = [];

  hc.onEvent((e: any) => {
    switch (e.type) {
      case 'HAND_COMPLETE':
        rake = e.rake ?? 0;
        bbjFee = e.bbjFee ?? 0;
        complete = true;
        ctx.log.push(`HAND_COMPLETE rake=${rake} bbj=${bbjFee}`);
        break;
      case 'ALL_IN_RUNOUT':
        runoutPending = true;
        ctx.log.push('ALL_IN_RUNOUT (parked)');
        break;
      case 'SHOWDOWN':
        reachedShowdown = true;
        break;
      case 'PINEAPPLE_DISCARD_REQUIRED':
        pineappleSeats = [...(e.seats ?? [])];
        break;
      case 'COMMUNITY_CARDS':
        ctx.log.push(`-- ${e.stage}: ${cardsToString(e.cards ?? [])}`);
        break;
      case 'UNCALLED_BET_RETURNED':
        ctx.log.push(`uncalled bet ${e.amount} returned to seat ${e.seat}`);
        break;
      case 'WINNERS':
        ctx.log.push(
          `WINNERS ${JSON.stringify((e.winners ?? []).map((w: any) => [w.userId, w.amount]))}`
        );
        break;
    }
  });

  hc.start();
  checkMidHand(ctx, 'after start()');

  // REVIEW FIX 2026-08-20: this used to be captured ONCE for the whole hand.
  // checkMidHand and replayOf re-read it on every call, so if HandController
  // ever reassigned `this.state` (a reset or restore path) the driver would
  // read a dead snapshot while the assertions read the live one — a false
  // negative, and the only reflection site here that would fail QUIETLY.
  const readState = () => (hc as any).state;
  let actions = 0;
  // Bound: 9 seats x 4 streets x a generous raise war. A hand that cannot
  // finish inside this is itself a defect (the live 10-minute void).
  // Observed maximum across ~250,000 hands: 41.
  const MAX_STEPS = 800;
  let steps = 0;

  while (!complete && steps++ < MAX_STEPS) {
    const st = readState();
    if (pineappleSeats.length > 0) {
      const seats = pineappleSeats;
      pineappleSeats = [];
      for (const seat of seats) {
        hc.performDiscard(seat, Math.floor(rnd() * 3));
        checkMidHand(ctx, `after discard seat ${seat}`);
      }
      /* PHASE 3 2026-08-31: the last discard buys a HAND_COMPLETION
         .DISCARD_SETTLE_MS beat so the card leaving the hand finishes its
         flight before a betting round opens over it. This driver has no
         clock - it walks an entire hand inside one synchronous loop - so it
         collapses the beat instead of waiting it out. Without this the very
         next iteration finds a stage with nobody to act and reports LIVENESS,
         which would be the fuzzer correctly describing a hand that, in wall
         clock, is 600ms from continuing. */
      if (hc.flushPineappleSettle()) checkMidHand(ctx, 'after discard settle beat');
      continue;
    }

    if (runoutPending) {
      runoutPending = false;
      // Production all-in Pineapple runouts obtain these choices from the
      // live horse-decision worker before HandController is allowed to cross
      // the flop. This synchronous property harness deliberately has no
      // worker/runtime, so install a complete seeded result set through the
      // same public hand/fence boundary. Choosing an arbitrary legal discard
      // is enough here: the property under test is chip conservation, while
      // worker strategy and ownership are covered by their focused suites.
      const pineappleSnapshot = hc.getPineappleRunoutDiscardSnapshot();
      if (pineappleSnapshot) {
        const decisions = new Map(
          pineappleSnapshot.players.map((player) => [player.seat, Math.floor(rnd() * 3)])
        );
        if (!hc.preparePineappleRunoutDiscards(pineappleSnapshot.flop, decisions)) {
          fail(ctx, 'LIVENESS', 'worker-equivalent Pineapple discard preparation was rejected');
        }
      }
      ctx.log.push('continueRunout()');
      hc.continueRunout();
      // completeHand() runs inside; conservation is checked below on exit.
      continue;
    }

    const seat = st.currentPlayerSeat;
    if (seat === -1 || seat === undefined) {
      fail(ctx, 'LIVENESS', `no player to act and hand is not complete (stage=${st.stage})`);
    }
    const player: SeatPlayer | undefined = st.players.find((p: SeatPlayer) => p.seat === seat);
    if (!player) fail(ctx, 'LIVENESS', `currentPlayerSeat ${seat} is not a seated player`);

    const available: ActionType[] = (hc as any).getAvailableActions(player);
    // Weighted so hands actually reach showdown instead of folding out
    // immediately, while still exercising aggression and all-ins heavily.
    const weights: Record<string, number> = {
      fold: 12,
      check: 30,
      call: 30,
      bet: 18,
      raise: 14,
      all_in: 8,
    };
    const pool: ActionType[] = [];
    for (const a of available) {
      for (let i = 0; i < (weights[a] ?? 1); i++) pool.push(a);
    }

    let performed = false;
    const tried: string[] = [];
    const order: ActionType[] = [];
    const primary = pool.length > 0 ? pool[Math.floor(rnd() * pool.length)] : undefined;
    if (primary) order.push(primary);
    // REVIEW FIX 2026-08-20: all_in comes BEFORE check/call in the fallback.
    //
    // amountFor() returns null exactly when the stack (or the pot-limit cap) is
    // below one min-raise — the shove-or-fold spot. Measured over 3,000 hands,
    // that was 25% of raise picks and 20% of bet picks, and every one of them
    // fell through to a passive call or check. The fuzzer was systematically
    // converting the most interesting short-stack spots into the least
    // interesting action.
    for (const a of ['all_in', 'check', 'call', 'fold'] as ActionType[]) {
      if (available.includes(a) && !order.includes(a)) order.push(a);
    }

    for (const action of order) {
      let amount = 0;
      if (action === 'bet' || action === 'raise') {
        const a = amountFor(hc, player, action, rnd);
        if (a === null) {
          // Not a defect: no legal size exists (stack below one min-raise).
          tried.push(`${action}(no legal size)`);
          continue;
        }
        amount = a;
      }
      const before = st.stage;
      if (hc.performAction(seat, action, amount)) {
        actions++;
        ctx.log.push(`[${before}] seat ${seat} ${action}${amount ? ' ' + amount : ''}`);
        performed = true;
        break;
      }
      tried.push(`${action}${amount ? '(' + amount + ')' : ''}`);

      // ── INV-LEGALITY ──────────────────────────────────────────────────────
      // REVIEW FIX 2026-08-20: this used to fall through silently to the next
      // candidate, and that silence hid a live, player-facing bug for as long
      // as this fuzzer had been running.
      //
      // `action` came from the engine's own getAvailableActions(). If it needed
      // a size, that size came from amountFor(), which mirrors validateAction's
      // published bounds exactly. So a `false` here is the engine contradicting
      // itself — it offered the action and then refused it — and that is never
      // acceptable, because it is precisely what a real player sees when they
      // press a button the UI has enabled.
      //
      // What it was hiding: `raiseAmount = amount - currentBet` is IEEE 754
      // subtraction of two exact-cent values, so an exactly-minimum raise
      // computed 0.04999999999999999 against a 0.05 minimum and was rejected.
      // 538 of 1,200 cent-granular raise levels — 44.8% of min-raise presses.
      // Fixed in PokerEngine.validateAction (CENT_EPS).
      fail(
        ctx,
        'INV-LEGALITY',
        `the engine OFFERED ${action}${amount ? ` (${amount})` : ''} to seat ${seat} and then ` +
          `REFUSED it. available=${JSON.stringify(available)} stage=${st.stage} ` +
          `currentBet=${st.currentBet} lastRaise=${st.lastRaise} minRaise=${st.minRaise} ` +
          `playerBet=${player!.bet} stack=${player!.stack}. A player pressing that button ` +
          `gets the same rejection.`
      );
    }

    if (!performed) {
      fail(
        ctx,
        'LIVENESS',
        `seat ${seat} could perform NO action. available=${JSON.stringify(available)} ` +
          `tried=${JSON.stringify(tried)} stage=${st.stage} currentBet=${st.currentBet} ` +
          `playerBet=${player!.bet} stack=${player!.stack}`
      );
    }

    if (!complete) checkMidHand(ctx, `after seat ${seat} action #${actions}`);
  }

  const st = readState();
  if (!complete) {
    fail(ctx, 'LIVENESS', `hand did not complete within ${MAX_STEPS} steps (stage=${st.stage})`);
  }

  // ── INV-4: the settlement ledger ───────────────────────────────────────────
  const finalChips = cents(st.players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0));
  if (rake < -EPS) fail(ctx, 'INV-4', `negative rake ${rake}`);
  if (bbjFee < -EPS) fail(ctx, 'INV-4', `negative bbjFee ${bbjFee}`);

  const settled = cents(finalChips + rake + bbjFee);
  if (Math.abs(settled - startingChips) > EPS) {
    fail(
      ctx,
      'INV-4',
      `chips ${settled > startingChips ? 'CREATED' : 'DESTROYED'} at settlement: ` +
        `sum(stacks)=${finalChips} + rake=${rake} + bbj=${bbjFee} = ${settled}, ` +
        `expected ${startingChips} (delta ${cents(settled - startingChips)})`
    );
  }

  for (const p of st.players as SeatPlayer[]) {
    if (p.stack < -EPS) fail(ctx, 'INV-5', `negative final stack seat ${p.seat} = ${p.stack}`);
    if (Math.abs(p.stack * 100 - Math.round(p.stack * 100)) > 1e-6) {
      fail(ctx, 'INV-5', `sub-cent final stack seat ${p.seat} = ${p.stack}`);
    }
  }

  // ── INV-7: nobody is paid out of a pot they were not eligible for ─────────
  // Settlement pots are the ones completeHand computed AFTER returnUncalledBet.
  // A player's winnings can never exceed the sum of the pots they are eligible
  // for; 1c of slack covers clockwise odd-chip allocation on a chopped pot.
  const settlementPots = (st.pots ?? []) as { amount: number; eligiblePlayers: string[] }[];
  for (const p of st.players as SeatPlayer[]) {
    const start = ctx.seatStart.get(p.seat) ?? 0;
    const winnings = cents(p.stack - (start - (p.totalInvested ?? 0)));
    if (winnings <= EPS) continue;
    const cap = cents(
      settlementPots
        .filter((pot) => pot.eligiblePlayers.includes(p.user_id))
        .reduce((sn, pot) => sn + pot.amount, 0)
    );
    // REVIEW FIX 2026-08-20: this had 1c of slack "for odd-chip allocation".
    // distributePot splits WITHIN a pot and its shares sum to that pot exactly,
    // so a player can never exceed the sum of the pots they are eligible for —
    // not even by a cent. The slack only blinded this to a 1-cent overpayment,
    // which is the same class as the two 1-cent leaks this engine has shipped.
    if (winnings > cap + EPS) {
      fail(
        ctx,
        'INV-7',
        `seat ${p.seat} (${p.user_id}) was paid ${winnings} but is eligible for only ${cap} ` +
          `across ${settlementPots.length} pot(s): ` +
          JSON.stringify(settlementPots.map((x) => [x.amount, x.eligiblePlayers])) +
          `\n  rake=${rake} bbjFee=${bbjFee} statePot=${st.pot} sawFlop=${st.sawFlop}` +
          `\n  winners=${JSON.stringify(
            ((st as unknown as { winners?: unknown[] }).winners ?? []).map((w) => {
              const ww = w as { userId?: string; amount?: number; potIndex?: number };
              return [ww.userId, ww.amount, ww.potIndex];
            })
          )}` +
          `\n  seats=${JSON.stringify(
            (st.players as SeatPlayer[]).map((q) => [
              q.seat,
              q.user_id,
              ctx.seatStart.get(q.seat) ?? 0,
              q.totalInvested ?? 0,
              q.stack,
              q.is_folded ? 'folded' : 'live',
            ])
          )}`
      );
    }
  }

  // ── INV-9: the rake gate must agree with the board ────────────────────────
  // "No flop, no drop" is enforced off state.sawFlop, not off the board. When
  // the two disagreed (all-in runouts dealt a board with sawFlop still false)
  // every preflop all-in hand raked zero — the 2026-08-18 live rake leak.
  const board: unknown[] = st.communityCards ?? [];
  if (st.sawFlop !== board.length >= 3) {
    fail(
      ctx,
      'INV-9',
      `sawFlop=${st.sawFlop} but the board has ${board.length} card(s) - ` +
        `the rake / BBJ gate and the dealt board disagree`
    );
  }
  if (!st.sawFlop && cfg.config.rakeConfig.noFlopNoDrop && (rake > EPS || bbjFee > EPS)) {
    fail(ctx, 'INV-9', `no flop was dealt but rake=${rake} bbj=${bbjFee} was taken`);
  }
  if (rake + bbjFee > cents(st.pot) + EPS) {
    fail(ctx, 'INV-9', `rake ${rake} + bbj ${bbjFee} exceeds the pot ${st.pot}`);
  }

  return {
    seed,
    variant: cfg.config.gameVariant,
    players: cfg.seats.length,
    startingChips,
    finalChips,
    rake,
    bbjFee,
    actions,
    checks: ctx.checks,
    reachedShowdown,
    allInRunout: ctx.log.some((l) => l.startsWith('ALL_IN_RUNOUT')),
    sidePots: ctx.maxSidePots,
    replay: '', // populated only on failure, via ChipConservationError
  };
}
