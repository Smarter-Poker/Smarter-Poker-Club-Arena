/**
 * Every assertion here is a way this gauge could have repeated the 2026-09-04
 * incident: a real failure rate that reads as healthy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./supabase.js', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

import { SettlementMetrics } from './SettlementMetrics.js';
import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const ok = (row: unknown) => ({ data: [row], error: null });

const healthy = {
  window_minutes: 5,
  settled: 2400,
  failed: 0,
  stuck: 3,
  failure_rate: 0,
  top_failure: null,
};

/** The real shape of the incident, at its worst hour. */
const incident = {
  window_minutes: 5,
  settled: 1400,
  failed: 1100,
  stuck: 5,
  failure_rate: 0.44,
  top_failure: 'seat write failed for <uuid> - hand write rejected whole',
};

describe('SettlementMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('puts the failure rate on a gauge at the value the incident actually had', async () => {
    rpc.mockResolvedValue(ok(incident));
    const m = new SettlementMetrics();
    await m.refresh();
    const text = m.toPrometheus().join('\n');

    expect(text).toContain('poker_settlement_failure_rate 0.44');
    expect(text).toContain('poker_settlement_failed 1100');
    expect(text).toContain('poker_settlement_settled 1400');
    expect(text).toContain('poker_settlement_window_hands 2500');
  });

  it('asks for a five-minute window, never a lifetime total', async () => {
    // The lifetime ratio read 0.077 while the live rate was 0.44. A gauge
    // computed over all history would have shown this incident as a minor
    // background defect for its entire thirteen hours.
    rpc.mockResolvedValue(ok(healthy));
    const m = new SettlementMetrics();
    await m.refresh();

    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe('fn_settlement_health');
    expect(args.p_window_minutes).toBe(5);
  });

  it('reports a healthy window as a real zero, not as an absent series', async () => {
    // 0% with hands flowing is a genuine measurement and must be visible.
    rpc.mockResolvedValue(ok(healthy));
    const m = new SettlementMetrics();
    await m.refresh();
    const text = m.toPrometheus().join('\n');

    expect(text).toContain('poker_settlement_failure_rate 0');
    expect(text).toContain('poker_settlement_window_hands 2400');
  });

  it('OMITS the failure rate when nothing settled at all', async () => {
    // No hands is not no failures. Emitting 0 here would report a platform
    // that has stopped settling entirely as flawless.
    rpc.mockResolvedValue(
      ok({
        window_minutes: 5,
        settled: 0,
        failed: 0,
        stuck: 0,
        failure_rate: null,
        top_failure: null,
      })
    );
    const m = new SettlementMetrics();
    await m.refresh();
    const text = m.toPrometheus().join('\n');

    expect(text).not.toContain('poker_settlement_failure_rate');
    expect(text).toContain('poker_settlement_window_hands 0');
  });

  it('is already firing before the first successful collection', () => {
    const m = new SettlementMetrics();
    const text = m.toPrometheus().join('\n');
    expect(text).toContain('poker_settlement_metrics_stale_seconds 86400');
  });

  it('keeps the last good snapshot when a refresh fails, and never zeroes it', async () => {
    rpc.mockResolvedValue(ok(incident));
    const m = new SettlementMetrics();
    await m.refresh();

    rpc.mockResolvedValue({ data: null, error: { message: 'statement timeout' } });
    await m.refresh();

    // Zeroing here would turn a live incident into a green board the moment
    // the collector itself started struggling.
    expect(m.toPrometheus().join('\n')).toContain('poker_settlement_failure_rate 0.44');
  });

  it('survives a thrown RPC and reports once per outage', async () => {
    rpc.mockRejectedValue(new Error('socket hang up'));
    const m = new SettlementMetrics();
    await expect(m.refresh()).resolves.toBeUndefined();
    await m.refresh();
    expect(reportError).not.toHaveBeenCalled();
    await m.refresh();
    expect(reportError).toHaveBeenCalledTimes(1);
    await m.refresh();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('carries the failure text with ids masked, for the incident note', async () => {
    rpc.mockResolvedValue(ok(incident));
    const m = new SettlementMetrics();
    await m.refresh();
    expect(m.describeTopFailure()).toBe('seat write failed for <uuid> - hand write rejected whole');
    // and never as a metric label - unbounded label values kill a Prometheus.
    expect(m.toPrometheus().join('\n')).not.toContain('seat write failed');
  });
});
