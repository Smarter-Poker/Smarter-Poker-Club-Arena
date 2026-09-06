/**
 * LAW: THE CLUSTER CONTROLLER PAGES (2026-09-05)
 *
 * On 2026-09-04 22:10 UTC the controller's pass latch stalled for eleven
 * minutes with no log line. It had a rich event log and a per-pass summary
 * and nothing that could reach Prometheus, so nothing could reach a human.
 *
 * PINS
 *   1. A real tick writes into the ALWAYS-ON registry that GameServer renders
 *      on every scrape (not the ENGINE_METRICS-gated one, which is off).
 *   2. A frozen tick is counted as skipped and does NOT count as a pass, so
 *      a frozen controller looks stalled to the rule and the break guard is
 *      what silences it - never a fake pass.
 *   3. The stall branch counts.
 *   4. infra/monitoring/alert-rules.yml has a `cluster` group with the five
 *      alerts, EVERY one break-guarded (CLAUDE.md 13 rule 6), reading only
 *      metrics the engine emits, routed to a receiver that delivers.
 *   5. /health carries the last pass under `cluster`, null on a non-leader.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClusterController,
  type ClusterControllerDeps,
  CLUSTER_TICK_STALL_MS,
} from './ClusterController.js';
import { clusterMetrics } from './ClusterMetrics.js';
import { alwaysOnPrometheusLines } from '../observability/engineInstruments.js';
import { sliceYamlEntry } from '../testHelpers/sourceWindow.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

type Rpc = NonNullable<ClusterControllerDeps['rpc']>;

const controllerWith = (rpc: Rpc, frozen = () => false) =>
  new ClusterController({
    eligibleHorseCount: () => 0,
    eligibleCounts: () => new Map<string, number>(),
    ensureEngine: async () => true,
    hasEngine: () => true,
    seatedCount: async () => 0,
    frozen,
    rpc,
  });

/* PIN MOVED 2026-09-05: the pass is ONE call to fn_cash_clusters_tick_all
   (#3119), which returns every game's tick result; the per-game RPC is no
   longer made by the pass. */
const okRpc = (actions: unknown[] = []) =>
  vi.fn(async (fn: string) => {
    if (fn === 'fn_cash_clusters_tick_all')
      return {
        data: {
          ok: true,
          games: 2,
          ticked: 2,
          errors: 0,
          rested: 0,
          results: [
            {
              game_id: 'g1',
              main1_table_id: 't1',
              enabled: true,
              result: { ok: true, actions, seated_total: 0 },
            },
            {
              game_id: 'g2',
              main1_table_id: 't2',
              enabled: true,
              result: { ok: true, actions, seated_total: 0 },
            },
          ],
        },
        error: null,
      };
    return { data: { ok: true, actions, seated_total: 0 }, error: null };
  }) as unknown as Rpc;

afterEach(() => vi.restoreAllMocks());

describe('LAW 1 - a tick is scraped', () => {
  it('a real pass lands in the always-on registry with its actions by kind', async () => {
    const before = clusterMetrics.passesTotal.get();
    const c = controllerWith(okRpc([{ feeder: 'opened', buyers: 2 }, { moves_planned: 1 }]));
    const s = await c.tick();
    expect(s.ticked).toBe(2);
    expect(clusterMetrics.passesTotal.get()).toBe(before + 1);
    expect(clusterMetrics.passGames.get()).toBe(2);
    /* poker_cluster_games{state} is fed from worklist rows carrying `state`;
       the one-RPC pass (#3119) returns per-game results without it, so the
       gauge is not asserted here until fn_cash_clusters_tick_all carries state. */
    expect(clusterMetrics.actionsTotal.get({ kind: 'feeder_opened' })).toBeGreaterThanOrEqual(2);
    expect(clusterMetrics.actionsTotal.get({ kind: 'moves_planned' })).toBeGreaterThanOrEqual(2);
    const text = alwaysOnPrometheusLines().join('\n');
    expect(text).toContain('# TYPE poker_cluster_pass_duration_seconds histogram');
    expect(text).toMatch(/^poker_cluster_last_pass_timestamp_seconds \d{10}$/m);
    expect(text).toMatch(/^poker_cluster_actions_total\{kind="feeder_opened"\} \d+$/m);
  });

  it('a failed worklist is a pass with an error, so the timestamp still moves', async () => {
    const errors = clusterMetrics.passErrorsTotal.get();
    const passes = clusterMetrics.passesTotal.get();
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'boom' } })) as unknown as Rpc;
    await controllerWith(rpc).tick();
    expect(clusterMetrics.passErrorsTotal.get()).toBe(errors + 1);
    expect(clusterMetrics.passesTotal.get()).toBe(passes + 1);
  });
});

