import { qualifyHorseRetainedDecisionEffects, horseRetainedPlanContext } from './effects.js';
import { horsePlanHandKey } from '../../engine/HorseDecisionEffects.js';
import { horsePhase6AttributionMatchesSnapshot } from '../../engine/HorsePhase6Attribution.js';
import {
  anchorHorseDecisionHand,
  bindHorseDecisionToCommittedHand,
  horseCompletedHandKey,
  horseHandAnchorKey,
  horsePriorActionsDigest,
} from '../../engine/HorseDecisionHandBinding.js';
import {
  createHorseExecutionWitness,
  type HorseExecutionWitness,
} from '../../engine/HorseExecutionWitness.js';
import { decodeHorseDecisionReads } from '../../engine/HorseDecisionReadFrame.js';
import {
  buildHorseDecisionKey,
  type CompletedHandObservation,
  type FastHorseDecisionRequest,
  type DeepHorseDecisionRequest,
} from '../../engine/horseDecision/protocol.js';
import type { HorseDecision } from '../../types.js';
import {
  horseComputeMetadataIsValid,
  horseDecisionReceiptIsValid,
  horseSamplingStateIsValid,
} from '../../engine/horseDecision/responseValidation.js';
import {
  horseJournalJson,
  journalHash,
  validateHorseJournalRecord,
  type HorseJournalRecord,
} from './record.js';
import { HorseDecisionJournalStore } from './store.js';
import {
  horseLifecycleKeys,
  horseLifecycleRequestDigest,
  validateHorseRequestLifecycle,
  type HorseRequestLifecycle,
} from './lifecycle.js';
import {
  bindHorseDiscardExecutionToHand,
  horseDiscardHandKey,
  horseDiscardTurnKey,
  validateHorseDiscardDecision,
  validateHorseDiscardExecution,
  type HorseDiscardDecisionCapture,
  type HorseDiscardExecutionObservation,
} from './discard.js';

export type HorseJournalReviewGap =
  | 'request_lifecycle_missing'
  | 'request_lifecycle_conflict'
  | 'request_lifecycle_mismatch'
  | 'storage_unavailable'
  | 'invalid_records'
  | 'record_conflict'
  | 'accepted_hand_missing'
  | 'accepted_hand_conflict'
  | 'decision_missing'
  | 'execution_missing'
  | 'turn_conflict'
  | 'input_mismatch'
  | 'decision_effects_missing'
  | 'decision_effects_invalid'
  | 'read_frame_unavailable'
  | 'binding_unavailable'
  | 'multiple_decisions_for_action'
  | 'unmatched_horse_action'
  | 'fallback_lineage_unavailable'
  | 'action_origin_unavailable'
  | 'discard_decision_missing'
  | 'discard_execution_missing'
  | 'discard_capture_conflict'
  | 'discard_input_mismatch'
  | 'discard_binding_unavailable'
  | 'unmatched_discard_action';
export interface HorseJournalHandReview {
  version: 1;
  scope: 'single_retained_hand';
  status: 'reconciled' | 'incomplete' | 'unavailable';
  manifest: string | null;
  retainedRecords: number;
  acceptedHorseActions: number;
  matchedActions: number;
  retiredDecisions: number;
  discardDecisions: number;
  acceptedDiscardActions: number;
  matchedHorseDiscards: number;
  requestedRequests: number;
  terminalRequests: number;
  /** Only the retained request/result joins; never a full source population. */
  requestLifecycleVerified: boolean;
  gaps: HorseJournalReviewGap[];
  /** A finite local read cannot establish hands that never reached this spool. */
  completePopulation: false;
  replayVerified: false;
  gtoVerified: false;
  activationAllowed: false;
}
const empty = (): HorseJournalHandReview => ({
  version: 1,
  scope: 'single_retained_hand',
  status: 'unavailable',
  manifest: null,
  retainedRecords: 0,
  acceptedHorseActions: 0,
  matchedActions: 0,
  retiredDecisions: 0,
  discardDecisions: 0,
  acceptedDiscardActions: 0,
  matchedHorseDiscards: 0,
  requestedRequests: 0,
  terminalRequests: 0,
  requestLifecycleVerified: false,
  gaps: [],
  completePopulation: false,
  replayVerified: false,
  gtoVerified: false,
  activationAllowed: false,
});
const key = (x: {
  generation: number;
  fence: string;
  requestId: number;
  decisionKey: string;
  decisionTimeMs: number;
}) =>
  journalHash(
    JSON.stringify([x.generation, x.fence, x.requestId, x.decisionKey, x.decisionTimeMs])
  );
