/**
 * Phase 6C: exact-input replay of one journaled Horse decision with
 * independent qualification.
 *
 * Protocol: docs/horse-brain-phase6c-replay-protocol-2026-09-26.md.
 *
 *   reproduced  same accepted action AND same reference route AND the
 *               independent qualification agreed AND every cited reference
 *               was available.
 *   diverged    the replay ran under the same inputs and any of those differ.
 *   refused     the replay did not run, or cannot be trusted, for a named
 *               reason: replay_input_incomplete:<field>,
 *               replay_unsupported:<type>, reference_unavailable:<ref>,
 *               runtime_rejected:<message>, rng_stream_mismatch.
 *
 * Deterministic replay is not GTO strength; nothing here claims it.
 */
import { createHash } from 'node:crypto';
import type { HorseDecision } from '../../../types.js';
import type { HorsePolicyNode } from '../../HorsePolicyGraph.js';
import type { Phase6ReferenceRoute } from '../../HorsePhase6Attribution.js';
import {
  HorseReplayRefusal,
  reconstructHorseReplayInput,
  type HorseReplayInput,
} from './reconstruct.js';
import {
  qualifyHorseDecisionIndependently,
  type IndependentQualification,
} from './independentQualification.js';
import { checkCitedReferences, type ReplaySolverStores } from './references.js';
import { replayThroughWorkerRuntime } from './runtimeReplay.js';
import type {
  HorseDecisionReplayVerdict,
  HorseReplayAction,
  HorseReplayAuthorityOwner,
  HorseReplayQualification,
  HorseReplayReference,
} from './verdict.js';

export type { HorseDecisionReplayVerdict } from './verdict.js';
export { HorseReplayRefusal, reconstructHorseReplayInput } from './reconstruct.js';

export interface HorseDecisionReplayOptions {
  /** Git SHA of the decision code executing this replay. */
  engineSha: string;
  /** Solver stores visible to the replay; defaults to the live module stores. */
  stores?: ReplaySolverStores;
  /**
   * Per recorded release, the earliest instant a process running it can have
   * started (its commit time), for matching count-only records to a pinned
   * store snapshot. A release not listed is never matched to a pin.
   */
  releaseNotBeforeMs?: Readonly<Record<string, number>>;
}

export interface HorseJournalDecisionSource {
  /** Returns the raw journal record for one decision id (its eventId), or null. */
  recordById(decisionId: string): unknown | null;
}

const actionOf = (decision: HorseDecision | null | undefined): HorseReplayAction | null =>
  decision && typeof decision.action === 'string'
    ? { action: decision.action, amount: decision.amount ?? null }
    : null;

const sameAction = (a: HorseReplayAction | null, b: HorseReplayAction | null): boolean =>
  a !== null && b !== null && a.action === b.action && a.amount === b.amount;

/** The module that owns the accepted action, read from the decision's own receipts. */
export function horseReplayAuthority(
  decision: HorseDecision,
  stage: string | null = null
): HorseReplayAuthorityOwner {
  const route = (decision.tournamentPreflopAttribution?.route ??
    null) as Phase6ReferenceRoute | null;
  const variantOwner = decision.policyOwnership ? String(decision.policyOwnership.owner) : null;
  if (decision.policyFallback === 'brain_exception')
    return { module: 'brain_exception', node: 'brain_exception', route, variantOwner };
  const transitions = decision.policyGraph?.transitions ?? [];
  let node: HorsePolicyNode | null = transitions.length ? 'reference' : null;
  for (const t of transitions) if (t.changed) node = t.node;
  const module =
    node === null
      ? 'unknown'
      : node === 'reference'
        ? `reference:${route ?? (stage && stage !== 'preflop' ? 'postflop' : 'unattributed')}`
        : node === 'variant_policy'
          ? `variant_policy:${variantOwner ?? 'unknown'}`
          : node;
  return { module, node, route, variantOwner };
}

/** Wall-clock fields, and receipts of policies that ran in shadow mode under a
 * wall-clock work budget without owning the action, are the only parts of a
 * decision a faithful replay is allowed to change. Everything else in the
 * receipt is a function of the exact inputs and the RNG stream. */
const VOLATILE_KEY = /(?:elapsed|latency)Ms$/i;
const SHADOW_RECEIPTS = new Set([
  'jointPolicy',
  'plo4Policy',
  'omahaVariantPolicy',
  'remainingVariantPolicy',
  'tournamentPostflop',
]);
const isShadowReceipt = (value: unknown): boolean =>
  !!value &&
  typeof value === 'object' &&
  ((value as { applied?: unknown }).applied === false ||
    (value as { mode?: unknown }).mode === 'shadow');
