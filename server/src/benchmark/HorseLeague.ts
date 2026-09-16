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

import {
  HorseLeagueComputeWorkerClient,
  type HorseLeagueCompute,
} from './HorseLeagueComputeWorkerClient.js';
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

// V16 DEEP-READS HARNESS: hand-category names matching the engine's showdown
// vocabulary, so sandboxed league play can feed observeHandComplete and the
// v16_deep_reads matchup measures a layer that otherwise only learns in
// production.
const CAT_NAMES = [
  '',
  'High Card',
  'Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
  'Royal Flush',
];
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
  /** Candidate-policy decisions actually consumed during an offline gate. */
  candidatePolicyHits: number;
  /** Solver samples that legalization changed into a different action family. */
  candidateExecutionMismatches: number;
  /** Exact solver node roles reached by those decisions. */
  candidateNodeRoles: string[];
  /** Per-scenario evidence retained when several utility contexts are gated. */
  benchmarkComponents: LeagueBenchmarkComponent[];
}

export interface LeagueBenchmarkComponent {
  scenario: string;
  hands: number;
  bb100: number;
  stderr: number;
  durationMs: number;
  illegalActions: number;
  truncatedStreets: number;
  candidatePolicyHits: number;
  candidateExecutionMismatches: number;
  candidateNodeRoles: string[];
}

