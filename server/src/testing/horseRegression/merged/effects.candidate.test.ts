/** PREPARED, UNEXECUTED. Finite synthetic retained-contract laws; no actual
 * worker/controller acceptance, source authentication or applied mind writes. */
import { describe, expect, it } from 'vitest';
import { qualifyHorseRetainedDecisionEffects } from '../../../services/horseDecisionJournal/effects.js';
import { reconcileHorseJournalHand } from '../../../services/horseDecisionJournal/review.js';
import {
  horseDecisionEffectsMatchRequest,
  horseReferenceWagerWasRetained,
} from '../../../engine/HorseDecisionEffects.js';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from '../../../engine/HorsePolicyGraph.js';
import { horseDecisionReceiptIsValid } from '../../../engine/horseDecision/responseValidation.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
} from '../../../engine/HorseExecutionWitness.js';
import { encodeHorseDecisionReads } from '../../../engine/HorseDecisionReadFrame.js';
import { HorseMind } from '../../../engine/HorseMind.js';
import {
  horseLifecycleKeys,
  horseLifecycleRequestDigest,
} from '../../../services/horseDecisionJournal/lifecycle.js';
import {
  makeHorseJournalRecord,
  journalHash,
  type HorseJournalRecord,
} from '../../../services/horseDecisionJournal/record.js';
import type { HorseDecision } from '../../../types.js';
import type {
  FastHorseDecisionRequest,
  DeepHorseDecisionRequest,
} from '../../../engine/horseDecision/protocol.js';
import { fixture, request, TABLE, HAND } from './fixture.js';

