/**
 * P15-A step 4: exact historical replay of one journaled Horse decision.
 *
 * Protocol: docs/horse-brain-phase15-2-historical-replay-2026-10-07.md. This
 * is the strict form of the Phase 6C replay (HorseDecisionReplay.ts), which it
 * builds on rather than duplicates. Phase 6C replays the original inputs on
 * whatever code runs it and reports both SHAs; this replays a record only on
 * the exact source that made it, from the record alone, with the clock frozen
 * and every worker-owned state restored from the record, and compares the
 * whole decision and its plan effects before it looks at acceptance.
 *
 *   replayed_exact             every compared field is equal.
 *   replayed_mismatch          the replay ran on the exact inputs and source;
 *                              `firstDifference` names the first field that
 *                              differs (compared in a fixed order).
 *   non_replayable:<input>     an input needed for exactness is missing or not
 *                              available to this process; nothing is
 *                              substituted for it.
 *
 * Isolation: the decision runs through the production worker runtime with no
 * journal, no plan application, no store refresh and no table; the Phase 8
 * sentinel, the governor override and both clocks are restored afterwards.
 * Only `replayed_exact` sets `replayVerified`.
 */
import { performance } from 'node:perf_hooks';
import type { HorseDecision } from '../../../types.js';
import {
  horseJournalJson,
  validateHorseJournalRecord,
  type HorseJournalRecord,
} from '../../../services/horseDecisionJournal/record.js';
import { horseDecisionEffectsAreValid } from '../../HorseDecisionEffects.js';
import {
  reconstructHorseReplayInput,
  HorseReplayRefusal,
  type HorseReplayInput,
} from './reconstruct.js';
import { qualifyHorseDecisionIndependently } from './independentQualification.js';
import { checkCitedReferences, type ReplaySolverStores } from './references.js';
import { replayThroughWorkerRuntime } from './runtimeReplay.js';
import { stableReceipt } from './HorseDecisionReplay.js';
import {
  HORSE_OPTIONAL_OWNER_OPTIONS,
  isHorseDecisionReplayState,
  type HorseDecisionReplayState,
} from '../replayState.js';

export const HORSE_EXACT_REPLAY_VERSION = 'horse-exact-replay-v1';

export type HorseExactReplayOutcome =
  | 'replayed_exact'
  | 'replayed_mismatch'
  | `non_replayable:${string}`;

/** Fields compared, in order; the first unequal one is the named mismatch. */
export const HORSE_EXACT_REPLAY_COMPARED = [
  'rng_before',
  'governor_scale',
  'decision',
  'rng_after',
  'effects',
  'plan_binding',
] as const;

export interface HorseExactReplayOptions {
  /** Full git SHA of the source this process runs. A record made by any other source is refused. */
  runningSource: string;
  /** Solver stores loaded into this process; defaults to the module stores. */
  stores?: ReplaySolverStores;
  /** Per recorded release, its commit time (for count-only store pins, as in Phase 6C). */
  releaseNotBeforeMs?: Readonly<Record<string, number>>;
  /**
   * The journal's execution record for this decision's turn. Undefined: the
   * source offers no acceptance evidence. Null: the source holds none for it.
   */
  execution?: unknown | null;
}

export interface HorseExactReplayAcceptance {
  /** The acceptance evidence this replay joins: the journal's execution witness. */
  source: 'journal_execution_witness';
  /** The durable accepted-effect receipt (P15-A steps 1 to 3) is not on this source. */
  durableEffectReceipt: 'unavailable';
  status: 'joined' | 'not_joined';
  reason: string | null;
  executionStatus: string | null;
  /** The witness's selected action equals the original (and so the replayed) decision. */
  selectedEqualsDecision: boolean | null;
  executed: { action: string | null; amount: number | null } | null;
  acceptedActions: number | null;
}

