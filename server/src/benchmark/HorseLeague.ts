/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE LEAGUE — Nightly Duplicate-Deal Self-Play (V12 — 2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Dan: "constantly improving and optimizing their play." Improvements must be
 * MEASURED, not argued. The engine's layers were historically tuned with
 * ad-hoc duplicate-deal ablations run by hand; this module makes that a
 * permanent instrument:
 *
 *  - DUPLICATE DEALS: config A and config B play the exact same cards twice,
 *    with the seat assignments swapped between passes, so card luck cancels
 *    and the remaining chip difference is pure strategy.
 *  - LIGHTWEIGHT TABLE: a self-contained NLH hand loop (blinds, streets,
 *    betting, side pots, showdown) driving HorseLogic.decide directly — no
 *    timers, no DB, no sockets. Thousands of hands per second of CPU.
 *  - NIGHTLY RUN: a bounded league fires at 04:30 UTC on the engine host and
 *    writes bb/100 per matchup to horse_league_results. A regression in any
 *    strategy layer shows up as a sign flip within days, with a standard
 *    error attached so noise cannot be mistaken for signal.
 *
 * The simulator trusts HorseLogic's own legalization (every decision is
 * validated against the same rules the real engine enforces) and uses
 * synthetic `league-*` user ids so HorseMind's live opponent memory is never
 * polluted with reads about real players.
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

import type { Card, SeatPlayer, HandStage, ActionRecord } from '../types.js';
import { HorseLogic, type HorseDecideOpts, type HorseGameStateV2 } from '../engine/HorseLogic.js';
import { HorseMind, type HorseMindSandbox } from '../engine/HorseMind.js';
import {
  seedFastRandom,
  saveFastRandom,
  restoreFastRandom,
  fastRandom,
  scoreHoldem,
  scoreOmahaHi,
  variantInfo,
} from '../engine/HorseEval.js';
import { SUITS, RANKS, validateAction, calculateBettingState } from '../engine/PokerEngine.js';
import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LeagueResult {
  matchup: string;
  hands: number;
  /** chips won by config A per 100 hands, in big blinds (duplicate-adjusted) */
  bb100: number;
  /** standard error of bb100 across per-pair samples */
  stderr: number;
  durationMs: number;
  illegalActions: number;
  /** streets cut short by the action cap (must be 0; see runStreet) */
  truncatedStreets: number;
}

export interface LeagueMatchup {
  name: string;
  /** game variant the matchup deals (default 'nlh'). V15: the plo6 matchup
   *  exists because the Omaha discipline layer cannot be measured by an NLH
   *  deal at all. */
  variant?: string;
  a: HorseDecideOpts;
  b: HorseDecideOpts;
  /** V12.3: RETIRED as an opt-in — EVERY matchup is now sandboxed. It was
   *  never safe to run a league hand against live HorseMind state: `mind:false`
   *  suppresses stats and pair writes but NOT barrel plans, so the four
   *  unsandboxed matchups were writing thousands of synthetic plan keys into
   *  the live map and tripping its 8000-key wipe — clearing the barrel plan of
   *  every hand in progress on every live table. Kept only so an existing
   *  config object still type-checks. */
  mind?: 'sandbox';
}

const SEATS = 6;
const BB = 2;
const SB = 1;
const START_STACK = 200; // 100bb
// V12.3: raised from 24. A six-way preflop raise war can legitimately exceed
// 24 actions, and hitting the cap now folds the debtors (see runStreet)
// rather than silently forgiving their unpaid bets.
const MAX_ACTIONS_PER_STREET = 48;

/** V12.3: process-wide monotonic base for synthetic action timestamps. Two
 *  hands must never share a HorseMind hand key (see playHand). */
let handTsCounter = 1;
const TS_STRIDE = 4096; // room for every action in a hand
function nextHandTsBase(): number {
  handTsCounter += TS_STRIDE;
  return handTsCounter;
}

const FULL_DECK: Card[] = [];
for (const suit of SUITS) for (const rank of RANKS) FULL_DECK.push({ rank, suit });