export interface LeagueMatchup {
  name: string;
  /** game variant the matchup deals (default 'nlh'). V15: the plo6 matchup
   *  exists because the Omaha discipline layer cannot be measured by an NLH
   *  deal at all. */
  variant?: string;
  /** V16: seats at the table (default 6). 2 = heads-up. */
  seats?: number;
  /** V16: starting stack in big blinds (default 100). 40 exercises the
   *  short-stack push/fold and reshove tiers the 100bb card never touches. */
  stackBB?: number;
  /** Exact format/utility context used by Phase 4 promotion matchups. */
  context?: LeagueGameContext;
  /** V16: duplicate pairs for this matchup (default PAIRS_PER_MATCHUP).
   *  Newer exploratory matchups run fewer pairs so the whole card still
   *  fits the wall-clock budget; stderr scales as 1/sqrt(pairs). */
  pairs?: number;
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

export interface LeagueGameContext {
  gameMode: 'cash' | 'tournament';
  format: 'cash' | 'mtt' | 'sng' | 'spin' | 'hu_sng';
  ante?: number;
  tournament?: HorseGameStateV2['tournament'];
}

const CASH_LEAGUE_CONTEXT: LeagueGameContext = {
  gameMode: 'cash',
  format: 'cash',
  ante: 0,
};

const DEFAULT_SEATS = 6;
const BB = 2;
const SB = 1;
// START_STACK is per-matchup now (stackBB * BB); 100bb was the only depth
// the league ever measured before V16.
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
  gameVariant: string = 'nlh',
  /** V16: seats at the table (default 6; 2 = heads-up). */
  numSeats: number = 6,
  /** V16: starting stack in big blinds (default 100). */
  stackBB: number = 100,
  /** Phase 4: exact cash/tournament utility family. */
  gameContext: LeagueGameContext = CASH_LEAGUE_CONTEXT
): number[] {
  const SEATS = numSeats;
  const START_STACK = stackBB * BB;
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
        gameMode: gameContext.gameMode,
        ante: gameContext.ante ?? 0,
        format: gameContext.format,
        ...(gameContext.tournament ? { tournament: structuredClone(gameContext.tournament) } : {}),
      } as HorseGameStateV2;

      const d = sandbox
        ? HorseMind.runInSandbox(sandbox, () => HorseLogic.decide(p, gs, 'balanced', {}, seat.opts))
        : HorseLogic.decide(p, gs, 'balanced', {}, seat.opts);
      const toCall = Math.max(0, currentBet - p.bet);

      // Validate against the engine's own rules; downgrade an illegal action
      // to the safe fallback and count it (the conservation test asserts 0).
      let action = d.action as string;
      const amount = d.amount ?? 0;
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

  // ═══ V16 DEEP-READS HARNESS (2026-08-26) ═══
  // Production learns fold-to-c-bet / fold-to-3-bet / sizing tells from
  // COMPLETED hands at settlement. The league sandbox never ran settlement,
  // so those reads stayed empty and the layer was unmeasurable (stated
  // plainly in the deep-reads PR). Feed the same observation here, inside
  // the SANDBOX so nothing synthetic touches live memory. Showdown identity
  // comes from the same evaluators that settled the pot.
  if (sandbox) {
    try {
      const showdown: Array<{ user_id: string; mucked: boolean; hand_name?: string }> = [];
      const liveSeats = seats.filter((s) => !s.player.is_folded);
      if (liveSeats.length >= 2) {
        for (const s of liveSeats) {
          const score = vi.isOmaha
            ? scoreOmahaHi(s.player.cards, board)
            : scoreHoldem(s.player.cards.concat(board), s.player.cards.length + 5, vi.isShortDeck);
          const cat = Math.floor(score / 0x100000);
          showdown.push({
            user_id: s.player.user_id,
            mucked: false,
            hand_name: CAT_NAMES[cat] ?? '',
          });
        }
      }
      HorseMind.runInSandbox(sandbox, () =>
        HorseMind.observeHandComplete(`league:${ts}`, history, BB, showdown)
      );
    } catch {
      /* the harness is measurement plumbing — never let it break a deal */
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
  runSeed: number,
  shouldContinue: () => boolean = () => true
): Promise<LeagueResult> {
  const SEATS = matchup.seats ?? DEFAULT_SEATS;
  const t0 = Date.now();
  const counters = { illegal: 0, truncated: 0 };
  let candidatePolicyHits = 0;
  let candidateExecutionMismatches = 0;
  const candidateNodeRoles = new Set<string>();
  const perPairDiff: number[] = [];
  // V12.3: before compute isolation this ran inside the dealer process, where
  // HorseEval's module-global RNG was shared with every live decision.
  // Production now calls this only in its worker; the bracket remains part of
  // the simulator's deterministic contract and protects direct test callers.
  const rngBefore = saveFastRandom();
  // V12.2: one sandbox PER PASS, alive for the whole matchup. Pass 1 always
  // plays sandbox 1 and pass 2 always plays sandbox 2, so each accumulates a
  // coherent memory of its own seat assignment; identical configs therefore
  // produce identical evolutions in both sandboxes and the mirror invariant
  // survives mind-on play.
  const sb1 = HorseMind.createSandbox();
  const sb2 = HorseMind.createSandbox();

  for (let p = 0; p < pairs; p++) {
    if (!shouldContinue()) break;
    // V12.3: retain a worker yield every 16 pairs. Production no longer shares
    // this event loop with live poker, but the yield is where CANCEL messages
    // are observed and where the worker sends its liveness heartbeat.
    if (p > 0 && (p & 0x0f) === 0) await new Promise((res) => setImmediate(res));
    const handSeed = (runSeed ^ (p * 2654435761)) >>> 0 || 1;
    const dealerSeat = (p % SEATS) + 1;
    const withEvidence = (opts: HorseDecideOpts): HorseDecideOpts => {
      if (!opts.gtoV31DatasetChecksum && !opts.onGtoV31Decision) return opts;
      return {
        ...opts,
        onGtoV31Decision: (receipt) => {
          if (opts.gtoV31DatasetChecksum) {
            if (receipt.executedAsIntended) {
              candidatePolicyHits++;
              candidateNodeRoles.add(receipt.nodeRole);
            } else {
              candidateExecutionMismatches++;
            }
          }
          opts.onGtoV31Decision?.(receipt);
        },
      };
    };
    const evenIsA = (s: number) => withEvidence(s % 2 === 0 ? matchup.a : matchup.b);
    const evenIsB = (s: number) => withEvidence(s % 2 === 0 ? matchup.b : matchup.a);

    const net1 = playHand(
      handSeed,
      dealerSeat,
      evenIsA,
      counters,
      sb1,
      matchup.variant ?? 'nlh',
      SEATS,
      matchup.stackBB ?? 100,
      matchup.context ?? CASH_LEAGUE_CONTEXT
    );
    const net2 = playHand(
      handSeed,
      dealerSeat,
      evenIsB,
      counters,
      sb2,
      matchup.variant ?? 'nlh',
      SEATS,
      matchup.stackBB ?? 100,
      matchup.context ?? CASH_LEAGUE_CONTEXT
    );

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
    candidatePolicyHits,
    candidateExecutionMismatches,
    candidateNodeRoles: [...candidateNodeRoles].sort(),
    benchmarkComponents: [],
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
  // ── V16 (2026-08-26): measure the variants and depths the fleet actually
  // plays. Exploratory pairs counts keep the whole card inside the budget;
  // stderr ~4.6 bb/100 at 6000 pairs — enough to catch layer-scale edges. ──
  { name: 'plo4_v15_discipline', variant: 'plo4', pairs: 6000, a: {}, b: { v15: false } },
  { name: 'plo8_hilo_layer', variant: 'plo8', pairs: 6000, a: {}, b: { v8HiLo: false } },
  { name: 'shortdeck_v8_layer', variant: 'short_deck', pairs: 6000, a: {}, b: { v8: false } },
  { name: 'nlh_40bb_preflop', stackBB: 40, pairs: 6000, a: {}, b: { v7Preflop: false } },
  { name: 'hu_mind_layer', seats: 2, pairs: 6000, a: {}, b: { mind: false } },
  // ── V16 strategy matchups (2026-08-26) ──
  { name: 'hu_v16_overlay', seats: 2, pairs: 6000, a: {}, b: { v16Hu: false } },
  /*
   * v16_ratio_rescale is NOT on the card (2026-09-05). Measured 2026-09-04:
   * 0.00 bb100 with 0.00 stderr over 12,000 hands - the flag changed no
   * decision at all (08-31, before V38, it read +0.35 +/- 0.24, unresolved).
   * The flag rescales two thresholds in HorseLogic: the OOP check-raise
   * bluff gate (betRatio <= 0.6 vs 1.5, which on the bet/(pot+bet) scale is
   * "bet at most 1.5x pot" either way and never binds) and the heads-up river
   * bluff-catch gate (0.4 vs 0.667). V38 - opts.v38Ev, default ON since
   * 2026-09-03 - returns a call or a fold for EVERY river spot and every
   * solverless flop/turn spot before that second gate is reached, so no hand
   * can differ between the arms. Same shape as v18_exploit_size and
   * v31_gto_suit_aware above: a matchup that always reports 0.00 +/- 0.00
   * spends 12,000 hands a night measuring nothing. The default stays OFF;
   * the promotion rule (three significant positive runs) cannot be met by a
   * flag that no longer reaches code.
   */
  // { name: 'v16_ratio_rescale', pairs: 6000, a: { v16Ratio: true }, b: {} },
  { name: 'v16_sizecond', pairs: 6000, a: {}, b: { v16SizeCond: false } },
  { name: 'plo4_v16_polarity', variant: 'plo4', pairs: 6000, a: {}, b: { v16PloPolar: false } },
  // Measurable because playHand's sandbox settlement now feeds
  // observeHandComplete — the reads accumulate inside each pass's sandbox.
  { name: 'v16_deep_reads', pairs: 6000, a: {}, b: { v16Reads: false } },
  // ── V17 (2026-08-26) ──
  { name: 'v17_positional', pairs: 6000, a: {}, b: { v17Pos: false } },
  { name: 'v17_river_probe', pairs: 6000, a: {}, b: { v17RiverProbe: false } },
  { name: 'shortdeck_v17', variant: 'short_deck', pairs: 6000, a: {}, b: { v17ShortDeck: false } },
  // ── V18 (2026-08-26) ──
  { name: 'v18_squeeze_response', pairs: 6000, a: {}, b: { v18Squeeze: false } },
  // ── V29-V33 (2026-09-01) ── THE SOLVER STACK HAD NO ABLATION MATCHUP AT
  // ALL. V29/V30/V31/V32 shipped between 08-29 and 08-30, they short-circuit
  // the mature V15-V23 layers on every spot they answer, and nothing on the
  // card could say whether that trade was positive. Their gates need heads-up
  // hold'em with the betting lead, so they are dealt at seats: 2 - the same
  // shape hu_mind_layer uses.
  { name: 'v29_gto_flop', seats: 2, pairs: 6000, a: {}, b: { v29GtoFlop: false } },
  { name: 'v30_gto_turn_river', seats: 2, pairs: 6000, a: {}, b: { v30GtoTurnRiver: false } },
  /*
   * v31_gto_suit_aware is NOT on the card. Measured 2026-09-01: it returned
   * 0.00 bb100 with 0.00 stderr over 12,000 hands, which is not "no edge" -
   * an exact zero with zero variance means the flag changed no decision at
   * all. Live telemetry says why: v31_gto_open fired 195 times against
   * 924,871 decides on the same day, so at 6,000 pairs the matchup expects
   * roughly TWO firings, and observing zero difference is the likely
   * outcome rather than a surprising one. The league cannot resolve a layer
   * this rare at any sample size it can afford, and a matchup that always
   * reports 0.00 +/- 0.00 spends 12,000 hands teaching us nothing while the
   * card is only completing one matchup a night. Ablate it deliberately with
   * a temporary pairs bump if it ever needs a verdict.
   */
  // { name: 'v31_gto_suit_aware', seats: 2, pairs: 6000, a: {}, b: { v31GtoSuitAware: false } },
  { name: 'v32_facing_defense', seats: 2, pairs: 6000, a: {}, b: { v32FacingDefense: false } },
  // The depth ceiling only changes a decision ABOVE it, so dealing this at
  // the standard 100bb would measure exactly nothing and report 0.00 +/- 0.00
  // forever - the inert-matchup shape the audit now flags. 400bb is past
  // GTO_MAX_DEPTH_BB (300), which is the only place the flag has an effect.
  {
    name: 'v33_depth_ceiling_400bb',
    seats: 2,
    stackBB: 400,
    pairs: 6000,
    a: {},
    b: { v33DepthCeiling: false },
  },
  { name: 'v18_self_image', pairs: 6000, a: {}, b: { v18SelfImage: false } },
  /*
   * v18_exploit_size is NOT on the card, and this one is impossible by
   * CONSTRUCTION rather than merely underpowered - it reported 0.00 +/- 0.00
   * on 2026-09-01 and 2026-08-31 both.
   *
   * The layer multiplies its river raise by (exploit.valueThinMod - 1), and
   * only counts a firing when abs(valueThinMod - 1) > 0.03. HorseMind.exploit
   * moves valueThinMod off 1 ONLY when the opponent's fold-vs-aggression rate
   * leaves the middle band - above 0.62 (a folder) or below 0.35 (a station).
   * A league matchup is a MIRROR: both arms are the same brain, differing
   * only in the flag under test, so each arm's opponent folds at the brain's
   * own middling rate and valueThinMod stays exactly 1. The multiplier is
   * then exactly 1, the telemetry gate never opens, and the two arms play
   * byte-identical poker. 0.00 +/- 0.00 is the correct answer to the question
   * this matchup was asking; the question was just unanswerable.
   *
   * Measuring it needs an exploitable opponent, which self-play cannot
   * produce. It is pinned deterministically instead, where the effect is
   * exact and costs no hands at all:
   * server/src/engine/V18ExploitSizingIsMeasurable.test.ts
   */
  // { name: 'v18_exploit_size', pairs: 6000, a: {}, b: { v18ExploitSize: false } },
  // 2026-08-27: the bet-ratio scale repair. There is no "off" for a fixed
  // arithmetic bug, so this measures the sizing-read layer as a whole
  // against playing without size reads at all - if the repair helps, this
  // matchup should grow relative to its own history.
  { name: 'v19_size_reads', pairs: 6000, a: {}, b: { v7SizeReads: false } },
  // ── V20 (2026-08-27) ──
  // Multiway discipline lives postflop in every variant; measure it on the
  // standard NLH card where multiway all-in chains actually occur. The
  // M-zone layer only fires in tournament mode, which the league does not
  // deal (gameMode: 'cash'), so it is validated by scenario tests instead —
  // same position V16 real ICM shipped from.
  { name: 'v20_multiway', pairs: 6000, a: {}, b: { v20Multiway: false } },
  // ── V21 (2026-08-27, Phase 2) ── river endgame: NLH nut status, dominated
  // caps, the raise-war governor. Measured on the standard NLH card where
  // the -500bb river wars actually happened.
  { name: 'v21_river_endgame', pairs: 6000, a: {}, b: { v21River: false } },
  // Deep-stack discipline only differs past 120bb — deal it at 250bb.
  { name: 'v21_deep_250bb', stackBB: 250, pairs: 6000, a: {}, b: { v21Deep: false } },
  // ── V23 (2026-08-28) ── the cash-measurable slices. The endgame and spin
  // layers only fire in tournament/spin modes the league does not deal;
  // they ship scenario-tested with telemetry, the way V16 real ICM did.
  { name: 'v23_raise_plans', pairs: 6000, a: {}, b: { v23Plan: false } },
  { name: 'v23_river_reads', pairs: 6000, a: {}, b: { v23Reads: false } },
  { name: 'shortdeck_v23', variant: 'short_deck', pairs: 6000, a: {}, b: { v23Variants: false } },
  { name: 'plo8_v23_lowdraw', variant: 'plo8', pairs: 6000, a: {}, b: { v23Variants: false } },
  // ── V24 (2026-08-28) ── Dan full-potted 8 PLO hands in a PKO and was never
  // called once. The price defense is measurable on a PLO card; the bounty
  // layer and the tempo floors only exist in tournament/live conditions the
  // league cannot deal, so those ship scenario-tested with telemetry.
  { name: 'plo4_v24_price', variant: 'plo4', pairs: 6000, a: {}, b: { v24PloDefense: false } },
  { name: 'plo6_v24_price', variant: 'plo6', pairs: 6000, a: {}, b: { v24PloDefense: false } },
  // ── V40 (2026-09-04) ── "horses are playing PLO like it's hold'em". The
  // tiered aggressor sampler, the pair/two-pair/trips pressure cap and the
  // small-ball betting law, measured where the naked-aces call-down
  // happened (plo6) and on the widest-played Omaha card (plo4).
  // V46 (2026-09-05): the hand-class chart. The league seats horses with the
  // cards it deals, so this is one of the few layers self-play measures
  // honestly: both arms see the same shapes, only one reads them.
  { name: 'plo4_v46_classes', variant: 'plo4', pairs: 6000, a: {}, b: { v46Charts: false } },
  { name: 'plo6_v46_classes', variant: 'plo6', pairs: 6000, a: {}, b: { v46Charts: false } },
  {
    name: 'shortdeck_v46_classes',
    variant: 'short_deck',
    pairs: 6000,
    a: {},
    b: { v46Charts: false },
  },
  { name: 'plo6_v40_omaha', variant: 'plo6', pairs: 6000, a: {}, b: { v40Omaha: false } },
  { name: 'plo4_v40_omaha', variant: 'plo4', pairs: 6000, a: {}, b: { v40Omaha: false } },
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
      v16Reads: false,
      v16Icm: false,
      v16Hu: false,
      v16Blockers: false,
      v16SizeCond: false,
      v16PloPolar: false,
      v17Pos: false,
      v17RiverProbe: false,
      v17CatchBlock: false,
      v17ShortDeck: false,
      v18Straddle: false,
      v18Squeeze: false,
      v18SelfImage: false,
      v18ExploitSize: false,
      v18Families: false,
      v20Multiway: false,
      v20Mzone: false,
      v21River: false,
      v21Deep: false,
      v23Endgame: false,
      v23Plan: false,
      v23Reads: false,
      v23Variants: false,
      v23Spin: false,
      v24Bounty: false,
      v24PloDefense: false,
      v25PloTourney: false,
      v40Omaha: false,
      v41Leaks: false,
      v43Tempo: false,
      v46Charts: false,
      mind: false,
      streetIQ: false,
      handReading: false,
    },
  },
];