export interface HorseExactReplayVerdict {
  version: typeof HORSE_EXACT_REPLAY_VERSION;
  decisionId: string;
  recordedSource: string | null;
  runningSource: string;
  outcome: HorseExactReplayOutcome;
  firstDifference: string | null;
  /** True only for `replayed_exact`. */
  replayVerified: boolean;
  /** True when the original receipt shows a wall-clock work budget bound a non-shadow owner. */
  wallClockBudgetBound: boolean | null;
  original: { action: string; amount: number | null; rngAfter: number; effects: number } | null;
  replayed: { action: string; amount: number | null; rngAfter: number; effects: number } | null;
  context: {
    gameMode: string | null;
    format: string | null;
    variant: string | null;
    stage: string | null;
  };
  acceptance: HorseExactReplayAcceptance;
}

const SHA = /^[0-9a-f]{40}$/;
const obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Reason values a cooperative wall-clock budget writes into a receipt. */
const WALL_CLOCK_BUDGET_REASONS = new Set([
  'budget_exhausted',
  'sampler_budget_exhausted',
  'work_budget',
  'operation_budget',
  'continuation_operation_budget',
]);
function mentionsBudget(value: unknown): boolean {
  if (typeof value === 'string') return WALL_CLOCK_BUDGET_REASONS.has(value);
  if (Array.isArray(value)) return value.some(mentionsBudget);
  if (obj(value)) return Object.values(value).some(mentionsBudget);
  return false;
}

/** The journal's own portable JSON form (sorted keys, no undefined). */
const portable = (value: unknown): unknown => JSON.parse(horseJournalJson(value));

/** First path at which two portable values differ, or null when equal. */
export function firstHorseReplayDifference(a: unknown, b: unknown, path: string): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const d = firstHorseReplayDifference(a[i], b[i], `${path}[${i}]`);
        if (d) return d;
      }
      return `${path}.length`;
    }
    for (let i = 0; i < a.length; i++) {
      const d = firstHorseReplayDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (obj(a) && obj(b)) {
    // The action and its amount first: they are what the table accepts.
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => {
      const rank = (k: string) => (k === 'action' ? 0 : k === 'amount' ? 1 : 2);
      return rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0);
    });
    for (const key of keys) {
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return `${path}.${key}`;
      const d = firstHorseReplayDifference(a[key], b[key], `${path}.${key}`);
      if (d) return d;
    }
    return null;
  }
  return path;
}

/** Run `fn` with both clocks frozen; the originals are restored however it ends. */
export async function withFrozenHorseReplayClock<T>(
  decisionTimeMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const dateNow = Date.now;
  const ownNow = Object.getOwnPropertyDescriptor(performance, 'now');
  Date.now = () => decisionTimeMs;
  Object.defineProperty(performance, 'now', {
    value: () => FROZEN_MONOTONIC_MS,
    configurable: true,
    writable: true,
  });
  try {
    return await fn();
  } finally {
    Date.now = dateNow;
    if (ownNow) Object.defineProperty(performance, 'now', ownNow);
    else delete (performance as { now?: unknown }).now;
  }
}
/** Any constant: a frozen monotonic clock measures zero elapsed time. */
const FROZEN_MONOTONIC_MS = 1_000_000;

function joinAcceptance(
  execution: unknown,
  record: HorseJournalRecord,
  original: HorseDecision | null,
  decisionKey: string | null
): HorseExactReplayAcceptance {
  const out: HorseExactReplayAcceptance = {
    source: 'journal_execution_witness',
    durableEffectReceipt: 'unavailable',
    status: 'not_joined',
    reason: null,
    executionStatus: null,
    selectedEqualsDecision: null,
    executed: null,
    acceptedActions: null,
  };
  if (execution === undefined) return { ...out, reason: 'no_acceptance_source' };
  if (execution === null) return { ...out, reason: 'execution_record_absent' };
  try {
    validateHorseJournalRecord(execution);
  } catch {
    return { ...out, reason: 'execution_record_invalid' };
  }
  if (execution.kind !== 'execution' || execution.turnKey !== record.turnKey)
    return { ...out, reason: 'execution_record_other_turn' };
  let witness: Record<string, unknown>;
  try {
    witness = JSON.parse(execution.body) as Record<string, unknown>;
  } catch {
    return { ...out, reason: 'execution_record_invalid' };
  }
  const identity = witness.identity as { decisionKey?: unknown } | undefined;
  if (!obj(identity) || identity.decisionKey !== decisionKey)
    return { ...out, reason: 'execution_record_other_decision' };
  const selected = witness.selected as { action?: unknown; amount?: unknown } | undefined;
  return {
    ...out,
    status: 'joined',
    executionStatus: typeof witness.executionStatus === 'string' ? witness.executionStatus : null,
    selectedEqualsDecision:
      !!original &&
      obj(selected) &&
      selected.action === original.action &&
      (selected.amount ?? null) === (original.amount ?? null),
    executed: {
      action: typeof witness.executedAction === 'string' ? witness.executedAction : null,
      amount: typeof witness.executedAmount === 'number' ? witness.executedAmount : null,
    },
    acceptedActions: Array.isArray(witness.acceptedActions) ? witness.acceptedActions.length : null,
  };
}

