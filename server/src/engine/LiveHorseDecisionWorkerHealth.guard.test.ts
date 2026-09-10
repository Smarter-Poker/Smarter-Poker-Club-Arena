import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { sliceMethod } from '../testHelpers/sourceWindow.js';

const gameServer = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');
const instruments = readFileSync(
  new URL('../observability/engineInstruments.ts', import.meta.url),
  'utf8'
);
const leagueClient = readFileSync(
  new URL('../benchmark/HorseLeagueComputeWorkerClient.ts', import.meta.url),
  'utf8'
);
const decisionClient = readFileSync(new URL('./horseDecision/client.ts', import.meta.url), 'utf8');
const alertRules = readFileSync(
  new URL('../../../infra/monitoring/alert-rules.yml', import.meta.url),
  'utf8'
);

describe('live horse compute health has one authority', () => {
  it('does not report the idle main-thread governor as live horse capacity', () => {
    const health = sliceMethod(gameServer, 'getStatus()');
    expect(health).toContain('equityGovernor: liveHorseDecision.governor');
    expect(health).toContain('mainEventLoopGovernor: equityGovernor.snapshot()');
    expect(health).not.toContain('equityGovernor: equityGovernor.snapshot()');
  });

  it('publishes worker backlog, compute age, completion age, and both core governors', () => {
    for (const metric of [
      'poker_horse_decision_worker_ready',
      'poker_horse_decision_worker_queue_depth',
      'poker_horse_decision_worker_expired_jobs',
      'poker_horse_decision_worker_recoverable_request_errors',
      'poker_horse_decision_worker_active_job_age_ms',
      'poker_horse_decision_worker_oldest_queued_age_ms',
      'poker_horse_decision_worker_last_completion_age_ms',
      'poker_horse_decision_worker_last_compute_ms',
      'poker_horse_decision_worker_event_loop_delay_p50_ms',
      'poker_horse_decision_worker_event_loop_delay_p99_ms',
      'poker_main_event_loop_governor_scale',
      'poker_main_event_loop_governor_sampler_late_ms',
    ]) {
      expect(instruments).toContain(metric);
    }

    const metrics = sliceMethod(gameServer, 'getPrometheusMetrics()');
    expect(metrics).toContain('const worker = liveHorseDecisionWorkerStatus()');
    expect(metrics).toContain('horseDecisionWorkerQueueDepth.set(worker.queueDepth)');
    expect(metrics).toContain('horseDecisionWorkerExpiredJobs.set(worker.expiredJobs)');
    expect(metrics).toContain(
      'horseDecisionWorkerRecoverableRequestErrors.set(worker.recoverableRequestErrors)'
    );
    expect(metrics).toContain('worker.activeJobAgeMs ?? 0');
    expect(metrics).toContain('worker.oldestQueuedAgeMs ?? 0');
    expect(metrics).toContain('Date.now() - worker.lastCompletedAt');
    expect(metrics).toContain('horseDecisionWorkerLastComputeMs.set(worker.lastComputeMs ?? 0)');
    expect(metrics).toContain('equityGovernorScale.set(');
    expect(metrics).toContain('workerGovernor.scale');
    expect(metrics).toContain('mainEventLoopGovernorScale.set(');
  });

  it('never diagnoses main-loop saturation from the horse worker sampler', () => {
    const engineCore = alertRules.slice(
      alertRules.indexOf('- name: engine-core'),
      alertRules.indexOf('- name: tournament-work-scheduler')
    );
    expect(engineCore).toContain('poker_main_event_loop_governor_sampler_late_ms > 40');
    expect(engineCore).toContain('poker_main_event_loop_governor_sampler_late_ms > 300');
    expect(engineCore).not.toContain('poker_equity_governor_sampler_late_ms >');
    expect(engineCore).toContain('poker_equity_governor_scale < 1');
  });

  it('cannot publish status ok before dealer readiness or outside worker ready', () => {
    const health = sliceMethod(gameServer, 'getStatus()');
    expect(health).toContain('this.dealerPrerequisitesReady &&');
    expect(health).toContain("liveHorseDecision.phase === 'ready'");
  });

  it('pins nightly solver evidence to the exact worker-owned live V31 corpus', () => {
    expect(leagueClient).toContain('liveHorseDecisionWorkerStatus');
    expect(leagueClient).toContain("live.phase !== 'ready' || !live.solverStores");
    expect(leagueClient).toContain('return structuredClone(live.solverStores);');
    expect(leagueClient).toContain('postflopV31Dataset');
    expect(leagueClient).toContain('does not exactly match the live decision worker');
    expect(leagueClient).not.toContain('gtoChartCount');
    expect(leagueClient).not.toContain('gtoPostflopCount');
    expect(leagueClient).not.toContain('gtoPostflopV31Count');
    expect(decisionClient).toContain('horseDecisionSolverStoresAreValid(message.solverStores)');
    expect(decisionClient).toContain('invalid solver-store identity');
    expect(decisionClient).toContain('status lost solver-store identity');
  });
});