type Request = FastHorseDecisionRequest | DeepHorseDecisionRequest;
type Capture = {
  snapshot: Request;
  decision: HorseDecision;
  effects?: unknown;
  lifecycleVersion?: unknown;
  readFrame: ReturnType<typeof encodeHorseDecisionReads>;
  rngBefore: number;
  rngAfter: number;
  computeMs: number;
  governorScale: number;
};
function graphDecision(amount = 100, referenceAmount = amount): HorseDecision {
  const graph = new HorsePolicyGraph(() => 0);
  let previous: HorseDecision | null = null;
  for (const node of HORSE_POLICY_ORDER) {
    const next: HorseDecision = {
      action: 'bet',
      amount: node === 'reference' ? referenceAmount : amount,
      thinkTime: 0,
    };
    previous = graph.run(node, previous, () => ({ decision: next })).decision;
  }
  return graph.finish(previous!);
}
function effectFixture(lane: 'fast' | 'deep' = 'fast') {
  const f = fixture();
  Object.assign(f.state, {
    stage: 'flop',
    currentBet: 0,
    toCall: 0,
    minRaiseTo: 100,
    maxRaiseTo: f.hero.stack,
    legalActions: ['check', 'bet', 'all_in'],
    communityCards: [
      { rank: '2', suit: 'hearts' },
      { rank: '5', suit: 'clubs' },
      { rank: '8', suit: 'diamonds' },
    ],
  });
  f.hero.bet = 0;
  f.state.players.forEach((player) => {
    player.bet = 0;
  });
  const other = f.state.players[1]!;
  f.state.actionHistory = [
    {
      seat: other.seat,
      userId: other.user_id,
      action: 'check',
      amount: 0,
      stage: 'flop',
      timestamp: 10,
    },
  ];
  const fast = request(f);
  const snapshot: Request =
    lane === 'fast' ? fast : { ...fast, type: 'DECIDE_DEEP', rngBefore: 1, deepEquity: 2 };
  const capture: Capture = {
    snapshot,
    decision: graphDecision(),
    rngBefore: 1,
    rngAfter: 2,
    computeMs: 1,
    governorScale: 1,
    readFrame: encodeHorseDecisionReads(
      HorseMind.createSandbox(),
      snapshot.gameState.players,
      HorseMind.handKeyOf(snapshot.gameState.actionHistory)
    ),
  };
  if (lane === 'fast') capture.effects = [];
  const handKey = `10:${other.user_id}`,
    userId = f.hero.user_id;
  const plan = { type: 'plan', handKey, userId, barrelIntent: true };
  const raisePlan = { type: 'raise_plan', handKey, userId, street: 'flop', plan: 'callOnce' };
  const outlook = { type: 'outlook', handKey, userId, street: 'flop', good: ['Ah'], scare: ['Ks'] };
  return { capture, plan, raisePlan, outlook };
}
type Fixture = ReturnType<typeof effectFixture>;
type Law = {
  id: string;
  status: 'qualified' | 'unavailable' | 'invalid';
  mutate: (f: Fixture) => void;
};
const fastLaws: Law[] = [
  { id: 'empty', status: 'qualified', mutate: () => {} },
  {
    id: 'plan',
    status: 'qualified',
    mutate: (f) => {
      f.capture.effects = [f.plan];
    },
  },
  {
    id: 'all_three_types',
    status: 'qualified',
    mutate: (f) => {
      f.capture.effects = [f.plan, f.raisePlan, f.outlook];
    },
  },
  {
    id: 'exact_batch_ceiling',
    status: 'qualified',
    mutate: (f) => {
      f.capture.effects = Array.from({ length: 16 }, () => ({ ...f.plan }));
    },
  },
  {
    id: 'batch_overflow',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = Array.from({ length: 17 }, () => ({ ...f.plan }));
    },
  },
  {
    id: 'missing',
    status: 'unavailable',
    mutate: (f) => {
      delete f.capture.effects;
    },
  },
  {
    id: 'own_undefined',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = undefined;
    },
  },
  {
    id: 'null',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = null;
    },
  },
  {
    id: 'object',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = {};
    },
  },
  {
    id: 'string',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = '[]';
    },
  },
  {
    id: 'null_element',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [null];
    },
  },
  {
    id: 'foreign_actor',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [{ ...f.plan, userId: 'another-horse' }];
    },
  },
  {
    id: 'foreign_hand',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [{ ...f.plan, handKey: '11:other' }];
    },
  },
  {
    id: 'foreign_street',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [{ ...f.outlook, street: 'turn' }];
    },
  },
  {
    id: 'missing_history',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [f.plan];
      f.capture.snapshot.gameState.actionHistory = [];
    },
  },
  {
    id: 'preflop_plan',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [f.plan];
      f.capture.snapshot.gameState.stage = 'preflop';
    },
  },
  {
    id: 'fallback_with_plans',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [f.plan];
      f.capture.decision = { action: 'check', thinkTime: 0, policyFallback: 'brain_exception' };
    },
  },
  {
    id: 'fallback_empty',
    status: 'qualified',
    mutate: (f) => {
      f.capture.decision = { action: 'check', thinkTime: 0, policyFallback: 'brain_exception' };
    },
  },
  {
    id: 'missing_graph',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [f.plan];
      delete f.capture.decision.policyGraph;
    },
  },
  {
    id: 'reference_wager_replaced',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [f.plan];
      f.capture.decision = graphDecision(101, 100);
    },
  },
  {
    id: 'reference_replaced_empty',
    status: 'qualified',
    mutate: (f) => {
      f.capture.decision = graphDecision(101, 100);
    },
  },
  {
    id: 'call_with_plans',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [f.plan];
      f.capture.decision = { action: 'call', amount: 100, thinkTime: 0 };
    },
  },
  {
    id: 'allin_with_plans',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [f.plan];
      f.capture.decision = { action: 'all_in', thinkTime: 0 };
    },
  },
  {
    id: 'extra_private_field',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [{ ...f.plan, privateCards: ['As', 'Ks'] }];
    },
  },
  {
    id: 'invalid_outlook_card',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [{ ...f.outlook, good: ['XX'] }];
    },
  },
  {
    id: 'duplicate_outlook_card',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [{ ...f.outlook, good: ['Ah', 'Ah'] }];
    },
  },
  {
    id: 'unknown_raise_plan',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [{ ...f.raisePlan, plan: 'raiseMore' }];
    },
  },
  {
    id: 'string_boolean',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [{ ...f.plan, barrelIntent: 'true' }];
    },
  },
  {
    id: 'one_bad_among_valid',
    status: 'invalid',
    mutate: (f) => {
      f.capture.effects = [f.plan, f.raisePlan, { ...f.outlook, userId: 'foreign' }];
    },
  },
];
describe('retained FAST effects reuse the actual live effects predicates', () => {
  for (const lifecycle of ['absent', 'v1'] as const)
    it.each(fastLaws)(`${lifecycle} / $id`, (law) => {
      const f = effectFixture();
      if (lifecycle === 'v1') f.capture.lifecycleVersion = 1;
      law.mutate(f);
      const before = structuredClone(f.capture);
      const actual = qualifyHorseRetainedDecisionEffects(f.capture, f.capture.snapshot);
      const d = f.capture.decision,
        request = f.capture.snapshot;
      const clientEffectsValid =
        horseDecisionEffectsMatchRequest(f.capture.effects, {
          userId: request.player.user_id,
          history: request.gameState.actionHistory,
          street: request.gameState.stage,
          brainFallback: d.policyFallback === 'brain_exception',
        }) &&
        ((f.capture.effects as unknown[]).length === 0 || horseReferenceWagerWasRetained(d));
      expect(actual.status).toBe(law.status);
      expect(actual.status === 'qualified').toBe(clientEffectsValid);
      expect(actual.applicationVerified).toBe(false);
      expect(f.capture).toEqual(before);
      if (law.id === 'missing') expect(actual.reason).toBe('fast_effects_missing');
    });
});

