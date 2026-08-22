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
import { seedFastRandom, fastRandom, scoreHoldem } from '../engine/HorseEval.js';
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
}

export interface LeagueMatchup {
  name: string;
  a: HorseDecideOpts;
  b: HorseDecideOpts;
  /** V12.2: run this matchup's hands against sandboxed HorseMind state so the
   *  mind layer participates without touching live opponent memory. Each pass
   *  of the duplicate pair keeps its own sandbox for the whole matchup, so
   *  memory accumulates coherently and symmetrically and luck still cancels. */
  mind?: 'sandbox';
}

const SEATS = 6;
const BB = 2;
const SB = 1;
const START_STACK = 200; // 100bb
const MAX_ACTIONS_PER_STREET = 24;

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
  counters?: { illegal: number },
  /** V12.2: when present, decisions run against this sandboxed HorseMind and
   *  the per-seat `mind` flag is honored (default on) instead of forced off. */
  sandbox?: HorseMindSandbox
): number[] {
  seedFastRandom(handSeed);
  // Deterministic deck for this seed (Fisher-Yates on fastRandom).
  const deck = [...FULL_DECK];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(fastRandom() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }

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
        cards: [deck[s * 2], deck[s * 2 + 1]],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        is_horse: true,
      } as SeatPlayer,
    });
  }
  const board = deck.slice(SEATS * 2, SEATS * 2 + 5);

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
  let ts = handSeed >>> 1;

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
        gameVariant: 'nlh',
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
      if ((action === 'bet' || action === 'raise') && counters) {
        const bs = calculateBettingState(pot, currentBet, p.bet, BB, lastRaise, false);
        if (!validateAction(action as never, amount, p.stack, bs).valid) {
          counters.illegal++;
          action = toCall > 0 ? 'fold' : 'check';
        }
      }

      ts++;
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
          // everyone else gets to act again
          toActQueue = [];
          for (let k = 1; k < SEATS; k++) {
            const j = (i + k) % SEATS;
            const q = seats[j].player;
            if (!q.is_folded && !q.is_all_in) toActQueue.push(j);
          }
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
        const inc = post(i, target - p.bet);
        pot += inc;
        if (target > currentBet) {
          lastRaise = target - currentBet;
          minRaise = lastRaise;
          currentBet = target;
        }
        lastAggressor = i;
        toActQueue = [];
        for (let k = 1; k < SEATS; k++) {
          const j = (i + k) % SEATS;
          const q = seats[j].player;
          if (!q.is_folded && !q.is_all_in) toActQueue.push(j);
        }
        history.push({
          seat: p.seat,
          userId: p.user_id,
          action: p.is_all_in ? 'all_in' : action,
          amount: target,
          timestamp: ts,
          stage,
          ...(p.is_all_in ? { isFullRaise: true } : {}),
        } as ActionRecord);
      }
      actions++;
      void lastAggressor;
      if (live().length < 2) return true;
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
      s.player.is_folded ? -1 : scoreHoldem(s.player.cards.concat(board), 7, false)
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
export function runMatchup(matchup: LeagueMatchup, pairs: number, runSeed: number): LeagueResult {
  const t0 = Date.now();
  const counters = { illegal: 0 };
  const perPairDiff: number[] = [];
  // V12.2: one sandbox PER PASS, alive for the whole matchup. Pass 1 always
  // plays sandbox 1 and pass 2 always plays sandbox 2, so each accumulates a
  // coherent memory of its own seat assignment; identical configs therefore
  // produce identical evolutions in both sandboxes and the mirror invariant
  // survives mind-on play.
  const sb1 = matchup.mind === 'sandbox' ? HorseMind.createSandbox() : undefined;
  const sb2 = matchup.mind === 'sandbox' ? HorseMind.createSandbox() : undefined;

  for (let p = 0; p < pairs; p++) {
    const handSeed = (runSeed ^ (p * 2654435761)) >>> 0 || 1;
    const dealerSeat = (p % SEATS) + 1;
    const evenIsA = (s: number) => (s % 2 === 0 ? matchup.a : matchup.b);
    const evenIsB = (s: number) => (s % 2 === 0 ? matchup.b : matchup.a);

    const net1 = playHand(handSeed, dealerSeat, evenIsA, counters, sb1);
    const net2 = playHand(handSeed, dealerSeat, evenIsB, counters, sb2);

    let aNet = 0;
    for (let s = 0; s < SEATS; s++) {
      aNet += s % 2 === 0 ? net1[s] : -net1[s]; // pass 1: even seats are A
      aNet += s % 2 === 0 ? -net2[s] : net2[s]; // pass 2: odd seats are A
    }
    // aNet counts A-minus-B chips over 2 hands x (SEATS/2) A-seats;
    // normalize to "A's edge in bb per hand pair".
    perPairDiff.push(aNet / 2 / BB);
  }

  const n = perPairDiff.length;
  const mean = perPairDiff.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const varsum = perPairDiff.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  const sd = Math.sqrt(varsum / Math.max(1, n - 1));
  return {
    matchup: matchup.name,
    hands: n * 2,
    bb100: mean * 100,
    stderr: (sd / Math.sqrt(Math.max(1, n))) * 100,
    durationMs: Date.now() - t0,
    illegalActions: counters.illegal,
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
  { name: 'v12_ranges_river', a: {}, b: { v12: false }, mind: 'sandbox' },
  // The whole opponent-intelligence layer vs playing blind. B-seats skip
  // both reads and writes; A-seats read a memory that includes B's actions.
  { name: 'mind_layer', a: {}, b: { mind: false }, mind: 'sandbox' },
  {
    name: 'full_vs_v2_legacy',
    a: {},
    b: {
      v7: false,
      v8: false,
      v9: false,
      v10: false,
      v11: false,
      streetIQ: false,
      handReading: false,
    },
  },
];

const LEAGUE_HOUR_UTC = 4; // quietest hour on the engine host
const LEAGUE_CHECK_MS = 30 * 60 * 1000;
const PAIRS_PER_MATCHUP = 1500; // 3000 hands per matchup, ~1-2 min total CPU

let leagueTimer: NodeJS.Timeout | null = null;
let lastLeagueDate: string | null = null;
let leagueRunning = false;

export function startHorseLeague(): void {
  if (leagueTimer) return;
  leagueTimer = setInterval(() => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === LEAGUE_HOUR_UTC && lastLeagueDate !== today && !leagueRunning) {
      lastLeagueDate = today;
      void runLeague(today);
    }
  }, LEAGUE_CHECK_MS);
  leagueTimer.unref?.();
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
  try {
    const runSeed = (Date.parse(date) / 86_400_000) >>> 0;
    for (const m of LEAGUE_MATCHUPS) {
      const r = runMatchup(m, PAIRS_PER_MATCHUP, runSeed ^ hash32(m.name));
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
            illegal_actions: r.illegalActions,
          },
          { onConflict: 'run_date,matchup' }
        );
        if (error) throw new Error(error.message);
      } catch (err) {
        reportError(err, 'HorseLeague.write');
      }
      console.log(
        `[HorseLeague] ${r.matchup}: ${round2(r.bb100)} bb/100 (se ${round2(r.stderr)}) over ` +
          `${r.hands} hands in ${r.durationMs}ms, illegal=${r.illegalActions}`
      );
      // Yield the event loop between matchups — production tables come first.
      await new Promise((res) => setTimeout(res, 250));
    }
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
