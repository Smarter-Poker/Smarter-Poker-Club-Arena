import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { reconstructPhase8Hand, type CapturedPhase8Hand } from './HorsePhase8ReplayFixture.js';
import { horseDecisionReceiptIsValid } from './horseDecision/responseValidation.js';
import { HorseQualifiedAuthorityHolder } from './HorseQualifiedAuthority.js';
import { qualifiedTestAdmission } from './HorseQualifiedAuthority.test-support.js';
import { LiveHorseDecisionWorkerClient, type WorkerLike } from './horseDecision/client.js';
import {
  buildHorseDecisionKey,
  type HorseDecisionWorkerResponse,
  type LiveHorseDecisionSnapshot,
} from './horseDecision/protocol.js';
import { horsePlanBatchBindingFromRequest } from './HorsePlanHandIdentity.js';

const hands: CapturedPhase8Hand[] = JSON.parse(
  readFileSync(new URL('./fixtures/phase8-production-hands.json', import.meta.url), 'utf8')
);

describe('Phase 8 captured public-line reconstruction', () => {
  it.each(hands)('review $reviewId remains legal and private', (hand) => {
    const { hero, gs, recorded } = reconstructPhase8Hand(hand);
    seedFastRandom(hand.reviewId);
    const baseline = HorseLogic.decide(
      hero,
      gs,
      'balanced',
      {},
      { phase8Postflop: 'off', mind: false, decisionTimeMs: 0 }
    );
    seedFastRandom(hand.reviewId);
    // Semantic replay is clock-independent. The league separately measures
    // real elapsed budgets; no synthetic zero is reported as latency proof.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    let candidate: ReturnType<typeof HorseLogic.decide>;
    try {
      candidate = HorseLogic.decide(
        hero,
        gs,
        'balanced',
        {},
        { phase8Postflop: 'candidate', mind: false, decisionTimeMs: 0 }
      );
    } finally {
      clock.mockRestore();
    }
    expect(gs.players.every((p) => p.cards.length === 0)).toBe(true);
    expect(gs.legalActions).toContain(baseline.action);
    expect(gs.legalActions).toContain(candidate.action);
    expect(['call', 'all_in', 'bet']).toContain(recorded);
    expect(candidate.tournamentPostflop).toBeDefined();
    // V51 (2026-10-05): in 400340 the villain jammed the river for less than
    // hero's stack, so hero's recorded all_in was a call (the excess came
    // back at showdown). The committed river one-pair branch now names that
    // decision `call`; the chips it puts in are identical.
    if (hand.reviewId === 400340) expect(baseline.action).toBe('call');
    else expect(['all_in', 'bet', 'raise']).toContain(baseline.action);
    expect(candidate.action).toBe(hand.reviewId === 400615 ? 'check' : 'fold');
    console.info(
      JSON.stringify({
        reviewId: hand.reviewId,
        context: 'reconstructed_field',
        recorded,
        baseline: baseline.action,
        candidate: candidate.action,
        reason: candidate.tournamentPostflop?.reason,
        features: candidate.tournamentPostflop?.reasons,
        eligible: candidate.tournamentPostflop?.eligible,
        fired: candidate.tournamentPostflop?.fired,
        latency: 'measured_separately_in_league',
      })
    );
  });
});