export function stableReceipt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableReceipt);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (VOLATILE_KEY.test(key) || key === 'executionWitness') continue;
      if (SHADOW_RECEIPTS.has(key) && isShadowReceipt(item)) continue;
      if (key === 'policyOwnership' && isShadowReceipt(item)) {
        // A shadow owner's outcome is a work-budget observation; its identity is not.
        out[key] = stableReceipt(
          Object.fromEntries(
            Object.entries(item as Record<string, unknown>).filter(
              ([k]) => k !== 'outcome' && k !== 'reason'
            )
          )
        );
        continue;
      }
      out[key] = stableReceipt(item);
    }
    return out;
  }
  return value;
}
export function horseDecisionReceiptDigest(decision: HorseDecision): string {
  return createHash('sha256')
    .update(JSON.stringify(stableReceipt(decision)))
    .digest('hex');
}

function emptyQualification(original: HorseDecision | null): HorseReplayQualification {
  const na = {
    status: 'not_applicable' as const,
    expected: null,
    observed: null,
    detail: 'not_evaluated',
  };
  return {
    status: 'refused',
    checks: { pot_odds: na, m_state: na, ante_mode: na, atlas_coordinate: na, route: na },
    references: [],
    route: {
      original: (original?.tournamentPreflopAttribution?.route ??
        null) as Phase6ReferenceRoute | null,
      replayed: null,
    },
    atlasCell: {
      original: original?.tournamentPreflopAttribution?.lookup?.policy.cell ?? null,
      replayed: null,
    },
    rng: { before: { original: -1, replayed: null }, after: { original: -1, replayed: null } },
    receiptDigest: {
      original: original ? horseDecisionReceiptDigest(original) : '',
      replayed: null,
    },
  };
}

function qualificationFrom(
  input: HorseReplayInput,
  independent: IndependentQualification,
  references: HorseReplayReference[]
): HorseReplayQualification {
  const checks = {
    pot_odds: independent.pot_odds,
    m_state: independent.m_state,
    ante_mode: independent.ante_mode,
    atlas_coordinate: independent.atlas_coordinate,
    route: independent.route,
  };
  const disagreed = Object.values(checks).some((c) => c.status === 'disagreed');
  const unavailable = references.some((r) => r.status === 'unavailable');
  return {
    status: unavailable ? 'refused' : disagreed ? 'disagreed' : 'agreed',
    checks,
    references,
    route: {
      original: (input.original.tournamentPreflopAttribution?.route ??
        null) as Phase6ReferenceRoute | null,
      replayed: null,
    },
    atlasCell: {
      original: input.original.tournamentPreflopAttribution?.lookup?.policy.cell ?? null,
      replayed: null,
    },
    rng: {
      before: { original: input.rngBefore, replayed: null },
      after: { original: input.rngAfter, replayed: null },
    },
    receiptDigest: { original: horseDecisionReceiptDigest(input.original), replayed: null },
  };
}

function baseVerdict(
  raw: unknown,
  options: HorseDecisionReplayOptions
): HorseDecisionReplayVerdict {
  const record = raw as {
    eventId?: unknown;
    sourceRelease?: unknown;
    atMs?: unknown;
    body?: unknown;
  } | null;
  let original: HorseDecision | null = null;
  let context: HorseDecisionReplayVerdict['context'] = {
    atMs: null,
    gameMode: null,
    format: null,
    gameVariant: null,
    stage: null,
    tableSize: null,
    isHorse: null,
  };
  try {
    const body = JSON.parse(String(record?.body ?? 'null')) as {
      decision?: HorseDecision;
      snapshot?: { gameState?: Record<string, unknown>; player?: { is_horse?: boolean } };
    } | null;
    original = body?.decision ?? null;
    const gs = body?.snapshot?.gameState;
    if (gs)
      context = {
        atMs: typeof record?.atMs === 'number' ? record.atMs : null,
        gameMode: typeof gs.gameMode === 'string' ? gs.gameMode : null,
        format: typeof gs.format === 'string' ? gs.format : null,
        gameVariant: typeof gs.gameVariant === 'string' ? gs.gameVariant : null,
        stage: typeof gs.stage === 'string' ? gs.stage : null,
        tableSize: Array.isArray(gs.dealtSeatIds) ? gs.dealtSeatIds.length : null,
        isHorse: body?.snapshot?.player?.is_horse ?? null,
      };
  } catch {
    original = null;
  }
  return {
    decisionId: typeof record?.eventId === 'string' ? record.eventId : 'unknown',
    engineSha: options.engineSha,
    recordedRelease: typeof record?.sourceRelease === 'string' ? record.sourceRelease : null,
    status: 'refused',
    originalAction: actionOf(original),
    replayedAction: null,
    qualification: emptyQualification(original),
    latency: { wallMs: null, computeMs: null, originalComputeMs: null },
    work: {
      nodeVisits: null,
      originalNodeVisits: original?.policyGraph?.transitions.length ?? null,
      equityCalls: null,
      equitySamples: null,
      telemetryFires: null,
      governorScale: null,
    },
    authority: {
      original: original
        ? horseReplayAuthority(original, context.stage)
        : { module: 'unknown', node: null, route: null, variantOwner: null },
      replayed: null,
      same: null,
    },
    context,
  };
}

