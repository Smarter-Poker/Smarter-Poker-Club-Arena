/**
 * A GATEWAY BLIP ON THE DEPARTURE READ IS ASKED AGAIN (2026-10-15).
 *
 * postHandTasks.leave_pending_failed, 2026-10-14 14:27 and 2026-10-15 05:48
 * UTC: the enumeration read of processLeavePending returned a Cloudflare 502
 * page as an error with no SQLSTATE, the step's retry budget classified it
 * `non_transient`, and the boundary deferred every pending departure. The
 * read is a plain GET (PostgREST runs it read-only), so it is asked again
 * inside the boundary; an error the database itself raised stays final.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: mock }));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('./tables.js', () => ({ tableCountChangedFilter: () => 'current_players.neq.1' }));
import { isGatewayReadFailure, processLeavePending } from './seats.js';
import { LeavePendingOperation } from '../../observability/LeavePendingDiagnostic.js';

const occupancyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const receipt = {
  occupancy_id: occupancyId,
  user_id: 'player',
  table_id: 'table',
  ok: true,
  stack: 12.5,
  credited: true,
  seat_number: 2,
  idempotency_key: 'cashout:occupancy:' + occupancyId,
  tournament_table: false,
};
const seatRow = { user_id: 'player', seat_number: 2, occupancy_id: occupancyId };
const gatewayPage = {
  message: '<!DOCTYPE html><title>supabase.co | 502: Bad gateway</title>',
  code: null,
};

function arrange(...reads: Array<{ data: unknown; error: unknown }>) {
  mock.rpc.mockImplementation(async (name: string) =>
    name === 'fn_cashout_seat_occupancy'
      ? { data: receipt, error: null }
      : { data: { ok: false, reason: 'nobody_waiting' }, error: null }
  );
  const is = vi.fn();
  for (const read of reads) is.mockResolvedValueOnce(read);
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    or: vi.fn().mockResolvedValue({ error: null }),
    is,
  };
  mock.from.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe('a gateway blip on the departure read is asked again', () => {
  it('a 502 page then the rows: the departure completes in the same boundary', async () => {
    const chain = arrange(
      { data: null, error: gatewayPage },
      { data: [seatRow], error: null }
    );
    const diagnostic = new LeavePendingOperation();
    await expect(
      processLeavePending('table', 'club', undefined, undefined, diagnostic)
    ).resolves.toEqual([{ userId: 'player', occupancyId }]);
    expect(chain.is).toHaveBeenCalledTimes(2);
    expect(diagnostic.snapshot()).toMatchObject({ phase: 'departure_processing', error: null });
    expect(mock.rpc).toHaveBeenCalledWith('fn_cashout_seat_occupancy', expect.anything());
  });

  it('a pre-execution PostgREST 503 code is asked again too', async () => {
    const chain = arrange(
      { data: null, error: { message: 'schema cache', code: 'PGRST002' } },
      { data: [], error: null }
    );
    await expect(processLeavePending('table', 'club')).resolves.toEqual([]);
    expect(chain.is).toHaveBeenCalledTimes(2);
  });

  it('a gateway that stays down is reported after the bounded retries, nothing written', async () => {
    const chain = arrange(
      { data: null, error: gatewayPage },
      { data: null, error: gatewayPage },
      { data: null, error: gatewayPage }
    );
    const diagnostic = new LeavePendingOperation();
    await expect(
      processLeavePending('table', 'club', undefined, undefined, diagnostic)
    ).rejects.toThrow('502: Bad gateway');
    expect(chain.is).toHaveBeenCalledTimes(3);
    expect(diagnostic.snapshot()).toMatchObject({
      phase: 'table_seats_query',
      failure_kind: 'returned_error',
    });
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('an error the database raised is final on the first answer', async () => {
    const chain = arrange({ data: null, error: { message: 'read refused', code: '42501' } });
    await expect(processLeavePending('table', 'club')).rejects.toThrow('read refused');
    expect(chain.is).toHaveBeenCalledTimes(1);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('classifies only answers the database did not give', () => {
    expect(isGatewayReadFailure(gatewayPage)).toBe(true);
    expect(isGatewayReadFailure({ code: undefined })).toBe(true);
    expect(isGatewayReadFailure({ code: '' })).toBe(true);
    for (const code of ['PGRST001', 'PGRST002', 'PGRST003']) {
      expect(isGatewayReadFailure({ code })).toBe(true);
    }
    for (const code of ['42501', '57014', '55P03', 'PGRST116', 'PGRST301', 'P0001']) {
      expect(isGatewayReadFailure({ code })).toBe(false);
    }
    expect(isGatewayReadFailure(null)).toBe(false);
  });
});
