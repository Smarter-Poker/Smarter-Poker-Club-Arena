/**
 * AUDIT M3 / Q4 — server-side durable financial alerting.
 *
 * The point of this module is that it is the LAST line of defence: when a money
 * write has already failed, this is what tells a human. So the invariants under
 * test are mostly about what happens when IT fails too.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
vi.mock('./supabase.js', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

const mockReportError = vi.fn();
vi.mock('./errorReporter.js', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

import { raiseFinancialAlert } from './financialAlerts.js';

const ALERT_ID = '9f1d6f4a-6c1e-4d0e-9d5a-2f5b1c0a77e3';

describe('raiseFinancialAlert', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockReportError.mockReset();
    mockRpc.mockResolvedValue({ data: ALERT_ID, error: null });
  });

  it('calls the SERVER rpc (not the client one, which requires auth.uid())', async () => {
    const result = await raiseFinancialAlert('critical', 'Src.thing', 'boom', { hand: 7 });

    expect(result).toEqual({ persisted: true, alertId: ALERT_ID });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fnName, args] = mockRpc.mock.calls[0] as [string, Record<string, unknown>];
    // fn_raise_financial_alert would throw 28000 under service_role — using it
    // here would silently disable every server alert.
    expect(fnName).toBe('fn_raise_server_financial_alert');
    expect(args).toEqual({
      p_severity: 'critical',
      p_source: 'Src.thing',
      p_message: 'boom',
      p_context: { hand: 7 },
    });
  });

  it('defaults the context to an empty object rather than sending undefined', async () => {
    await raiseFinancialAlert('info', 'Src.thing', 'note');
    const [, args] = mockRpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_context).toEqual({});
  });

  it('AUDIT M3: an errored CRITICAL escalates to reportError', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });

    const result = await raiseFinancialAlert('critical', 'Src.money', 'ledger lost', { a: 1 });

    expect(result).toEqual({ persisted: false, alertId: null });
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError.mock.calls[0][1]).toContain('financialAlerts.rpc_failed');
  });

  it('AUDIT M3: a THROTTLED CRITICAL (null id, no error) also escalates', async () => {
    // The RPC returns NULL when the 60/min/source flood guard trips. A throttled
    // CRITICAL is still an unrecorded CRITICAL.
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await raiseFinancialAlert('critical', 'Src.money', 'ledger lost');

    expect(result).toEqual({ persisted: false, alertId: null });
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError.mock.calls[0][1]).toContain('financialAlerts.throttled');
  });

  it('AUDIT M3: a thrown RPC on a CRITICAL escalates rather than being swallowed', async () => {
    mockRpc.mockRejectedValue(new Error('socket hang up'));

    const result = await raiseFinancialAlert('critical', 'Src.money', 'ledger lost');

    expect(result).toEqual({ persisted: false, alertId: null });
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError.mock.calls[0][1]).toContain('financialAlerts.threw');
  });

  it('does NOT escalate a failed WARNING - that would move noise, not reduce it', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'nope' } });

    const result = await raiseFinancialAlert('warning', 'Src.minor', 'meh');

    expect(result.persisted).toBe(false);
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it('never throws, even when the transport rejects on a non-critical alert', async () => {
    mockRpc.mockRejectedValue(new Error('down'));
    await expect(raiseFinancialAlert('info', 'Src.minor', 'meh')).resolves.toEqual({
      persisted: false,
      alertId: null,
    });
  });

  it('treats an empty-string id as not persisted', async () => {
    mockRpc.mockResolvedValue({ data: '', error: null });
    const result = await raiseFinancialAlert('warning', 'Src.minor', 'meh');
    expect(result).toEqual({ persisted: false, alertId: null });
  });
});
