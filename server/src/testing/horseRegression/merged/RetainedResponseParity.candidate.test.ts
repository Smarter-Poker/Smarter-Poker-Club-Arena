import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  correctiveFixture,
  authorize,
  HAND_KEY,
} from '../../../services/horseCorrectiveReview/fixture.test-support.js';
import {
  correctiveReferenceBinding,
  reviewHorseCorrectiveHand,
} from '../../../services/horseCorrectiveReview/review.js';
import { reconcileHorseJournalHand } from '../../../services/horseDecisionJournal/review.js';
import {
  makeHorseJournalRecord,
  journalHash,
  validateHorseJournalRecord,
} from '../../../services/horseDecisionJournal/record.js';
import { horseLifecycleRequestDigest } from '../../../services/horseDecisionJournal/lifecycle.js';
import {
  horseDiscardTurnKey,
  validateHorseDiscardDecision,
  validateHorseDiscardExecution,
} from '../../../services/horseDecisionJournal/discard.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
} from '../../../engine/HorseExecutionWitness.js';
import {
  horseComputeMetadataIsValid,
  horseDecisionReceiptIsValid,
  horseSamplingStateIsValid,
} from '../../../engine/horseDecision/responseValidation.js';
import { HORSE_POLICY_ORDER } from '../../../engine/HorsePolicyGraph.js';
import { horsePolicyOwnership } from '../../../engine/HorsePolicyRegistry.js';
import { captureHorseHandJournalContext } from '../../../engine/HorseDecisionHandBinding.js';
import { HandController } from '../../../engine/HandController.js';

