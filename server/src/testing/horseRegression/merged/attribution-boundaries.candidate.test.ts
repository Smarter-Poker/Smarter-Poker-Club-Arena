import {
  horsePlanBatchBindingFromRequest,
  horsePlanContextFromDecision,
} from '../../../engine/HorsePlanHandIdentity.js';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { HorseLogic } from '../../../engine/HorseLogic.js';
import { seedFastRandom } from '../../../engine/HorseEval.js';
import { LiveHorseDecisionWorkerClient } from '../../../engine/horseDecision/client.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
} from '../../../engine/HorseExecutionWitness.js';
import { encodeHorseDecisionReads } from '../../../engine/HorseDecisionReadFrame.js';
import { HorseMind } from '../../../engine/HorseMind.js';
import {
  journalHash,
  makeHorseJournalRecord,
} from '../../../services/horseDecisionJournal/record.js';
import { reconcileHorseJournalHand } from '../../../services/horseDecisionJournal/review.js';
import { fixture, request, TABLE, HAND } from './fixture.js';
const handKey = journalHash(`${TABLE}:12:9`);
const producer = '40000000-0000-4000-8000-000000000001';
class FakeWorker extends EventEmitter {
  sent: any[] = [];
  postMessage(value: any) {
    this.sent.push(value);
  }
  terminate() {
    return Promise.resolve(0);
  }
}
const ready = {
  type: 'READY',
  solverStores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
  solverPolicyArtifact: { totalPolicies: 0 },
  governor: {
    enabled: false,
    scale: 1,
    p50Ms: 0,
    p99Ms: 0,
    sampledAt: 0,
    throttledForS: 0,
    stale: true,
    timerLateMs: 0,
  },
};
function capture() {
  const f = fixture(),
    s = request(f);
  seedFastRandom(901791);
  const decision = HorseLogic.decide(f.hero, f.state, 'balanced', {}, f.opts);
  return { f, s, decision };
}
describe('prepared actual client and retained-reader attribution boundaries', () => {
  it.each(
    ['fast', 'deep'].flatMap((lane) =>
      [
        'valid',
        'source_depth',
        'receipt_cell',
        'reference',
        'route_disabled',
        'variant_forbidden',
        'graph_missing',
      ].map((fault) => ({ lane, fault }))
    )
  )('$lane transport rejects only the altered $fault receipt', async ({ lane, fault }) => {
    const { s, decision } = capture(),
      worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => worker });
    worker.emit('message', ready);
    const pending =
      lane === 'fast'
        ? client.decideFast(s)
        : client.decideDeep({ ...s, rngBefore: 11, deepEquity: 6 });
    void pending.catch(() => undefined);
    const returned = structuredClone(decision);
    if (fault === 'source_depth') {
      // Canonical active request is already owned by the client. A valid
      // receipt from a different stack must not become its witness.
      const f = fixture(8),
        other = HorseLogic.decide(f.hero, f.state, 'balanced', {}, f.opts);
      returned.tournamentPreflopAttribution = other.tournamentPreflopAttribution;
    }
    if (fault === 'receipt_cell')
      returned.tournamentPreflopAttribution!.lookup!.policy.cell += ':wrong';
    if (fault === 'reference')
      returned.tournamentPreflopAttribution!.referenceProposal.action =
        returned.tournamentPreflopAttribution!.referenceProposal.action === 'fold'
          ? 'call'
          : 'fold';
    if (fault === 'route_disabled' || fault === 'variant_forbidden') {
      const r = returned.tournamentPreflopAttribution!;
      r.route = fault === 'route_disabled' ? 'chart_open_jam' : 'variant_price';
      r.status = 'bypassed';
      r.reason = fault === 'route_disabled' ? 'chart_return' : 'variant_price_return';
      r.forwardedToIntentEngine = false;
    }
    if (fault === 'graph_missing') {
      delete returned.policyGraph;
      returned.tournamentPreflopAttribution!.referenceProposal.action = 'check';
    }
    worker.emit('message', {
      type: lane === 'fast' ? 'FAST_RESULT' : 'DEEP_RESULT',
      requestId: 1,
      ...(lane === 'fast'
        ? {
            planBinding: horsePlanBatchBindingFromRequest({ ...s, requestId: 1 }),
            planIssueDisposition: 'no_effects',
          }
        : { planContext: horsePlanContextFromDecision(s) }),
      generation: s.generation,
      fence: s.fence,
      decision: returned,
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 1,
      governorScale: 1,
      effects: [],
    });
    if (fault === 'valid') {
      const result = await pending;
      expect(result.decision.executionWitness!.phase6Attribution).toEqual(
        decision.tournamentPreflopAttribution
      );
      expect(result.decision.executionWitness!.executionStatus).toBe('pending');
      const stopping = client.stop();
      worker.emit('message', { type: 'STOPPED' });
      await stopping;
    } else {
      await expect(pending).rejects.toThrow('invalid policy receipt');
      expect(client.status().phase).toBe('failed');
      await client.stop();
    }
  });
  it.each([
    'valid',
    'witness_omitted',
    'witness_changed',
    'snapshot_changed',
    'both_legacy_missing',
    'route_disabled',
    'variant_forbidden',
    'graph_missing',
  ] as const)('retained join handles %s without claiming controller/source authority', (fault) => {
    const { s, decision } = capture();
    const witness = createHorseExecutionWitness(s, decision, {
      requestId: 1,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    const accepted = {
      seat: s.player.seat,
      userId: s.player.user_id,
      action: decision.action,
      amount: witness.expectedExecutionAmount!,
      stage: 'preflop' as const,
      timestamp: 1001,
    };
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: [{ record: accepted, intended: true }],
    });
    const d = {
      snapshot: s,
      decision,
      effects: [],
      readFrame: encodeHorseDecisionReads(
        HorseMind.createSandbox(),
        s.gameState.players,
        HorseMind.handKeyOf(s.gameState.actionHistory)
      ),
      rngBefore: 1,
      rngAfter: 2,
      computeMs: 1,
      governorScale: 1,
      runtimePins: 'incomplete',
    };
    const w = structuredClone(witness) as any;
    if (fault === 'witness_omitted') delete w.phase6Attribution;
    if (fault === 'witness_changed') w.phase6Attribution!.lookup!.policy.shifts.call = 0.99;
    if (fault === 'snapshot_changed')
      d.decision = {
        ...decision,
        tournamentPreflopAttribution: structuredClone(decision.tournamentPreflopAttribution),
      };
    if (fault === 'snapshot_changed')
      d.decision.tournamentPreflopAttribution!.lookup!.coordinate.stackBB = 8;
    if (fault === 'both_legacy_missing') {
      delete d.decision.tournamentPreflopAttribution;
      delete w.phase6Attribution;
    }
    if (fault === 'route_disabled' || fault === 'variant_forbidden') {
      d.decision = structuredClone(d.decision);
      const r = d.decision.tournamentPreflopAttribution!;
      r.route = fault === 'route_disabled' ? 'chart_open_jam' : 'variant_price';
      r.status = 'bypassed';
      r.reason = fault === 'route_disabled' ? 'chart_return' : 'variant_price_return';
      r.forwardedToIntentEngine = false;
      w.phase6Attribution = structuredClone(r);
    }
    if (fault === 'graph_missing') {
      delete d.decision.policyGraph;
      w.policyGraph = null;
      d.decision = structuredClone(d.decision);
      d.decision.tournamentPreflopAttribution!.referenceProposal.action = 'check';
      w.phase6Attribution = structuredClone(d.decision.tournamentPreflopAttribution);
    }
    const ordinal = s.gameState.actionHistory!.length;
    const a = {
      type: 'OBSERVE_COMPLETED_HAND',
      requestId: 3,
      generation: 12,
      fence: `${TABLE}:12:9:observe`,
      handKey: `${TABLE}:12`,
      committedHandId: HAND,
      bigBlind: 100,
      actions: [
        ...s.gameState.actionHistory!,
        {
          ...accepted,
          origin: 'horse_policy',
          publicNode: {
            version: 1,
            status: 'captured',
            actorSeat: s.player.seat,
            street: 'preflop',
          },
          observationIdentity: {
            version: 1,
            status: 'bound',
            handId: HAND,
            actionOrdinal: ordinal,
            observationId: `${HAND}:${ordinal}`,
            sessionKey: 'a'.repeat(64),
          },
        },
      ],
    };
    const turnKey = journalHash(
      JSON.stringify([s.generation, s.fence, s.requestId, s.decisionKey, s.decisionTimeMs])
    );
    const rows = [
      ['decision', d],
      ['execution', w],
      ['accepted_hand', a],
    ].map(([kind, body], i) =>
      makeHorseJournalRecord(
        {
          producerId: producer,
          sequence: i + 1,
          atMs: 2000,
          sourceRelease: 'a'.repeat(40),
          kind: kind as any,
          handKey,
          turnKey: kind === 'accepted_hand' ? handKey : turnKey,
        },
        body
      )
    );
    const report = reconcileHorseJournalHand(rows, handKey);
    if (fault === 'valid' || fault === 'both_legacy_missing')
      expect(report).toMatchObject({ status: 'reconciled', matchedActions: 1 });
    else {
      expect(report.status).not.toBe('reconciled');
      expect(report.matchedActions).toBe(0);
    }
    expect(report).toMatchObject({
      completePopulation: false,
      replayVerified: false,
      gtoVerified: false,
      activationAllowed: false,
    });
    for (const secret of [
      s.player.user_id,
      decision.tournamentPreflopAttribution?.lookup?.policy.cell,
    ].filter(Boolean))
      expect(JSON.stringify(report)).not.toContain(secret);
  });
});
