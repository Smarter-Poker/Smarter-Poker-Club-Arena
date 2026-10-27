import type { HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';
import {
  deepOnePairCommitment,
  PHASE8_POLICY,
  type HorseTournamentPostflopLedger,
  type Phase8Mode,
} from './HorseTournamentPostflop.js';
export const CATASTROPHE_GUARD_VERSION = 'horse-tournament-catastrophe-guard-v1';
export interface HorseTournamentCatastropheGuardLedger extends Omit<
  HorseTournamentPostflopLedger,
  'version' | 'boundaries' | 'continuationPolicy' | 'continuationRetained'
> {
  version: typeof CATASTROPHE_GUARD_VERSION;
  policyFamily: 'catastrophe_guard_v1';
  workKind: 'phase7_candidate_guard';
  selectionRefusal?: 'downstream_owner' | 'illegal_candidate';
  guardPolicy: {
    version: typeof CATASTROPHE_GUARD_VERSION;
    maxCandidates: 16;
    deepStackBB: number;
    deepCommitFraction: number;
  };
  guardWork: { assessmentCompleted: boolean; candidateCount: number };
}
/** Isolated guard assessment. No rollout, sample, random draw or future-hand forecast. */
export function evaluateTournamentCatastropheGuard(
  hero: SeatPlayer,
  gs: HorseGameStateV2,
  baseline: HorseDecision,
  mode: Exclude<Phase8Mode, 'off'>,
  now: () => number
) {
  const start = now();
  const candidates = baseline.tournamentUtility?.candidates ?? [];
  const ledger: HorseTournamentCatastropheGuardLedger = {
    version: CATASTROPHE_GUARD_VERSION,
    policyFamily: 'catastrophe_guard_v1',
    workKind: 'phase7_candidate_guard',
    mode,
    eligible: false,
    fired: false,
    completed: false,
    changed: false,
    applied: false,
    selection: 'none',
    authority: null,
    authorityVerdict: null,
    reason: 'unavailable',
    reasons: [],
    baselineAction: baseline.action,
    baselineAmount: baseline.amount ?? null,
    candidateAction: baseline.action,
    candidateAmount: baseline.amount ?? null,
    objective: baseline.tournamentUtility?.objective ?? null,
    confidence: 'unavailable',
    futureGame: null,
    baselineFutureGame: null,
    guardPolicy: {
      version: CATASTROPHE_GUARD_VERSION,
      maxCandidates: 16,
      deepStackBB: PHASE8_POLICY.deepStackBB,
      deepCommitFraction: PHASE8_POLICY.deepCommitFraction,
    },
    guardWork: { assessmentCompleted: false, candidateCount: 0 },
    baselineCriticalCommitment: false,
    candidateCriticalCommitment: false,
    before: candidates,
    after: [],
    latencyMs: 0,
    simulationMs: 0,
    policyMs: 0,
    work: {
      attempts: 0,
      candidateCount: 0,
      candidatesCompleted: 0,
      outcomeSamples: 0,
      samplesVisited: 0,
      rollouts: 0,
      rolloutCacheHits: 0,
      estimates: 0,
      estimateCacheHits: 0,
      icmMethod: 'unavailable',
      levelBounds: 0,
      budgetStop: 'none',
    },
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
  };
  const finish = (reason: string, decision = baseline) => {
    ledger.reason = reason;
    ledger.latencyMs = Math.max(0, now() - start);
    ledger.policyMs = ledger.latencyMs;
    return { decision, ledger };
  };
  if (!['flop', 'turn', 'river'].includes(gs.stage)) return finish('not_postflop');
  if (gs.gameMode !== 'tournament' || gs.gameVariant !== 'nlh')
    return finish('unsupported_variant');
  if (gs.stateSchemaVersion !== 1 || gs.tournament?.contextStatus !== 'complete')
    return finish('context_incomplete');
  if ((gs.boardCount ?? 1) > 1 || gs.communityCards2?.length || gs.communityCards3?.length)
    return finish('multiple_boards');
  if (gs.players.some((p) => p.cards.length > 0)) return finish('private_state_rejected');
  if (!baseline.tournamentUtility) return finish('utility_unavailable');
  if (baseline.tournamentUtility.overrodeBaseline) return finish('phase7_choice_retained');
  const matches = (c: (typeof candidates)[number]) =>
    c.action === baseline.action &&
    (!['bet', 'raise'].includes(c.action) || c.amount === baseline.amount);
  if (!candidates.length || candidates.length > 16) return finish('candidate_budget');
  if (!(gs.legalActions ?? []).includes(baseline.action)) return finish('baseline_not_legal');
  ledger.guardWork.candidateCount = candidates.length;
  const base = candidates.find(matches);
  if (
    !base ||
    !Number.isFinite(base.investment) ||
    base.investment < 0 ||
    base.investment > hero.stack ||
    !Number.isFinite(base.stackConservationError) ||
    base.stackConservationError < 0 ||
    base.stackConservationError > 0.005
  )
    return finish('baseline_not_modeled');
  ledger.eligible = ledger.fired = ledger.completed = true;
  ledger.guardWork.assessmentCompleted = true;
  ledger.after = candidates;
  ledger.baselineCriticalCommitment = deepOnePairCommitment(hero, gs, base.investment);
  ledger.candidateCriticalCommitment = ledger.baselineCriticalCommitment;
  if (!ledger.baselineCriticalCommitment) return finish('guard_baseline_retained');
  const safe =
    candidates.find(
      (c) =>
        c.action === 'check' &&
        (gs.legalActions ?? []).includes('check') &&
        c.investment === 0 &&
        Number.isFinite(c.stackConservationError) &&
        c.stackConservationError >= 0 &&
        c.stackConservationError <= 0.005
    ) ??
    candidates.find(
      (c) =>
        c.action === 'fold' &&
        (gs.legalActions ?? []).includes('fold') &&
        c.investment === 0 &&
        Number.isFinite(c.stackConservationError) &&
        c.stackConservationError >= 0 &&
        c.stackConservationError <= 0.005
    );
  if (!safe) return finish('guard_safe_candidate_unavailable');
  ledger.changed = safe.action !== baseline.action;
  ledger.applied = mode === 'candidate' && ledger.changed;
  ledger.confidence = 'catastrophe_guard';
  ledger.reasons = ['deep_one_pair_commitment'];
  ledger.candidateAction = safe.action;
  ledger.candidateAmount = null;
  ledger.candidateCriticalCommitment = false;
  ledger.selection = ledger.applied ? 'selected' : ledger.changed ? 'shadow_change' : 'none';
  return finish(
    'guard_candidate_changed',
    ledger.applied ? { ...baseline, action: safe.action, amount: undefined } : baseline
  );
}