// V12.3: the old comment here claimed hour 4 was "the quietest hour on the
// engine host". Measured over 24h of hand_history it is the SECOND BUSIEST
// (5354 hands vs 6239 at hour 3) — the fleet plays around the clock and there
// is no quiet hour. The league is safe here only because production dispatches
// every matchup and solver-agreement scan to HorseLeagueComputeWorker. The
// yield inside runMatchup remains the worker's cancellation/heartbeat edge;
// it is not permission to put this CPU loop back on the dealer thread.
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
/** V23 (2026-08-28): a SECOND daily window. One 90-minute budget covers 4-6
 *  matchups against a ~30-matchup card — even staleness-first, a matchup got
 *  measured every ~5 nights and a new layer waited most of a week for its
 *  first read. The afternoon window doubles throughput: the staleness-first
 *  ordering naturally hands it the matchups the night window did not reach
 *  (their run_date is older), and (run_date, matchup) upserts make any
 *  overlap harmless. Claimed under its own job name so leader/standby pairs
 *  cannot both run it. */
const LEAGUE_PM_HOUR_UTC = 16;
/** Settle time before the boot check, so it never competes with table startup. */
const LEAGUE_BOOT_DELAY_MS = 90 * 1000;
// V12.3: raised 1500 -> 10000. At 1500 pairs the standard error was ~7 bb/100
// while real strategy-layer edges are single-digit bb/100 — the instrument
// could only ever detect catastrophic regressions, and its own header claimed
// it would catch a sign flip "within days". 10000 pairs puts the error near
// 2.8 bb/100. The cost is worker wall clock, not dealer responsiveness:
// production never executes runMatchup on the live engine event loop.
// 2026-08-27 (measured, not guessed): the 23-matchup card completed FOUR
// matchups in its 90-minute budget - roughly 22 minutes each at 10,000 pairs -
// so every V15/V16/V17/V18 layer went unmeasured while the four oldest
// matchups were re-measured for the fourth time. A card whose tail never runs
// is not a card. Two changes: a smaller default (stderr ~4.5 bb/100, still
// well inside layer-scale edges), and DAILY ROTATION so the starting index
// walks the list - every matchup is measured every few nights instead of the
// same head forever.
const PAIRS_PER_MATCHUP = 4000;
/** Wall-clock ceiling for a whole run. See the note in runLeague. */
const MAX_RUN_MS = 90 * 60 * 1000;
/**
 * Milliseconds left in the run window that `date`'s attempt belongs to.
 *
 * 2026-09-04: a partial card is resumable again (see alreadyRanToday), so the
 * per-ATTEMPT budget is no longer the only thing bounding a night. Each new
 * attempt would otherwise start a fresh 90 minutes, and with an engine that
 * restarts hourly that is an unbounded amount of league work on a host whose
 * event loop is the reason a matchup is slow in the first place. Clipping to
 * the window makes the night's total cost the window itself, which is what a
 * window is for.
 */