function refusalInput(error: unknown): string {
  const reason =
    error instanceof HorseReplayRefusal ? error.reason : 'replay_input_incomplete:record';
  if (reason === 'replay_unsupported:DECIDE_DEEP')
    // A second look reads the FAST decision's read view the worker retained in
    // memory; the journal does not carry it as this decision's own input.
    return 'retained_fast_read_view';
  return reason.replace(/^replay_input_incomplete:/, '').replace(/^replay_unsupported:/, 'type:');
}

/** Replay one journal record on the running source and compare it with the record. */
export async function exactReplayHorseDecisionRecord(
  raw: unknown,
  options: HorseExactReplayOptions
): Promise<HorseExactReplayVerdict> {
  if (!SHA.test(options.runningSource))
    throw new Error('exact replay needs the full git SHA of the running source');
  const verdict: HorseExactReplayVerdict = {
    version: HORSE_EXACT_REPLAY_VERSION,
    decisionId: obj(raw) && typeof raw.eventId === 'string' ? raw.eventId : 'unknown',
    recordedSource: null,
    runningSource: options.runningSource,
    outcome: 'non_replayable:record',
    firstDifference: null,
    replayVerified: false,
    wallClockBudgetBound: null,
    original: null,
    replayed: null,
    context: { gameMode: null, format: null, variant: null, stage: null },
    acceptance: joinAcceptance(undefined, raw as HorseJournalRecord, null, null),
  };
  const finish = (outcome: HorseExactReplayOutcome): HorseExactReplayVerdict => {
    verdict.outcome = outcome;
    verdict.replayVerified = outcome === 'replayed_exact';
    return verdict;
  };
  // 1. The record's own digest holds, and it names the source that made it.
  try {
    validateHorseJournalRecord(raw);
  } catch {
    return finish('non_replayable:record');
  }
  const record = raw;
  verdict.recordedSource = record.sourceRelease;
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(record.body) as unknown;
    if (obj(parsed)) body = parsed;
  } catch {
    // reconstruct names the body refusal below
  }
  const snapshot = obj(body.snapshot) ? body.snapshot : null;
  const gs = snapshot && obj(snapshot.gameState) ? snapshot.gameState : null;
  if (gs)
    verdict.context = {
      gameMode: typeof gs.gameMode === 'string' ? gs.gameMode : null,
      format: typeof gs.format === 'string' ? gs.format : null,
      variant: typeof gs.gameVariant === 'string' ? gs.gameVariant : null,
      stage: typeof gs.stage === 'string' ? gs.stage : null,
    };
  const originalDecision = obj(body.decision) ? (body.decision as unknown as HorseDecision) : null;
  const decisionKey =
    snapshot && typeof snapshot.decisionKey === 'string' ? snapshot.decisionKey : null;
  const acceptance = () => joinAcceptance(options.execution, record, originalDecision, decisionKey);
  verdict.acceptance = acceptance();
  if (record.sourceRelease === null) return finish('non_replayable:source_release');
  if (record.sourceRelease !== options.runningSource)
    return finish('non_replayable:original_source');

  // 2. Every input from the record alone (Phase 6C reconstruction, digest-bound).
  let input: HorseReplayInput;
  try {
    input = reconstructHorseReplayInput(record);
  } catch (error) {
    return finish(`non_replayable:${refusalInput(error)}`);
  }
  if (!isHorseDecisionReplayState(body.replayState)) return finish('non_replayable:replay_state');
  const state: HorseDecisionReplayState = body.replayState;
  if (!horseDecisionEffectsAreValid(body.effects)) return finish('non_replayable:effects');
  if (!obj(body.planBinding)) return finish('non_replayable:plan_binding');
  verdict.original = {
    action: input.original.action,
    amount: input.original.amount ?? null,
    rngAfter: input.rngAfter,
    effects: body.effects.length,
  };

  // 3. The artifacts the decision consulted, by identity.
  const independent = qualifyHorseDecisionIndependently({
    player: input.request.player,
    gameState: input.request.gameState as never,
    opts: (input.request.opts as Record<string, unknown> | undefined) ?? null,
    attribution: (input.original.tournamentPreflopAttribution as never) ?? null,
  });
  const missing = checkCitedReferences({
    gameState: input.request.gameState,
    original: input.original,
    recorded: input.readiness,
    admissibleRoutes: independent.admissibleRoutes,
    postflopStoreConsultPossible: independent.postflopStoreConsultPossible,
    stores: options.stores,
    atMs: input.atMs,
    releaseNotBeforeMs: options.releaseNotBeforeMs?.[options.runningSource] ?? null,
  }).find((r) => r.status === 'unavailable');
  if (missing) return finish(`non_replayable:artifact:${missing.ref}`);

  // 4. The compiled worker decision path, clock frozen at the decision time,
  // worker-owned state restored from the record.
  const outcome = await withFrozenHorseReplayClock(input.request.decisionTimeMs, () =>
    replayThroughWorkerRuntime(input, {
      phase8SafetyDisabledReason: state.phase8SafetyDisabledReason,
    })
  );
  // An optional owner this process cannot admit the way the worker did is a
  // missing input (its authority state), never a substitution.
  for (const option of HORSE_OPTIONAL_OWNER_OPTIONS)
    if (outcome.result && outcome.admission?.[option] !== state.admission[option])
      return finish(`non_replayable:admission:${option}`);

  // 5. Compare decision and effects, in order.
  const original = stableReceipt(input.original);
  verdict.wallClockBudgetBound = mentionsBudget(original);
  let difference: string | null;
  if (!outcome.result) {
    difference = `runtime_result:${outcome.error?.message ?? 'none'}`;
  } else {
    const result = outcome.result;
    verdict.replayed = {
      action: result.decision.action,
      amount: result.decision.amount ?? null,
      rngAfter: result.rngAfter,
      effects: result.effects.length,
    };
    let replayedReceipt: unknown;
    let replayedEffects: unknown;
    let replayedBinding: unknown;
    try {
      replayedReceipt = portable(stableReceipt(result.decision));
      replayedEffects = portable(result.effects);
      replayedBinding = portable(result.planBinding);
    } catch {
      replayedReceipt = replayedEffects = replayedBinding = null;
    }
    difference =
      result.rngBefore !== input.rngBefore
        ? 'rng_before'
        : result.governorScale !== input.governorScale
          ? 'governor_scale'
          : replayedReceipt === null
            ? 'decision'
            : (firstHorseReplayDifference(original, replayedReceipt, 'decision') ??
              (result.rngAfter !== input.rngAfter ? 'rng_after' : null) ??
              firstHorseReplayDifference(body.effects, replayedEffects, 'effects') ??
              firstHorseReplayDifference(body.planBinding, replayedBinding, 'plan_binding'));
  }
  verdict.acceptance = acceptance();
  if (difference === null) return finish('replayed_exact');
  verdict.firstDifference = difference;
  // A budget that bound against the original's wall clock is an input the
  // journal does not carry (how much work fit); the frozen replay cannot know it.
  if (verdict.wallClockBudgetBound) return finish('non_replayable:wall_clock_budget');
  return finish('replayed_mismatch');
}
