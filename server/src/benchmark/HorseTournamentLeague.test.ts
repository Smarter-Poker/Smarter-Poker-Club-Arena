import { describe, expect, it } from 'vitest';
import { buildTournamentMState } from '../engine/HorseTournamentPreflop.js';
import {
  runTournamentLeague,
  tournamentLeagueBlindLevels,
  tournamentPolicyVersion,
  tournamentPolicyFamily,
  tournamentBaselineRunVerified,
  tournamentRunCanPromote,
  TOURNAMENT_LEAGUE_OBJECTIVES,
  summarizeTournamentPromotion,
  pairedConfidence99,
  TOURNAMENT_PROMOTION_SEEDS,
  TOURNAMENT_PROMOTION_PAIRS,
  tournamentLeagueEntrants,
  realizedTournamentReturn,
} from './HorseTournamentLeague.js';
import { horseLeagueComputeResponseIsValid } from './HorseLeagueComputeWorkerClient.js';

describe('Phase 8 paired tournament league', () => {
  it.each([0, 1, 2])('forecasts the actual next blind and ante level from level %i', (level) => {
    const forecast = tournamentLeagueBlindLevels(level);
    const dealtNextLevel = tournamentLeagueBlindLevels(level + 1).current;
    expect(forecast.next).toEqual(dealtNextLevel);
    expect(forecast.current.ante).toBe(level < 2 ? 0 : 4);
    const projected = buildTournamentMState({
      stackChips: 2000,
      ...forecast.current,
      anteType: forecast.anteType,
      playersAtTable: 6,
      nextSmallBlind: forecast.next.smallBlind,
      nextBigBlind: forecast.next.bigBlind,
      nextAnte: forecast.next.ante,
      minutesToNextLevel: 3,
    });
    const nextLevel = tournamentLeagueBlindLevels(level + 1);
    const dealt = buildTournamentMState({
      stackChips: 2000,
      ...nextLevel.current,
      anteType: nextLevel.anteType,
      playersAtTable: 6,
    });
    expect(projected.projectedOrbitCostChips).toBe(dealt.orbitCostChips);
    if (level === 1) {
      expect(projected.orbitCostChips).toBe(30);
      expect(projected.projectedOrbitCostChips).toBe(84); // 20+40+6*4, not 60.
    }
  });

  it('binds isolated family versions and refuses unknown requests without playing', async () => {
    const guard = await runTournamentLeague(
      { objective: 'mtt', pairs: 1, seed: 901823, phase8PolicyFamily: 'catastrophe_guard_v1' },
      () => false
    );
    expect(guard.phase8PolicyFamily).toBe('catastrophe_guard_v1');
    expect(guard.workKind).toBe('phase7_candidate_guard');
    expect(guard.version).toBe(tournamentPolicyVersion('catastrophe_guard_v1'));
    expect(
      horseLeagueComputeResponseIsValid({ type: 'TOURNAMENT_RESULT', jobId: 1, result: guard })
    ).toBe(true);
    expect(tournamentPolicyFamily()).toBe('continuation_v2');
    await expect(
      runTournamentLeague(
        { objective: 'mtt', pairs: 1, seed: 1, phase8PolicyFamily: 'unknown' as never },
        () => false
      )
    ).rejects.toThrow('Unknown tournament policy family');
    expect(
      horseLeagueComputeResponseIsValid({
        type: 'TOURNAMENT_RESULT',
        jobId: 1,
        result: { ...guard, version: tournamentPolicyVersion('continuation_v2') },
      })
    ).toBe(false);
    const legacy = await runTournamentLeague({ objective: 'mtt', pairs: 1, seed: 1 }, () => false);
    const { phase8PolicyFamily, workKind, ...original } = legacy;
    expect(
      horseLeagueComputeResponseIsValid({ type: 'TOURNAMENT_RESULT', jobId: 1, result: original })
    ).toBe(true);
    expect(summarizeTournamentPromotion([legacy, guard]).reasons).toContain(
      'mixed_policy_families'
    );
  });
  it('collects only bounded guard assessment work through the real isolated league', async () => {
    const result = await runTournamentLeague({
      objective: 'spin',
      pairs: 1,
      seed: 901791,
      phase8PolicyFamily: 'catastrophe_guard_v1',
      evidenceMode: 'fixture',
    });
    expect(result.complete).toBe(true);
    expect(result.promotionEligible).toBe(false);
    expect(result.eligible).toBeGreaterThan(0);
    expect(result.completed).toBe(result.eligible);
    for (const row of result.completionDiagnostics) {
      expect(row.workKind).toBe('phase7_candidate_guard');
      expect(row.guardWork?.assessmentCompleted).toBe(true);
      expect(row.work.rollouts).toBe(0);
      expect(row.work.outcomeSamples).toBe(0);
    }
    expect(horseLeagueComputeResponseIsValid({ type: 'TOURNAMENT_RESULT', jobId: 1, result })).toBe(
      true
    );
    const row = result.completionDiagnostics[0];
    const refusedRow = {
      ...row,
      completed: false,
      reason: 'continuation_sample_calibration',
      guardWork: { ...row.guardWork!, assessmentCompleted: false },
    };
    const forged = {
      ...result,
      fired: result.fired - 1,
      completed: result.completed - 1,
      completionRefusals: { continuation_sample_calibration: 1 },
      completionDiagnostics: [refusedRow, ...result.completionDiagnostics.slice(1)],
    };
    // Synthetic promotion-shaped metadata exercises the gate only, never strength evidence.
    const promotion = {
      ...result,
      evidenceMode: 'promotion' as const,
      pairs: 1024,
      requestedPairs: 1024,
      complete: true,
      meanDifference: 0.1,
      standardError: 0.01,
      confidence99: pairedConfidence99(0.1, 0.01, 1024),
      candidateReturn: 0.2,
      baselineReturn: 0.1,
      candidateFinish: result.candidateFinish.map((_, i) => (i === 0 ? 1024 : 0)),
      baselineFinish: result.baselineFinish.map((_, i) => (i === 0 ? 1024 : 0)),
      changed: 1,
      latencyMs: { p50: 1, p95: 1, p99: 1, max: 1 },
    };
    expect(tournamentRunCanPromote(promotion)).toBe(true);
    const forgedPromotion = {
      ...promotion,
      fired: forged.fired,
      completed: forged.completed,
      completionRefusals: forged.completionRefusals,
      completionDiagnostics: forged.completionDiagnostics,
    };
    expect([
      horseLeagueComputeResponseIsValid({ type: 'TOURNAMENT_RESULT', jobId: 1, result: forged }),
      tournamentBaselineRunVerified(forged),
      tournamentRunCanPromote(forgedPromotion),
    ]).toEqual([false, false, false]);

    for (const [candidateCount, accepted] of [
      [0, false],
      [1, true],
      [16, true],
      [17, false],
    ] as const) {
      expect(
        horseLeagueComputeResponseIsValid({
          type: 'TOURNAMENT_RESULT',
          jobId: 1,
          result: {
            ...result,
            completionDiagnostics: [
              { ...row, guardWork: { ...row.guardWork!, candidateCount } },
              ...result.completionDiagnostics.slice(1),
            ],
          },
        })
      ).toBe(accepted);
    }

    expect(
      horseLeagueComputeResponseIsValid({
        type: 'TOURNAMENT_RESULT',
        jobId: 1,
        result: {
          ...result,
          completionDiagnostics: [
            { ...row, work: { ...row.work, rollouts: 1 } },
            ...result.completionDiagnostics.slice(1),
          ],
        },
      })
    ).toBe(false);
  }, 30000);
  it('conserves two satellite seats when equal stacks tie for the final award', () => {
    const returns = [50, 25, 25].map((prizePct) =>
      realizedTournamentReturn('satellite', prizePct, 0, 36000, 0)
    );
    expect(returns).toEqual([1, 0.5, 0.5]);
    expect(returns.reduce((sum, value) => sum + value, 0)).toBe(2);
    expect(realizedTournamentReturn('satellite', 0, 0, 36000, 0)).toBe(0);
  });
  it('keeps realized Spin prize and PKO paid-bounty returns separate from seat equity', () => {
    expect(realizedTournamentReturn('spin', 100, 0, 6000, 0)).toBe(1);
    expect(realizedTournamentReturn('pko', 20, 900, 18000, 18000)).toBe(0.125);
  });
  it('identical policies finish an identical seeded tournament with no illegal action or chip loss', async () => {
    const result = await runTournamentLeague({
      objective: 'spin',
      pairs: 1,
      seed: 8101101,
      candidateMode: 'off',
    });
    expect(result.complete).toBe(true);
    expect(result.pairs).toBe(1);
    expect(result.illegalActions).toBe(0);
    expect(result.conservationErrors).toBe(0);
    expect(result.truncatedHands).toBe(0);
    expect(result.meanDifference).toBe(0);
    const diagnostics = result.opportunityDiagnostics!;
    expect(diagnostics).toBeDefined();
    expect(diagnostics.arm).toBe('evaluated');
    // Identical policies produce identical arms: merging both arms would double this.
    expect(diagnostics.decisions * 2).toBe(result.decisions);
    expect(diagnostics.designatedHeroDecisions).toBeGreaterThan(0);
    expect(diagnostics.otherActorDecisions).toBeGreaterThan(0);
    expect(diagnostics.decisions).toBe(
      diagnostics.designatedHeroDecisions + diagnostics.otherActorDecisions
    );
    expect(diagnostics.designatedHeroDecisions).toBe(
      diagnostics.heroPreflopDecisions +
        diagnostics.heroPostflopDecisions +
        diagnostics.heroOtherStreetDecisions
    );
    expect(diagnostics.heroPostflopDecisions).toBeGreaterThan(0);
    expect(diagnostics.heroPostflopDecisions).toBe(
      diagnostics.heroPostflopLedgerMissing +
        diagnostics.heroPostflopEligible +
        Object.values(diagnostics.preEligibleRefusals).reduce((sum, count) => sum + count!, 0)
    );
    expect(
      horseLeagueComputeResponseIsValid({
        type: 'TOURNAMENT_RESULT',
        jobId: 1,
        result,
      })
    ).toBe(true);
    expect(result.candidateFinish).toEqual(result.baselineFinish);
    expect(tournamentBaselineRunVerified(result)).toBe(false);
    const exercising = {
      ...result,
      eligible: 1,
      fired: 1,
      completed: 1,
      latencyMs: { p50: 1, p95: 2, p99: 3, max: 3 },
    };
    expect(tournamentBaselineRunVerified(exercising)).toBe(true);
    expect(tournamentBaselineRunVerified({ ...exercising, conservationErrors: 1 })).toBe(false);
    expect(
      tournamentBaselineRunVerified({
        ...exercising,
        latencyMs: { p50: 1, p95: 2, p99: 6, max: 6 },
      })
    ).toBe(false);
    expect(result.promotionEligible).toBe(false);
  }, 30000);
  it('runs the candidate through canonical state and reports real eligibility', async () => {
    const result = await runTournamentLeague({ objective: 'spin', pairs: 1, seed: 8102203 });
    expect(result.complete).toBe(true);
    expect(result.illegalActions).toBe(0);
    expect(result.conservationErrors).toBe(0);
    expect(result.eligible).toBeGreaterThan(0);
    expect(result.promotionEligible).toBe(false);
  }, 30000);
  it('finishes a paired 18-entrant tournament across balanced six-seat tables', async () => {
    const result = await runTournamentLeague({ objective: 'mtt', pairs: 1, seed: 901823 });
    expect(result.entrants).toBe(18);
    expect(result.complete).toBe(true);
    expect(result.candidateFinish).toHaveLength(18);
    expect(result.illegalActions).toBe(0);
    expect(result.conservationErrors).toBe(0);
    expect(result.truncatedHands).toBe(0);
    // Six-seat tables are outside Phase 8's future-hand seat scope
    // (PHASE8_POLICY.maxFutureHandSeats), so the candidate is consulted on
    // every decision but becomes eligible only at a table of three or fewer
    // seats with chips; the Spin case above pins real eligibility.
    expect(result.decisions).toBeGreaterThan(0);
    expect(result.eligible).toBeLessThanOrEqual(result.decisions);
  }, 60000);
  it.each(TOURNAMENT_LEAGUE_OBJECTIVES)(
    'cancellation of %s returns incomplete evidence',
    async (objective) => {
      const result = await runTournamentLeague({ objective, pairs: 1, seed: 8103307 }, () => false);
      expect(result.complete).toBe(false);
      expect(result.pairs).toBe(0);
      expect(result.promotionEligible).toBe(false);
    }
  );
  it('rejects forged confidence, counters, hidden fields and promotion claims at transport', async () => {
    const result = await runTournamentLeague(
      { objective: 'spin', pairs: 1, seed: 8103307 },
      () => false
    );
    const message = { type: 'TOURNAMENT_RESULT', jobId: 1, result };
    expect(horseLeagueComputeResponseIsValid(message)).toBe(true);
    for (const patch of [
      { promotionEligible: true },
      { confidence99: [0.1, 0.2] },
      { fired: 1 },
      { candidateFinish: [1, 0, 0, 0, 0, 0] },
      { secretOpponentCards: ['As', 'Ah'] },
      { primaryMetric: 'seat_attainment' },
      { complete: true },
      { latencyMs: { p50: 5, p95: 4, p99: 3, max: 2 } },
    ]) {
      expect(
        horseLeagueComputeResponseIsValid({ ...message, result: { ...result, ...patch } })
      ).toBe(false);
    }
  });
  it('requires every predeclared independent seed and format, recomputes intervals and refuses a critical regression', async () => {
    const empty = await runTournamentLeague({ objective: 'spin', pairs: 1, seed: 1 }, () => false);
    const runs = TOURNAMENT_LEAGUE_OBJECTIVES.flatMap((objective) =>
      TOURNAMENT_PROMOTION_SEEDS.map((seed) => ({
        ...empty,
        objective,
        entrants: tournamentLeagueEntrants(objective),
        seed,
        evidenceMode: 'promotion' as const,
        candidateMode: 'candidate' as const,
        complete: true,
        pairs: TOURNAMENT_PROMOTION_PAIRS,
        requestedPairs: TOURNAMENT_PROMOTION_PAIRS,
        meanDifference: 0.05,
        standardError: 0.01,
        changed: 1,
        fired: 1,
        completed: 1,
        eligible: 1,
        decisions: 2,
        promotionEligible: false,
        confidence99: pairedConfidence99(0.05, 0.01, TOURNAMENT_PROMOTION_PAIRS),
        candidateReturn: 0.3,
        baselineReturn: 0.25,
        candidateFinish: Array.from({ length: tournamentLeagueEntrants(objective) }, (_, i) =>
          i === 0 ? TOURNAMENT_PROMOTION_PAIRS : 0
        ),
        baselineFinish: Array.from({ length: tournamentLeagueEntrants(objective) }, (_, i) =>
          i === 0 ? TOURNAMENT_PROMOTION_PAIRS : 0
        ),
      }))
    );
    // Fixture values exercise the gate, never published as played tournaments.
    expect(summarizeTournamentPromotion(runs).promoted).toBe(true);
    expect(summarizeTournamentPromotion(runs.slice(1)).promoted).toBe(false);
    expect(summarizeTournamentPromotion([...runs, runs[0]]).promoted).toBe(false);
    runs[0].meanDifference = 0;
    expect(summarizeTournamentPromotion(runs).promoted).toBe(false);
    runs[0].meanDifference = 0.05;
    runs[0].candidateDeepOnePairCommitments = 1;
    expect(summarizeTournamentPromotion(runs).promoted).toBe(false);
    expect(pairedConfidence99(0.2, 0, 1)).toEqual([-1, 1]);
    expect(pairedConfidence99(0.05, 0.01, 1024)[0]).toBeCloseTo(0.0241);
  });
});
