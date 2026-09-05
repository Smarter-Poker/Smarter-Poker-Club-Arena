/**
 * A CONDITION IS ONE ALERT, HOWEVER LONG IT STAYS TRUE
 * ═══════════════════════════════════════════════════════════════════════════
 * BBJ build plan phase 1, 2026-09-05.
 *
 * auditBBJDrift runs hourly and raised a NEW financial_alerts warning every
 * hour for the same 3.5 chips of unlinkable rake rows - 24 identical rows a
 * day, each also a Sentry event. That is the exact pattern that buried the
 * nine real alerts of 2026-08-22 under 988 duplicates. These pins say: raise
 * once, refresh the open row while the condition holds, resolve it with a
 * note the first cycle it clears, and never throw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const from = vi.fn();
const raiseFinancialAlert = vi.fn().mockResolvedValue({ persisted: true, alertId: 'a1' });
const reportError = vi.fn();
vi.mock('./supabase.js', () => ({
  supabase: { from: (...a: unknown[]) => from(...a), rpc: vi.fn() },
  logBBJCollection: vi.fn(),
}));
vi.mock('./supabase/bbj.js', () => ({
  processBBJPayout: vi.fn(),
  setBBJPayoutQueueWriter: vi.fn(),
}));
vi.mock('./errorReporter.js', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock('./financialAlerts.js', () => ({
  raiseFinancialAlert: (...a: unknown[]) => raiseFinancialAlert(...a),
}));

import { raiseOrRefreshCondition } from './FeeReconciler.js';

let openRow: { id: string; message: string } | null;
let updates: Array<{ id: string; patch: Record<string, unknown> }>;

beforeEach(() => {
  vi.clearAllMocks();
  openRow = null;
  updates = [];
  from.mockImplementation((name: string) => {
    expect(name).toBe('financial_alerts');
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
    chain.maybeSingle = () => Promise.resolve({ data: openRow, error: null });
    chain.update = (patch: Record<string, unknown>) => ({
      eq: (_col: string, id: string) => {
        updates.push({ id, patch });
        return Promise.resolve({ error: null });
      },
    });
    return chain;
  });
});

describe('raiseOrRefreshCondition', () => {
  it('raises once when the condition is true and nothing is open', async () => {
    const r = await raiseOrRefreshCondition('FeeReconciler.bbj_unlinkable', true, 'msg 1', {
      chips: 3.5,
    });
    expect(r).toBe('raised');
    expect(raiseFinancialAlert).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('refreshes the open row instead of raising again while the condition holds', async () => {
    openRow = { id: 'open-1', message: 'msg 1' };
    const r = await raiseOrRefreshCondition('FeeReconciler.bbj_unlinkable', true, 'msg 2', {
      chips: 4,
    });
    expect(r).toBe('refreshed');
    expect(raiseFinancialAlert).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('open-1');
    expect(updates[0].patch.message).toBe('msg 2');
  });

  it('does not even write when the figures are unchanged', async () => {
    openRow = { id: 'open-1', message: 'same' };
    const r = await raiseOrRefreshCondition('FeeReconciler.bbj_drift', true, 'same', {});
    expect(r).toBe('refreshed');
    expect(updates).toHaveLength(0);
  });

  it('resolves the open row, with a note, the first cycle the condition clears', async () => {
    openRow = { id: 'open-1', message: 'msg 1' };
    const r = await raiseOrRefreshCondition('FeeReconciler.bbj_unlinkable', false, 'unused', {
      chips: 0,
    });
    expect(r).toBe('resolved');
    expect(updates[0].patch.resolved).toBe(true);
    expect(String(updates[0].patch.resolution)).toContain('no longer true');
    expect(raiseFinancialAlert).not.toHaveBeenCalled();
  });

  it('is quiet when the condition is false and nothing is open', async () => {
    expect(await raiseOrRefreshCondition('FeeReconciler.bbj_drift', false, 'x', {})).toBe('quiet');
    expect(updates).toHaveLength(0);
  });

  it('never throws - a failed read is reported as quiet', async () => {
    from.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await raiseOrRefreshCondition('FeeReconciler.bbj_drift', true, 'x', {})).toBe('quiet');
  });
});
