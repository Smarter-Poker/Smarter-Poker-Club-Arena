import { describe, expect, it } from 'vitest';
import {
  emptyTournamentCompletionCounts,
  recordTournamentCompletion,
  MAX_TOURNAMENT_COMPLETION_DIAGNOSTICS,
  runTournamentLeague,
} from './HorseTournamentLeague.js';
import { horseLeagueComputeResponseIsValid } from './HorseLeagueComputeWorkerClient.js';
import type { HorseTournamentPostflopLedger } from '../engine/HorseTournamentPostflop.js';
import type { HorseGameStateV2 } from '../engine/HorseLogic.js';

function layer(completed: boolean, reason: string) {
  return {
    eligible: true,
    fired: true,
    completed,
    reason,
    latencyMs: completed ? 2 : 5.1,
    work: {
      attempts: 1,
      candidateCount: 3,
      candidatesCompleted: 3,
      outcomeSamples: 16,
      samplesVisited: 48,
      rollouts: 24,
      rolloutCacheHits: 0,
      estimates: 17,
      estimateCacheHits: 7,
      icmMethod: 'exact_mh',
      levelBounds: 2,
      budgetStop: 'none',
    },
  } as HorseTournamentPostflopLedger;
}
const state = {
  stage: 'turn',
  players: Array.from({ length: 6 }, () => ({})),
  tournament: { playersLeft: 18 },
} as HorseGameStateV2;

describe('Phase8 completion counters record returned useful continuations', () => {
  it('separates computed-but-refused results and retains exact refusal reasons', () => {
    const counts = emptyTournamentCompletionCounts();
    recordTournamentCompletion(counts, layer(false, 'budget_exhausted'), state);
    recordTournamentCompletion(counts, layer(false, 'illegal_candidate'), state);
    const accepted = layer(true, 'baseline_retained');
    recordTournamentCompletion(counts, accepted, state);
    expect(counts.completed).toBe(1);
    expect(counts.completionRefusals).toEqual({ budget_exhausted: 1, illegal_candidate: 1 });
    expect(counts.completionDiagnostics.map((row) => row.completed)).toEqual([false, false, true]);
    expect(counts.completionDiagnostics[0]).toMatchObject({
      street: 'turn',
      localPlayers: 6,
      fieldPlayers: 18,
    });
    accepted.work.estimates = 0;
    expect(counts.completionDiagnostics[2].work.estimates).toBe(17);
  });
  it('bounds detailed rows without dropping aggregate refusals or fabricating completion', () => {
    const counts = emptyTournamentCompletionCounts();
    const refused = layer(false, 'continuation_operation_budget');
    for (let i = 0; i < MAX_TOURNAMENT_COMPLETION_DIAGNOSTICS + 5; i++)
      recordTournamentCompletion(counts, refused, state);
    expect(counts.completed).toBe(0);
    expect(counts.completionDiagnostics).toHaveLength(MAX_TOURNAMENT_COMPLETION_DIAGNOSTICS);
    expect(counts.completionDiagnosticsDropped).toBe(5);
    expect(counts.completionRefusals.continuation_operation_budget).toBe(
      MAX_TOURNAMENT_COMPLETION_DIAGNOSTICS + 5
    );
    recordTournamentCompletion(counts, { ...refused, eligible: false }, state);
    expect(counts.completionDiagnosticsDropped).toBe(5);
  });
  it('requires a complete, private-data-free completion schema across the real transport validator', async () => {
    const empty = await runTournamentLeague({ objective: 'mtt', pairs: 1, seed: 1 }, () => false);
    const counts = emptyTournamentCompletionCounts();
    recordTournamentCompletion(counts, layer(false, 'budget_exhausted'), state);
    recordTournamentCompletion(counts, layer(true, 'baseline_retained'), state);
    const result = { ...empty, ...counts, decisions: 2, eligible: 2, fired: 2 };
    const message = { type: 'TOURNAMENT_RESULT', jobId: 1, result };
    expect(horseLeagueComputeResponseIsValid(message)).toBe(true);
    const mutations: Record<string, unknown>[] = [
      { completionSchemaVersion: undefined },
      { completed: 3 },
      { completed: 0 },
      { completionRefusals: {} },
      { completionRefusals: { secret_cards: 1 } },
      { completionRefusals: { budget_exhausted: -1 } },
      { completionDiagnosticsDropped: 1 },
      { completionDiagnostics: [] },
      {
        completionDiagnostics: counts.completionDiagnostics.map((row) => ({
          ...row,
          cards: ['As'],
        })),
      },
      {
        completionDiagnostics: counts.completionDiagnostics.map((row) => ({
          ...row,
          work: { ...row.work, secret: 'As' },
        })),
      },
      {
        completionDiagnostics: counts.completionDiagnostics.map((row) => ({
          ...row,
          work: { ...row.work, estimates: NaN },
        })),
      },
      {
        completionDiagnostics: counts.completionDiagnostics.map((row) => ({
          ...row,
          completed: true,
          reason: 'baseline_retained',
        })),
      },
      {
        completionDiagnostics: counts.completionDiagnostics.map((row) => ({
          ...row,
          reason: 'secret_cards',
        })),
      },
    ];
    for (const patch of mutations)
      expect(
        horseLeagueComputeResponseIsValid({ ...message, result: { ...result, ...patch } })
      ).toBe(false);
  });
});