describe('LAW 2 - the freeze is a skip, not a pass', () => {
  it('counts skipped_frozen and leaves the pass clock alone', async () => {
    const passes = clusterMetrics.passesTotal.get();
    const skipped = clusterMetrics.passSkippedFrozenTotal.get();
    const stamp = clusterMetrics.lastPassTimestamp.get();
    const rpc = okRpc();
    const s = await controllerWith(rpc, () => true).tick();
    expect(s.skippedFrozen).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    expect(clusterMetrics.passSkippedFrozenTotal.get()).toBe(skipped + 1);
    expect(clusterMetrics.passesTotal.get()).toBe(passes);
    expect(clusterMetrics.lastPassTimestamp.get()).toBe(stamp);
  });
});

describe('LAW 3 - the released latch is counted', () => {
  it('a pass still open past CLUSTER_TICK_STALL_MS increments stalled_total', async () => {
    const stalled = clusterMetrics.passStalledTotal.get();
    let first = true;
    const rpc = vi.fn(async (fn: string) => {
      if (fn === 'fn_cash_clusters_tick_all') {
        if (first) {
          first = false;
          return new Promise(() => {}); // the wedged pass
        }
        return {
          data: { ok: true, games: 0, ticked: 0, errors: 0, rested: 0, results: [] },
          error: null,
        };
      }
      return { data: { ok: true }, error: null };
    }) as unknown as Rpc;
    const c = controllerWith(rpc);
    const t0 = 1_757_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    void c.tick(); // holds the latch forever
    await Promise.resolve();
    now.mockReturnValue(t0 + CLUSTER_TICK_STALL_MS - 1);
    await c.tick(); // inside the ceiling: returns the stale summary, no count
    expect(clusterMetrics.passStalledTotal.get()).toBe(stalled);
    now.mockReturnValue(t0 + CLUSTER_TICK_STALL_MS + 1);
    const s = await c.tick(); // past it: reported, released, counted
    expect(s.games).toBe(0);
    expect(clusterMetrics.passStalledTotal.get()).toBe(stalled + 1);
    expect(clusterMetrics.healthSnapshot().stalled).toBeGreaterThanOrEqual(1);
  });
});

