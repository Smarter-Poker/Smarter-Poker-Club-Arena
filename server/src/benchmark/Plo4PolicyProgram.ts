/** Offline independent-equity adapter for the same bounded pack used by HorseLogic.
 * Oracle work stays off the live action clock. Tournament proposals must be priced
 * by HorseLogic's Phase 7 owner before execution; this adapter cannot authorize one.
 */
import type { HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from '../engine/HorseLogic.js';
import { calculateRake } from '../engine/PokerEngine.js';
import { omahaDrawQuality, omahaMadeClass, omahaNutStatus } from '../engine/HorseEval.js';
import {
  PLO4_POLICY_PACK,
  plo4HandShape,
  type Plo4NodeRole,
  type Plo4Position,
} from '../engine/plo4/Plo4PolicyPack.js';
import { evaluatePlo4LivePolicy, type Plo4LiveReceipt } from '../engine/plo4/Plo4LivePolicy.js';
import {
  evaluateOmahaEquity,
  type OmahaRange,
  type OmahaEquityResult,
} from './OmahaEquityOracle.js';
import { plo4PublicRanges } from './Plo4PublicRanges.js';
export type Plo4PolicyMode = 'off' | 'shadow' | 'candidate';
export interface Plo4PolicyInput {
  hero: SeatPlayer;
  state: HorseGameStateV2;
  baseline: HorseDecision;
  mode?: Plo4PolicyMode;
  seed: number;
  samples?: number;
  straddleBB?: number;
  opponentRanges?: Record<string, OmahaRange>;
}
export interface Plo4PolicyReceipt {
  packVersion: string;
  mode: Plo4PolicyMode;
  eligible: boolean;
  applied: boolean;
  reason: string;
  role: Plo4NodeRole | null;
  position: Plo4Position | null;
  confidence: 'uncalibrated_heuristic' | 'conditional_range_interval' | 'baseline';
  selected: HorseDecision;
  proposal: HorseDecision;
  shape: ReturnType<typeof plo4HandShape> | null;
  made: ReturnType<typeof omahaMadeClass> | null;
  draws: ReturnType<typeof omahaDrawQuality> | null;
  nuts: ReturnType<typeof omahaNutStatus> | null;
  equity: OmahaEquityResult | null;
  rangeBasis: 'explicit_ranges' | 'public_line_conditioned_heuristic';
  callEvInterval: [number, number] | null;
  elapsedMs: number;
  livePolicy: Plo4LiveReceipt | null;
}
export async function evaluatePlo4Policy(
  input: Plo4PolicyInput,
  shouldContinue = () => true
): Promise<Plo4PolicyReceipt> {
  const start = performance.now();
  const { hero, baseline } = input;
  // Offline fixtures may carry extra private fields. Never forward/read them.
  const s = { ...input.state, players: input.state.players.map((p) => ({ ...p, cards: [] })) };
  const mode = input.mode ?? 'shadow';
  const receipt: Plo4PolicyReceipt = {
    packVersion: PLO4_POLICY_PACK.version,
    mode,
    eligible: false,
    applied: false,
    reason: 'off',
    role: null,
    position: null,
    confidence: 'baseline',
    selected: baseline,
    proposal: baseline,
    shape: null,
    made: null,
    draws: null,
    nuts: null,
    equity: null,
    rangeBasis: input.opponentRanges ? 'explicit_ranges' : 'public_line_conditioned_heuristic',
    callEvInterval: null,
    elapsedMs: 0,
    livePolicy: null,
  };
  const finish = (reason: string, proposal = baseline) => {
    receipt.reason = reason;
    receipt.proposal = proposal;
    receipt.selected =
      mode === 'candidate' && receipt.eligible && s.gameMode !== 'tournament' ? proposal : baseline;
    receipt.applied =
      receipt.selected.action !== baseline.action ||
      (['bet', 'raise'].includes(receipt.selected.action) &&
        receipt.selected.amount !== baseline.amount);
    receipt.elapsedMs = performance.now() - start;
    return receipt;
  };
  if (!['off', 'shadow', 'candidate'].includes(mode)) throw new Error('Unknown PLO4 policy mode');
  if (mode === 'off') return finish('off');
  if (!shouldContinue()) return finish('cancelled');
  if (!Number.isInteger(input.seed) || input.seed < 1 || input.seed > 0xffffffff)
    return finish('invalid_seed');
  if (s.straddleActive && input.straddleBB !== 2) return finish('unknown_or_unsupported_straddle');
  const count = input.samples ?? PLO4_POLICY_PACK.defaultSamples;
  if (!Number.isInteger(count) || count < 1 || count > PLO4_POLICY_PACK.maxSamples)
    return finish('sample_budget_outside_pack');
  let core = evaluatePlo4LivePolicy(hero, s, baseline, null, mode, () => 0);
  receipt.livePolicy = core.receipt;
  receipt.eligible = core.receipt.eligible;
  receipt.role = core.receipt.role;
  receipt.position = core.receipt.position;
  if (!receipt.eligible) return finish(core.receipt.reason);
  receipt.shape = plo4HandShape(hero.cards);
  receipt.confidence = 'uncalibrated_heuristic';
  if (s.stage === 'preflop')
    return finish(
      s.gameMode === 'tournament' ? 'phase7_utility_required' : core.receipt.reason,
      core.proposal
    );
  receipt.made = omahaMadeClass(hero.cards, s.communityCards);
  receipt.draws = omahaDrawQuality(hero.cards, s.communityCards, false);
  receipt.nuts = omahaNutStatus(hero.cards, s.communityCards);
  const seats = s.players.filter((p) => !p.is_sitting_out);
  if (
    input.opponentRanges &&
    (Object.keys(input.opponentRanges).length !== seats.length - 1 ||
      seats.some(
        (p) => p.user_id !== hero.user_id && !Object.hasOwn(input.opponentRanges!, p.user_id)
      ))
  )
    return finish('incomplete_opponent_ranges');
  const ranges = input.opponentRanges ?? plo4PublicRanges(hero, s, input.seed);
  const callCost = Math.min(hero.stack, s.toCall ?? 0);
  const players = seats.map((p) => ({
    id: p.user_id,
    seat: p.seat,
    folded: p.is_folded,
    contributed:
      Math.round((p.totalInvested + (p.user_id === hero.user_id ? callCost : 0)) * 100) / 100,
    range:
      p.user_id === hero.user_id
        ? { combos: [{ cards: hero.cards, weight: 1 }] }
        : ranges[p.user_id],
  }));
  try {
    const exact = players.reduce(
      (n, p) => n * ('combos' in p.range ? p.range.combos.length : Infinity),
      1
    );
    const equity = await evaluateOmahaEquity(
      {
        variant: 'plo4',
        heroId: hero.user_id,
        players,
        boards: [s.communityCards],
        dealerSeat: s.dealerSeat!,
        chipUnit: s.gameMode === 'tournament' ? 1 : 0.01,
        mode:
          input.opponentRanges && s.stage === 'river' && exact <= 4096 ? 'exact_river' : 'sampled',
        samples: count,
        seed: input.seed,
      },
      shouldContinue
    );
    receipt.equity = equity;
    if (!equity.complete) return finish(`equity_${equity.reason}`);
    const total =
      players.reduce((n, p) => n + p.contributed, 0) -
      Object.values(equity.refunds).reduce((n, v) => n + v, 0);
    const rake = calculateRake(total, true, s.rakeConfig!, seats.length);
    const net = equity.eligiblePot * Math.max(0, 1 - rake / Math.max(0.01, total));
    receipt.callEvInterval = equity.confidence99.map((q) => q * net - callCost) as [number, number];
    const halfWidth = Math.max(
      equity.equity - equity.confidence99[0],
      equity.confidence99[1] - equity.equity
    );
    core = evaluatePlo4LivePolicy(
      hero,
      s,
      baseline,
      { equity: equity.equity, samples: count, standardError: halfWidth / 2.576 },
      mode,
      () => 0
    );
    receipt.livePolicy = core.receipt;
    receipt.confidence = 'conditional_range_interval';
    // Core texture policy owns future betting; exact terminal call prices are a
    // separate independent regression witness, never a generic raise-EV claim.
    return finish(
      s.gameMode === 'tournament' ? 'phase7_utility_required' : core.receipt.reason,
      core.proposal
    );
  } catch {
    return finish('invalid_or_incompatible_equity_request');
  }
}
