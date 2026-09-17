/** PREPARED, UNEXECUTED. Synthetic journal-boundary laws, not real worker,
 * controller, source-authority, strategic-strength or replay evidence. */
import { describe, expect, it } from 'vitest';
import { HorseLogic } from '../../../engine/HorseLogic.js';
import { seedFastRandom, saveFastRandom } from '../../../engine/HorseEval.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
} from '../../../engine/HorseExecutionWitness.js';
import { horseDecisionReceiptIsValid } from '../../../engine/horseDecision/responseValidation.js';
import { horsePhase6AttributionMatchesSnapshot } from '../../../engine/HorsePhase6Attribution.js';
import { encodeHorseDecisionReads } from '../../../engine/HorseDecisionReadFrame.js';
import { HorseMind } from '../../../engine/HorseMind.js';
import {
  horseLifecycleRequestDigest,
  horseLifecycleKeys,
} from '../../../services/horseDecisionJournal/lifecycle.js';
import {
  journalHash,
  makeHorseJournalRecord,
  type HorseJournalRecord,
} from '../../../services/horseDecisionJournal/record.js';
import { reconcileHorseJournalHand } from '../../../services/horseDecisionJournal/review.js';
import type {
  DeepHorseDecisionRequest,
  FastHorseDecisionRequest,
} from '../../../engine/horseDecision/protocol.js';
import { fixture, request, TABLE, HAND } from './fixture.js';

const faults = [
  'valid',
  'disabled_chart_route',
  'nlh_variant_route',
  'missing_reference_graph',
  'governor_above_one',
  'rng_before_negative',
  'rng_before_overflow',
  'rng_after_negative',
  'rng_after_overflow',
] as const;
const cases = (['fast', 'deep'] as const).flatMap((lane) =>
  [false, true].flatMap((execution) => {
    const laneFaults = lane === 'deep' ? [...faults, 'deep_rng_before_mismatch' as const] : faults;
    return laneFaults.map((fault) => ({ lane, execution, fault }));
  })
);

describe('composed receipt validation precedes lifecycle qualification', () => {
  it.each(cases)('$lane / execution=$execution / $fault', ({ lane, execution, fault }) => {
    const f = fixture();
    seedFastRandom(901791);
    const rngBefore = saveFastRandom();
    const original = HorseLogic.decide(f.hero, f.state, 'balanced', {}, f.opts);
    const rngAfter = saveFastRandom();
    const fast = request(f);
    const snapshot: FastHorseDecisionRequest | DeepHorseDecisionRequest =
      lane === 'fast' ? fast : { ...fast, type: 'DECIDE_DEEP', rngBefore, deepEquity: 2 };
    const decision = structuredClone(original);
    expect(decision.tournamentPreflopAttribution?.route).toBe('intent_engine');
    expect(snapshot.opts?.v27GtoCharts).toBe(false);
    if (fault === 'disabled_chart_route' || fault === 'nlh_variant_route') {
      const receipt = decision.tournamentPreflopAttribution!;
      receipt.route = fault === 'disabled_chart_route' ? 'chart_open_jam' : 'variant_price';
      receipt.reason = fault === 'disabled_chart_route' ? 'chart_return' : 'variant_price_return';
      receipt.status = 'bypassed';
      receipt.forwardedToIntentEngine = false;
      // These are internally coherent receipts. Their actual request forbids
      // the claimed route, so structure/hash equality alone cannot qualify them.
      expect(horseDecisionReceiptIsValid(decision, 'nlh')).toBe(true);
      expect(horsePhase6AttributionMatchesSnapshot(decision, snapshot)).toBe(false);
    }
    if (fault === 'missing_reference_graph') delete decision.policyGraph;
    const governorScale = fault === 'governor_above_one' ? 2 : 1;
    const witness = createHorseExecutionWitness(snapshot, decision, {
      requestId: snapshot.requestId,
      lane,
      computeMs: 1,
      governorScale,
    });
    const accepted = {
      seat: snapshot.player.seat,
      userId: snapshot.player.user_id,
      action: decision.action,
      amount: witness.expectedExecutionAmount!,
      stage: 'preflop' as const,
      timestamp: 1001,
    };
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: [{ record: accepted, intended: true }],
    });
    const capture = {
      snapshot,
      decision,
      rngBefore,
      rngAfter,
      computeMs: 1,
      governorScale,
      ...(lane === 'fast' ? { effects: [] } : {}),
      lifecycleVersion: 1,
      runtimePins: 'incomplete',
      readFrame: encodeHorseDecisionReads(
        HorseMind.createSandbox(),
        snapshot.gameState.players,
        HorseMind.handKeyOf(snapshot.gameState.actionHistory)
      ),
    };
    if (fault === 'rng_before_negative') capture.rngBefore = -1;
    if (fault === 'rng_before_overflow') capture.rngBefore = 0x100000000;
    if (fault === 'rng_after_negative') capture.rngAfter = -1;
    if (fault === 'rng_after_overflow') capture.rngAfter = 0x100000000;
    if (fault === 'deep_rng_before_mismatch') capture.rngBefore = (rngBefore + 1) >>> 0;
    const keys = horseLifecycleKeys(snapshot),
      handKey = journalHash(keys.hand);
    const requestDigest = horseLifecycleRequestDigest(snapshot);
    const hand = {
      type: 'OBSERVE_COMPLETED_HAND',
      requestId: 3,
      generation: 12,
      fence: `${TABLE}:12:9:observe`,
      handKey: `${TABLE}:12`,
      committedHandId: HAND,
      bigBlind: 100,
      actions: execution
        ? [
            {
              ...accepted,
              origin: 'horse_policy',
              publicNode: {
                version: 1,
                status: 'captured',
                actorSeat: snapshot.player.seat,
                street: 'preflop',
              },
              observationIdentity: {
                version: 1,
                status: 'bound',
                handId: HAND,
                actionOrdinal: 0,
                observationId: `${HAND}:0`,
                sessionKey: 'a'.repeat(64),
              },
            },
          ]
        : [],
    };
    const rows: HorseJournalRecord[] = [];
    const add = (kind: HorseJournalRecord['kind'], body: unknown) =>
      rows.push(
        makeHorseJournalRecord(
          {
            producerId: '40000000-0000-4000-8000-000000000001',
            sequence: rows.length + 1,
            atMs: 2000,
            sourceRelease: 'a'.repeat(40),
            kind,
            handKey,
            turnKey: kind === 'accepted_hand' ? handKey : journalHash(keys.turn),
          },
          body
        )
      );
    add('request_lifecycle', {
      version: 1,
      phase: 'requested',
      origin: 'worker_compute',
      request: snapshot,
      requestDigest,
    });
    add('decision', capture);
    add('request_lifecycle', { version: 1, phase: 'terminal', requestDigest, outcome: 'success' });
    if (execution) add('execution', witness);
    add('accepted_hand', hand);
    const result = reconcileHorseJournalHand(rows, handKey);
    expect(result.requestLifecycleVerified).toBe(fault === 'valid');
    if (fault !== 'valid') expect(result.gaps).toContain('request_lifecycle_mismatch');
    if (!execution) {
      expect(result.gaps).toContain('execution_missing');
      expect(result.status).toBe('incomplete');
    } else if (fault === 'valid') {
      expect(result.status).toBe('reconciled');
      expect(result.matchedActions).toBe(1);
    } else expect(result.matchedActions).toBe(0);
    expect(result).toMatchObject({
      completePopulation: false,
      replayVerified: false,
      gtoVerified: false,
      activationAllowed: false,
    });
  });
});
