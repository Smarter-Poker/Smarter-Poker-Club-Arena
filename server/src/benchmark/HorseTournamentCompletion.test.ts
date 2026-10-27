import { describe, expect, it } from 'vitest';
import {
  emptyTournamentCompletionCounts,
  recordTournamentCompletion,
  recordTournamentOpportunity,
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
  it('retains pre-eligibility reasons and separates designated-hero opportunities from all actors', () => {
    const counts = emptyTournamentCompletionCounts();
    const six = {
      ...state,
      players: Array.from({ length: 6 }, () => ({ stack: 100 })),
    } as HorseGameStateV2;
    const two = { ...six, players: six.players.slice(0, 2) };
    const refused = {
      ...layer(false, 'future_hand_seats_outside_work_budget'),
      eligible: false,
      fired: false,
    };
    const before = structuredClone(refused);
    recordTournamentOpportunity(counts, false, six, undefined);
    recordTournamentOpportunity(counts, true, { ...six, stage: 'preflop' }, undefined);
    recordTournamentOpportunity(counts, true, six, refused);
    recordTournamentOpportunity(counts, true, two, { ...refused, reason: 'utility_unavailable' });
    recordTournamentOpportunity(counts, true, two, layer(true, 'baseline_retained'));
    recordTournamentOpportunity(counts, true, two, undefined);
    expect(counts.opportunityDiagnostics).toEqual({
      version: 1,
      arm: 'evaluated',
      decisions: 6,
      designatedHeroDecisions: 5,
      otherActorDecisions: 1,
      heroPreflopDecisions: 1,
      heroPostflopDecisions: 4,
      heroOtherStreetDecisions: 0,
      heroPostflopWithinSeatBudget: 3,
      heroPostflopLedgerMissing: 1,
      heroPostflopEligible: 1,
      preEligibleRefusals: { future_hand_seats_outside_work_budget: 1, utility_unavailable: 1 },
    });
    expect(refused).toEqual(before); // Includes finalized latency and work; observation cannot alter it.
    expect(counts.completed).toBe(0);
    expect(counts.completionRefusals).toEqual({});
    expect(counts.completionDiagnostics).toEqual([]);
  });
  it('never copies an arbitrary refusal string into the public aggregate', () => {
    const counts = emptyTournamentCompletionCounts();
    recordTournamentOpportunity(counts, true, state, {
      ...layer(false, 'private raw input'),
      eligible: false,
    });
    expect(counts.opportunityDiagnostics?.preEligibleRefusals).toEqual({
      unknown_preeligibility_refusal: 1,
    });
    expect(JSON.stringify(counts)).not.toContain('private raw input');
  });
  it('admits original receipts and strictly validates optional opportunity denominators', async () => {
    const original = await runTournamentLeague(
      { objective: 'mtt', pairs: 1, seed: 1 },
      () => false
    );
    const counts = emptyTournamentCompletionCounts();
    recordTournamentOpportunity(counts, true, state, {
      ...layer(false, 'utility_unavailable'),
      eligible: false,
    });
    const result = { ...original, ...counts, decisions: 1 };
    const message = { type: 'TOURNAMENT_RESULT', jobId: 1, result };
    expect(horseLeagueComputeResponseIsValid({ ...message, result: original })).toBe(true);
    expect(horseLeagueComputeResponseIsValid(message)).toBe(true);
    const d = counts.opportunityDiagnostics!;
    // Keep every partition valid while forging eligibility outside the seat budget.
    expect(
      horseLeagueComputeResponseIsValid({
        ...message,
        result: {
          ...result,
          eligible: 1,
          opportunityDiagnostics: {
            ...d,
            heroPostflopWithinSeatBudget: 0,
            heroPostflopEligible: 1,
            preEligibleRefusals: {},
          },
        },
      })
    ).toBe(false);
    for (const patch of [
      { version: 2 },
      { arm: 'baseline' },
      { heroPostflopDecisions: 2 },
      { heroPostflopEligible: 1 },
      { decisions: -1 },
      { decisions: NaN },
      { decisions: Infinity },
      { decisions: 0.5 },
      { designatedHeroDecisions: 0 },
      { otherActorDecisions: 1 },
      { heroPostflopWithinSeatBudget: 2 },
      { heroPostflopLedgerMissing: 1 },
      { preEligibleRefusals: { private_cards: 1 } },
      { preEligibleRefusals: { utility_unavailable: NaN } },
      { preEligibleRefusals: { utility_unavailable: 0 } },
      { cards: ['As'] },
    ])
      expect(
        horseLeagueComputeResponseIsValid({
          ...message,
          result: { ...result, opportunityDiagnostics: { ...d, ...patch } },
        })
      ).toBe(false);
  });
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
