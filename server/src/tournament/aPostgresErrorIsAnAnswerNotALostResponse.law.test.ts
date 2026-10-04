/**
 * A POSTGRES ERROR IS AN ANSWER, NOT A LOST RESPONSE (2026-10-04).
 *
 * Production 2026-10-03, satellite ab4a05ce ("Saturday Night Big Stack
 * Satellite"), eight qualifiers. Read from the Postgres and API logs:
 *
 *   20:13:03.2Z  fn_settle_satellite_qualifiers waits for the exclusive
 *                ca:tournament-finish-lane:v1 behind every other finish on
 *                the platform, and is cancelled at 20:13:11.3 with 55P03
 *                (lock_timeout, the authenticator role's 8 s). Rolled back.
 *   20:13:11.4Z  The engine read that error as a lost response and asked
 *                fn_resolve_satellite_qualifier_outcome, which waits for the
 *                same exclusive lane and is cancelled with the same 55P03 at
 *                20:13:19.6.
 *   20:13:19.7Z  The engine reported the outcome as UNKNOWN, stopped the
 *                event's manager, and raised a critical financial alert.
 *   20:13:48.3Z  The next pass settled it whole (receipt v3, 6 x 50.00 cash,
 *                2 x 50.00 target seats, 32.00 remainder, 432.00 pool).
 *
 * Nothing about that outcome was ever unknown. A SQLSTATE in the body means
 * PostgREST rolled the call back; only a lost response leaves it open. And
 * when the response is lost, the resolver is a read: contention on its lane
 * is asked again, not reported as unknown.
 *
 * See docs/changelog/2026-10-04-a-postgres-error-is-an-answer-not-a-lost-response.md.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), verify: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('./satelliteQualifierReceipt.js', () => ({
  verifySatelliteQualifierReceipt: mocks.verify,
}));

import { requestSatelliteQualifierReceipt } from './satelliteQualifierRpc.js';
import {
  SatelliteSettlementOutcomeUnknownError,
  SatelliteSettlementRefusedError,
} from './satelliteSettlementRpc.js';
import { isLaneContention, isRolledBackStatementError } from './settlementRefusal.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EVENT = id(1);
const QUALIFIERS = [id(11), id(12), id(13)];
const RECEIPT = { tournamentId: EVENT, qualifierIds: QUALIFIERS } as any;
const LOCK_TIMEOUT = {
  code: '55P03',
  message: 'canceling statement due to lock timeout',
  details: null,
  hint: null,
};
const LOST = { code: '', message: 'Error: supabase_timeout', details: '', hint: '' };
const waits: number[] = [];
const wait = async (ms: number) => {
  waits.push(ms);
};

function outcome(committed: boolean) {
  return {
    data: {
      ok: true,
      tournament_id: EVENT,
      qualifier_ids: QUALIFIERS,
      satellite_committed: committed,
      definitively_not_committed: !committed,
      status: committed ? 'COMPLETED' : 'RUNNING',
      receipt: committed ? { stored: true } : null,
    },
    error: null,
  };
}

const calls = () => mocks.rpc.mock.calls.map(([name]) => name);

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.verify.mockReset();
  mocks.verify.mockReturnValue(RECEIPT);
  waits.length = 0;
});

describe('a Postgres error is an answer, not a lost response', () => {
  it('only a SQLSTATE that cannot describe a dead connection proves a rollback', () => {
    for (const code of ['55P03', '40001', '40P01', '55000', 'P0404', 'P0001', '23505', '42501'])
      expect(isRolledBackStatementError({ code, message: 'x' }), code).toBe(true);
    for (const code of ['', '08006', '08003', '57014', '57P01', '58030', '53300', 'XX000'])
      expect(isRolledBackStatementError({ code, message: 'x' }), code).toBe(false);
    // PostgREST's own codes, a gateway body and a thrown fetch never qualify.
    expect(isRolledBackStatementError({ code: 'PGRST002', message: 'x' })).toBe(false);
    expect(isRolledBackStatementError({ message: '<html>502</html>' })).toBe(false);
    expect(isRolledBackStatementError(new Error('55P03'))).toBe(false);
    expect(isRolledBackStatementError('55P03')).toBe(false);
    expect(isLaneContention(LOCK_TIMEOUT)).toBe(true);
    expect(isLaneContention({ code: '55000' })).toBe(false);
  });

  it('a settlement cancelled by lock_timeout is a refusal the next pass retries, never unknown', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: LOCK_TIMEOUT });
    const result = requestSatelliteQualifierReceipt(EVENT, QUALIFIERS, { wait });
    await expect(result).rejects.toBeInstanceOf(SatelliteSettlementRefusedError);
    await expect(result).rejects.toThrow(/lock timeout \(55P03\)/);
    // The answer was in the body: the contended lane is not asked twice.
    expect(calls()).toEqual(['fn_settle_satellite_qualifiers']);
  });

  it('a table-break refusal still reaches the stage that finishes the break', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '55000', message: 'F06_SOURCE_EXCLUDED', details: null, hint: null },
    });
    const error = await requestSatelliteQualifierReceipt(EVENT, QUALIFIERS, { wait }).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(SatelliteSettlementRefusedError);
    // isTableBreakExclusion (TournamentManagerEliminations) reads the code by name.
    expect(error.message).toMatch(/\bF06_SOURCE_EXCLUDED\b/);
  });

  it('a lost response asks the resolver, and its lane contention is asked again', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: LOST })
      .mockResolvedValueOnce({ data: null, error: LOCK_TIMEOUT })
      .mockResolvedValueOnce({ data: null, error: LOCK_TIMEOUT })
      .mockResolvedValueOnce(outcome(true));
    await expect(requestSatelliteQualifierReceipt(EVENT, QUALIFIERS, { wait })).resolves.toBe(
      RECEIPT
    );
    expect(calls()).toEqual([
      'fn_settle_satellite_qualifiers',
      'fn_resolve_satellite_qualifier_outcome',
      'fn_resolve_satellite_qualifier_outcome',
      'fn_resolve_satellite_qualifier_outcome',
    ]);
    expect(waits).toEqual([500, 1000]);
  });

  it('a lost response proven not committed is a refusal', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: LOST })
      .mockResolvedValueOnce({ data: null, error: LOCK_TIMEOUT })
      .mockResolvedValueOnce(outcome(false));
    await expect(
      requestSatelliteQualifierReceipt(EVENT, QUALIFIERS, { wait })
    ).rejects.toBeInstanceOf(SatelliteSettlementRefusedError);
  });

  it('unknown is reserved for a lost response the resolver could never read', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: LOST });
    mocks.rpc.mockResolvedValue({ data: null, error: LOCK_TIMEOUT });
    const error = await requestSatelliteQualifierReceipt(EVENT, QUALIFIERS, { wait }).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(SatelliteSettlementOutcomeUnknownError);
    expect(error.message).toMatch(/resolver attempt 3\/3/);
    // Bounded: three reads, never a loop.
    expect(calls().filter((n) => n === 'fn_resolve_satellite_qualifier_outcome')).toHaveLength(3);
  });

  it('a resolver refusal that is not contention is not asked again', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: LOST }).mockResolvedValueOnce({
      data: null,
      error: { code: 'P0404', message: 'satellite qualifier outcome lacks a proven running source' },
    });
    await expect(
      requestSatelliteQualifierReceipt(EVENT, QUALIFIERS, { wait })
    ).rejects.toBeInstanceOf(SatelliteSettlementOutcomeUnknownError);
    expect(calls()).toHaveLength(2);
  });
});
