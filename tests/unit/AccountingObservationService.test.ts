import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OBSERVER_ID as ID,
  observationInput,
  observationRow,
  missingObservation,
} from '../helpers/accountingObservation';
const m = vi.hoisted(() => ({
  id: null as string | null,
  handlers: new Set<(event: any) => void>(),
  rpc: vi.fn(),
}));
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: () => ({ loaded: !!m.id, authenticated: !!m.id, userId: m.id }),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: (name: string, fn: (event: any) => void) => {
      if (name === 'AUTH_STATE_CHANGED') m.handlers.add(fn);
      return () => m.handlers.delete(fn);
    },
  },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: m.rpc, from: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import {
  accountingWeekEndingOn,
  accountingRunExpectedAt,
  accountingInstant,
  parseAccountingRunObservation,
  readAccountingRunObservation,
} from '../../src/services/AccountingObservationService';
function auth(id: string | null) {
  m.id = id;
  for (const fn of m.handlers) fn({ payload: { isAuthenticated: !!id, userId: id } });
}
beforeEach(() => {
  m.rpc.mockReset();
  auth(null);
  auth(ID.actor);
});
describe('strict scoped accounting observation', () => {
  it.each([
    [
      '2026-03-09',
      '2026-03-02T08:00:00.000Z',
      '2026-03-09T07:00:00.000Z',
      167,
      '2026-03-09T09:00:00.000Z',
    ],
    [
      '2026-11-02',
      '2026-10-26T07:00:00.000Z',
      '2026-11-02T08:00:00.000Z',
      169,
      '2026-11-02T10:00:00.000Z',
    ],
  ])('uses the calendar week ending %s across DST', (day, start, end, hours, expected) => {
    const week = accountingWeekEndingOn(day as string);
    expect(week).toEqual({ periodStart: start, periodEnd: end });
    expect((Date.parse(week.periodEnd) - Date.parse(week.periodStart)) / 3600000).toBe(hours);
    expect(accountingRunExpectedAt(week)).toBe(expected);
  });
  it('retains microseconds rather than rounding a mismatched week or attempt', () => {
    expect(
      accountingInstant('2026-09-14T07:00:00.000001+00:00') -
        accountingInstant(observationInput.periodEnd)
    ).toBe(1n);
    expect(() =>
      parseAccountingRunObservation(
        observationRow({ period_end: '2026-09-14T07:00:00.000001Z' }),
        observationInput
      )
    ).toThrow();
    expect(() =>
      parseAccountingRunObservation(
        observationRow({ finished_at: '2026-09-14T09:00:00.000000Z' }),
        observationInput
      )
    ).toThrow();
  });
  it.each([
    { contract_version: '1' },
    { actor_user_id: ID.otherActor },
    { scope_id: ID.otherUnion },
    { scope_kind: 'club' },
    { state: 'posted', posted: false },
    { record_found: false },
    { attempts: '1' },
    { attempts: null },
    { attempts: 0 },
    { state: 'running', finished_at: '2026-09-14T09:00:01Z', posted: false },
    { state: 'unavailable' },
    { state: 'complete' },
    { state: ['posted'], posted: false },
    { accounting_version: 3 },
    { result: { success: true, accounting_version: 3 } },
    { recorded_scheduled_at: '2026-09-14T10:00:00Z' },
    { observed_at: '2026-02-30T10:00:00Z' },
    { started_at: '2026-09-14T08:59:59Z' },
    { finished_at: '2026-09-14T11:00:00Z' },
  ])('refuses malformed, extra, legacy or contradictory evidence %j', (fault) => {
    expect(() => parseAccountingRunObservation(observationRow(fault), observationInput)).toThrow();
  });
  it('keeps missing club applicability distinct from a missing union run', () => {
    expect(parseAccountingRunObservation(missingObservation(), observationInput).state).toBe(
      'no_recorded_run'
    );
    const input = { ...observationInput, scopeKind: 'club' as const, scopeId: ID.club };
    expect(parseAccountingRunObservation(missingObservation('club', ID.club), input).state).toBe(
      'unavailable'
    );
    expect(() =>
      parseAccountingRunObservation(
        { ...missingObservation('club', ID.club), state: 'no_recorded_run' },
        input
      )
    ).toThrow();
  });
  it('dispatches only the new exact actor/scope/week RPC, with no old fallback', async () => {
    m.rpc.mockResolvedValue({ data: observationRow(), error: null });
    expect(
      (await readAccountingRunObservation({ ...observationInput, scopeId: ID.union.toUpperCase() }))
        .posted
    ).toBe(true);
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith('fn_accounting_run_observation_v1', {
      p_expected_actor_id: ID.actor,
      p_scope_kind: 'union',
      p_scope_id: ID.union,
      p_period_start: observationInput.periodStart,
      p_period_end: observationInput.periodEnd,
    });
  });
  it('refuses failed transport without consulting an old getter or returning zero success', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
    await expect(readAccountingRunObservation(observationInput)).rejects.toThrow();
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects A to B to A during the read without an intermediate view render', async () => {
    let resolve!: (x: unknown) => void;
    m.rpc.mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      })
    );
    const pending = readAccountingRunObservation(observationInput);
    auth(ID.otherActor);
    auth(ID.actor);
    resolve({ data: observationRow(), error: null });
    await expect(pending).rejects.toThrow();
  });
  it('refuses an unloaded actor or invalid scope/week before any query', async () => {
    auth(null);
    await expect(readAccountingRunObservation(observationInput)).rejects.toThrow();
    auth(ID.actor);
    await expect(
      readAccountingRunObservation({ ...observationInput, scopeId: '' })
    ).rejects.toThrow();
    await expect(
      readAccountingRunObservation({ ...observationInput, periodStart: '2026-09-07T00:00:00Z' })
    ).rejects.toThrow();
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
