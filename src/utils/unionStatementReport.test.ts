import { describe, it, expect } from 'vitest';
import { mapUnionStatementReport } from './unionStatementReport';

const now = Date.parse('2026-09-07T12:00:00Z');
const row = (patch: Record<string, unknown> = {}) => ({
  club_id: 'club-a', club_name: 'Club A', invoice_id: 'invoice-a', status: 'generated', snapshot_complete: true,
  amount: 100, paid_total: 0, rake_generated: 1000, union_fee_kept: 100, rakeback_due: 900,
  due_at: '2026-09-08T00:00:00Z', ...patch,
});
const board = (clubs = [row()]) => ({ union_id: 'union-a', period_start: '2026-08-31', period_end: '2026-09-07', clubs });

describe('recorded union statement report', () => {
  it('uses historical snapshot amounts and never equates direction with payment', () => {
    const report = mapUnionStatementReport('union-a', board([row({ amount: -100, union_fee_kept: 250, rakeback_due: 750 })]), now);
    expect(report.totalRakeCollected).toBe(1000);
    expect(report.netUnionRevenue).toBe(250);
    expect(report.clubBreakdowns[0]).toMatchObject({ status: 'pending', wireDirection: 'COLLECT_FROM_UNION', outstanding: 100 });
    expect(report.totalAgentCommissions).toBeNull();
  });
  it('retains the last unpaid cent and derives overdue from the actual due date', () => {
    const report = mapUnionStatementReport('union-a', board([row({ status: 'paid', paid_total: 99.99, due_at: '2026-09-01T00:00:00Z' })]), now);
    expect(report.clubBreakdowns[0]).toMatchObject({ status: 'overdue', outstanding: 0.01 });
    expect(mapUnionStatementReport('union-a', board([row({ status: 'overdue', due_at: null })]), now).clubBreakdowns[0].status).toBe('pending');
    expect(mapUnionStatementReport('union-a', board([row({ status: 'paid', paid_total: 100 })]), now).clubBreakdowns[0].status).toBe('paid');
  });
  it('keeps missing statements unavailable and excludes cancellation from active totals', () => {
    const missing = row({ club_id: 'missing', invoice_id: null, status: 'missing' });
    const cancelled = row({ club_id: 'cancelled', status: 'cancelled' });
    const report = mapUnionStatementReport('union-a', board([row(), missing, cancelled]), now);
    expect(report).toMatchObject({ coverage: 'partial', issuedClubs: 1, totalRakeCollected: 1000 });
    expect(report.clubBreakdowns[1].rakeCollected).toBeNull();
    expect(report.clubBreakdowns[2].outstanding).toBe(0);
    expect(mapUnionStatementReport('union-a', board([missing]), now).netUnionRevenue).toBeNull();
  });
  it('aggregates more than 2000 records without truncation or floating-cent drift', () => {
    const rows = Array.from({ length: 2501 }, (_, i) => row({ club_id: String(i), rake_generated: '0.30', union_fee_kept: '0.10', rakeback_due: '0.20' }));
    expect(mapUnionStatementReport('union-a', board(rows), now)).toMatchObject({ totalClubs: 2501, totalRakeCollected: 750.3, netUnionRevenue: 250.1 });
  });
  it('rejects missing or malformed accounting data instead of returning zero', () => {
    for (const value of [null, '', 'NaN', Infinity, '0.001', '90071992547409.92']) {
      expect(() => mapUnionStatementReport('union-a', board([row({ rake_generated: value })]), now)).toThrow();
    }
    expect(() => mapUnionStatementReport('other-union', board(), now)).toThrow();
    expect(() => mapUnionStatementReport('union-a', board([row(), row()]), now)).toThrow();
    expect(() => mapUnionStatementReport('union-a', { ...board(), period_start: null }, now)).toThrow();
    expect(() => mapUnionStatementReport('union-a', null, now)).toThrow();
    expect(() => mapUnionStatementReport('union-a', board([row({ snapshot_complete: false })]), now)).toThrow();
  });
});
