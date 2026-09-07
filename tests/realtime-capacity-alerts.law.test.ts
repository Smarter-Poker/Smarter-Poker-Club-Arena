import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const rules = read('infra/monitoring/alert-rules.yml');
const instruments = `${read('server/src/observability/engineInstruments.ts')}\n${read(
  'server/src/tournament/TournamentEliminationScheduler.ts'
)}`;
const gameServer = read('server/src/GameServer.ts');
const governor = read('server/src/engine/EquityLoadGovernor.ts');
const runbook = read('docs/runbooks/tournament-scheduler-and-engine-saturation.md');

function alert(name: string): string {
  const start = rules.indexOf(`- alert: ${name}`);
  expect(start, `${name} is missing`).toBeGreaterThan(-1);
  const next = rules.indexOf('\n      - alert:', start + 1);
  const nextGroup = rules.indexOf('\n  - name:', start + 1);
  const ends = [next, nextGroup].filter((position) => position > start);
  return rules.slice(start, ends.length > 0 ? Math.min(...ends) : rules.length);
}

const expectedMetrics = [
  'poker_tournament_elimination_scheduler_slots_inflight',
  'poker_tournament_elimination_scheduler_stalled_slots',
  'poker_tournament_elimination_scheduler_oldest_wait_ms',
  'poker_tournament_bounty_recovery_sweep_runs_total',
  'poker_tournament_bounty_recovery_pending',
  'poker_tournament_bounty_realtime_connected',
  'poker_tournament_manager_wake_realtime_connected',
  'poker_event_loop_delay_p50_ms',
  'poker_equity_governor_sampler_late_ms',
];

describe('realtime capacity alerts', () => {
  it('only references metrics that the engine actually emits', () => {
    for (const metric of expectedMetrics) {
      expect(instruments, `${metric} is not emitted by the engine`).toContain(`'${metric}'`);
    }
    expect(gameServer).toContain('...alwaysOnPrometheusLines()');
  });

  it('alerts on physical saturation plus wait age, never ordinary queue depth alone', () => {
    const rule = alert('TournamentEliminationSchedulerSaturated');
    expect(rule).toContain('poker_tournament_elimination_scheduler_slots_inflight >= 4');
    expect(rule).toContain('poker_tournament_elimination_scheduler_oldest_wait_ms > 120000');
    expect(rule).not.toMatch(/^\s*poker_tournament_elimination_scheduler_queue_depth\s*>/m);
    expect(rule).toContain('max_over_time(poker_maintenance_break_active[6m])');
  });

  it('alerts when every physical promise is stalled even if the logical queue is empty', () => {
    const rule = alert('TournamentEliminationSchedulerAllSlotsStalled');
    expect(rule).toContain('poker_tournament_elimination_scheduler_slots_inflight >= 4');
    expect(rule).toContain('poker_tournament_elimination_scheduler_stalled_slots >= 4');
    expect(rule).not.toContain('poker_tournament_elimination_scheduler_oldest_wait_ms');
    expect(rule).not.toMatch(/^\s*poker_tournament_elimination_scheduler_queue_depth\s*>/m);
    expect(rule).toMatch(/for:\s*2m/);
    expect(rule).toContain('max_over_time(poker_maintenance_break_active[6m])');
    expect(rule).toContain('tournament-scheduler-and-engine-saturation.md');
    expect(runbook).toContain('All Elimination Slots Stalled');
  });

  it('pages on repeated bounty recovery failures or a durable stuck obligation', () => {
    const failures = alert('TournamentBountyRecoveryLaneFailing');
    expect(failures).toContain(
      'poker_tournament_bounty_recovery_sweep_runs_total{outcome=~"error|partial"}'
    );
    expect(failures).not.toContain('outcome="frozen"');
    expect(failures).not.toContain('outcome="coalesced"');
    expect(failures).toMatch(/for:\s*2m/);

    const backlog = alert('TournamentBountyOutboxBacklogStuck');
    expect(backlog).toContain('poker_tournament_bounty_recovery_pending > 0');
    expect(backlog).toMatch(/for:\s*10m/);
    for (const rule of [failures, backlog]) {
      expect(rule).toContain('max_over_time(poker_maintenance_break_active[6m])');
      expect(rule).toContain('tournament-scheduler-and-engine-saturation.md');
    }
    expect(runbook).toContain('Bounty Recovery Failing Or Stuck');

    const disconnected = alert('TournamentBountyRealtimeDisconnected');
    expect(disconnected).toContain('poker_tournament_bounty_realtime_connected == 0');
    expect(disconnected).toMatch(/for:\s*2m/);
    expect(disconnected).toContain('max_over_time(poker_maintenance_break_active[6m])');

    const wakeDisconnected = alert('TournamentManagerWakeRealtimeDisconnected');
    expect(wakeDisconnected).toContain('poker_tournament_manager_wake_realtime_connected == 0');
    expect(wakeDisconnected).toMatch(/for:\s*2m/);
    expect(wakeDisconnected).toContain('max_over_time(poker_maintenance_break_active[6m])');
  });

  it('keeps the existing sustained event-loop alert guarded and runbook-backed', () => {
    const warning = alert('EngineCoreOutOfHeadroom');
    expect(warning).toContain('poker_event_loop_delay_p50_ms > 40');
    expect(warning).toContain('poker_equity_governor_sampler_late_ms > 40');
    expect(warning).toMatch(/for:\s*10m/);
    expect(warning).toContain('max_over_time(poker_maintenance_break_active[6m])');
    expect(warning).toContain('tournament-scheduler-and-engine-saturation.md');

    const rule = alert('EngineCoreSaturated');
    expect(rule).toContain('poker_event_loop_delay_p50_ms > 300');
    expect(rule).toContain('poker_equity_governor_sampler_late_ms > 300');
    expect(rule).toMatch(/poker_event_loop_delay_p50_ms > 300\s+or /);
    expect(rule).not.toMatch(/\bor\s+on\(/);
    expect(rule).toMatch(/for:\s*5m/);
    expect(rule).toContain('max_over_time(poker_maintenance_break_active[6m])');
    expect(rule).toContain('tournament-scheduler-and-engine-saturation.md');
    expect(rule).toContain('the 0.08 scale and 30-iteration deep floor');
    expect(governor).toMatch(/if \(p50Ms < 1000\) return 0\.2;\s+return 0\.08;/);
    expect(runbook).toContain('1,000 ms or more should be 0.08');
  });

  it('links every new alert to a checked-in runbook', () => {
    const runbook = 'docs/runbooks/tournament-scheduler-and-engine-saturation.md';
    expect(existsSync(resolve(process.cwd(), runbook))).toBe(true);
    for (const name of [
      'TournamentEliminationSchedulerSaturated',
      'TournamentEliminationSchedulerAllSlotsStalled',
      'TournamentBountyRecoveryLaneFailing',
      'TournamentBountyRealtimeDisconnected',
      'TournamentManagerWakeRealtimeDisconnected',
      'TournamentBountyOutboxBacklogStuck',
    ]) {
      expect(alert(name)).toContain(runbook);
    }
  });
});
