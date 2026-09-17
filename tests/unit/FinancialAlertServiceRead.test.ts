import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  responses: [] as unknown[],
  queries: [] as Array<Array<unknown[]>>,
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const calls: unknown[][] = [['from', table]];
      fixture.queries.push(calls);
      const response = fixture.responses.shift();
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'neq', 'order', 'limit']) {
        query[method] = (...args: unknown[]) => {
          calls.push([method, ...args]);
          return query;
        };
      }
      query.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(response).then(resolve, reject);
      return query;
    },
  },
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
// Use the real retryAsync: a fulfilled provider error must not be treated as a
// throw, retried into a different observation, or replaced with empty evidence.
import { FinancialAlertService } from '../../src/services/FinancialAlertService';

const alert = (n: number, severity = 'critical') => ({
  id: `51000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  severity,
  source: 'fixture',
  message: 'Retain this original alert',
  context: { original: n },
  resolved: false,
  created_at: '2026-09-15T05:00:00.000001Z',
});
beforeEach(() => {
  fixture.responses = [];
  fixture.queries = [];
});

describe('financial alert read failures remain unavailable', () => {
  it('refuses a fulfilled critical-query denial before querying or returning lower-severity rows', async () => {
    const error = { code: '42501', message: 'permission denied' };
    fixture.responses = [{ data: null, error }];
    await expect(FinancialAlertService.getUnresolved()).rejects.toBe(error);
    expect(fixture.queries).toHaveLength(1);
  });

  it('refuses the whole observation when the lower-severity query fails after valid criticals', async () => {
    const error = { code: '57014', message: 'statement timeout' };
    fixture.responses = [
      { data: [alert(1)], error: null },
      { data: null, error },
    ];
    await expect(FinancialAlertService.getUnresolved(10)).rejects.toBe(error);
    expect(fixture.queries).toHaveLength(2);
  });

  it.each([null, {}, 'unavailable'])(
    'does not turn a malformed critical response %j into an empty queue',
    async (data) => {
      fixture.responses = [{ data, error: null }];
      await expect(FinancialAlertService.getUnresolved()).rejects.toThrow('could not be verified');
      expect(fixture.queries).toHaveLength(1);
    }
  );

  it('preserves the critical-first budget and original rows when both reads succeed', async () => {
    const first = alert(1);
    const second = alert(2, 'warning');
    fixture.responses = [
      { data: [first], error: null },
      { data: [second], error: null },
    ];
    const rows = await FinancialAlertService.getUnresolved(2);
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(rows[0].context).toEqual(first.context);
    expect(rows[0].createdAt).toBe(first.created_at);
    expect(fixture.queries[0]).toContainEqual(['limit', 500]);
    expect(fixture.queries[1]).toContainEqual(['limit', 1]);
  });

  it('retains all returned critical rows when they exceed the requested page budget', async () => {
    fixture.responses = [{ data: [alert(1), alert(2)], error: null }];
    expect(await FinancialAlertService.getUnresolved(1)).toHaveLength(2);
    expect(fixture.queries).toHaveLength(1);
  });

  it.each([
    null,
    {},
    { ...alert(1), id: 'not-an-id' },
    { ...alert(1), severity: 'warning' },
    { ...alert(1), resolved: true },
    { ...alert(1), message: null },
    { ...alert(1), created_at: '2026-02-30T00:00:00Z' },
    { ...alert(1), context: [] },
  ])('refuses malformed or wrong-branch critical row %j', async (row) => {
    fixture.responses = [{ data: [row], error: null }];
    await expect(FinancialAlertService.getUnresolved(1)).rejects.toThrow(
      'record could not be verified'
    );
  });

  it('refuses a critical returned by the lower-severity query', async () => {
    fixture.responses = [
      { data: [], error: null },
      { data: [alert(1)], error: null },
    ];
    await expect(FinancialAlertService.getUnresolved()).rejects.toThrow(
      'record could not be verified'
    );
  });

  it('refuses duplicate identities when an alert changes severity between the two reads', async () => {
    fixture.responses = [
      { data: [alert(1)], error: null },
      { data: [alert(1, 'warning')], error: null },
    ];
    await expect(FinancialAlertService.getUnresolved(2)).rejects.toThrow(
      'changed during this read'
    );
  });

  it('retains nullable context as an empty display object without changing original identity or time', async () => {
    fixture.responses = [{ data: [{ ...alert(1), context: null }], error: null }];
    expect((await FinancialAlertService.getUnresolved(1))[0]).toEqual({
      id: alert(1).id,
      severity: 'critical',
      source: 'fixture',
      message: alert(1).message,
      context: {},
      resolved: false,
      createdAt: alert(1).created_at,
    });
  });

  it('permits a genuine empty visible result without certifying global absence', async () => {
    fixture.responses = [
      { data: [], error: null },
      { data: [], error: null },
    ];
    expect(await FinancialAlertService.getUnresolved()).toEqual([]);
  });

  it.each([null, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '0'])(
    'refuses unavailable or invalid count %j',
    async (count) => {
      fixture.responses = [
        { count, error: null },
        ...[0, 0, 0].map((v) => ({ count: v, error: null })),
      ];
      await expect(FinancialAlertService.getUnresolvedCounts()).rejects.toThrow(
        'count could not be verified'
      );
    }
  );

  it('propagates one failed count rather than returning a zero for that severity', async () => {
    const error = { code: '42501', message: 'permission denied' };
    fixture.responses = [
      { count: 7, error: null },
      { count: null, error },
      { count: 4, error: null },
      { count: 3, error: null },
    ];
    await expect(FinancialAlertService.getUnresolvedCounts()).rejects.toBe(error);
    expect(fixture.queries).toHaveLength(4);
  });

  it('preserves valid independently observed zero and nonzero counts', async () => {
    fixture.responses = [8, 0, 5, 3].map((count) => ({ count, error: null }));
    expect(await FinancialAlertService.getUnresolvedCounts()).toEqual({
      total: 8,
      critical: 0,
      warning: 5,
      info: 3,
    });
  });

  it.each([0, -1, 1.5, 1001, Number.NaN])(
    'refuses invalid page limit %j without a provider query',
    async (limit) => {
      await expect(FinancialAlertService.getUnresolved(limit)).rejects.toThrow('limit is invalid');
      expect(fixture.queries).toHaveLength(0);
    }
  );
});
