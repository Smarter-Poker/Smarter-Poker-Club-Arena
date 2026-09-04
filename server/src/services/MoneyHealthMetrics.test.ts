/**
 * Every assertion here is a way this could have repeated one of the two
 * 2026-09-04 incidents: a real backlog reading as empty, or an unreviewed
 * trigger reading as an all-clear.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./supabase.js', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

import { MoneyHealthMetrics, STALE_ALERT_HOURS } from './MoneyHealthMetrics.js';
import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

/** The backlog exactly as it stood when this was written. */
const backlog = {
  unresolved_total: 1345,
  unresolved_critical: 619,
  stale_critical: 600,
  distinct_conditions: 656,
  oldest_unresolved_age: 361.4,
  meta_alerts: 154,
};

/** Route each RPC to its own answer, the way the collector calls them. */
function route(opts: {
  alerts?: unknown;
  alertsError?: { message: string };
  triggers?: unknown[];
  triggersError?: { message: string };
}) {
  rpc.mockImplementation((fn: string) => {
    if (fn === 'fn_financial_alert_health') {
      return Promise.resolve(
        opts.alertsError
          ? { data: null, error: opts.alertsError }
          : { data: [opts.alerts ?? backlog], error: null }
      );
    }
    if (fn === 'fn_undeclared_money_triggers') {
      return Promise.resolve(
        opts.triggersError
          ? { data: null, error: opts.triggersError }
          : { data: opts.triggers ?? [], error: null }
      );
    }
    throw new Error(`unexpected rpc ${fn}`);
  });
}

describe('MoneyHealthMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('puts the whole backlog on gauges, at the numbers it actually had', async () => {
    route({});
    const m = new MoneyHealthMetrics();
    await m.refresh();
    const text = m.toPrometheus().join('\n');

    expect(text).toContain('poker_financial_alerts_unresolved 1345');
    expect(text).toContain('poker_financial_alerts_unresolved_critical 619');
    expect(text).toContain('poker_financial_alerts_stale_critical 600');
    expect(text).toContain('poker_financial_alerts_distinct_conditions 656');
    expect(text).toContain('poker_financial_alerts_meta 154');
    expect(text).toContain('poker_financial_alerts_oldest_hours 361.4');
  });

  it('asks for the 24-hour stale window', async () => {
    route({});
    const m = new MoneyHealthMetrics();
    await m.refresh();
    const call = rpc.mock.calls.find((c) => c[0] === 'fn_financial_alert_health');
    expect(call?.[1]).toEqual({ p_stale_hours: STALE_ALERT_HOURS });
    expect(STALE_ALERT_HOURS).toBe(24);
  });

  it('reports zero undeclared triggers as a real zero — that is the all-clear', async () => {
    route({ triggers: [] });
    const m = new MoneyHealthMetrics();
    await m.refresh();
    expect(m.toPrometheus().join('\n')).toContain('poker_money_undeclared_triggers 0');
  });

  it('counts an undeclared trigger, which is what would have caught the incident', async () => {
    route({
      triggers: [
        {
          table_name: 'table_seats',
          trigger_name: 'aaa_skip_noop_update',
          function_name: 'fn_skip_noop_update',
          trigger_def:
            'CREATE TRIGGER aaa_skip_noop_update BEFORE UPDATE ON public.table_seats ...',
        },
      ],
    });
    const m = new MoneyHealthMetrics();
    await m.refresh();
    expect(m.toPrometheus().join('\n')).toContain('poker_money_undeclared_triggers 1');
  });

  it('OMITS the trigger gauge when the check itself failed, rather than reporting the all-clear', async () => {
    // This is the important one. Zero undeclared triggers is the all-clear;
    // emitting it because the query errored is exactly the lie that let a
    // rogue trigger run for thirteen hours.
    route({ triggersError: { message: 'statement timeout' } });
    const m = new MoneyHealthMetrics();
    await m.refresh();
    const text = m.toPrometheus().join('\n');

    expect(text).not.toContain('poker_money_undeclared_triggers');
    // ...but the alert half still reported, because it succeeded.
    expect(text).toContain('poker_financial_alerts_unresolved 1345');
  });

  it('OMITS the oldest-alert age when the backlog is empty', async () => {
    // An empty table has no oldest row. 0 would read as an alert raised this
    // second, which is the opposite of an all-clear.
    route({
      alerts: {
        unresolved_total: 0,
        unresolved_critical: 0,
        stale_critical: 0,
        distinct_conditions: 0,
        oldest_unresolved_age: null,
        meta_alerts: 0,
      },
    });
    const m = new MoneyHealthMetrics();
    await m.refresh();
    const text = m.toPrometheus().join('\n');

    expect(text).not.toContain('poker_financial_alerts_oldest_hours');
    expect(text).toContain('poker_financial_alerts_unresolved 0');
  });

  it('is already firing before the first successful collection', () => {
    const m = new MoneyHealthMetrics();
    const text = m.toPrometheus().join('\n');
    expect(text).toContain('poker_money_health_stale_seconds 86400');
    // and claims no all-clear it has not earned
    expect(text).not.toContain('poker_money_undeclared_triggers');
  });

  it('keeps the last good snapshot when a refresh fails, and never zeroes it', async () => {
    route({});
    const m = new MoneyHealthMetrics();
    await m.refresh();

    route({ alertsError: { message: 'statement timeout' } });
    await m.refresh();

    expect(m.toPrometheus().join('\n')).toContain('poker_financial_alerts_unresolved 1345');
  });

  it('survives a thrown RPC and reports once per outage', async () => {
    rpc.mockRejectedValue(new Error('socket hang up'));
    const m = new MoneyHealthMetrics();
    await expect(m.refresh()).resolves.toBeUndefined();
    await m.refresh();
    expect(reportError).not.toHaveBeenCalled();
    await m.refresh();
    expect(reportError).toHaveBeenCalledTimes(1);
    await m.refresh();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('declares HELP and TYPE exactly once per metric family', async () => {
    route({});
    const m = new MoneyHealthMetrics();
    await m.refresh();
    const lines = m.toPrometheus();
    const families = lines.filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]);
    expect(new Set(families).size).toBe(families.length);
  });
});
