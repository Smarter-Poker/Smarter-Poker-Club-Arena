import { describe, expect, it } from 'vitest';
import {
  runTournamentLeague,
  tournamentBaselineRunVerified,
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
    expect(result.eligible).toBeGreaterThan(0);
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