export function msLeftInRunWindow(now: Date = new Date()): number {
  const hour = now.getUTCHours();
  const startHour =
    hour >= LEAGUE_PM_HOUR_UTC && hour < LEAGUE_PM_HOUR_UTC + LEAGUE_CATCHUP_HOURS
      ? LEAGUE_PM_HOUR_UTC
      : LEAGUE_HOUR_UTC;
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    startHour + LEAGUE_CATCHUP_HOURS
  );
  return Math.max(0, end - now.getTime());
}

let leagueTimer: NodeJS.Timeout | null = null;
let leagueBootTimer: NodeJS.Timeout | null = null;
let lastLeagueDate: string | null = null;
let leagueRunning = false;
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlightRuns = new Set<Promise<void>>();

const lifecycleIsCurrent = (generation: number): boolean =>
  lifecycleActive && lifecycleGeneration === generation;

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
/**
 * A DEAD CLAIM MUST NOT BURN THE DAY (2026-08-28).
 *
 * MEASURED, on the day the PM window shipped. The 04:04 UTC league run
 * claimed 2026-08-28 and wrote ZERO rows: the engine container was recreated
 * at 04:06, two minutes in. The claim is the lock, so nothing retried, and
 * the AM slot was simply gone - the only reason that day has any measurement
 * at all is that the new 16:00 window happened to exist.
 *
 * Every ingredient of that failure is routine here. `server/**` merges deploy
 * automatically, the engine restarts several times a day, and a league run
 * takes ~20 minutes; a restart landing inside one is expected, not exotic.
 *
 * So a claim now carries a LIVENESS test: it owns the day only while it is
 * either fresh or has something to show for itself. A claim older than
 * CLAIM_STALE_MS whose job wrote no rows for that date is a crashed run, and
 * the next instance takes the work over by stamping its own name on the row.
 *
 * The takeover is a CONDITIONAL update - `.eq('claimed_by', dead.claimed_by)`
 * - so when two instances notice the same corpse simultaneously, exactly one
 * UPDATE matches and the loser stands down. That is the same
 * one-winner property the INSERT gives, applied to the second attempt.
 */
/*
 * 2026-09-01: was 60 minutes against a 3-hour window. The threshold only ever
 * bites when the claim wrote NOTHING (see claimNightlyJob: age AND no rows),
 * and at PAIRS_PER_MATCHUP=4000 a matchup completes in roughly nine minutes -
 * so a live run proves itself long before this. An hour of grace bought no
 * safety and cost most of the window: it left only two chances to notice a
 * corpse. Thirty minutes is still triple the measured first-row time, and a
 * mistaken takeover is harmless anyway - the (run_date, matchup) upsert makes
 * a duplicated matchup idempotent.
 */
const CLAIM_STALE_MS = 30 * 60 * 1000;

/**
 * Where each nightly job leaves its evidence.
 *
 * ── 2026-08-30, found by the daily analysis it was supposed to enable ──
 * This map used to hold only the two league jobs, with every other job
 * "asked to prove nothing". That sounds conservative. It is the opposite:
 * `claimNightlyJob` treats a null answer as "cannot be judged" and DECLINES
 * the takeover, so the liveness test above - the whole point of this block -
 * was switched off for exactly the jobs that had no other retry.
 *
 * What that cost, measured: 'daily_audit' claimed 2026-08-29 at 06:09 UTC and
 * the container was replaced mid-run. Nothing took it over, the orphaned claim
 * permanently satisfied the INSERT lock, and the day's audit did not exist
 * until an agent generated it by hand ~28 hours later. 'self_tuner' lost
 * 2026-08-26 the same way. The engine restarts several times a day
 * (RestartCount 7, six boots in 30h as this was written), so a restart inside
 * a job window is routine, not exotic - which is precisely the reasoning in
 * the comment above that this map failed to apply.
 *
 * A job belongs here the moment it writes a row somewhere. Anything genuinely
 * unjudgeable still returns null and keeps the old all-or-nothing claim.
 */
const CLAIM_EVIDENCE: Record<string, { table: string; column: string; dateColumn: string }> = {
  league: { table: 'horse_league_results', column: 'matchup', dateColumn: 'run_date' },
  league_pm: { table: 'horse_league_results', column: 'matchup', dateColumn: 'run_date' },
  daily_audit: { table: 'horse_daily_audit', column: 'day', dateColumn: 'day' },
  self_tuner: { table: 'horse_self_tune_log', column: 'id', dateColumn: 'run_date' },
};

/**
 * Jobs whose output row is PARTIAL progress rather than proof of completion.
 *
 * ── 2026-09-04, found by the daily audit three days running ──
 * For `daily_audit` and `self_tuner` one row IS the night's whole output, so
 * "a row exists" correctly means "this claim delivered". A league row is ONE
 * MATCHUP out of 38. Treating it as delivery meant that the moment the first
 * matchup landed, the claim became permanently untakeable and the night was
 * over - which stopped mattering only in theory until the hourly maintenance
 * break landed on 2026-09-01 and started killing the engine at :55 of every
 * hour. A run that opens at 04:04 now has 51 minutes against a 90-minute
 * budget, so it is ALWAYS killed mid-card, and every night since has recorded
 * exactly one matchup, a stale card and a `nightly_job_lost` finding.
 *
 * For these jobs the honest question is not "did anything land" but "is this
 * claim still producing". A live run writes a matchup every 9-22 minutes; a
 * corpse writes nothing. So freshness, not existence, is the evidence - which
 * keeps the anti-duplicate protection the existence check was really giving
 * us (two league runs at once would double the load on an engine that is
 * already the reason a matchup takes 22 minutes).
 */
const CLAIM_EVIDENCE_IS_PARTIAL: Record<string, { timeColumn: string }> = {
  league: { timeColumn: 'created_at' },
  league_pm: { timeColumn: 'created_at' },
};