vi.mock('../../../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../../../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn(async () => ({ persisted: true, alertId: 'synthetic' })),
}));
const observations: any[] = [];
const controllers: HandController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No network in retained-response audit');
    })
  );
});
afterEach(() => {
  for (const c of controllers.splice(0)) c.cancelPineappleSettle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function graph() {
  return {
    version: 'horse-policy-order-v1',
    transitions: HORSE_POLICY_ORDER.map((node: any, i: number) => ({
      node,
      before: i ? { action: 'call', amount: null } : null,
      after: { action: 'call', amount: null },
      changed: false,
      elapsedMs: 1,
    })),
    finalAction: { action: 'call', amount: null },
  };
}
type Case = { id: string; valid: boolean; mutate: (d: any) => void };
const ordinaryCases: Case[] = [
  { id: 'ordinary_legacy_positive', valid: true, mutate: () => {} },
  {
    id: 'zero_think_and_compute_positive',
    valid: true,
    mutate: (d) => {
      d.decision.thinkTime = 0;
      d.computeMs = 0;
    },
  },
  {
    id: 'governor_fraction_positive',
    valid: true,
    mutate: (d) => {
      d.governorScale = 0.25;
    },
  },
  {
    id: 'governor_next_above_one',
    valid: false,
    mutate: (d) => {
      d.governorScale = 1 + Number.EPSILON;
    },
  },
  {
    id: 'governor_two',
    valid: false,
    mutate: (d) => {
      d.governorScale = 2;
    },
  },
  {
    id: 'governor_zero',
    valid: false,
    mutate: (d) => {
      d.governorScale = 0;
    },
  },
  {
    id: 'governor_negative',
    valid: false,
    mutate: (d) => {
      d.governorScale = -1;
    },
  },
  {
    id: 'governor_string',
    valid: false,
    mutate: (d) => {
      d.governorScale = '1';
    },
  },
  {
    id: 'compute_negative',
    valid: false,
    mutate: (d) => {
      d.computeMs = -1;
    },
  },
  {
    id: 'compute_string',
    valid: false,
    mutate: (d) => {
      d.computeMs = '1';
    },
  },
  {
    id: 'think_negative',
    valid: false,
    mutate: (d) => {
      d.decision.thinkTime = -1;
    },
  },
  {
    id: 'think_string',
    valid: false,
    mutate: (d) => {
      d.decision.thinkTime = '10';
    },
  },
  {
    id: 'think_null',
    valid: false,
    mutate: (d) => {
      d.decision.thinkTime = null;
    },
  },
  {
    id: 'think_missing',
    valid: false,
    mutate: (d) => {
      delete d.decision.thinkTime;
    },
  },
  {
    id: 'amount_negative',
    valid: false,
    mutate: (d) => {
      d.decision.amount = -1;
    },
  },
  {
    id: 'fallback_unknown',
    valid: false,
    mutate: (d) => {
      d.decision.policyFallback = 'arbitrary_reason';
    },
  },
  {
    id: 'fallback_exception_on_call',
    valid: false,
    mutate: (d) => {
      d.decision.policyFallback = 'brain_exception';
    },
  },
  {
    id: 'reference_ownership_positive',
    valid: true,
    mutate: (d) => {
      d.decision.policyOwnership = horsePolicyOwnership('nlh', d.decision, true);
    },
  },
  {
    id: 'ownership_wrong_variant',
    valid: false,
    mutate: (d) => {
      d.decision.policyOwnership = horsePolicyOwnership('plo4', d.decision, false);
    },
  },
  {
    id: 'ownership_wrong_owner',
    valid: false,
    mutate: (d) => {
      d.decision.policyOwnership = {
        ...horsePolicyOwnership('nlh', d.decision, true),
        owner: 'phase10',
      };
    },
  },
  {
    id: 'ownership_missing_field',
    valid: false,
    mutate: (d) => {
      d.decision.policyOwnership = horsePolicyOwnership('nlh', d.decision, true);
      delete d.decision.policyOwnership.mode;
    },
  },
  {
    id: 'graph_positive',
    valid: true,
    mutate: (d) => {
      d.decision.policyGraph = graph();
    },
  },
  {
    id: 'graph_wrong_version',
    valid: false,
    mutate: (d) => {
      d.decision.policyGraph = { ...graph(), version: 'future' };
    },
  },
  {
    id: 'graph_empty',
    valid: false,
    mutate: (d) => {
      d.decision.policyGraph = { ...graph(), transitions: [] };
    },
  },
  {
    id: 'graph_negative_elapsed',
    valid: false,
    mutate: (d) => {
      d.decision.policyGraph = graph();
      d.decision.policyGraph.transitions[0].elapsedMs = -1;
    },
  },
  {
    id: 'graph_discontinuous',
    valid: false,
    mutate: (d) => {
      d.decision.policyGraph = graph();
      d.decision.policyGraph.transitions[2].before.action = 'fold';
    },
  },
  {
    id: 'graph_wrong_final',
    valid: false,
    mutate: (d) => {
      d.decision.policyGraph = graph();
      d.decision.policyGraph.finalAction.action = 'fold';
    },
  },
  {
    id: 'graph_changed_flag',
    valid: false,
    mutate: (d) => {
      d.decision.policyGraph = graph();
      d.decision.policyGraph.transitions[2].changed = true;
    },
  },
  {
    id: 'graph_wrong_node',
    valid: false,
    mutate: (d) => {
      d.decision.policyGraph = graph();
      d.decision.policyGraph.transitions[2].node = 'invented';
    },
  },
];
for (const lane of ['fast', 'deep'] as const)
  for (const pair of [false, true])
    describe(`${lane}, lifecycle ${pair}`, () => {
      for (const c of ordinaryCases)
        it(c.id, () => {
          const f = correctiveFixture();
          const d: any = structuredClone(f.capture);
          if (lane === 'deep') {
            delete d.effects;
            d.snapshot.type = 'DECIDE_DEEP';
            d.snapshot.rngBefore = d.rngBefore;
            d.snapshot.deepEquity = 2;
          }
          c.mutate(d);
          if (pair) d.lifecycleVersion = 1;
          const liveValid =
            horseComputeMetadataIsValid(d) &&
            horseDecisionReceiptIsValid(d.decision, d.snapshot.gameState.gameVariant) &&
            horseSamplingStateIsValid(d.rngBefore) &&
            horseSamplingStateIsValid(d.rngAfter);
          const w = createHorseExecutionWitness(d.snapshot, d.decision, {
            requestId: d.snapshot.requestId,
            lane,
            computeMs: d.computeMs,
            governorScale: d.governorScale,
          });
          settleHorseExecutionWitness(w, {
            applied: true,
            acceptedActions: f.witness.acceptedActions,
          });
          const requestDigest = horseLifecycleRequestDigest(d.snapshot);
          const records = [
            ...(pair
              ? [
                  f.make('request_lifecycle', 1, {
                    version: 1,
                    phase: 'requested',
                    origin: 'worker_compute',
                    request: d.snapshot,
                    requestDigest,
                  }),
                ]
              : []),
            f.make('decision', 2, d),
            ...(pair
              ? [
                  f.make('request_lifecycle', 3, {
                    version: 1,
                    phase: 'terminal',
                    requestDigest,
                    outcome:
                      d.decision.policyFallback === 'brain_exception' ? 'exception' : 'success',
                  }),
                ]
              : []),
            f.make('execution', 4, w),
            f.make('accepted_hand', 5, f.hand),
          ];
          records.forEach(validateHorseJournalRecord);
          const retained = reconcileHorseJournalHand(records, HAND_KEY);
          // Independently signed synthetic-only reference demonstrates downstream behavior;
          // this does not establish trusted producer provenance for any real input.
          const commitment = { ...f.commitments, acceptedHandRecordDigest: records.at(-1)!.sha256 };
          const reference = {
            ...f.reference,
            binding: correctiveReferenceBinding(
              records.find((r) => r.kind === 'decision')!,
              records.find((r) => r.kind === 'execution')!,
              records.at(-1)!
            ),
          };
          const corrective = reviewHorseCorrectiveHand({
            records,
            handKey: HAND_KEY,
            commitments: commitment,
            references: [reference],
            authority: authorize(commitment, [reference]).authority,
          });
          const first = corrective.actors[0]?.decisions[0];
          observations.push({
            id: c.id,
            lane,
            lifecyclePair: pair,
            liveValid,
            expectedValid: c.valid,
            retainedStatus: retained.status,
            gaps: retained.gaps,
            lifecycleVerified: retained.requestLifecycleVerified,
            matchedActions: retained.matchedActions,
            correctiveStatus: corrective.status,
            correctiveDisposition: first?.disposition ?? null,
            candidateStatus: first?.candidate?.status ?? null,
            activationAllowed: corrective.activationAllowed,
            replayVerified: corrective.replayVerified,
            gtoVerified: corrective.gtoVerified,
          });
          expect(liveValid).toBe(c.valid);
          expect(retained.status === 'reconciled').toBe(liveValid);
          expect(retained.requestLifecycleVerified).toBe(pair && liveValid);
          expect(corrective).toMatchObject({
            completePopulation: false,
            replayVerified: false,
            gtoVerified: false,
            activationAllowed: false,
          });
          if (!liveValid) {
            expect(corrective.status).toBe('incomplete');
            expect(
              corrective.actors.flatMap((a) => a.decisions).every((d) => d.candidate === null)
            ).toBe(true);
          }
        });
    });

function realDiscard() {
  const table = '10000000-0000-4000-8000-000000000001',
    actor = '20000000-0000-4000-8000-000000000001',
    human = '20000000-0000-4000-8000-000000000002',
    lease = '50000000-0000-4000-8000-000000000001';
  const players = [actor, human].map((user_id, i) => ({
    user_id,
    seat: i + 1,
    username: 'Synthetic' + i,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
  const controller = new HandController(
    {
      tableId: table,
      handNumber: 12,
      gameVariant: 'pineapple',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    },
    players,
    1
  );
  controllers.push(controller);
  controller.start();
  for (let i = 0; i < 8 && controller.getState().stage === 'preflop'; i++) {
    const s = controller.getState(),
      p = s.players.find((p) => p.seat === s.currentPlayerSeat)!;
    expect(controller.performAction(p.seat, p.bet < s.currentBet ? 'call' : 'check')).toBe(true);
  }
  expect(controller.getState().stage).toBe('pineapple_discard');
  const state = controller.getState(),
    p = state.players.find((p) => p.user_id === actor)!;
  const prior = structuredClone(state.actionHistory),
    priorContext = captureHorseHandJournalContext(prior)!;
  const cards = structuredClone(p.cards),
    communityCards = structuredClone(state.communityCards);
  const cardKey = (a: any[]) => a.map((c) => `${c.rank}:${c.suit}`).join('|');
  const request: any = {
    type: 'DECIDE_DISCARD',
    requestId: 11,
    generation: 4,
    cards,
    communityCards,
    gameVariant: 'pineapple',
    fence: [
      table,
      12,
      'pineapple-discard',
      p.seat,
      lease,
      4,
      cardKey(cards),
      cardKey(communityCards),
    ].join(':'),
    journalContext: {
      version: 1,
      tableId: table,
      handNumber: 12,
      leaseGeneration: lease,
      actorId: actor,
      seat: p.seat,
      requestedAtMs: 0,
      lane: 'choice',
      priorActions: priorContext,
    },
  };
  let receipt: any = null;
  controller.observeNextPineappleDiscard(p.seat, (r) => {
    receipt = r;
  });
  expect(controller.performDiscard(p.seat, 1)).toBe(true);
  expect(receipt).not.toBeNull();
  const execution: any = {
    version: 1,
    request,
    selectedIndex: 1,
    controller: receipt,
    acceptedActionOrdinal: prior.length,
    priorActions: priorContext,
  };
  validateHorseDiscardExecution(execution);
  const capture: any = {
    version: 1,
    snapshot: request,
    cardIndex: 1,
    rngBefore: 1,
    rngAfter: 2,
    computeMs: 1,
    governorScale: 1,
    runtimePins: 'incomplete',
  };
  const coordinate = `${table}:12:${lease}`,
    handKey = journalHash(coordinate);
  const hand = {
    generation: 12,
    fence: `${coordinate}:observe`,
    handKey: `${table}:12`,
    committedHandId: '30000000-0000-4000-8000-000000000001',
    bigBlind: 2,
    actions: [
      ...prior.map((r) => ({ ...r, origin: 'player' })),
      { ...receipt.acceptedRecord, origin: 'unknown' },
    ],
  };
  const make = (kind: any, sequence: number, payload: any) =>
    makeHorseJournalRecord(
      {
        kind,
        sequence,
        producerId: '40000000-0000-4000-8000-000000000001',
        atMs: 2000 + sequence,
        sourceRelease: 'a'.repeat(40),
        handKey,
        turnKey: kind === 'accepted_hand' ? handKey : journalHash(horseDiscardTurnKey(request)),
      },
      payload
    );
  return { capture, execution, request, hand, handKey, make };
}
const discardCases: Case[] = [
  { id: 'discard_positive', valid: true, mutate: () => {} },
  {
    id: 'discard_fraction_positive',
    valid: true,
    mutate: (d) => {
      d.governorScale = 0.25;
      d.computeMs = 0;
    },
  },
  {
    id: 'discard_governor_next_above_one',
    valid: false,
    mutate: (d) => {
      d.governorScale = 1 + Number.EPSILON;
    },
  },
  {
    id: 'discard_governor_two',
    valid: false,
    mutate: (d) => {
      d.governorScale = 2;
    },
  },
  {
    id: 'discard_governor_zero',
    valid: false,
    mutate: (d) => {
      d.governorScale = 0;
    },
  },
  {
    id: 'discard_governor_string',
    valid: false,
    mutate: (d) => {
      d.governorScale = '1';
    },
  },
  {
    id: 'discard_compute_negative',
    valid: false,
    mutate: (d) => {
      d.computeMs = -1;
    },
  },
  {
    id: 'discard_index_fraction',
    valid: false,
    mutate: (d) => {
      d.cardIndex = 1.5;
    },
  },
  {
    id: 'discard_index_negative',
    valid: false,
    mutate: (d) => {
      d.cardIndex = -1;
    },
  },
  {
    id: 'discard_index_overflow',
    valid: false,
    mutate: (d) => {
      d.cardIndex = 3;
    },
  },
];
for (const pair of [false, true])
  describe(`real controller discard, lifecycle ${pair}`, () => {
    for (const c of discardCases)
      it(c.id, () => {
        const f = realDiscard(),
          d = f.capture;
        c.mutate(d);
        if (pair) d.lifecycleVersion = 1;
        const liveValid =
          horseComputeMetadataIsValid(d) &&
          Number.isInteger(d.cardIndex) &&
          d.cardIndex >= 0 &&
          d.cardIndex <= 2;
        let captureValid = true;
        try {
          validateHorseDiscardDecision(d);
        } catch {
          captureValid = false;
        }
        const requestDigest = horseLifecycleRequestDigest(f.request);
        const records = [
          ...(pair
            ? [
                f.make('request_lifecycle', 1, {
                  version: 1,
                  phase: 'requested',
                  origin: 'worker_compute',
                  request: f.request,
                  requestDigest,
                }),
              ]
            : []),
          f.make('discard_decision', 2, d),
          ...(pair
            ? [
                f.make('request_lifecycle', 3, {
                  version: 1,
                  phase: 'terminal',
                  requestDigest,
                  outcome: 'success',
                }),
              ]
            : []),
          f.make('discard_execution', 4, f.execution),
          f.make('accepted_hand', 5, f.hand),
        ];
        records.forEach(validateHorseJournalRecord);
        const retained = reconcileHorseJournalHand(records, f.handKey);
        observations.push({
          id: c.id,
          lane: 'discard',
          lifecyclePair: pair,
          liveValid,
          expectedValid: c.valid,
          captureValid,
          retainedStatus: retained.status,
          gaps: retained.gaps,
          lifecycleVerified: retained.requestLifecycleVerified,
          matchedHorseDiscards: retained.matchedHorseDiscards,
          activationAllowed: retained.activationAllowed,
          replayVerified: retained.replayVerified,
          gtoVerified: retained.gtoVerified,
        });
        expect(liveValid).toBe(c.valid);
        expect(retained.status === 'reconciled').toBe(liveValid);
        expect(retained.requestLifecycleVerified).toBe(pair && liveValid);
      });
  });