describe('Phase 8.3 qualified authority on the actual candidate receipt', () => {
  function decideAt(hand: CapturedPhase8Hand, mode: 'shadow' | 'candidate') {
    const { hero, gs } = reconstructPhase8Hand(hand);
    seedFastRandom(hand.reviewId);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      return HorseLogic.decide(
        hero,
        gs,
        'balanced',
        {},
        { phase8Postflop: mode, mind: false, decisionTimeMs: 0 }
      );
    } finally {
      clock.mockRestore();
    }
  }

  it.each(hands)(
    'review $reviewId: a selected candidate is a valid live receipt only with usable authority',
    (hand) => {
      const worker = new HorseQualifiedAuthorityHolder('worker');
      worker.apply(qualifiedTestAdmission(1));
      const candidate = decideAt(hand, 'candidate');
      const ledger = candidate.tournamentPostflop!;
      expect(ledger).toMatchObject({ applied: true, selection: 'selected', authority: null });
      expect(candidate.action).toBe(ledger.candidateAction);
      // The Phase 7 receipt still names the action Phase 8 received.
      expect(candidate.tournamentUtility?.selectedAction).toBe(ledger.baselineAction);
      // A candidate without worker authority is refused by the client boundary.
      expect(horseDecisionReceiptIsValid(candidate, 'nlh')).toBe(false);
      ledger.authority = worker.receipt();
      expect(horseDecisionReceiptIsValid(candidate, 'nlh')).toBe(true);
      // An authority that is not usable cannot back a candidate.
      worker.withdraw('test');
      ledger.authority = worker.receipt();
      expect(horseDecisionReceiptIsValid(candidate, 'nlh')).toBe(false);

      // Shadow computes the same change and never applies or counts it.
      const shadow = decideAt(hand, 'shadow');
      expect(shadow.tournamentPostflop).toMatchObject({
        applied: false,
        changed: true,
        selection: 'shadow_change',
        candidateAction: ledger.candidateAction,
      });
      expect(shadow.action).toBe(ledger.baselineAction);
      expect(horseDecisionReceiptIsValid(shadow, 'nlh')).toBe(true);
      // A shadow ledger claiming application is malformed.
      expect(
        horseDecisionReceiptIsValid(
          {
            ...shadow,
            action: ledger.candidateAction,
            amount: ledger.candidateAmount ?? undefined,
            tournamentPostflop: {
              ...shadow.tournamentPostflop!,
              applied: true,
              selection: 'selected',
            },
          },
          'nlh'
        )
      ).toBe(false);
    }
  );

  // The Phase 7 audit (#5711) refuses, at worker admission, a receipt whose
  // Phase 7 evidence is not bound to the request it answers. A candidate that
  // changes play must pass that check exactly like any other receipt.
  it.each(['matches', 'mismatches'] as const)(
    'the client admits a play-changing candidate only when its receipt %s its request',
    async (mode) => {
      const hand = hands[0];
      const { hero, gs } = reconstructPhase8Hand(hand);
      const candidate = decideAt(hand, 'candidate');
      expect(candidate.action).not.toBe(candidate.tournamentPostflop?.baselineAction);
      expect(candidate.tournamentUtility?.evidence).toBeDefined();
      const worker = new HorseQualifiedAuthorityHolder('replay-worker');
      worker.apply(qualifiedTestAdmission(1));
      candidate.tournamentPostflop!.authority = worker.receipt();

      const sent: Array<{ type?: string; requestId?: number }> = [];
      let deliver: (message: HorseDecisionWorkerResponse) => void = () => {};
      const fake: WorkerLike = {
        postMessage: (message: unknown) => {
          sent.push(message as { type?: string });
        },
        on(event: string, listener: unknown) {
          if (event === 'message') deliver = listener as typeof deliver;
          return this;
        },
        terminate: async () => 0,
      } as unknown as WorkerLike;
      const client = new LiveHorseDecisionWorkerClient({ workerFactory: () => fake });
      deliver({
        type: 'READY',
        solverStores: {
          charts: 1,
          postflop: 2,
          postflopV31: 3,
          postflopV31Dataset: {
            id: '11111111-1111-4111-8111-111111111111',
            checksum: 'a'.repeat(64),
          },
        },
        solverPolicyArtifact: { totalPolicies: 4 },
        governor: {
          enabled: true,
          scale: 0.35,
          p50Ms: 180,
          p99Ms: 240,
          sampledAt: 123,
          throttledForS: 4,
          stale: false,
          timerLateMs: 25,
        },
      } as unknown as HorseDecisionWorkerResponse);
      // The mismatching request names an opponent the receipt never priced.
      const gameState =
        mode === 'matches'
          ? gs
          : {
              ...gs,
              players: gs.players.map((p) =>
                p.user_id === hero.user_id ? p : { ...p, user_id: `renamed-${p.user_id}` }
              ),
            };
      const snapshot: LiveHorseDecisionSnapshot = {
        generation: 7,
        fence: `phase8-replay-${mode}`,
        decisionTimeMs: 0,
        decisionKey: '',
        player: hero,
        gameState,
        style: 'balanced',
        mods: {},
      };
      snapshot.decisionKey = buildHorseDecisionKey(snapshot);
      const pending = client.decideFast(snapshot);
      const request = sent.find((m) => m.type === 'DECIDE_FAST') as Parameters<
        typeof horsePlanBatchBindingFromRequest
      >[0];
      expect(request).toBeDefined();
      deliver({
        type: 'FAST_RESULT',
        requestId: request.requestId,
        generation: 7,
        fence: snapshot.fence,
        planBinding: horsePlanBatchBindingFromRequest(request),
        planIssueDisposition: 'no_effects',
        decision: candidate,
        rngBefore: 11,
        rngAfter: 22,
        computeMs: 4,
        governorScale: 0.35,
        effects: [],
        phase8Authority: worker.receipt(),
      } as HorseDecisionWorkerResponse);
      if (mode === 'matches') {
        const result = await pending;
        expect(result.decision.action).toBe(candidate.tournamentPostflop!.candidateAction);
        expect(result.decision.executionWitness?.phase8Authority?.selection).toBe('selected');
        expect(client.status().phase).toBe('ready');
      } else {
        await expect(pending).rejects.toThrow('invalid policy receipt: phase7_foreign_opponent');
        expect(client.status().phase).toBe('failed');
      }
    }
  );
});