describe('known DEEP omission and unknown lifecycle versions', () => {
  for (const lifecycle of ['absent', 'v1'] as const) {
    it(`${lifecycle} / DEEP intentionally omits effects`, () => {
      const f = effectFixture('deep');
      if (lifecycle === 'v1') f.capture.lifecycleVersion = 1;
      expect(qualifyHorseRetainedDecisionEffects(f.capture, f.capture.snapshot)).toEqual({
        status: 'qualified',
        reason: 'deep_effects_not_emitted',
        batchSize: null,
        applicationVerified: false,
      });
    });
    it.each([[], null, undefined, {}, [{ type: 'plan' }]])(
      `${lifecycle} / DEEP supplied effects %j`,
      (effects) => {
        const f = effectFixture('deep');
        if (lifecycle === 'v1') f.capture.lifecycleVersion = 1;
        f.capture.effects = effects;
        expect(qualifyHorseRetainedDecisionEffects(f.capture, f.capture.snapshot)).toMatchObject({
          status: 'invalid',
          reason: 'deep_effects_unexpected',
          applicationVerified: false,
        });
      }
    );
  }
  for (const lane of ['fast', 'deep'] as const)
    it.each([0, 2, '1', null])(`${lane} / unsupported version %j`, (version) => {
      const f = effectFixture(lane);
      f.capture.lifecycleVersion = version;
      expect(qualifyHorseRetainedDecisionEffects(f.capture, f.capture.snapshot)).toMatchObject({
        status: 'invalid',
        reason: 'unsupported_capture_version',
        applicationVerified: false,
      });
    });
});