/** Replay one journal record (steps b through h) and return the fixed-shape verdict. */
export async function replayHorseDecisionRecord(
  raw: unknown,
  options: HorseDecisionReplayOptions
): Promise<HorseDecisionReplayVerdict> {
  const verdict = baseVerdict(raw, options);
  let input: HorseReplayInput;
  try {
    input = reconstructHorseReplayInput(raw);
  } catch (error) {
    verdict.reason =
      error instanceof HorseReplayRefusal
        ? error.reason
        : `replay_input_incomplete:${String((error as Error)?.message ?? error)}`;
    return verdict;
  }
  verdict.latency.originalComputeMs = input.computeMs;
  verdict.work.governorScale = input.governorScale;
  verdict.originalAction = actionOf(input.original);
  verdict.authority.original = horseReplayAuthority(input.original, input.request.gameState.stage);

  const independent = qualifyHorseDecisionIndependently({
    player: input.request.player,
    gameState: input.request.gameState as never,
    opts: (input.request.opts as Record<string, unknown> | undefined) ?? null,
    attribution: (input.original.tournamentPreflopAttribution as never) ?? null,
  });
  const references = checkCitedReferences({
    gameState: input.request.gameState,
    original: input.original,
    recorded: input.readiness,
    admissibleRoutes: independent.admissibleRoutes,
    postflopStoreConsultPossible: independent.postflopStoreConsultPossible,
    stores: options.stores,
    atMs: input.atMs,
    releaseNotBeforeMs: input.recordedRelease
      ? (options.releaseNotBeforeMs?.[input.recordedRelease] ?? null)
      : null,
  });
  verdict.qualification = qualificationFrom(input, independent, references);
  const missing = references.find((r) => r.status === 'unavailable');
  if (missing) {
    verdict.reason = `reference_unavailable:${missing.ref}`;
    return verdict;
  }

  const outcome = await replayThroughWorkerRuntime(input);
  verdict.latency.wallMs = outcome.wallMs;
  verdict.work.equityCalls = outcome.work.equityCalls;
  verdict.work.equitySamples = outcome.work.equitySamples;
  verdict.work.telemetryFires = outcome.work.telemetryFires;
  if (!outcome.result) {
    verdict.reason = `runtime_rejected:${outcome.error?.message ?? 'no terminal result'}`;
    return verdict;
  }
  const replayed = outcome.result.decision;
  verdict.replayedAction = actionOf(replayed);
  verdict.latency.computeMs = outcome.result.computeMs;
  verdict.work.nodeVisits = replayed.policyGraph?.transitions.length ?? null;
  verdict.authority.replayed = horseReplayAuthority(replayed, input.request.gameState.stage);
  verdict.authority.same = verdict.authority.replayed.module === verdict.authority.original.module;
  const q = verdict.qualification;
  q.rng.before.replayed = outcome.result.rngBefore;
  q.rng.after.replayed = outcome.result.rngAfter;
  q.route.replayed = (replayed.tournamentPreflopAttribution?.route ??
    null) as Phase6ReferenceRoute | null;
  q.atlasCell.replayed = replayed.tournamentPreflopAttribution?.lookup?.policy.cell ?? null;
  q.receiptDigest.replayed = horseDecisionReceiptDigest(replayed);

  if (outcome.result.rngBefore !== input.rngBefore) {
    verdict.reason = 'rng_stream_mismatch';
    return verdict;
  }
  const divergences: string[] = [];
  if (!sameAction(verdict.originalAction, verdict.replayedAction)) divergences.push('action');
  if (q.route.original !== q.route.replayed) divergences.push('route');
  if (q.atlasCell.original !== q.atlasCell.replayed) divergences.push('atlas_cell');
  if (q.status === 'disagreed')
    divergences.push(
      `qualification:${Object.entries(q.checks)
        .filter(([, c]) => c.status === 'disagreed')
        .map(([k]) => k)
        .join(',')}`
    );
  if (divergences.length) {
    verdict.status = 'diverged';
    verdict.reason = divergences.join(';');
    return verdict;
  }
  verdict.status = 'reproduced';
  if (outcome.result.rngAfter !== input.rngAfter) verdict.reason = 'rng_after_differs';
  else if (q.receiptDigest.original !== q.receiptDigest.replayed)
    verdict.reason = 'receipt_digest_differs';
  return verdict;
}

/** Step (a): load one journaled decision by id from a source and replay it. */
export async function replayHorseDecisionById(
  source: HorseJournalDecisionSource,
  decisionId: string,
  options: HorseDecisionReplayOptions
): Promise<HorseDecisionReplayVerdict> {
  const raw = source.recordById(decisionId);
  if (raw === null) {
    const verdict = baseVerdict({ eventId: decisionId }, options);
    verdict.reason = 'replay_input_incomplete:record';
    return verdict;
  }
  return replayHorseDecisionRecord(raw, options);
}