/**
 * ═══ A CLAIM FROM BEFORE THIS PROCESS BOOTED IS A CORPSE (2026-09-06) ═══
 *
 * MEASURED, from horse_job_runs and horse_league_results, by the 2026-09-05
 * daily analysis:
 *
 *   2026-09-05  league     claimed 06:56:50 (last takeover)  ZERO matchups
 *   2026-09-05  league_pm  claimed 18:56:38 (last takeover)  ZERO matchups
 *   2026-09-06  league     first matchup written 04:51, second 06:48 -
 *               117 minutes between two matchups that take 9-16 minutes.
 *
 * The engine restarts at :55 of every hour (CLAUDE.md 13), so the run that
 * opens at ~04:00 is killed at 04:55 with a matchup in flight. Its
 * replacement boots at ~04:58 and arrives here at ~05:00, where the thirty-
 * minute clock refuses it TWICE: the claim is still under CLAIM_STALE_MS, and
 * once it is not, the newest row (written at ~04:50 by the dead process) is
 * still "fresh". So every restart costs the league the in-flight matchup PLUS
 * up to thirty minutes of standing down in front of a corpse - roughly half
 * of every hour, and the whole of a window when a matchup is slow. That is
 * how a three-hour window produced nothing at all on 2026-09-05, twice.
 *
 * A clock was the wrong instrument. The calendar already answers: this engine
 * is ONE container, recreated on every deploy and every :55, and nothing
 * survives that recreation. A claim stamped before THIS process booted was
 * made by a process that no longer exists, and a row written before this
 * process booted proves nothing about anyone being alive now. So a claim that
 * predates the boot is taken over at the boot check, ninety seconds after the
 * restart, instead of thirty minutes later.
 *
 * The grace below is for the one shape that could be alive: a leader/standby
 * sibling that booted a little before this one and claimed at ITS boot check.
 * Two minutes covers any stagger a paired deploy has ever shown; the hourly
 * corpse is fifty-plus minutes older than that. A mistaken takeover is still
 * harmless - the (run_date, matchup) upsert makes a duplicated matchup
 * idempotent - so the grace is a courtesy to the sibling's CPU, not a lock.
 */
const PROCESS_BOOT_MS = Date.now() - Math.floor(process.uptime() * 1000);
const BOOT_CORPSE_GRACE_MS = 2 * 60 * 1000;
let bootMsOverride: number | null = null;
/** Tests only: pretend this process booted at `ms` (null restores the truth). */
export function __setProcessBootMsForTest(ms: number | null): void {
  bootMsOverride = ms;
}
const processBootMs = (): number => bootMsOverride ?? PROCESS_BOOT_MS;

/** Was this timestamp written by a process that cannot be alive any more? */
function predatesThisProcess(ms: number): boolean {
  return isFinite(ms) && ms < processBootMs() - BOOT_CORPSE_GRACE_MS;
}

/** Rows already written for this job+date - the proof a claim did work. */
async function claimProducedRows(job: string, date: string): Promise<boolean | null> {
  const evidence = CLAIM_EVIDENCE[job];
  if (evidence === undefined) return null;
  const partial = CLAIM_EVIDENCE_IS_PARTIAL[job];
  if (partial !== undefined) {
    // Still producing? Only the NEWEST row can answer that.
    const { data, error } = await supabase
      .from(evidence.table)
      .select(partial.timeColumn)
      .eq(evidence.dateColumn, date)
      .order(partial.timeColumn, { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const rows = data as unknown as Array<Record<string, string>> | null;
    const newest = rows?.[0]?.[partial.timeColumn];
    if (newest === undefined) return false; // nothing at all - a plain corpse
    const newestMs = Date.parse(newest);
    const ageMs = Date.now() - newestMs;
    if (!isFinite(ageMs)) return true; // unreadable stamp - do not take it over
    // A row from before this process booted was written by a process that is
    // gone. It is history, not a heartbeat - see the boot note above.
    if (predatesThisProcess(newestMs)) return false;
    return ageMs < CLAIM_STALE_MS; // fresh row = alive; stale row = abandoned
  }
  const { data, error } = await supabase
    .from(evidence.table)
    .select(evidence.column)
    .eq(evidence.dateColumn, date)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data?.length ?? 0) > 0;
}

export async function claimNightlyJob(job: string, date: string): Promise<boolean> {
  const me = process.env.HOSTNAME ?? 'engine';
  try {
    const { error } = await supabase
      .from('horse_job_runs')
      .insert({ job, run_date: date, claimed_by: me });
    if (!error) return true;
    const code = (error as { code?: string }).code;
    if (code !== '23505') throw new Error(error.message);

    // Somebody owns it. Is that owner alive?
    const { data: existing, error: readErr } = await supabase
      .from('horse_job_runs')
      .select('claimed_at, claimed_by')
      .eq('job', job)
      .eq('run_date', date)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!existing) return false; // vanished under us - let the next tick retry

    const claimedAtMs = Date.parse(String(existing.claimed_at));
    const ageMs = isFinite(claimedAtMs) ? Date.now() - claimedAtMs : 0;
    // A claim stamped before this process booted belongs to a process that
    // no longer exists (the boot note above claimProducedRows). Its age on the
    // clock is irrelevant; only its evidence can still speak for it.
    const claimIsFromBeforeBoot = predatesThisProcess(claimedAtMs);
    if (ageMs < CLAIM_STALE_MS && !claimIsFromBeforeBoot) return false; // still plausibly working

    const produced = await claimProducedRows(job, date);
    if (produced !== false) return false; // it delivered, or cannot be judged

    // Snapshot the owner BEFORE the update: the row object may be a live
    // reference (a test double, a future client that returns the same
    // object), and reading it afterwards would report OUR name as the
    // corpse's - which is exactly the confusing message this line exists to
    // avoid emitting.
    const prevOwner = String(existing.claimed_by);
    const { data: taken, error: takeErr } = await supabase
      .from('horse_job_runs')
      .update({ claimed_by: me, claimed_at: new Date().toISOString() })
      .eq('job', job)
      .eq('run_date', date)
      .eq('claimed_by', prevOwner) // the race-loser matches nothing
      .select('job');
    if (takeErr) throw new Error(takeErr.message);
    if (!taken || taken.length === 0) return false;

    console.warn(
      `[HorseLeague] ${job} ${date} was claimed by ${prevOwner} ` +
        `${Math.round(ageMs / 60000)} min ago and wrote NOTHING - taking it over. ` +
        (claimIsFromBeforeBoot
          ? `The claim predates this process's boot, so its owner is gone (a restart inside a run).`
          : `A restart inside a run is the usual cause.`)
    );
    return true;
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
      .limit(LEAGUE_MATCHUPS.length * 2);
    if (error) throw new Error(error.message);
    /*
     * ── 2026-09-04: "any rows = done" is retired, and this comment with it ──
     *
     * The 2026-08-27 note below was right for the platform it was written on.
     * It said: with a rotating card the budget legitimately leaves the tail
     * unrun, so a run counts as done once ANY rows exist, and the ROTATION
     * (not a same-night retry) covers the rest. That reasoning depends on a
     * run getting its full 90-minute budget, which stopped being true on
     * 2026-09-01 when the engine began restarting at :55 of every hour. The
     * 04:00 window now yields at most 51 minutes before the process dies, and
     * this line then told the replacement the night was finished. Measured
     * result: 2026-09-02 and 2026-09-03 each recorded ONE matchup, the card
     * went stale, and the audit raised `nightly_job_lost` for 'league' both
     * days. Rotation cannot cover a tail when every night is one matchup long.
     *
     * So a partial card is resumable again. Runaway work is bounded by the
     * WINDOW rather than by this flag - see the budget clip in runLeague,
     * which stops a resumed attempt at the window edge.
     */
    const distinct = new Set((data ?? []).map((r) => (r as { matchup: string }).matchup));
    if (distinct.size < LEAGUE_MATCHUPS.length) return false;

    // A complete matchup card is not complete Phase 4 evidence when a
    // certified corpus is active. Require a same-day decision receipt bound
    // to that exact dataset; otherwise the catch-up window must retry the
    // agreement probe instead of latching the day as done.
    const { data: activeRows, error: activeError } = await supabase
      .from('gto_v31_datasets')
      .select('dataset_id,dataset_checksum')
      .eq('state', 'active')
      .limit(1);
    if (activeError) throw new Error(activeError.message);
    const active = (activeRows?.[0] ?? null) as {
      dataset_id: string;
      dataset_checksum: string;
    } | null;
    if (!active) return true;
    const { data: receipts, error: receiptError } = await supabase
      .from('horse_solver_agreement_v31_decisions')
      .select('source_seal')
      .eq('run_date', date)
      .eq('reference', 'gto_v31_certified')
      .limit(1);
    if (receiptError) throw new Error(receiptError.message);
    return (receipts ?? []).some((row) => {
      const seal = (row as { source_seal?: unknown }).source_seal;
      return (
        !!seal &&
        typeof seal === 'object' &&
        !Array.isArray(seal) &&
        (seal as Record<string, unknown>).dataset_id === active.dataset_id &&
        (seal as Record<string, unknown>).dataset_checksum === active.dataset_checksum
      );
    });
  } catch (err) {
    // Never let a failed lookup silently skip the night; the upsert on
    // (run_date, matchup) makes a duplicate run harmless.
    reportError(err, 'HorseLeague.alreadyRanToday');
    return false;
  }
}

