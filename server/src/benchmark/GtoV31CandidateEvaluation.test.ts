import { describe, expect, it } from 'vitest';
import {
  aggregateGtoV31Evaluation,
  buildGtoV31EvaluationScenarios,
  type GtoV31EvaluationFamily,
} from './GtoV31CandidateEvaluation.js';
import type { LeagueBenchmarkComponent } from './HorseLeague.js';

const CHECKSUM = 'a'.repeat(64);

describe('V31 candidate promotion card', () => {
  it('covers every required family and every tournament utility without aliasing ICM', () => {
    const families: GtoV31EvaluationFamily[] = ['cash', 'spin', 'tourney_ev', 'tourney_icm'];
    const scenarios = families.flatMap((family) =>
      buildGtoV31EvaluationScenarios(family, 'paired_replay', CHECKSUM)
    );
    expect(scenarios.reduce((total, scenario) => total + scenario.pairs, 0)).toBe(20_000);
    expect(scenarios.filter((scenario) => scenario.family === 'spin').map((s) => s.key)).toEqual([
      'chip_ev',
      'spin_ladder',
    ]);
    expect(
      scenarios.filter((scenario) => scenario.family === 'tourney_icm').map((s) => s.key)
    ).toEqual(['satellite', 'bubble', 'final_table', 'in_money', 'ladder']);
    const spinChip = scenarios.find(
      (scenario) => scenario.key === 'chip_ev' && scenario.family === 'spin'
    );
    const spinIcm = scenarios.find((scenario) => scenario.key === 'spin_ladder');
    expect(spinChip?.matchup.context?.tournament?.spotsPaid).toBe(1);
    expect(spinIcm?.matchup.context?.tournament?.spotsPaid).toBe(2);
    for (const scenario of scenarios) {
      expect(scenario.matchup.a.gtoV31DatasetChecksum).toBe(CHECKSUM);
      expect(scenario.matchup.b.gtoV31DatasetChecksum).toBeUndefined();
      expect(scenario.matchup.a.mind).toBe(false);
      expect(scenario.matchup.b.mind).toBe(false);
      expect(scenario.matchup.a.telemetry).toBe(false);
      expect(scenario.matchup.b.telemetry).toBe(false);
    }

    const league = buildGtoV31EvaluationScenarios('cash', 'league', CHECKSUM)[0];
    expect(league.matchup.a.gtoV31DatasetChecksum).toBe(CHECKSUM);
    expect(league.matchup.a.mind).toBeUndefined();
    expect(league.matchup.b.mind).toBeUndefined();
    expect(league.matchup.a.telemetry).toBeUndefined();
    expect(league.matchup.b.telemetry).toBeUndefined();
  });

  it('rejects a missing or placeholder candidate checksum', () => {
    expect(() => buildGtoV31EvaluationScenarios('cash', 'league', 'bad')).toThrow(/sealed/);
    expect(() => buildGtoV31EvaluationScenarios('cash', 'league', '0'.repeat(64))).toThrow(
      /sealed/
    );
  });

  it('combines scenario estimates and preserves every proof component', () => {
    const components: LeagueBenchmarkComponent[] = [
      {
        scenario: 'one',
        hands: 4_000,
        bb100: 2,
        stderr: 1,
        durationMs: 10,
        illegalActions: 0,
        truncatedStreets: 0,
        candidatePolicyHits: 12,
        candidateNodeRoles: ['open'],
      },
      {
        scenario: 'two',
        hands: 6_000,
        bb100: -1,
        stderr: 2,
        durationMs: 20,
        illegalActions: 0,
        truncatedStreets: 0,
        candidatePolicyHits: 18,
        candidateNodeRoles: ['facing_bet'],
      },
    ];
    const result = aggregateGtoV31Evaluation('card', components);
    expect(result.hands).toBe(10_000);
    expect(result.bb100).toBeCloseTo(0.2, 10);
    expect(result.stderr).toBeCloseTo(Math.sqrt(4_000 ** 2 + (2 * 6_000) ** 2) / 10_000, 10);
    expect(result.candidatePolicyHits).toBe(30);
    expect(result.candidateNodeRoles).toEqual(['facing_bet', 'open']);
    expect(result.benchmarkComponents).toEqual(components);
  });
});
