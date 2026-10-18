import { describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '../observability/Metrics.js';
import { LightningMetrics } from './LightningMetrics.js';

describe('a player in two Lightning clusters keeps independent latency legs', () => {
  it('matches and deals each room against its own idle and fold request', () => {
    const tap = { idle: vi.fn(), latency: vi.fn() };
    const m = new LightningMetrics(new MetricsRegistry(), tap);
    m.noteIdle('player', 100, 'fast', 'action', 90);
    m.noteIdle('player', 10000, 'normal', 'madness', 9990);
    m.noteMatched(['player'], 200, 'action');
    m.noteDealt(['player'], 250, 'action');
    m.noteMatched(['player'], 10100, 'madness');
    m.noteDealt(['player'], 10200, 'madness');
    expect(tap.latency.mock.calls).toEqual([
      ['action', 'idle_pool_to_match', 100],
      ['action', 'fast_fold_to_next_hand', 160],
      ['madness', 'idle_pool_to_match', 100],
      ['madness', 'normal_fold_to_next_hand', 210],
    ]);
  });
  it('a deal in a room without an idle record cannot consume another rooms record', () => {
    const tap = { idle: vi.fn(), latency: vi.fn() };
    const m = new LightningMetrics(new MetricsRegistry(), tap);
    m.noteIdle('player', 100, 'fold_watch', 'action', 80);
    m.noteDealt(['player'], 150, 'madness');
    m.noteMatched(['player'], 200, 'action');
    m.noteDealt(['player'], 250, 'action');
    expect(tap.latency.mock.calls).toEqual([
      ['action', 'idle_pool_to_match', 100],
      ['action', 'fold_watch_to_next_hand', 170],
    ]);
  });
  it('forgetting a stopped cluster discards its idle legs and preserves the other cluster', () => {
    const tap = { idle: vi.fn(), latency: vi.fn() };
    const m = new LightningMetrics(new MetricsRegistry(), tap);
    m.noteIdle('player', 100, 'fast', 'action');
    m.noteIdle('player', 110, 'normal', 'madness');
    m.forgetCluster('action');
    m.noteMatched(['player'], 200, 'action');
    m.noteDealt(['player'], 220, 'action');
    m.noteMatched(['player'], 300, 'madness');
    expect(tap.latency.mock.calls).toEqual([['madness', 'idle_pool_to_match', 190]]);
  });
});