describe('LAW 4 - the rules are wired, guarded and real', () => {
  const rules = read('infra/monitoring/alert-rules.yml');
  const ALERTS = [
    'ClusterControllerStalled',
    'ClusterPassLatchReleased',
    'ClusterPassErrors',
    'ClusterTickingNothing',
    'ClusterFeedersAbandoned',
    'ClusterMovesExpiring',
    'ClusterPassSlow',
  ];

  it('the file is loaded by prometheus and mounted into the container', () => {
    expect(read('infra/monitoring/prometheus.yml')).toContain('/etc/prometheus/alert-rules.yml');
    expect(read('infra/monitoring/docker-compose.yml')).toContain(
      './alert-rules.yml:/etc/prometheus/alert-rules.yml:ro'
    );
  });

  it('the cluster group exists with every alert', () => {
    expect(rules).toMatch(/^  - name: cluster\s*$/m);
    for (const a of ALERTS) expect(rules, a).toContain(`- alert: ${a}`);
  });

  it('EVERY rule carries the break guard (CLAUDE.md 13 rule 6), with on() so it survives aggregation', () => {
    for (const a of ALERTS) {
      const block = sliceYamlEntry(rules, `alert: ${a}`);
      expect(block, a).toContain(
        'unless on() max_over_time(poker_maintenance_break_active[6m]) == 1'
      );
      expect(block, `${a} has a severity`).toMatch(/severity: (critical|warning)/);
      expect(block, `${a} names its component`).toContain('component: cluster');
    }
  });

  it('every poker_cluster_* metric a rule reads is one the engine emits', () => {
    const emitted = alwaysOnPrometheusLines().join('\n');
    const rendered = new Set(
      [...emitted.matchAll(/^(poker_[a-z_0-9]+?)(?:_bucket|_count|_sum)?[{ ]/gm)].map((m) => m[1])
    );
    // Rendered by GameServer.getPrometheusMetrics directly, not the registry.
    rendered.add('poker_maintenance_break_active');
    for (const a of ALERTS) {
      const block = sliceYamlEntry(rules, `alert: ${a}`);
      const expr = block.slice(block.indexOf('expr:'), block.indexOf('for:'));
      const names = new Set(
        [...expr.matchAll(/poker_[a-z_0-9]+/g)].map((m) => m[0].replace(/_(bucket|count|sum)$/, ''))
      );
      expect(names.size, `${a} reads at least one metric`).toBeGreaterThan(0);
      for (const n of names)
        expect(rendered.has(n), `${a} reads ${n}, which the engine emits`).toBe(true);
    }
  });

  it('the stall rule only speaks while the engine is scraped, and within a minute', () => {
    const block = sliceYamlEntry(rules, 'alert: ClusterControllerStalled');
    expect(block).toContain('time() - poker_cluster_last_pass_timestamp_seconds');
    expect(block).toContain('up{job="engine_game_server"} == 1');
    expect(block).toMatch(/> 60\b/);
    expect(block).toContain('severity: critical');
  });

  it('the feeder rule needs five abandonments AND no feeder live, and tolerates a series that never existed', () => {
    const block = sliceYamlEntry(rules, 'alert: ClusterFeedersAbandoned');
    expect(block).toContain('kind="feeder_abandoned"');
    expect(block).toMatch(/\[30m\]\)\) >= 5/);
    expect(block).toContain('kind="feeder_live"');
    expect(block).toContain('or vector(0)');
  });

  it('the slow-pass rule sits above the measured ~10 s norm, never below it', () => {
    const block = sliceYamlEntry(rules, 'alert: ClusterPassSlow');
    const limit = Number(block.match(/\)\s*>\s*(\d+)\s*$/m)![1]);
    expect(limit).toBeGreaterThan(10);
    expect(block).toContain('histogram_quantile(0.95');
  });

  it('critical and warning both reach a receiver that delivers', () => {
    const am = read('infra/monitoring/alertmanager.yml');
    for (const sev of ['critical', 'warning']) {
      // The route entry is `- matchers: [severity="..."]` then `receiver:`.
      const after = am.slice(am.indexOf(`severity="${sev}"`));
      const receiver = after.match(/receiver:\s*([\w-]+)/)![1];
      expect(receiver, sev).not.toMatch(/null|blackhole/);
      const def = sliceYamlEntry(am, `name: ${receiver}`);
      expect(def, `${receiver} delivers`).toContain('_configs:');
    }
  });
});

describe('LAW 5 - /health carries the last pass', () => {
  it('GameServer.getStatus publishes cluster from the controller, null off-leader', () => {
    const src = read('server/src/GameServer.ts');
    expect(src).toContain(
      'cluster: this.clusterController.isRunning ? clusterMetrics.healthSnapshot() : null'
    );
  });

  it('the controller calls the three hooks and nothing else', () => {
    const src = read('server/src/cluster/ClusterController.ts');
    expect(src.match(/clusterMetrics\.recordPass\(/g)?.length).toBe(2);
    expect(src.match(/clusterMetrics\.recordStalled\(\)/g)?.length).toBe(1);
    expect(src.match(/clusterMetrics\.recordSkippedFrozen\(\)/g)?.length).toBe(1);
    expect(src.match(/clusterMetrics\./g)?.length).toBe(4);
  });
});