// ─────────────────────────────────────────────────────────────────────────────
// One hand
// ─────────────────────────────────────────────────────────────────────────────

interface Seat {
  player: SeatPlayer;
  contributed: number;
  opts: HorseDecideOpts;
}

/**
 * Play one full NLH hand. `configOf(seatIdx)` maps a seat to its engine
 * config. Returns net chips per seat (sum is always 0) — verified by the
 * conservation test.
 */
export function playHand(
  handSeed: number,
  dealerSeat: number,
  configOf: (seatIdx: number) => HorseDecideOpts,
  counters?: { illegal: number; truncated: number },
  /** V12.2: when present, decisions run against this sandboxed HorseMind and
   *  the per-seat `mind` flag is honored (default on) instead of forced off. */
  sandbox?: HorseMindSandbox,
  /** V15: game variant to deal (default 'nlh'). Omaha variants deal the full
   *  hole count, enforce pot-limit sizing in validation, and score showdowns
   *  with the Omaha evaluator. */
  gameVariant: string = 'nlh'
): number[] {
  const vi = variantInfo(gameVariant);
  const holeCount = vi.holeCount;
  seedFastRandom(handSeed);
  // Deterministic deck for this seed (Fisher-Yates on fastRandom).
  const deck = [...FULL_DECK];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(fastRandom() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }

  const tally = counters ?? { illegal: 0, truncated: 0 };

  const seats: Seat[] = [];
  for (let s = 0; s < SEATS; s++) {
    seats.push({
      contributed: 0,
      // Without a sandbox, league hands are memory-free (mind:false) — they
      // must never write synthetic reads into the live opponent memory. With
      // one, the mind runs for real against the sandbox's isolated state.
      opts: sandbox ? { ...configOf(s) } : { ...configOf(s), mind: false },
      player: {
        seat: s + 1,
        user_id: `league-${s + 1}`,
        username: `League${s + 1}`,
        stack: START_STACK,
        bet: 0,
        totalInvested: 0,
        cards: deck.slice(s * holeCount, s * holeCount + holeCount),
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        is_horse: true,
      } as SeatPlayer,
    });
  }
  const board = deck.slice(SEATS * holeCount, SEATS * holeCount + 5);

  const idx = (seatNo: number) => (seatNo - 1 + SEATS) % SEATS;
  const sbIdx = idx(dealerSeat + 1);
  const bbIdx = idx(dealerSeat + 2);

  const post = (i: number, amt: number) => {
    const p = seats[i].player;
    const real = Math.min(amt, p.stack);
    p.stack -= real;
    p.bet += real;
    seats[i].contributed += real;
    if (p.stack === 0) p.is_all_in = true;
    return real;
  };
  let pot = post(sbIdx, SB) + post(bbIdx, BB);
  let currentBet = BB;
  let minRaise = BB;
  let lastRaise = BB;
  const history: ActionRecord[] = [];
  // V12.3: a per-call monotonic timestamp base. `handSeed >>> 1` collided
  // across the two passes of a duplicate pair (same seed, same base), which
  // made HorseMind.handKeyOf identical in both passes — config B then read
  // config A's barrel plan, destroying the independence the duplicate design
  // exists to provide. A process-wide counter cannot collide.
  let ts = nextHandTsBase();

  const live = () => seats.filter((s) => !s.player.is_folded);
  const canAct = () => seats.filter((s) => !s.player.is_folded && !s.player.is_all_in);

  const runStreet = (stage: HandStage, firstIdx: number): boolean => {
    // returns true when the hand ended by folds
    let toActQueue: number[] = [];
    for (let k = 0; k < SEATS; k++) {
      const i = (firstIdx + k) % SEATS;
      const p = seats[i].player;
      if (!p.is_folded && !p.is_all_in) toActQueue.push(i);
    }
    let actions = 0;
    let lastAggressor = -1;
    // V12.3: who has already acted on this street. A short all-in reopens
    // nothing for them (TDA 44); a full raise reopens for everyone.
    const acted = new Set<number>();
    const rebuildQueue = (raiserIdx: number, reopens: boolean, actedSet: Set<number>): number[] => {
      const q: number[] = [];
      for (let k = 1; k < SEATS; k++) {
        const j = (raiserIdx + k) % SEATS;
        const other = seats[j].player;
        if (other.is_folded || other.is_all_in) continue;
        if (!reopens && actedSet.has(j)) continue; // owes the difference only
        q.push(j);
      }
      return q;
    };
    while (toActQueue.length > 0 && actions < MAX_ACTIONS_PER_STREET) {
      const i = toActQueue.shift()!;
      const seat = seats[i];
      const p = seat.player;
      if (p.is_folded || p.is_all_in) continue;
      if (live().length < 2) break;

      const boardCards =
        stage === 'preflop'
          ? []
          : stage === 'flop'
            ? board.slice(0, 3)
            : stage === 'turn'
              ? board.slice(0, 4)
              : board.slice(0, 5);
      const gs: HorseGameStateV2 = {
        players: seats.map((s) => s.player),
        communityCards: boardCards,
        pot,
        currentBet,
        minRaise,
        lastRaise,
        stage,
        gameVariant,
        bigBlind: BB,
        dealerSeat,
        actionHistory: history,
        gameMode: 'cash',
        ante: 0,
        format: 'cash',
      } as HorseGameStateV2;

      const d = sandbox
        ? HorseMind.runInSandbox(sandbox, () => HorseLogic.decide(p, gs, 'balanced', {}, seat.opts))
        : HorseLogic.decide(p, gs, 'balanced', {}, seat.opts);
      const toCall = Math.max(0, currentBet - p.bet);

      // Validate against the engine's own rules; downgrade an illegal action
      // to the safe fallback and count it (the conservation test asserts 0).
      let action = d.action as string;
      let amount = d.amount ?? 0;
      if (action === 'check' && toCall > 0) action = 'fold';
      if (action === 'call' && toCall === 0) action = 'check';
      if (action === 'bet' && currentBet > 0) action = 'raise';
      if (action === 'raise' && currentBet === 0) action = 'bet';
      // V12.3: validation is UNCONDITIONAL. It used to be gated on `counters`
      // being passed, so the chip-conservation tests — which pass none — ran a
      // different code path from production and could never catch an illegal
      // sizing. `tally` keeps the counting optional without changing the path.
      if (action === 'bet' || action === 'raise') {
        const bs = calculateBettingState(pot, currentBet, p.bet, BB, lastRaise, vi.isPotLimit);
        if (!validateAction(action as never, amount, p.stack, bs).valid) {
          tally.illegal++;
          action = toCall > 0 ? 'fold' : 'check';
        }
      }

      ts++;
      acted.add(i);
      if (action === 'fold') {
        p.is_folded = true;
        history.push({
          seat: p.seat,
          userId: p.user_id,
          action: 'fold',
          amount: 0,
          timestamp: ts,
          stage,
        } as ActionRecord);
      } else if (action === 'check') {
        history.push({
          seat: p.seat,
          userId: p.user_id,
          action: 'check',
          amount: 0,
          timestamp: ts,
          stage,
        } as ActionRecord);
      } else if (action === 'call') {
        const inc = post(i, toCall);
        pot += inc;
        history.push({
          seat: p.seat,
          userId: p.user_id,
          action: 'call',
          amount: inc,
          timestamp: ts,
          stage,
        } as ActionRecord);
      } else if (action === 'all_in') {
        const target = p.bet + p.stack;
        const inc = post(i, p.stack);
        pot += inc;
        const isFullRaise = target >= currentBet + lastRaise - 1e-9 && target > currentBet;
        if (target > currentBet) {
          if (isFullRaise) {
            lastRaise = target - currentBet;
            minRaise = lastRaise;
          }
          currentBet = target;
          lastAggressor = i;
          // V12.3 (TDA Rule 44, as HandController.canReopenBetting enforces):
          // a SHORT all-in does not reopen the betting. Players who already
          // acted owe the difference and may call or fold, but may not
          // re-raise. Rebuilding the full queue on any all-in let the
          // simulator model a more permissive game than the engine it tunes,
          // biasing every matchup toward whichever config raises more.
          toActQueue = rebuildQueue(i, isFullRaise, acted);
        }
        history.push({
          seat: p.seat,
          userId: p.user_id,
          action: 'all_in',
          amount: target,
          timestamp: ts,
          stage,
          isFullRaise,
        } as ActionRecord);
      } else {
        // bet / raise to `amount`
        const target = Math.min(amount, p.bet + p.stack);
        // V12.3: floor at 0. `target - p.bet` could go negative on a
        // raise-to below the actor's own street bet, and post() would then
        // ADD chips to the stack and drive `contributed` negative — silent
        // chip creation that chip conservation cannot see.
        const inc = post(i, Math.max(0, target - p.bet));
        pot += inc;
        // V12.3: the real reopening test, not a hard-coded true.
        const reopens = target >= currentBet + lastRaise - 1e-9 && target > currentBet;
        if (target > currentBet) {
          if (reopens) {
            lastRaise = target - currentBet;
            minRaise = lastRaise;
          }
          currentBet = target;
          lastAggressor = i;
          toActQueue = rebuildQueue(i, reopens, acted);
        }
        history.push({
          seat: p.seat,
          userId: p.user_id,
          action: p.is_all_in ? 'all_in' : action,
          amount: target,
          timestamp: ts,
          stage,
          ...(p.is_all_in ? { isFullRaise: reopens } : {}),
        } as ActionRecord);
      }
      actions++;
      void lastAggressor;
      if (live().length < 2) return true;
    }
    // V12.3: if we left the loop with players still owing chips, the street
    // was TRUNCATED by MAX_ACTIONS_PER_STREET. Resetting bets here would
    // treat their unpaid debt as matched and let them reach a showdown they
    // never paid for — chip conservation still holds (settlement uses
    // `contributed`), so no test could see it. Fold the debtors and count it.
    if (toActQueue.length > 0) {
      let truncated = false;
      for (const j of toActQueue) {
        const q = seats[j].player;
        if (q.is_folded || q.is_all_in) continue;
        if (currentBet - q.bet > 1e-9) {
          q.is_folded = true;
          truncated = true;
        }
      }
      if (truncated) tally.truncated++;
    }
    // Street over: reset per-street bets.
    for (const s of seats) {
      s.player.bet = 0;
    }
    currentBet = 0;
    minRaise = BB;
    lastRaise = BB;
    return live().length < 2;
  };

  // First live seat left of the dealer — evaluated per street, AFTER folds.
  const firstPostflop = (): number => {
    for (let k = 1; k <= SEATS; k++) {
      const i = idx(dealerSeat + k);
      if (!seats[i].player.is_folded) return i;
    }
    return sbIdx;
  };

  let endedByFolds = runStreet('preflop', idx(dealerSeat + 3));
  if (!endedByFolds && canAct().length >= 2) endedByFolds = runStreet('flop', firstPostflop());
  if (!endedByFolds && canAct().length >= 2) endedByFolds = runStreet('turn', firstPostflop());
  if (!endedByFolds && canAct().length >= 2) endedByFolds = runStreet('river', firstPostflop());

  // ── Settlement with proper side pots ──
  const contenders = seats
    .map((s, i) => ({ i, folded: s.player.is_folded, contributed: s.contributed }))
    .filter((c) => c.contributed > 0 || !c.folded);
  const winnings = new Array(SEATS).fill(0);

  if (live().length === 1) {
    winnings[seats.indexOf(live()[0])] = pot;
  } else {
    const scores = seats.map((s) =>
      s.player.is_folded
        ? -1
        : vi.isOmaha
          ? scoreOmahaHi(s.player.cards, board)
          : scoreHoldem(s.player.cards.concat(board), s.player.cards.length + 5, vi.isShortDeck)
    );
    // Layered side pots by contribution level.
    const levels = [...new Set(contenders.map((c) => c.contributed))].sort((a, b) => a - b);
    let prev = 0;
    for (const lvl of levels) {
      const layer = lvl - prev;
      if (layer <= 0) continue;
      let layerPot = 0;
      const eligible: number[] = [];
      for (let i = 0; i < SEATS; i++) {
        const contrib = Math.min(seats[i].contributed, lvl) - Math.min(seats[i].contributed, prev);
        layerPot += contrib;
        if (!seats[i].player.is_folded && seats[i].contributed >= lvl) eligible.push(i);
      }
      if (eligible.length > 0) {
        let best = -1;
        for (const i of eligible) if (scores[i] > best) best = scores[i];
        const winners = eligible.filter((i) => scores[i] === best);
        for (const w of winners) winnings[w] += layerPot / winners.length;
      } else {
        // Cannot happen in a legal sequence (a live player always matches the
        // top contribution), but chips must NEVER evaporate: hand the layer
        // to the best live hand overall.
        let bestI = -1;
        for (let i = 0; i < SEATS; i++) {
          if (!seats[i].player.is_folded && (bestI === -1 || scores[i] > scores[bestI])) bestI = i;
        }
        if (bestI >= 0) winnings[bestI] += layerPot;
      }
      prev = lvl;
    }
  }

  return seats.map((s, i) => winnings[i] - s.contributed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate-deal matchup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run `pairs` duplicate deals of config A vs config B. Each pair plays the
 * same seed twice with the seat->config assignment inverted, so identical
 * cards flow to both configs and luck cancels in the difference.
 */
export async function runMatchup(
  matchup: LeagueMatchup,
  pairs: number,
  runSeed: number
): Promise<LeagueResult> {
  const t0 = Date.now();
  const counters = { illegal: 0, truncated: 0 };
  const perPairDiff: number[] = [];
  // V12.3: the league runs INSIDE the live engine process. `rngState` in
  // HorseEval is a module global shared with every live decision, and
  // playHand reseeds it once per synthetic hand. Bracket the whole matchup so
  // the live stream resumes exactly where it was.
  const rngBefore = saveFastRandom();
  // V12.2: one sandbox PER PASS, alive for the whole matchup. Pass 1 always
  // plays sandbox 1 and pass 2 always plays sandbox 2, so each accumulates a
  // coherent memory of its own seat assignment; identical configs therefore
  // produce identical evolutions in both sandboxes and the mirror invariant
  // survives mind-on play.
  const sb1 = HorseMind.createSandbox();
  const sb2 = HorseMind.createSandbox();

  for (let p = 0; p < pairs; p++) {
    // V12.3: YIELD THE EVENT LOOP. This loop used to run all 1500 pairs (3000
    // hands, measured at 7-10 seconds) without a single yield, inside the
    // process serving live poker. DeadlineScheduler ticks every 100ms and its
    // deadlines are absolute wall-clock, so a multi-second freeze means every
    // action clock, timebank grant and disconnect grace across the fleet is
    // already past due when the loop resumes — a fleet-wide auto-fold storm.
    // 16 hands is well under one scheduler tick budget.
    if (p > 0 && (p & 0x0f) === 0) await new Promise((res) => setImmediate(res));
    const handSeed = (runSeed ^ (p * 2654435761)) >>> 0 || 1;
    const dealerSeat = (p % SEATS) + 1;
    const evenIsA = (s: number) => (s % 2 === 0 ? matchup.a : matchup.b);
    const evenIsB = (s: number) => (s % 2 === 0 ? matchup.b : matchup.a);

    const net1 = playHand(handSeed, dealerSeat, evenIsA, counters, sb1, matchup.variant ?? 'nlh');
    const net2 = playHand(handSeed, dealerSeat, evenIsB, counters, sb2, matchup.variant ?? 'nlh');

    let aNet = 0;
    for (let s = 0; s < SEATS; s++) {
      aNet += s % 2 === 0 ? net1[s] : -net1[s]; // pass 1: even seats are A
      aNet += s % 2 === 0 ? -net2[s] : net2[s]; // pass 2: odd seats are A
    }
    // aNet counts A-minus-B chips over 2 hands x (SEATS/2) A-seats;
    // normalize to "A's edge in bb per hand pair".
    perPairDiff.push(aNet / 2 / BB);
  }

  restoreFastRandom(rngBefore);

  const n = perPairDiff.length;
  const mean = perPairDiff.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const varsum = perPairDiff.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  const sd = Math.sqrt(varsum / Math.max(1, n - 1));
  // V12.3: `perPairDiff[p]` is A's edge in bb summed over SEATS/2 A-seats x 2
  // passes = 6 player-hands. Dividing by that is what makes the number an
  // actual bb/100; without it every figure ever written to
  // horse_league_results was inflated 6x. Ratios and signs are unchanged, so
  // historical comparisons still hold — only the scale was wrong.
  const A_HANDS_PER_PAIR = (SEATS / 2) * 2;
  return {
    matchup: matchup.name,
    hands: n * 2,
    bb100: (mean / A_HANDS_PER_PAIR) * 100,
    stderr: (sd / Math.sqrt(Math.max(1, n)) / A_HANDS_PER_PAIR) * 100,
    durationMs: Date.now() - t0,
    illegalActions: counters.illegal,
    truncatedStreets: counters.truncated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Nightly league
// ─────────────────────────────────────────────────────────────────────────────

/** The standing card: every strategy layer vs the engine without it. */
// V12.2: the two `mind: 'sandbox'` matchups run with the full HorseMind live
// against isolated state (see runInSandbox) — the gap that used to force v12
// to be validated only by seeded equity-shift tests in HorseEval is closed.
export const LEAGUE_MATCHUPS: LeagueMatchup[] = [
  { name: 'v11_leak_fixes', a: {}, b: { v11: false } },
  { name: 'v10_strategy', a: {}, b: { v10: false } },
  { name: 'v7_preflop', a: {}, b: { v7Preflop: false } },
  // Full V12 (board-conditioned ranges + river polish) vs the engine without
  // it, both sides with the mind on — the matchup the 2026-08-22 handoff
  // deferred for lack of a pollution-free mind mode.
  { name: 'v12_ranges_river', a: {}, b: { v12: false } },
  // V15 Omaha nut discipline, measured where it lives: a plo6 deal. The
  // other matchups deal NLH, where v15 changes nothing by construction.
  { name: 'plo6_v15_discipline', variant: 'plo6', a: {}, b: { v15: false } },
  // The whole opponent-intelligence layer vs playing blind. B-seats skip
  // both reads and writes; A-seats read a memory that includes B's actions.
  { name: 'mind_layer', a: {}, b: { mind: false } },
  {
    name: 'full_vs_v2_legacy',
    a: {},
    b: {
      v7: false,
      v8: false,
      v9: false,
      v10: false,
      v11: false,
      // V12.3: v12 was missing, so "vs v2 legacy" kept board-conditioned
      // sampling and the river polish and measured the wrong thing.
      // LeagueAblationCompleteness.test.ts now fails if a future layer
      // drifts out of this list the same way.
      v12: false,
      v15: false,
      mind: false,
      streetIQ: false,
      handReading: false,
    },
  },
];

// V12.3: the old comment here claimed hour 4 was "the quietest hour on the
// engine host". Measured over 24h of hand_history it is the SECOND BUSIEST
// (5354 hands vs 6239 at hour 3) — the fleet plays around the clock and there
// is no quiet hour. The league is safe here only because runMatchup now
// yields the event loop every 16 hands; do not remove that yield.
const LEAGUE_HOUR_UTC = 4;
// V13: was 30 minutes against a ONE-HOUR window, so any engine restart in the
// back half of the window pushed the next tick past it and the league silently
// did not run that day at all. This repo deploys many times a day; on
// 2026-08-23 a 04:32 restart moved the next tick to ~05:02 and the first
// nightly run was skipped with nothing reporting it. Ten minutes, plus the
// catch-up window below, closes that hole.
const LEAGUE_CHECK_MS = 10 * 60 * 1000;
/** Hours after LEAGUE_HOUR_UTC during which a missed run is still picked up. */
const LEAGUE_CATCHUP_HOURS = 3;
/** Settle time before the boot check, so it never competes with table startup. */
const LEAGUE_BOOT_DELAY_MS = 90 * 1000;
// V12.3: raised 1500 -> 10000. At 1500 pairs the standard error was ~7 bb/100
// while real strategy-layer edges are single-digit bb/100 — the instrument
// could only ever detect catastrophic regressions, and its own header claimed
// it would catch a sign flip "within days". 10000 pairs puts the error near
// 2.8 bb/100. The cost is wall clock, not responsiveness: runMatchup yields
// every 16 hands, so this is ~70s of shared CPU per matchup rather than 70s
// of frozen tables.
const PAIRS_PER_MATCHUP = 10000;
/** Wall-clock ceiling for a whole run. See the note in runLeague. */
const MAX_RUN_MS = 90 * 60 * 1000;

let leagueTimer: NodeJS.Timeout | null = null;
let lastLeagueDate: string | null = null;
let leagueRunning = false;

/**
 * V13.1 — WHY THIS CHECKS AT BOOT, NOT ONLY ON A TIMER.
 *
 * A setInterval is reset by every process restart, so a job whose interval is
 * longer than the gap between deploys NEVER FIRES. On 2026-08-23 the engine
 * restarted roughly every ten to twenty minutes all night (an active repo, and
 * every merge touching server/** redeploys), and the league's check simply
 * never survived to its first tick: 90 minutes after its window opened the
 * container logs contained not one league line. Widening the window did not
 * help, because the clock kept going back to zero.
 *
 * So the check now runs shortly AFTER BOOT as well. That makes a restart the
 * thing that triggers the run rather than the thing that prevents it.
 *
 * The in-memory `lastLeagueDate` cannot guard that on its own — it is empty
 * again after every restart — so the guard asks the DATABASE whether today's
 * run already happened. `horse_league_results` is keyed (run_date, matchup),
 * which makes it the authoritative record of what has been done.
 */

/**
 * V13.1: claim a night's work for exactly one engine instance. Returns true
 * when THIS process won the claim. The INSERT is the lock — a duplicate-key
 * violation means another instance got there first.
 *
 * Fails CLOSED on an unexpected error: if we cannot tell whether someone else
 * owns tonight, not running is the safe answer, because the other instance
 * almost certainly is. (The date guard below fails OPEN, deliberately — there,
 * nobody is holding the work and both writers upsert.)
 */
export async function claimNightlyJob(job: string, date: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('horse_job_runs')
      .insert({ job, run_date: date, claimed_by: process.env.HOSTNAME ?? 'engine' });
    if (!error) return true;
    const code = (error as { code?: string }).code;
    if (code === '23505') return false; // unique_violation: another instance owns tonight
    throw new Error(error.message);
  } catch (err) {
    reportError(err, 'HorseLeague.claimNightlyJob');
    return false;
  }
}

async function alreadyRanToday(date: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('horse_league_results')
      .select('matchup')
      .eq('run_date', date)
      .limit(LEAGUE_MATCHUPS.length);
    if (error) throw new Error(error.message);
    // A partial run (fewer rows than matchups) SHOULD be resumed, so only a
    // complete card counts as done.
    return (data?.length ?? 0) >= LEAGUE_MATCHUPS.length;
  } catch (err) {
    // Never let a failed lookup silently skip the night; the upsert on
    // (run_date, matchup) makes a duplicate run harmless.
    reportError(err, 'HorseLeague.alreadyRanToday');
    return false;
  }
}

async function maybeRunLeague(): Promise<void> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hour = now.getUTCHours();
  const inWindow = hour >= LEAGUE_HOUR_UTC && hour < LEAGUE_HOUR_UTC + LEAGUE_CATCHUP_HOURS;
  if (!inWindow || leagueRunning || lastLeagueDate === today) return;
  if (await alreadyRanToday(today)) {
    lastLeagueDate = today; // remember for the rest of this process's life
    return;
  }
  // V13.1: leader/standby means TWO containers boot the full engine path and
  // both reach this line within seconds. Claim the night before working it.
  if (!(await claimNightlyJob('league', today))) {
    lastLeagueDate = today;
    console.log(`[HorseLeague] run ${today} claimed by another instance - standing down`);
    return;
  }
  lastLeagueDate = today;
  await runLeague(today);
}

export function startHorseLeague(): void {
  if (leagueTimer) return;
  leagueTimer = setInterval(() => void maybeRunLeague(), LEAGUE_CHECK_MS);
  leagueTimer.unref?.();
  // Boot check, after a short settle so it never competes with table startup.
  const boot = setTimeout(() => void maybeRunLeague(), LEAGUE_BOOT_DELAY_MS);
  boot.unref?.();
}

export function stopHorseLeague(): void {
  if (leagueTimer) {
    clearInterval(leagueTimer);
    leagueTimer = null;
  }
}

export async function runLeague(runDate?: string): Promise<LeagueResult[]> {
  if (leagueRunning) return [];
  leagueRunning = true;
  const date = runDate ?? new Date().toISOString().slice(0, 10);
  const results: LeagueResult[] = [];
  const startedAt = Date.now();
  // V13: SAY THAT IT STARTED. Rows are only written as each matchup finishes,
  // and a matchup yields the event loop every 16 hands on a host that is also
  // dealing live poker — so a run in progress and a run that never began were
  // indistinguishable from outside. That is exactly the state this whole audit
  // keeps finding: a job that looks identical whether or not it is working.
  console.log(
    `[HorseLeague] run ${date} starting: ${LEAGUE_MATCHUPS.length} matchups x ` +
      `${PAIRS_PER_MATCHUP} pairs (budget ${Math.round(MAX_RUN_MS / 60000)} min)`
  );
  try {
    const runSeed = (Date.parse(date) / 86_400_000) >>> 0;
    for (const m of LEAGUE_MATCHUPS) {
      // V13: a wall-clock budget. The league shares the event loop with live
      // tables by design, so its duration depends on how busy the fleet is,
      // not on its own CPU cost — an unbounded run could still be going when
      // the next night's window opens. Stop cleanly and keep what completed;
      // partial results are still valid measurements.
      if (Date.now() - startedAt > MAX_RUN_MS) {
        console.warn(
          `[HorseLeague] run ${date} hit its ${Math.round(MAX_RUN_MS / 60000)}-minute budget ` +
            `after ${results.length}/${LEAGUE_MATCHUPS.length} matchups - stopping cleanly`
        );
        break;
      }
      const r = await runMatchup(m, PAIRS_PER_MATCHUP, runSeed ^ hash32(m.name));
      results.push(r);
      try {
        const { error } = await supabase.from('horse_league_results').upsert(
          {
            run_date: date,
            matchup: r.matchup,
            hands: r.hands,
            bb100: round2(r.bb100),
            stderr: round2(r.stderr),
            config_a: m.a as never,
            config_b: m.b as never,
            duration_ms: r.durationMs,
            illegal_actions: r.illegalActions + r.truncatedStreets,
          },
          { onConflict: 'run_date,matchup' }
        );
        if (error) throw new Error(error.message);
      } catch (err) {
        reportError(err, 'HorseLeague.write');
      }
      console.log(
        `[HorseLeague] ${r.matchup}: ${round2(r.bb100)} bb/100 (se ${round2(r.stderr)}) ` +
          `${Math.abs(r.bb100) > 2 * r.stderr ? 'SIGNIFICANT' : 'not resolved'} over ` +
          `${r.hands} hands in ${r.durationMs}ms, illegal=${r.illegalActions}, ` +
          `truncated=${r.truncatedStreets}`
      );
      // Yield the event loop between matchups — production tables come first.
      await new Promise((res) => setTimeout(res, 250));
    }
    console.log(
      `[HorseLeague] run ${date} finished: ${results.length}/${LEAGUE_MATCHUPS.length} matchups ` +
        `in ${Math.round((Date.now() - startedAt) / 1000)}s`
    );
  } catch (err) {
    reportError(err, 'HorseLeague.run');
    lastLeagueDate = null;
  } finally {
    leagueRunning = false;
  }
  return results;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function hash32(s: string): number {
  let h = 17;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