let lastLeaguePmDate: string | null = null;

async function maybeRunLeague(generation: number): Promise<void> {
  if (!lifecycleIsCurrent(generation)) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hour = now.getUTCHours();
  const inWindow = hour >= LEAGUE_HOUR_UTC && hour < LEAGUE_HOUR_UTC + LEAGUE_CATCHUP_HOURS;
  const inPmWindow = hour >= LEAGUE_PM_HOUR_UTC && hour < LEAGUE_PM_HOUR_UTC + LEAGUE_CATCHUP_HOURS;
  if (leagueRunning) return;

  if (inWindow && lastLeagueDate !== today) {
    const alreadyRan = await alreadyRanToday(today);
    if (!lifecycleIsCurrent(generation)) return;
    if (alreadyRan) {
      lastLeagueDate = today; // remember for the rest of this process's life
      return;
    }
    // NOTE: lastLeagueDate is per-process, so a RESTARTED instance arrives
    // here with it empty and reaches the claim - which is exactly how a
    // crashed run gets taken over by its own replacement.

    // V13.1: leader/standby means TWO containers boot the full engine path and
    // both reach this line within seconds. Claim the night before working it.
    const claimed = await claimNightlyJob('league', today);
    if (!lifecycleIsCurrent(generation)) return;
    if (!claimed) {
      /*
       * DO NOT LATCH lastLeagueDate HERE (2026-09-01, measured).
       *
       * Standing down is not the same as settling the day. This line used to
       * latch the per-process "settled today" flag, and that single
       * assignment defeated the whole takeover mechanism below it:
       *
       *   04:04  instance A claims 'league' and starts the run.
       *   04:10  the container is replaced (server/** merges deploy, so this
       *          is routine). The run dies having written ZERO rows - the
       *          first matchup had not finished yet.
       *   04:12  the replacement boots, finds no rows, tries to claim, and is
       *          refused because the dead claim is only EIGHT MINUTES old and
       *          therefore judged "still plausibly working". It then latched
       *          lastLeagueDate = today and every 10-minute tick for the rest
       *          of the process's life returned immediately - including every
       *          tick after the claim went stale and became reclaimable.
       *
       * The window is three hours precisely so a corpse can be taken over
       * inside it. Latching on stand-down threw that away and cost the league
       * 2026-08-29, 2026-08-30 and 2026-09-01 - three days in four with a
       * claim row and no results, while nothing said so.
       *
       * Leaving the flag unset costs one extra claim probe per ten minutes
       * per standby, and buys a retry every ten minutes until either the run
       * lands rows (alreadyRanToday short-circuits above) or the stale claim
       * is taken over.
       */
      console.log(
        `[HorseLeague] run ${today} claimed by another instance - standing down, ` +
          `will re-check in ${Math.round(LEAGUE_CHECK_MS / 60000)} min in case that claim dies`
      );
      return;
    }
    /*
     * 2026-09-04: latch only when the day is genuinely FINISHED. This used to
     * be set before the run, which is the same defect PR #2628 fixed in
     * HorseDailyAudit and HorseSelfTuner: a run that dies leaves the flag
     * saying the day is settled, so no later tick inside the window can
     * resume it. With a partial card now resumable, latching here would undo
     * the entire fix above.
     */
    await runLeague(today, () => lifecycleIsCurrent(generation));
    if (!lifecycleIsCurrent(generation)) return;
    const completed = await alreadyRanToday(today);
    if (!lifecycleIsCurrent(generation)) return;
    if (completed) lastLeagueDate = today;
    return;
  }

  // V23 PM WINDOW: no alreadyRanToday here — the night run's rows exist by
  // design. The claim itself is the dedup (unique on job + run_date), and
  // the staleness-first card ordering serves the matchups the night window
  // left unmeasured.
  if (inPmWindow && lastLeaguePmDate !== today) {
    const claimed = await claimNightlyJob('league_pm', today);
    if (!lifecycleIsCurrent(generation)) return;
    if (!claimed) {
      // Same reasoning as the AM window above: standing down is not settling
      // the day, so the flag stays unset and the next tick re-checks.
      console.log(
        `[HorseLeague] pm run ${today} claimed by another instance - standing down, ` +
          `will re-check in ${Math.round(LEAGUE_CHECK_MS / 60000)} min in case that claim dies`
      );
      return;
    }
    /*
     * 2026-09-04: latch AFTER the run, not before it - the same defect PR
     * #2628 fixed in HorseDailyAudit and HorseSelfTuner. It is deliberately
     * NOT gated on alreadyRanToday: LeaguePmAndStraddle.test.ts pins that the
     * PM window never consults it, because the night run's rows exist by
     * design and the claim is the dedup here. Reaching this line at all means
     * runLeague returned rather than dying mid-card, and rows mean it did
     * real work; a run that produced nothing leaves the day open to retry.
     */
    const pmResults = await runLeague(today, () => lifecycleIsCurrent(generation));
    if (!lifecycleIsCurrent(generation)) return;
    if (pmResults.length > 0) lastLeaguePmDate = today;
  }
}

function launchMaybeRunLeague(): void {
  const generation = lifecycleGeneration;
  if (!lifecycleIsCurrent(generation) || inFlightRuns.size > 0) return;
  const tracked = maybeRunLeague(generation)
    .catch((err) => reportError(err, 'HorseLeague.tick'))
    .finally(() => inFlightRuns.delete(tracked));
  inFlightRuns.add(tracked);
}

async function drainRuns(): Promise<void> {
  while (inFlightRuns.size > 0) await Promise.allSettled([...inFlightRuns]);
}

export function startHorseLeague(): void {
  if (leagueTimer) return;
  lifecycleActive = true;
  lifecycleGeneration += 1;
  stopOperation = null;
  leagueTimer = setInterval(launchMaybeRunLeague, LEAGUE_CHECK_MS);
  leagueTimer.unref?.();
  // Boot check, after a short settle so it never competes with table startup.
  leagueBootTimer = setTimeout(() => {
    leagueBootTimer = null;
    launchMaybeRunLeague();
  }, LEAGUE_BOOT_DELAY_MS);
  leagueBootTimer.unref?.();
}

