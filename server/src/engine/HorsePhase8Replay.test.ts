import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { reconstructPhase8Hand, type CapturedPhase8Hand } from './HorsePhase8ReplayFixture.js';
import { horseDecisionReceiptIsValid } from './horseDecision/responseValidation.js';
import { HorseQualifiedAuthorityHolder } from './HorseQualifiedAuthority.js';
import { qualifiedTestAdmission } from './HorseQualifiedAuthority.test-support.js';

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
    expect(['all_in', 'bet', 'raise']).toContain(baseline.action);
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
});
