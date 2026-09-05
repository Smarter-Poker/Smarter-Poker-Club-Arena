/**
 * ClusterMetrics turns the controller's pass into series. These pin: every
 * named metric is emitted with HELP and TYPE; a pass observes the histogram
 * and stamps the timestamp; actions are counted by kind with a bounded label;
 * the stall and freeze branches count; the summary's newer shape (rested,
 * rpcs) is optional; /health gets the snapshot.
 */
import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../observability/Metrics.js';
import {
  ClusterMetrics,
  actionKind,
  MAX_KINDS,
  CLUSTER_PASS_DURATION_BUCKETS_S,
} from './ClusterMetrics.js';
import type { ClusterRow, ClusterTickSummary } from './ClusterController.js';

const summary = (over: Partial<ClusterTickSummary> = {}): ClusterTickSummary => ({
  games: 3,
  ticked: 3,
  woken: 1,
  errors: 0,
  skippedFrozen: false,
  elapsedMs: 1200,
  actions: [],
  ...over,
});

const rows = (states: string[]): ClusterRow[] =>
  states.map((state, i) => ({
    game_id: `g${i}`,
    club_id: 'c',
    main1_table_id: `t${i}`,
    state,
    enabled: true,
  }));

const build = (nowMs = 1_757_000_000_000) => {
  const registry = new MetricsRegistry();
  let now = nowMs;
  const m = new ClusterMetrics(registry, () => now);
  return { registry, m, advance: (ms: number) => (now += ms) };
};

describe('actionKind', () => {
  it('derives the vocabulary the rule file reads', () => {
    expect(actionKind({ moves_planned: 2 })).toBe('moves_planned');
    expect(actionKind({ moves_expired: 1 })).toBe('moves_expired');
    expect(actionKind({ feeder: 'opened', buyers: 3 })).toBe('feeder_opened');
    expect(actionKind({ feeder_abandoned: '5f0c1c2e-1111-4a4a-8b8b-0123456789ab' })).toBe(
      'feeder_abandoned'
    );
    expect(actionKind({ feeder_live: '5f0c1c2e-1111-4a4a-8b8b-0123456789ab' })).toBe('feeder_live');
    expect(actionKind({ break_started: 'c0ffee00-2222-4b4b-9c9c-0123456789ab' })).toBe(
      'break_started'
    );
    expect(actionKind({ closed: 'c0ffee00-2222-4b4b-9c9c-0123456789ab' })).toBe('closed');
    expect(actionKind({ main1: 'opened' })).toBe('main1_opened');
    expect(actionKind({ main1: 'reopened' })).toBe('main1_reopened');
    expect(actionKind({ second_chair_cashed_out: 'c0ffee00-2222-4b4b-9c9c-0123456789ab' })).toBe(
      'second_chair_cashed_out'
    );
    expect(actionKind({ lifecycle_followed_status: 'closed' })).toBe(
      'lifecycle_followed_status_closed'
    );
    expect(actionKind({ feeder_became_main1: 'c0ffee00-2222-4b4b-9c9c-0123456789ab' })).toBe(
      'feeder_became_main1'
    );
    expect(actionKind({ state: 'live' })).toBe('state_live');
    expect(actionKind({ state: 'dormant' })).toBe('state_dormant');
  });

  it('never puts an id, a number or an unknown shape into the label', () => {
    expect(actionKind({ closed: 'A1B2C3' })).toBe('closed'); // uppercase: not a word
    expect(actionKind({ moves_planned: 40 })).toBe('moves_planned');
    expect(actionKind('closed')).toBeNull();
    expect(actionKind(null)).toBeNull();
    expect(actionKind([])).toBeNull();
    expect(actionKind({})).toBeNull();
    expect(actionKind({ 'weird key': 1 })).toBeNull();
  });
});

