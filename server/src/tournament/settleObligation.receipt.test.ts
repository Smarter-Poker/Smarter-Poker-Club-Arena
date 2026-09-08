import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase.js', () => ({ supabase: {} }));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn(async () => {}) }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { settleTournamentObligation } from './settleObligation.js';

const input = {
  tournamentId: 'event',
  kind: 'place' as const,
  place: 1,
  userId: 'player',
  amount: 100,
  source: 'engine.test',
};
const full = {
  ok: true,
  paid: 100,
  already_paid: 0,
  amount_owed: 100,
  amount_paid: 100,
  remaining: 0,
  fully_settled: true,
};
async function settle(data: unknown) {
  const rpc = vi.fn(async () => ({ data, error: null }));
  const result = await settleTournamentObligation({ rpc }, input, {
    maxAttempts: 3,
    retryDelayMs: () => 0,
  });
  expect(rpc).toHaveBeenCalledTimes(1);
  return result;
}
describe('tournament payment receipt boundary', () => {
  it('keeps missing and malformed replies unconfirmed without asserting nonpayment', async () => {
    for (const data of [
      null,
      undefined,
      '',
      'not json',
      'null',
      '[]',
      [],
      {},
      true,
      100,
      { ok: 'true' },
      { ok: null },
      { paid: 100 },
    ]) {
      const before = vi.mocked(raiseFinancialAlert).mock.calls.length;
      expect(await settle(data)).toMatchObject({
        ok: false,
        fully_settled: false,
        refused_reason: 'invalid_response',
      });
      expect(vi.mocked(raiseFinancialAlert).mock.calls.length).toBe(before);
    }
  });
  it('rejects invalid moved amounts without claiming nonpayment or retrying a possible committed credit', async () => {
    for (const paid of [
      Infinity,
      -1,
      NaN,
      null,
      undefined,
      true,
      {},
      [],
      '',
      ' ',
      '0x64',
      '1e2',
      '100.001',
    ]) {
      const before = vi.mocked(raiseFinancialAlert).mock.calls.length;
      const result = await settle({ ...full, paid });
      expect(result).toMatchObject({
        ok: false,
        fully_settled: false,
        refused_reason: 'invalid_response',
      });
      expect(Number.isFinite(result.paid)).toBe(true);
      expect(vi.mocked(raiseFinancialAlert).mock.calls.length).toBe(before);
    }
  });
  it('rejects contradictory totals and does not certify an overpaid obligation', async () => {
    for (const patch of [
      { already_paid: Infinity },
      { already_paid: undefined },
      { already_paid: null },
      { amount_paid: 101, paid: 101 },
      { remaining: 1 },
      { amount_owed: null },
      { remaining: null },
    ]) {
      expect(await settle({ ...full, ...patch })).toMatchObject({
        ok: false,
        fully_settled: false,
        refused_reason: 'invalid_response',
      });
    }
  });
  it('preserves exact valid partial, final, replay and numeric decimal receipts', async () => {
    expect(await settle(full)).toMatchObject({ ok: true, fully_settled: true, paid: 100 });
    expect(await settle({ ...full, paid: 0, already_paid: 100 })).toMatchObject({
      ok: true,
      fully_settled: true,
      paid: 0,
    });
    expect(
      await settle({
        ...full,
        paid: 99.99,
        amount_paid: 99.99,
        remaining: 0.01,
        fully_settled: false,
      })
    ).toMatchObject({ ok: true, fully_settled: false, paid: 99.99, remaining: 0.01 });
    expect(
      await settle({
        ...full,
        paid: '100.00',
        already_paid: '0',
        amount_paid: '100.00',
        amount_owed: '100',
        remaining: '0',
      })
    ).toMatchObject({ ok: true, fully_settled: true, paid: 100 });
    expect(await settle({ ok: true, paid: 100, already_paid: 0 })).toMatchObject({
      ok: true,
      fully_settled: false,
    });
  });
  it('retains a real database refusal and its financial alert', async () => {
    const before = vi.mocked(raiseFinancialAlert).mock.calls.length;
    expect(
      await settle({ ok: false, paid: 0, already_paid: 0, refused_reason: 'escrow_short' })
    ).toMatchObject({ ok: false, refused_reason: 'escrow_short' });
    expect(vi.mocked(raiseFinancialAlert).mock.calls.length).toBe(before + 1);
  });
});