export function stopHorseLeague(): Promise<void> {
  if (stopOperation) return stopOperation;
  lifecycleActive = false;
  lifecycleGeneration += 1;
  if (leagueTimer) {
    clearInterval(leagueTimer);
    leagueTimer = null;
  }
  if (leagueBootTimer) clearTimeout(leagueBootTimer);
  leagueBootTimer = null;
  stopOperation = drainRuns();
  return stopOperation;
}

class RequiredV31AgreementError extends Error {
  override readonly name = 'RequiredV31AgreementError';
}

export async function runLeague(
  runDate?: string,
  shouldContinue: () => boolean = () => true,
  computeFactory: () => HorseLeagueCompute = () => new HorseLeagueComputeWorkerClient()
): Promise<LeagueResult[]> {
  if (leagueRunning) return [];
  leagueRunning = true;
  let compute: HorseLeagueCompute | null = null;
  const date = runDate ?? new Date().toISOString().slice(0, 10);
  const results: LeagueResult[] = [];
  const startedAt = Date.now();
  // Whichever runs out first: this attempt's own budget, or the window.
  const runBudgetMs = Math.min(MAX_RUN_MS, msLeftInRunWindow());
  let requiresV31Agreement = false;
  // V13: SAY THAT IT STARTED. Rows are only written as each worker matchup
  // finishes, so a run in progress and a run that never began would otherwise
  // remain indistinguishable from outside.
  // DAILY ROTATION (2026-08-27): start the card at a different index each
  // day so the budget cannot permanently starve the tail. Deterministic from
  // the run date, so a re-run of the same date repeats the same order.
  const dayIndex = Math.floor(Date.parse(date) / 86_400_000);
  const rotateBy =
    ((dayIndex % LEAGUE_MATCHUPS.length) + LEAGUE_MATCHUPS.length) % LEAGUE_MATCHUPS.length;
  let card = LEAGUE_MATCHUPS.slice(rotateBy).concat(LEAGUE_MATCHUPS.slice(0, rotateBy));
  // STALENESS-FIRST (2026-08-27, Phase 2): rotation alone walks the start
  // index by ONE per night while the budget covers ~4-6 matchups, so a new
  // layer's matchup could wait a week for its first measurement — and the
  // v16_ratio decision needs THREE significant runs. Order the card by how
  // long each matchup has gone unmeasured (never-run first, then oldest),
  // with the rotation order as the deterministic tie-break. The DB is the
  // authority on what has been measured; if it cannot answer, rotation alone
  // still runs the night.
  try {
    const { data, error } = await supabase
      .from('horse_league_results')
      .select('matchup, run_date')
      .order('run_date', { ascending: false })
      .limit(2000);
    if (!error && data) {
      const lastRun = new Map<string, string>();
      for (const r of data as Array<{ matchup: string; run_date: string }>) {
        if (!lastRun.has(r.matchup)) lastRun.set(r.matchup, r.run_date);
      }
      const pos = new Map(card.map((m, i) => [m.name, i]));
      card = card
        .slice()
        .sort(
          (a, b) =>
            (lastRun.get(a.name) ?? '0000').localeCompare(lastRun.get(b.name) ?? '0000') ||
            pos.get(a.name)! - pos.get(b.name)!
        );
    }
  } catch {
    /* staleness ordering is best-effort — rotation already covers the night */
  }
  console.log(
    `[HorseLeague] run ${date} starting: ${card.length} matchups x ` +
      `${PAIRS_PER_MATCHUP} pairs (budget ${Math.round(runBudgetMs / 60000)} min ` +
      `of a possible ${Math.round(MAX_RUN_MS / 60000)}, clipped to the window), ` +
      `rotation offset ${rotateBy} -> first up ${card[0]?.name}`
  );
  try {
    if (!shouldContinue()) return results;
    // CAPACITY ROOT FIX (2026-09-08): this is the only compute lane the
    // production league may use. The old path executed 32 complete synthetic
    // hands between yields on the same event loop as table clocks, WebSockets
    // and lease heartbeats. At the first 10-minute tick after the 03:55 engine
    // restart, production moved from scale=1 / p50=20ms to scale=0.2 /
    // p50=640ms while ~300 tables were live. The tick and the cliff were the
    // same second. A dedicated worker keeps the exact seeded simulator and
    // its HorseMind sandbox intact on another core. There is deliberately no
    // sync fallback: failed analysis is retried from its durable claim;
    // delaying live poker to finish a benchmark is never an allowed fallback.
    compute = computeFactory();
    const solverStores = await compute.ready();
    requiresV31Agreement = solverStores.postflopV31 > 0;
    if (!shouldContinue()) return results;
    // ═══ V47 SOLVER AGREEMENT (2026-09-05) ═══════════════════════════════
    // The matchups below measure a DIFFERENCE between two configs. This is
    // the absolute score, against the only reference in the building: the
    // hold'em push/fold charts. It costs a few hundred worker decisions once a
    // night, and it is the one number that can say the brain got WORSE without
    // another config to compare it to.
    //
    // IT RUNS FIRST (2026-09-06). It used to run after the card, and the
    // card never ends: the engine restarts at :55 of every hour, a matchup
    // in flight dies with it, and the loop below is killed before it returns
    // on every attempt that does not run out of budget first. Measured by
    // the 2026-09-05 daily analysis: horse_solver_agreement had ZERO rows,
    // ever - the audit's `data_stale` and `solver_agreement_missing` findings
    // were both this ordering. Putting them before the hours-long part means
    // the one number
    // that needs no second config exists on every night the league is even
    // attempted. fn_horse_solver_agreement_add upserts on (run_date,
    // reference), so a resumed card re-scores the same day harmlessly.
    try {
      const agreement = await compute.scoreSolverAgreement();
      if (agreement.reference) {
        const { error } = await supabase.rpc('fn_horse_solver_agreement_add', {
          p_rows: [
            {
              run_date: date,
              reference: agreement.reference,
              spots: agreement.spots,
              agreement: round4(agreement.agreement),
              pure_misses: agreement.pureMisses,
              eligible_spots: agreement.eligibleSpots,
              reconciled_spots: agreement.reconciledSpots,
              action_regret_bb: agreement.actionRegretBb,
              regret_eligible_spots: agreement.regretEligibleSpots,
              decision_checksum: agreement.decisionChecksum,
              decisions: agreement.decisions.map((decision) => ({
                state_key: decision.stateKey,
                decision_state: {
                  schema_version: decision.decisionState.schemaVersion,
                  stage: decision.decisionState.stage,
                  game_variant: decision.decisionState.gameVariant,
                  game_type: decision.decisionState.gameType,
                  format: decision.decisionState.format,
                  kind: decision.decisionState.kind,
                  position: decision.decisionState.position,
                  stack_bb: decision.decisionState.stackBb,
                  hand: decision.decisionState.hand,
                  chart: decision.decisionState.chart,
                  villain_action: decision.decisionState.villainAction,
                  legal_actions: decision.decisionState.legalActions,
                },
                kind: decision.kind,
                game_type: decision.gameType,
                position: decision.position,
                stack_bb: decision.stackBb,
                hand: decision.hand,
                final_action: decision.finalAction,
                reference_distribution: decision.referenceDistribution,
                chosen_probability: decision.chosenProbability,
                action_regret_bb: decision.actionRegretBb,
                regret_eligible: decision.regretEligible,
                pure_miss: decision.pureMiss,
                source_seal: {
                  quality_seal: decision.sourceSeal.qualitySeal,
                  policy_version: decision.sourceSeal.policyVersion,
                  policy_checksum: decision.sourceSeal.policyChecksum,
                  system: decision.sourceSeal.system,
                  artifact_id: decision.sourceSeal.artifactId,
                  scenario_hash: decision.sourceSeal.scenarioHash,
                  source_artifact_checksum: decision.sourceSeal.sourceArtifactChecksum,
                  provenance_complete: decision.sourceSeal.provenanceComplete,
                  audited_at: decision.sourceSeal.auditedAt,
                },
              })),
            },
          ],
        });
        if (!shouldContinue()) return results;
        if (error) throw new Error(error.message);
        console.log(
          `[HorseLeague] solver agreement ${round4(agreement.agreement)} over ${agreement.spots} ` +
            `spots (${agreement.pureMisses} pure misses)`
        );
      } else {
        console.log('[HorseLeague] solver agreement skipped - the chart store is empty here');
      }
    } catch (err) {
      reportError(err, 'HorseLeague.agreement');
    }

    if (!shouldContinue()) return results;
    // PHASE 4 CERTIFIED V31 AGREEMENT. The chart score above is preflop-only
    // and cannot prove that the promoted postflop corpus is being selected,
    // legalized, or reconciled. This second probe drives deterministic hands
    // through the ordinary active V31 path and persists its own reference row
    // plus every regret/source-seal decision receipt.
    try {
      const agreement = await compute.scoreGtoV31Agreement(undefined, shouldContinue);
      if (!shouldContinue()) return results;
      if (agreement.reference) {
        const { error } = await supabase.rpc('fn_horse_solver_agreement_add', {
          p_rows: [
            {
              run_date: date,
              reference: agreement.reference,
              spots: agreement.spots,
              agreement: round4(agreement.agreement),
              pure_misses: agreement.pureMisses,
              eligible_spots: agreement.eligibleSpots,
              reconciled_spots: agreement.reconciledSpots,
              action_regret_bb: agreement.actionRegretBb,
              regret_eligible_spots: agreement.regretEligibleSpots,
              decision_checksum: agreement.decisionChecksum,
              decisions: agreement.decisions.map((decision) => ({
                state_key: decision.stateKey,
                decision_state: {
                  schema_version: decision.decisionState.schemaVersion,
                  street: decision.decisionState.street,
                  game_variant: decision.decisionState.gameVariant,
                  game_family: decision.decisionState.gameFamily,
                  objective: decision.decisionState.objective,
                  utility_context: decision.decisionState.utilityContext,
                  format: decision.decisionState.format,
                  table_size: decision.decisionState.tableSize,
                  pot_type: decision.decisionState.potType,
                  hero_position: decision.decisionState.heroPosition,
                  opponent_position: decision.decisionState.opponentPosition,
                  stack_bb: decision.decisionState.stackBb,
                  depth_bucket: decision.decisionState.depthBucket,
                  texture_class: decision.decisionState.textureClass,
                  node_role: decision.decisionState.nodeRole,
                  facing_kind: decision.decisionState.facingKind,
                  facing_size_bucket: decision.decisionState.facingSizeBucket,
                  hand: decision.decisionState.hand,
                  hand_key: decision.decisionState.handKey,
                  cell: decision.decisionState.cell,
                  board: decision.decisionState.board,
                  hole_cards: decision.decisionState.holeCards,
                  pot: decision.decisionState.pot,
                  current_bet: decision.decisionState.currentBet,
                  to_call: decision.decisionState.toCall,
                  big_blind: decision.decisionState.bigBlind,
                  probe_scenario: decision.decisionState.probeScenario,
                  probe_ordinal: decision.decisionState.probeOrdinal,
                  sampled_action_id: decision.decisionState.sampledActionId,
                  sampled_action_family: decision.decisionState.sampledActionFamily,
                  sampled_amount: decision.decisionState.sampledAmount,
                  final_action: decision.decisionState.finalAction,
                  final_amount: decision.decisionState.finalAmount,
                  executed_as_intended: decision.decisionState.executedAsIntended,
                },
                stage: decision.stage,
                game_family: decision.gameFamily,
                objective: decision.objective,
                utility_context: decision.utilityContext,
                table_size: decision.tableSize,
                pot_type: decision.potType,
                hero_position: decision.heroPosition,
                opponent_position: decision.opponentPosition,
                depth_bucket: decision.depthBucket,
                texture_class: decision.textureClass,
                node_role: decision.nodeRole,
                facing_kind: decision.facingKind,
                facing_size_bucket: decision.facingSizeBucket,
                cell: decision.cell,
                hand_key: decision.handKey,
                sampled_action_id: decision.sampledActionId,
                sampled_action_family: decision.sampledActionFamily,
                final_action: decision.finalAction,
                executed_as_intended: decision.executedAsIntended,
                reference_distribution: decision.referenceDistribution,
                chosen_probability: decision.chosenProbability,
                action_regret_bb: decision.actionRegretBb,
                regret_eligible: decision.regretEligible,
                pure_miss: decision.pureMiss,
                source_seal: decision.sourceSeal,
              })),
            },
          ],
        });
        if (!shouldContinue()) return results;
        if (error) throw new Error(error.message);
        console.log(
          `[HorseLeague] certified V31 agreement ${round4(agreement.agreement)} over ` +
            `${agreement.spots} spots (${agreement.pureMisses} pure misses, ` +
            `${agreement.regretEligibleSpots} regret-eligible)`
        );
      } else {
        if (requiresV31Agreement) {
          throw new Error('the active certified V31 store returned no agreement reference');
        }
        console.log('[HorseLeague] certified V31 agreement skipped - the active store is empty');
      }
    } catch (err) {
      reportError(err, 'HorseLeague.agreement.v31');
      if (requiresV31Agreement) {
        throw new RequiredV31AgreementError(
          err instanceof Error ? err.message : 'certified V31 agreement failed'
        );
      }
    }

    const runSeed = (Date.parse(date) / 86_400_000) >>> 0;
    for (const m of card) {
      if (!shouldContinue()) break;
      // V13: a wall-clock budget. Even isolated analysis must not consume a
      // host core across the next run window. Stop cleanly and keep what
      // completed; partial results are still valid measurements.
      if (Date.now() - startedAt > runBudgetMs) {
        console.warn(
          `[HorseLeague] run ${date} hit its ${Math.round(runBudgetMs / 60000)}-minute budget ` +
            `after ${results.length}/${card.length} matchups - stopping cleanly. ` +
            `Unrun tonight: ${card
              .slice(results.length)
              .map((x) => x.name)
              .join(', ')} (they lead tomorrow's rotation)`
        );
        break;
      }
      const r = await compute.runMatchup(
        m,
        m.pairs ?? PAIRS_PER_MATCHUP,
        runSeed ^ hash32(m.name),
        shouldContinue
      );
      if (!shouldContinue()) break;
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
            truncated_streets: r.truncatedStreets,
            candidate_policy_hits: r.candidatePolicyHits,
            candidate_execution_mismatches: r.candidateExecutionMismatches,
            candidate_node_roles: r.candidateNodeRoles,
            candidate_benchmark_components: r.benchmarkComponents,
          },
          { onConflict: 'run_date,matchup' }
        );
        if (!shouldContinue()) break;
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
    if (err instanceof RequiredV31AgreementError) throw err;
  } finally {
    if (compute) {
      try {
        await compute.shutdown();
      } catch (err) {
        reportError(err, 'HorseLeague.compute_worker_shutdown');
      }
    }
    leagueRunning = false;
  }
  return results;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

function hash32(s: string): number {
  let h = 17;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