describe('a pass', () => {
  it('emits every metric with HELP and TYPE in Prometheus text', () => {
    const { registry, m } = build();
    m.recordPass(
      summary({ actions: [{ game_id: 'g', actions: [{ moves_planned: 1 }] }] }),
      rows(['live'])
    );
    m.recordStalled();
    m.recordSkippedFrozen();
    const text = registry.renderPrometheus();
    const expectType = (name: string, type: string) => {
      expect(text, `${name} HELP`).toContain(`# HELP ${name} `);
      expect(text, `${name} TYPE`).toContain(`# TYPE ${name} ${type}`);
    };
    expectType('poker_cluster_pass_duration_seconds', 'histogram');
    expectType('poker_cluster_pass_games', 'gauge');
    expectType('poker_cluster_pass_ticked', 'gauge');
    expectType('poker_cluster_pass_woken', 'gauge');
    expectType('poker_cluster_pass_rested', 'gauge');
    expectType('poker_cluster_pass_errors_total', 'counter');
    expectType('poker_cluster_pass_stalled_total', 'counter');
    expectType('poker_cluster_pass_skipped_frozen_total', 'counter');
    expectType('poker_cluster_passes_total', 'counter');
    expectType('poker_cluster_rpcs_total', 'counter');
    expectType('poker_cluster_last_pass_timestamp_seconds', 'gauge');
    expectType('poker_cluster_actions_total', 'counter');
    expectType('poker_cluster_games', 'gauge');
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      expect(Number.isFinite(Number(line.split(' ').pop())), `"${line}" carries a number`).toBe(
        true
      );
    }
  });

  it('observes the duration in SECONDS and stamps the pass time', () => {
    const { m } = build(1_757_000_000_000);
    m.recordPass(summary({ elapsedMs: 1200 }));
    const h = m.passDuration.snapshot()[0];
    expect(h.count).toBe(1);
    expect(h.sum).toBeCloseTo(1.2, 6);
    expect(h.buckets.find((b) => b.le === 1)!.count).toBe(0);
    expect(h.buckets.find((b) => b.le === 2)!.count).toBe(1);
    expect(m.lastPassTimestamp.get()).toBe(1_757_000_000);
    expect(m.passesTotal.get()).toBe(1);
    expect(m.passGames.get()).toBe(3);
    expect(m.passTicked.get()).toBe(3);
    expect(m.passWoken.get()).toBe(1);
  });

  it('the buckets are strictly ascending and in seconds, up to the stall ceiling', () => {
    for (let i = 1; i < CLUSTER_PASS_DURATION_BUCKETS_S.length; i++) {
      expect(CLUSTER_PASS_DURATION_BUCKETS_S[i]).toBeGreaterThan(
        CLUSTER_PASS_DURATION_BUCKETS_S[i - 1]
      );
    }
    expect(CLUSTER_PASS_DURATION_BUCKETS_S.at(-1)).toBe(120);
  });

  it('counts actions per kind across games and passes', () => {
    const { m } = build();
    m.recordPass(
      summary({
        actions: [
          { game_id: 'a', actions: [{ moves_planned: 2 }, { feeder: 'opened', buyers: 2 }] },
          { game_id: 'b', actions: [{ closed: 'a-1' }, { closed: 'a-2' }, { state: 'dormant' }] },
        ],
      })
    );
    m.recordPass(summary({ actions: [{ game_id: 'a', actions: [{ moves_expired: 1 }] }] }));
    expect(m.actionsTotal.get({ kind: 'moves_planned' })).toBe(1);
    expect(m.actionsTotal.get({ kind: 'feeder_opened' })).toBe(1);
    expect(m.actionsTotal.get({ kind: 'closed' })).toBe(2);
    expect(m.actionsTotal.get({ kind: 'state_dormant' })).toBe(1);
    expect(m.actionsTotal.get({ kind: 'moves_expired' })).toBe(1);
    expect(m.passesTotal.get()).toBe(2);
  });

  it('the kind label is bounded: past MAX_KINDS everything folds into other', () => {
    const { m } = build();
    const actions = Array.from({ length: MAX_KINDS + 10 }, (_, i) => ({ [`kind_${i}`]: 1 }));
    m.recordPass(summary({ actions: [{ game_id: 'a', actions }] }));
    expect(m.actionsTotal.snapshot().length).toBe(MAX_KINDS + 1);
    expect(m.actionsTotal.get({ kind: 'other' })).toBe(10);
    // A kind seen before the cap keeps counting under its own name.
    m.recordPass(summary({ actions: [{ game_id: 'a', actions: [{ kind_0: 1 }] }] }));
    expect(m.actionsTotal.get({ kind: 'kind_0' })).toBe(2);
  });

  it('errors accumulate; a clean pass adds nothing', () => {
    const { m } = build();
    m.recordPass(summary({ errors: 2 }));
    m.recordPass(summary({ errors: 0 }));
    m.recordPass(summary({ errors: 1 }));
    expect(m.passErrorsTotal.get()).toBe(3);
  });

  it('games by state come from the worklist rows, both states always present', () => {
    const { m } = build();
    m.recordPass(summary(), rows(['live', 'live', 'dormant']));
    expect(m.games.get({ state: 'live' })).toBe(2);
    expect(m.games.get({ state: 'dormant' })).toBe(1);
    m.recordPass(summary(), rows(['live']));
    expect(m.games.get({ state: 'live' })).toBe(1);
    expect(m.games.get({ state: 'dormant' })).toBe(0);
  });

  it('a summary without rows leaves the state gauge untouched', () => {
    const { m } = build();
    m.recordPass(summary(), rows(['live']));
    m.recordPass(summary());
    expect(m.games.get({ state: 'live' })).toBe(1);
  });
});