const same = (a: unknown, b: unknown) => horseJournalJson(a) === horseJournalJson(b);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uint = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
type Capture = {
  snapshot: FastHorseDecisionRequest | DeepHorseDecisionRequest;
  readFrame: Parameters<typeof decodeHorseDecisionReads>[0];
  decision: HorseDecision;
  rngBefore: number;
  rngAfter: number;
  computeMs: number;
  governorScale: number;
  effects?: unknown;
  lifecycleVersion?: unknown;
};

/** Inspect retained evidence without running a current policy against historical
 * inputs, mutating HorseMind, emitting private fields or treating absent source
 * as a zero-error population. A reconciled result proves only exact joins. */
export function reconcileHorseJournalHand(
  records: readonly HorseJournalRecord[],
  handKey: string
): HorseJournalHandReview {
  const out = empty();
  const gap = (reason: HorseJournalReviewGap) => {
    if (!out.gaps.includes(reason)) out.gaps.push(reason);
  };
  const effectsMatch = (
    capture: unknown,
    request: FastHorseDecisionRequest | DeepHorseDecisionRequest
  ): boolean => {
    const evidence = qualifyHorseRetainedDecisionEffects(capture, request);
    if (evidence.status === 'qualified') return true;
    gap(
      evidence.status === 'unavailable' ? 'decision_effects_missing' : 'decision_effects_invalid'
    );
    return false;
  };
  try {
    if (!/^[0-9a-f]{64}$/.test(handKey) || !Array.isArray(records) || records.length > 256)
      throw Error();
    let bytes = 0;
    const unique = new Map<string, HorseJournalRecord>();
    for (const record of records) {
      validateHorseJournalRecord(record);
      bytes += Buffer.byteLength(horseJournalJson(record));
      if (record.handKey !== handKey || bytes > 8 * 1024 * 1024) throw Error();
      const old = unique.get(record.eventId);
      if (old && !same(old, record)) {
        gap('record_conflict');
        return out;
      }
      unique.set(record.eventId, record);
    }
    const rows = [...unique.values()];
    out.retainedRecords = rows.length;
    out.manifest = journalHash(
      JSON.stringify(
        rows.map((r) => [r.eventId, r.sha256]).sort((a, b) => a[0]!.localeCompare(b[0]!))
      )
    );
    let hand: CompletedHandObservation | undefined;
    const turns = new Map<
      string,
      { decisions: HorseJournalRecord[]; executions: HorseJournalRecord[] }
    >();
    const discards = new Map<
      string,
      { decisions: HorseJournalRecord[]; executions: HorseJournalRecord[] }
    >();
    const lifecycles = new Map<
      string,
      { requested: HorseJournalRecord[]; terminal: HorseJournalRecord[] }
    >();
    for (const row of rows) {
      if (row.kind === 'accepted_hand') {
        const raw = JSON.parse(row.body);
        // FIFO request IDs are transport identities and may change on replay.
        const candidate: CompletedHandObservation = {
          generation: raw.generation,
          fence: raw.fence,
          handKey: raw.handKey,
          committedHandId: raw.committedHandId,
          actions: raw.actions,
          bigBlind: raw.bigBlind,
          showdown: raw.showdown,
          scope: raw.scope,
        };
        const coordinate = horseCompletedHandKey(candidate);
        if (
          !coordinate ||
          journalHash(coordinate) !== handKey ||
          row.turnKey !== handKey ||
          !uuid.test(candidate.committedHandId ?? '') ||
          !Array.isArray(candidate.actions) ||
          !horsePriorActionsDigest(candidate.actions) ||
          !(candidate.bigBlind > 0) ||
          !Number.isFinite(candidate.bigBlind)
        )
          throw Error();
        if (hand && !same(hand, candidate)) {
          gap('accepted_hand_conflict');
          return out;
        }
        hand = candidate;
      } else if (row.kind === 'request_lifecycle') {
        const payload: HorseRequestLifecycle = JSON.parse(row.body);
        validateHorseRequestLifecycle(payload);
        const k = `${row.producerId}:${row.turnKey}`;
        const lifecycle = lifecycles.get(k) ?? { requested: [], terminal: [] };
        lifecycle[payload.phase].push(row);
        if (payload.phase === 'requested') out.requestedRequests++;
        else out.terminalRequests++;
        lifecycles.set(k, lifecycle);
      } else if (row.kind === 'discard_decision' || row.kind === 'discard_execution') {
        const k = `${row.producerId}:${row.turnKey}`;
        const turn = discards.get(k) ?? { decisions: [], executions: [] };
        (row.kind === 'discard_decision' ? turn.decisions : turn.executions).push(row);
        if (row.kind === 'discard_decision') out.discardDecisions++;
        discards.set(k, turn);
      } else {
        const k = `${row.producerId}:${row.turnKey}`;
        const turn = turns.get(k) ?? { decisions: [], executions: [] };
        (row.kind === 'decision' ? turn.decisions : turn.executions).push(row);
        turns.set(k, turn);
      }
    }
    let lifecycleComplete = lifecycles.size > 0;
    const lifecycleGap = (reason: HorseJournalReviewGap) => {
      lifecycleComplete = false;
      gap(reason);
    };
    for (const [k, lifecycle] of lifecycles) {
      if (lifecycle.requested.length > 1 || lifecycle.terminal.length > 1) {
        lifecycleGap('request_lifecycle_conflict');
        continue;
      }
      if (lifecycle.requested.length !== 1 || lifecycle.terminal.length !== 1) {
        lifecycleGap('request_lifecycle_missing');
        continue;
      }
      const requested = lifecycle.requested[0]!,
        terminal = lifecycle.terminal[0]!;
      const admission: HorseRequestLifecycle = JSON.parse(requested.body),
        end: HorseRequestLifecycle = JSON.parse(terminal.body);
      try {
        if (admission.phase !== 'requested' || end.phase !== 'terminal') throw Error();
        const identity = horseLifecycleKeys(admission.request);
        if (
          requested.sequence >= terminal.sequence ||
          requested.sourceRelease !== terminal.sourceRelease ||
          admission.requestDigest !== end.requestDigest ||
          journalHash(identity.hand) !== handKey ||
          journalHash(identity.turn) !== requested.turnKey ||
          requested.turnKey !== terminal.turnKey ||
          (admission.origin === 'client_not_dispatched' &&
            !['cancelled', 'expired'].includes(end.outcome)) ||
          (end.outcome === 'refused' && admission.request.type !== 'DECIDE_DEEP')
        )
          throw Error();
        const result = admission.request.type === 'DECIDE_DISCARD' ? discards.get(k) : turns.get(k);
        const decision = result?.decisions[0];
        if (end.outcome === 'success' || (end.outcome === 'exception' && decision)) {
          if (
            !decision ||
            result!.decisions.length !== 1 ||
            decision.sequence <= requested.sequence ||
            decision.sequence >= terminal.sequence ||
            decision.sourceRelease !== requested.sourceRelease ||
            result!.executions.some((execution) => execution.sequence <= terminal.sequence)
          )
            throw Error();
          const capture = JSON.parse(decision.body);
          // Bind the retained sampling, compute and policy receipt contract
          // before lifecycle qualification, including when execution is absent.
          // This is not a claim that every live transport predicate is replayed.
          if (admission.request.type === 'DECIDE_DISCARD') {
            validateHorseDiscardDecision(capture);
          } else if (
            !horseSamplingStateIsValid(capture.rngBefore) ||
            !horseSamplingStateIsValid(capture.rngAfter) ||
            (admission.request.type === 'DECIDE_DEEP' &&
              capture.rngBefore !== admission.request.rngBefore) ||
            !horseComputeMetadataIsValid(capture) ||
            !horseDecisionReceiptIsValid(
              capture.decision,
              admission.request.gameState.gameVariant
            ) ||
            !horsePhase6AttributionMatchesSnapshot(capture.decision, admission.request) ||
            !effectsMatch(capture, admission.request)
          ) {
            throw Error();
          }
          if (
            horseLifecycleRequestDigest(capture.snapshot) !== admission.requestDigest ||
            (end.outcome === 'exception' &&
              capture.decision?.policyFallback !== 'brain_exception') ||
            (end.outcome === 'success' && capture.decision?.policyFallback === 'brain_exception')
          )
            throw Error();
        } else if (result && (result.decisions.length || result.executions.length)) throw Error();
      } catch {
        lifecycleGap('request_lifecycle_mismatch');
      }
    }
    for (const [k, turn] of [...turns, ...discards]) {
      if (
        turn.decisions.some((row) => {
          const version = JSON.parse(row.body).lifecycleVersion;
          return version !== undefined && version !== 1;
        })
      )
        lifecycleGap('request_lifecycle_mismatch');
      if (!lifecycles.has(k)) {
        lifecycleComplete = false;
        // Preserve legacy structural joins, but never upgrade them to verified
        // request lifecycle. New producers explicitly require both records.
        if (turn.decisions.some((row) => JSON.parse(row.body).lifecycleVersion !== undefined))
          gap('request_lifecycle_missing');
      }
    }
    out.requestLifecycleVerified = lifecycleComplete;
    if (!hand) {
      gap('accepted_hand_missing');
      return out;
    }
    const expected = new Set<number>();
    hand.actions!.forEach((action, i) => {
      if (action.action === 'discard') out.acceptedDiscardActions++;
      else if (action.origin === 'horse_policy') expected.add(i);
      else if (action.origin === 'horse_fallback') gap('fallback_lineage_unavailable');
      else if (!['player', 'pre_action', 'forced'].includes(action.origin ?? ''))
        gap('action_origin_unavailable');
    });
    const discardMatches = new Map<number, number>();
    for (const turn of discards.values()) {
      if (turn.decisions.length > 1 || turn.executions.length > 1) {
        gap('discard_capture_conflict');
        continue;
      }
      if (!turn.decisions.length) {
        gap('discard_decision_missing');
        continue;
      }
      if (!turn.executions.length) {
        gap('discard_execution_missing');
        continue;
      }
      const dRecord = turn.decisions[0]!,
        eRecord = turn.executions[0]!;
      try {
        const d: HorseDiscardDecisionCapture = JSON.parse(dRecord.body);
        const e: HorseDiscardExecutionObservation = JSON.parse(eRecord.body);
        validateHorseDiscardDecision(d);
        validateHorseDiscardExecution(e);
        if (
          !same(d.snapshot, e.request) ||
          d.cardIndex !== e.selectedIndex ||
          journalHash(horseDiscardTurnKey(d.snapshot)) !== dRecord.turnKey ||
          journalHash(horseDiscardTurnKey(e.request)) !== eRecord.turnKey ||
          journalHash(horseDiscardHandKey(d.snapshot)!) !== handKey ||
          dRecord.sequence >= eRecord.sequence ||
          dRecord.sourceRelease !== eRecord.sourceRelease
        )
          throw Error();
        const ordinal = bindHorseDiscardExecutionToHand(e, hand);
        if (ordinal === null) {
          gap('discard_binding_unavailable');
          continue;
        }
        discardMatches.set(ordinal, (discardMatches.get(ordinal) ?? 0) + 1);
      } catch {
        gap('discard_input_mismatch');
      }
    }
    hand.actions!.forEach((action, i) => {
      if (action.action !== 'discard') return;
      const count = discardMatches.get(i) ?? 0;
      if (count === 1) out.matchedHorseDiscards++;
      else if (count > 1) gap('discard_capture_conflict');
      // A human/forced discard does not imply a missing Horse decision.
      // Legacy unknown origin remains unknown unless this exact private join
      // established the actor and physical controller choice.
      else if (!['player', 'forced', 'pre_action'].includes(action.origin ?? ''))
        gap('unmatched_discard_action');
    });
    out.acceptedHorseActions = expected.size;
    const matches = new Map<number, number>();
    for (const turn of turns.values()) {
      if (turn.decisions.length > 1 || turn.executions.length > 1) {
        gap('turn_conflict');
        continue;
      }
      if (!turn.decisions.length) {
        gap('decision_missing');
        continue;
      }
      if (!turn.executions.length) {
        gap('execution_missing');
        continue;
      }
      const decisionRecord = turn.decisions[0]!,
        executionRecord = turn.executions[0]!;
      try {
        const d: Capture = JSON.parse(decisionRecord.body),
          w: HorseExecutionWitness = JSON.parse(executionRecord.body),
          s = d.snapshot;
        if (
          !s ||
          !['DECIDE_FAST', 'DECIDE_DEEP'].includes(s.type) ||
          !uint(s.requestId) ||
          !uint(s.generation) ||
          !uint(s.decisionTimeMs) ||
          s.decisionKey !== buildHorseDecisionKey(s) ||
          key(s) !== decisionRecord.turnKey ||
          !horseSamplingStateIsValid(d.rngBefore) ||
          !horseSamplingStateIsValid(d.rngAfter) ||
          !horseComputeMetadataIsValid(d) ||
          !horseDecisionReceiptIsValid(d.decision, s.gameState.gameVariant) ||
          !effectsMatch(d, s) ||
          (s.type === 'DECIDE_DEEP' &&
            (s.rngBefore !== d.rngBefore || !Number.isFinite(s.deepEquity) || s.deepEquity <= 1)) ||
          decisionRecord.sequence >= executionRecord.sequence ||
          decisionRecord.sourceRelease !== executionRecord.sourceRelease
        )
          throw Error();
        if (!horsePhase6AttributionMatchesSnapshot(d.decision, s)) throw Error();
        const anchor = anchorHorseDecisionHand(s);
        if (anchor.status !== 'anchored' || journalHash(horseHandAnchorKey(anchor)) !== handKey)
          throw Error();
        const expectedWitness = createHorseExecutionWitness(s, d.decision, {
          requestId: s.requestId,
          lane: s.type === 'DECIDE_FAST' ? 'fast' : 'deep',
          computeMs: d.computeMs,
          governorScale: d.governorScale,
        });
        if (
          w.version !== 'horse-execution-witness-v4' ||
          key(w.identity) !== executionRecord.turnKey ||
          !same(w.handAnchor, anchor) ||
          !same(w.identity, expectedWitness.identity) ||
          !same(w.selected, expectedWitness.selected) ||
          !same(w.policyOwnership, expectedWitness.policyOwnership) ||
          !same(w.policyGraph, expectedWitness.policyGraph) ||
          !same(w.phase6Attribution ?? null, expectedWitness.phase6Attribution ?? null) ||
          w.policyFallback !== expectedWitness.policyFallback ||
          w.expectedExecutionAmount !== expectedWitness.expectedExecutionAmount ||
          w.computeMs !== d.computeMs ||
          w.governorScale !== d.governorScale ||
          !Array.isArray(w.acceptedActions)
        )
          throw Error();
        try {
          const plan = horseRetainedPlanContext(d, s);
          if (plan.kind === 'invalid') throw Error('invalid retained plan identity');
          const planContext = plan.kind === 'current' ? plan.context : undefined;
          decodeHorseDecisionReads(
            d.readFrame,
            s.gameState.players,
            horsePlanHandKey(s.gameState.actionHistory, planContext),
            planContext
          );
        } catch {
          gap('read_frame_unavailable');
          continue;
        }
        if (
          w.executionStatus === 'not_executed' &&
          w.acceptedActions.length === 0 &&
          [
            'caller_settled',
            'turn_abandoned',
            'response_fence',
            'second_look_replaced',
            'second_look_unchanged',
            'brain_exception',
            'action_rejected',
          ].includes(w.retirementReason ?? '') &&
          w.executedAction === null &&
          w.executedAmount === null
        ) {
          out.retiredDecisions++;
          continue;
        }
        // Reconcile the final controller fact as well as the original selection.
        const accepted = w.acceptedActions[0];
        if (
          !accepted ||
          w.acceptedActions.length !== 1 ||
          accepted.intended !== true ||
          !['intended', 'coerced'].includes(w.executionStatus) ||
          w.retirementReason !== null ||
          w.policyFallback === 'brain_exception' ||
          w.executedAction !== accepted.record.action ||
          w.executedAmount !==
            (['fold', 'check'].includes(accepted.record.action) ? null : accepted.record.amount) ||
          (w.executionStatus === 'intended') !==
            (accepted.record.action === w.selected.action &&
              accepted.record.amount === w.expectedExecutionAmount)
        ) {
          gap('binding_unavailable');
          continue;
        }
        const binding = bindHorseDecisionToCommittedHand(w, hand);
        if (binding.status !== 'bound') {
          gap('binding_unavailable');
          continue;
        }
        matches.set(binding.actionOrdinal, (matches.get(binding.actionOrdinal) ?? 0) + 1);
      } catch {
        gap('input_mismatch');
      }
    }
    for (const ordinal of expected) {
      const count = matches.get(ordinal) ?? 0;
      if (count === 1) out.matchedActions++;
      else gap(count > 1 ? 'multiple_decisions_for_action' : 'unmatched_horse_action');
    }
    out.status = out.gaps.length ? 'incomplete' : 'reconciled';
    return out;
  } catch {
    gap('invalid_records');
    return out;
  }
}

/** Explicit offline reader. No implicit creation, migration, export, deletion,
 * journal write or policy activation is permitted by this entry point. */
export function readHorseJournalHand(directory: string, handKey: string): HorseJournalHandReview {
  let store: HorseDecisionJournalStore | undefined;
  try {
    store = new HorseDecisionJournalStore(directory, { readOnly: true });
    return reconcileHorseJournalHand(store.readHand(handKey), handKey);
  } catch {
    return { ...empty(), gaps: ['storage_unavailable'] };
  } finally {
    try {
      store?.close();
    } catch {
      /* read-only connection cleanup */
    }
  }
}