const joinedLaws = [
  { lane: 'fast', id: 'valid_empty', good: true },
  { lane: 'fast', id: 'valid_plan', good: true },
  { lane: 'fast', id: 'missing', good: false },
  { lane: 'fast', id: 'foreign_actor', good: false },
  { lane: 'fast', id: 'reference_wager_replaced', good: false },
  { lane: 'deep', id: 'expected_absence', good: true },
  { lane: 'deep', id: 'unexpected_empty', good: false },
  { lane: 'deep', id: 'unexpected_plan', good: false },
] as const;
describe('effects qualify before lifecycle and accepted-action joins', () => {
  for (const lifecycle of ['legacy_no_pair', 'legacy_paired', 'v1_paired'] as const) {
    for (const execution of [false, true])
      it.each(joinedLaws)(`${lifecycle} / execution=${execution} / $lane / $id`, (law) => {
        const f = effectFixture(law.lane),
          d = f.capture,
          s = d.snapshot;
        if (lifecycle === 'v1_paired') d.lifecycleVersion = 1;
        if (law.id === 'valid_plan' || law.id === 'unexpected_plan') d.effects = [f.plan];
        if (law.id === 'missing') delete d.effects;
        if (law.id === 'foreign_actor') d.effects = [{ ...f.plan, userId: 'foreign' }];
        if (law.id === 'reference_wager_replaced') {
          d.effects = [f.plan];
          d.decision = graphDecision(101, 100);
        }
        if (law.id === 'unexpected_empty') d.effects = [];
        expect(horseDecisionReceiptIsValid(d.decision, 'nlh')).toBe(true);
        const witness = createHorseExecutionWitness(s, d.decision, {
          requestId: s.requestId,
          lane: law.lane,
          computeMs: d.computeMs,
          governorScale: d.governorScale,
        });
        const accepted = {
          seat: s.player.seat,
          userId: s.player.user_id,
          action: d.decision.action,
          amount: witness.expectedExecutionAmount!,
          stage: 'flop' as const,
          timestamp: 1001,
        };
        settleHorseExecutionWitness(witness, {
          applied: true,
          acceptedActions: [{ record: accepted, intended: true }],
        });
        const keys = horseLifecycleKeys(s),
          handKey = journalHash(keys.hand),
          requestDigest = horseLifecycleRequestDigest(s);
        const prior = s.gameState.actionHistory!;
        const hand = {
          generation: 12,
          fence: `${TABLE}:12:9:observe`,
          handKey: `${TABLE}:12`,
          committedHandId: HAND,
          bigBlind: 100,
          actions: [
            ...prior.map((a) => ({ ...a, origin: 'player' })),
            ...(execution
              ? [
                  {
                    ...accepted,
                    origin: 'horse_policy',
                    publicNode: {
                      version: 1,
                      status: 'captured',
                      actorSeat: s.player.seat,
                      street: 'flop',
                    },
                    observationIdentity: {
                      version: 1,
                      status: 'bound',
                      handId: HAND,
                      actionOrdinal: prior.length,
                      observationId: `${HAND}:${prior.length}`,
                      sessionKey: 'a'.repeat(64),
                    },
                  },
                ]
              : []),
          ],
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
        if (lifecycle !== 'legacy_no_pair')
          add('request_lifecycle', {
            version: 1,
            phase: 'requested',
            origin: 'worker_compute',
            request: s,
            requestDigest,
          });
        add('decision', d);
        if (lifecycle !== 'legacy_no_pair')
          add('request_lifecycle', {
            version: 1,
            phase: 'terminal',
            outcome: 'success',
            requestDigest,
          });
        if (execution) add('execution', witness);
        add('accepted_hand', hand);
        const out = reconcileHorseJournalHand(rows, handKey);
        expect(out.requestLifecycleVerified).toBe(lifecycle !== 'legacy_no_pair' && law.good);
        expect(out.matchedActions).toBe(execution && law.good ? 1 : 0);
        expect(out.status).toBe(execution && law.good ? 'reconciled' : 'incomplete');
        if (!execution) expect(out.gaps).toContain('execution_missing');
        if (!law.good && (execution || lifecycle !== 'legacy_no_pair'))
          expect(out.gaps).toContain(
            law.id === 'missing' ? 'decision_effects_missing' : 'decision_effects_invalid'
          );
        expect(out).toMatchObject({
          completePopulation: false,
          replayVerified: false,
          gtoVerified: false,
          activationAllowed: false,
        });
      });
  }
});