describe('the summary shape the sibling branch adds', () => {
  it('rested and rpcs are read when present and default to zero', () => {
    const { m } = build();
    m.recordPass(summary());
    expect(m.passRested.get()).toBe(0);
    expect(m.rpcsTotal.get()).toBe(0);
    m.recordPass({ ...summary(), rested: 4, rpcs: 12 } as ClusterTickSummary);
    expect(m.passRested.get()).toBe(4);
    expect(m.rpcsTotal.get()).toBe(12);
    m.recordPass({ ...summary(), rpcs: 3 } as ClusterTickSummary);
    expect(m.rpcsTotal.get()).toBe(15);
  });
});

describe('the stall and the freeze', () => {
  it('count, and appear on /health', () => {
    const { m } = build();
    expect(m.healthSnapshot()).toEqual({
      lastPassAt: null,
      elapsedMs: 0,
      games: 0,
      ticked: 0,
      woken: 0,
      errors: 0,
      rested: 0,
      rpcs: 0,
      stalled: 0,
      skippedFrozen: 0,
    });
    m.recordStalled();
    m.recordSkippedFrozen();
    m.recordSkippedFrozen();
    expect(m.passStalledTotal.get()).toBe(1);
    expect(m.passSkippedFrozenTotal.get()).toBe(2);
    // A skipped tick is NOT a pass: the timestamp does not move, which is
    // what lets the stall rule see a frozen controller (and the break guard
    // silence it).
    expect(m.passesTotal.get()).toBe(0);
    expect(m.healthSnapshot().lastPassAt).toBeNull();
    expect(m.healthSnapshot().stalled).toBe(1);
    expect(m.healthSnapshot().skippedFrozen).toBe(2);
  });

  it('/health carries the last pass with an ISO timestamp', () => {
    const { m } = build(1_757_000_000_000);
    m.recordPass({
      ...summary({ elapsedMs: 900, games: 5, ticked: 4, errors: 1 }),
      rested: 2,
      rpcs: 6,
    } as ClusterTickSummary);
    expect(m.healthSnapshot()).toEqual({
      lastPassAt: new Date(1_757_000_000_000).toISOString(),
      elapsedMs: 900,
      games: 5,
      ticked: 4,
      woken: 1,
      errors: 1,
      rested: 2,
      rpcs: 6,
      stalled: 0,
      skippedFrozen: 0,
    });
  });
});
