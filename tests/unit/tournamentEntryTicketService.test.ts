import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { mockEmit, mockRpc, mockUuid, formatProjection, mockTournamentUpdate } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockRpc: vi.fn(),
  mockUuid: vi.fn(),
  formatProjection: {} as Record<string, unknown>,
  mockTournamentUpdate: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => {
  const tournament = {
    id: 'tournament-1',
    name: 'Sunday Major',
    club_id: 'club-1',
    status: 'REGISTERING',
    current_players: 1,
    max_players: 100,
    variant: 'mtt',
    format_contract: 'mtt-v1',
  };
  const player = {
    id: 'registration-1',
    tournament_id: 'tournament-1',
    user_id: 'user-1',
    username: 'Player',
    status: 'registered',
    table_id: 'table-1',
  };

  const chain = (row: unknown): any => {
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      update: vi.fn((patch) => {
        mockTournamentUpdate(patch);
        return query;
      }),
      maybeSingle: vi.fn(async () => ({ data: row, error: null })),
      then: (resolve: (value: unknown) => unknown) =>
        resolve({ data: Array.isArray(row) ? row : row ? [row] : [], error: null }),
    };
    return query;
  };

  return {
    getAuthUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    supabase: {
      rpc: mockRpc,
      from: vi.fn((table: string) =>
        chain(
          table === 'tournaments'
            ? { ...tournament, ...formatProjection }
            : table === 'tournament_players'
              ? player
              : null
        )
      ),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: mockEmit, subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('club-1'),
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

vi.mock('../../src/utils/uuid', () => ({ uuid: mockUuid }));

import {
  registerReasonText,
  tournamentService,
  tournamentUnregisterSuccessText,
} from '../../src/services/TournamentService';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('navigator', {
    locks: { request: (_key: string, fn: () => Promise<unknown>) => fn() },
  });
});
afterEach(() => vi.unstubAllGlobals());
describe('tournament-entry ticket client service', () => {
  beforeEach(() => {
    mockEmit.mockReset();
    mockTournamentUpdate.mockReset();
    for (const key of Object.keys(formatProjection)) delete formatProjection[key];
    mockRpc.mockReset();
    mockUuid.mockReset();
    mockUuid.mockReturnValue('00000000-0000-4000-8000-000000000001');
  });

  it('returns the exact ticket selected by the server', async () => {
    mockRpc.mockResolvedValue({
      data: { ok: true, ticket_id: 'ticket-1', ticket_value: 110 },
      error: null,
    });

    await expect(tournamentService.findTournamentEntryTicket('tournament-1')).resolves.toEqual({
      id: 'ticket-1',
      value: 110,
    });
    expect(mockRpc).toHaveBeenCalledWith('fn_find_tournament_entry_ticket', {
      p_tournament_id: 'tournament-1',
    });
  });

  it('treats a selector failure or malformed answer as a refusal, never no-ticket', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
    await expect(tournamentService.findTournamentEntryTicket('tournament-1')).rejects.toThrow(
      'No Chips Were Charged'
    );

    mockRpc.mockResolvedValueOnce({ data: { ok: true }, error: null });
    await expect(tournamentService.findTournamentEntryTicket('tournament-1')).rejects.toThrow(
      'No Chips Were Charged'
    );
  });

  it('uses the exact ticket-admission RPC and emits no wallet balance event', async () => {
    mockRpc.mockResolvedValue({
      data: {
        ok: true,
        registration_id: 'registration-1',
        ticket_id: 'ticket-1',
        wallet_chips_credited: 0,
      },
      error: null,
    });

    await tournamentService.registerPlayer('tournament-1', 'user-1', 'Player', 'ticket-1');

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('fn_register_for_tournament_with_ticket', {
      p_tournament_id: 'tournament-1',
      p_ticket_id: 'ticket-1',
    });
    expect(mockEmit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
    expect(mockEmit).toHaveBeenCalledWith('TOURNAMENT_REGISTERED', {
      tournamentId: 'tournament-1',
      userId: 'user-1',
      clubId: 'club-1',
    });
  });

  it('replays only the same idempotent ticket after an ambiguous transport result', async () => {
    mockRpc
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({
        data: {
          ok: true,
          replayed: true,
          registration_id: 'registration-1',
          ticket_id: 'ticket-1',
          wallet_chips_credited: 0,
        },
        error: null,
      });

    await tournamentService.registerPlayer('tournament-1', 'user-1', 'Player', 'ticket-1');

    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'fn_register_for_tournament_with_ticket', {
      p_tournament_id: 'tournament-1',
      p_ticket_id: 'ticket-1',
    });
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'fn_register_for_tournament_with_ticket', {
      p_tournament_id: 'tournament-1',
      p_ticket_id: 'ticket-1',
    });
    expect(mockEmit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
  });

  it('does not treat an unrelated roster row as proof after two ticket transport errors', async () => {
    mockRpc.mockRejectedValue(new Error('connection closed after commit'));

    await expect(
      tournamentService.registerPlayer('tournament-1', 'user-1', 'Player', 'ticket-1')
    ).rejects.toThrow('Could Not Confirm Tournament Ticket Registration');

    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockEmit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
  });

  it('rejects a ticket admission receipt for any other ticket id', async () => {
    mockRpc.mockResolvedValue({
      data: {
        ok: true,
        registration_id: 'registration-1',
        ticket_id: 'ticket-other',
        wallet_chips_credited: 0,
      },
      error: null,
    });

    await expect(
      tournamentService.registerPlayer('tournament-1', 'user-1', 'Player', 'ticket-1')
    ).rejects.toThrow('Could Not Confirm Tournament Ticket Registration');
    expect(mockEmit).not.toHaveBeenCalledWith('TOURNAMENT_REGISTERED', expect.anything());
  });

  it('keeps ordinary registration on the wallet RPC', async () => {
    mockRpc.mockResolvedValue({
      data: {
        ok: true,
        registration_id: 'registration-1',
        request_id: '00000000-0000-4000-8000-000000000001',
        tournament_id: 'tournament-1',
        user_id: 'user-1',
      },
      error: null,
    });

    await tournamentService.registerPlayer('tournament-1', 'user-1', 'Player');

    expect(mockRpc).toHaveBeenCalledWith('fn_register_for_tournament_request', {
      p_tournament_id: 'tournament-1',
      p_request_id: '00000000-0000-4000-8000-000000000001',
    });
    expect(mockEmit).toHaveBeenCalledWith('BALANCE_UPDATED', {
      source: 'tournament_buyin',
      userId: 'user-1',
    });
  });

  it.each([
    [undefined, false],
    [null, false],
    ['unknown-v9', false],
    ['mtt-v1', false],
    ['mtt-v2', false],
    ['sng-v1', true],
    ['spin-v1', true],
    ['seat-first-satellite-v1', true],
  ] as const)(
    'preserves a committed registration and nudges only the recorded fixed format %s',
    async (format_contract, shouldNudge) => {
      const capacity = format_contract === 'spin-v1' ? 3 : 2;
      Object.assign(formatProjection, {
        current_players: capacity,
        max_players: capacity,
        variant: format_contract === 'spin-v1' ? 'spin' : 'sng',
        format_contract,
        ...(format_contract === 'seat-first-satellite-v1'
          ? { tournament_type: 'SATELLITE', satellite_target_id: 'target-1' }
          : {}),
      });
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          registration_id: 'registration-1',
          request_id: '00000000-0000-4000-8000-000000000001',
          tournament_id: 'tournament-1',
          user_id: 'user-1',
        },
        error: null,
      });
      await expect(
        tournamentService.registerPlayer('tournament-1', 'user-1', 'Player')
      ).resolves.toMatchObject({ id: 'registration-1' });
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockTournamentUpdate).toHaveBeenCalledTimes(shouldNudge ? 1 : 0);
      if (shouldNudge) {
        expect(mockTournamentUpdate).toHaveBeenCalledWith({ start_time: expect.any(String) });
      }
      expect(
        mockEmit.mock.calls.filter(([event]) => event === 'TOURNAMENT_REGISTERED')
      ).toHaveLength(1);
      expect(mockEmit.mock.calls.filter(([event]) => event === 'BALANCE_UPDATED')).toHaveLength(1);
    }
  );

  it('retains an initial wallet registration request after exhausted transport attempts', async () => {
    mockRpc.mockRejectedValue(new Error('commit response lost'));
    await expect(
      tournamentService.registerPlayer('tournament-1', 'user-1', 'Player')
    ).rejects.toThrow('Could Not Confirm Tournament Registration');
    expect(mockRpc).toHaveBeenCalledTimes(2);
    const original = mockRpc.mock.calls[0][1].p_request_id;
    mockUuid.mockReturnValue('00000000-0000-4000-8000-000000000002');
    mockRpc.mockResolvedValue({
      data: {
        ok: true,
        request_id: original,
        tournament_id: 'tournament-1',
        user_id: 'user-1',
        registration_id: 'registration-1',
        cost: 110,
      },
      error: null,
    });
    await tournamentService.registerPlayer('tournament-1', 'user-1', 'Player');
    expect(mockRpc).toHaveBeenCalledTimes(3);
    expect(mockRpc.mock.calls[2]).toEqual(mockRpc.mock.calls[0]);
    expect(mockUuid).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls.filter(([name]) => name === 'BALANCE_UPDATED')).toHaveLength(1);
  });

  it('does not use a current roster row as proof of an unknown wallet registration', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'response lost' } });
    await expect(
      tournamentService.registerPlayer('tournament-1', 'user-1', 'Player')
    ).rejects.toThrow('Could Not Confirm Tournament Registration');
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
    expect(mockEmit).not.toHaveBeenCalledWith('TOURNAMENT_REGISTERED', expect.anything());
  });

  it.each([
    { request_id: '00000000-0000-4000-8000-000000000099' },
    { tournament_id: 'other-tournament' },
    { user_id: 'other-user' },
    { ok: 'true' },
  ])('refuses an unbound registration receipt %j', async (changed) => {
    mockRpc.mockResolvedValue({
      data: {
        ok: true,
        request_id: '00000000-0000-4000-8000-000000000001',
        tournament_id: 'tournament-1',
        user_id: 'user-1',
        registration_id: 'registration-1',
        ...changed,
      },
      error: null,
    });
    await expect(
      tournamentService.registerPlayer('tournament-1', 'user-1', 'Player')
    ).rejects.toThrow('Could Not Confirm Tournament Registration');
    expect(mockEmit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
  });

  it('refuses registration under a stale client account before any purchase', async () => {
    await expect(
      tournamentService.registerPlayer('tournament-1', 'other-user', 'Player')
    ).rejects.toThrow('Correct Account');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('renders ticket refusal codes as human messages', () => {
    expect(registerReasonText('ticket_not_owned')).toBe(
      'That Tournament Ticket does not belong to you.'
    );
    expect(registerReasonText('ticket_entry_contract_mismatch')).toBe(
      'That Tournament Ticket does not match this tournament entry fee.'
    );
  });

  it('uses only the authoritative refund rails and validates the exact request receipt', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        request_id: '00000000-0000-4000-8000-000000000001',
        registration_id: 'registration-1',
        refunded_chips: 110,
        returned_ticket_value: 55,
        wallet_chips_from_satellite_entitlements: 0,
      },
      error: null,
    });
    await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).resolves.toEqual({
      refundedChips: 110,
      returnedTicketValue: 55,
    });
    expect(mockEmit).toHaveBeenCalledWith('BALANCE_UPDATED', {
      source: 'tournament_unregister_refund',
      userId: 'user-1',
    });
    expect(mockRpc).toHaveBeenCalledWith('fn_unregister_from_tournament', {
      p_tournament_id: 'tournament-1',
      p_request_id: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('reports a returned entry ticket without inventing a wallet balance change', async () => {
    mockRpc.mockResolvedValue({
      data: {
        ok: true,
        request_id: '00000000-0000-4000-8000-000000000001',
        registration_id: 'registration-1',
        refunded_chips: 0,
        returned_ticket_value: 110,
        wallet_chips_from_satellite_entitlements: 0,
      },
      error: null,
    });

    await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).resolves.toEqual({
      refundedChips: 0,
      returnedTicketValue: 110,
    });
    expect(mockEmit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
    expect(tournamentUnregisterSuccessText({ refundedChips: 0, returnedTicketValue: 110 })).toBe(
      'A Tournament Ticket For A 110 Chip Entry Was Issued. No Chips Were Added To Your Wallet.'
    );
  });

  it('reuses one request id after a lost response and accepts only its replay receipt', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: null, error: { message: 'connection closed after commit' } })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          replayed: true,
          request_id: '00000000-0000-4000-8000-000000000001',
          registration_id: 'registration-1',
          refunded_chips: 0,
          returned_ticket_value: 110,
          wallet_chips_from_satellite_entitlements: 0,
        },
        error: null,
      });

    await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).resolves.toEqual({
      refundedChips: 0,
      returnedTicketValue: 110,
    });
    expect(mockUuid).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
  });

  it('reuses the exact request when the first Supabase transport promise rejects', async () => {
    mockRpc
      .mockRejectedValueOnce(new Error('fetch rejected after an unknown commit outcome'))
      .mockResolvedValueOnce({
        data: {
          ok: true,
          replayed: true,
          request_id: '00000000-0000-4000-8000-000000000001',
          registration_id: 'registration-1',
          refunded_chips: 0,
          returned_ticket_value: 110,
          wallet_chips_from_satellite_entitlements: 0,
        },
        error: null,
      });

    await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).resolves.toEqual({
      refundedChips: 0,
      returnedTicketValue: 110,
    });
    expect(mockUuid).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
    expect(mockEmit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
  });

  it('fails closed after two unknown outcomes and emits no balance event', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'connection closed' } });

    await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).rejects.toThrow(
      'Could Not Confirm Tournament Unregistration'
    );
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
    expect(mockEmit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
  });

  it('fails closed after two rejected transports without invoking any legacy fallback', async () => {
    mockRpc.mockRejectedValue(new Error('fetch rejected with an unknown commit outcome'));

    await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).rejects.toThrow(
      'Could Not Confirm Tournament Unregistration'
    );
    expect(mockUuid).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_unregister_from_tournament',
      'fn_unregister_from_tournament',
    ]);
    expect(mockEmit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
  });

  it.each(['event', 'seat'] as const)(
    'retires an obsolete %s refund request without treating the later registration as refunded',
    async (scope) => {
      const oldId = '00000000-0000-4000-8000-000000000001';
      const newId = '00000000-0000-4000-8000-000000000002';
      const storageKey =
        'ca:tournament-unregister:v1:user-1:' +
        (scope === 'event' ? 'tournament-1' : 'seat:table-1');
      const requestRefund = () =>
        scope === 'event'
          ? tournamentService.unregisterPlayer('tournament-1', 'user-1')
          : tournamentService.leaveTournamentSeatAndRefund('table-1', 'user-1');
      const pending = JSON.stringify({ requestId: oldId, state: 'pending' });
      localStorage.setItem(storageKey, pending);
      sessionStorage.setItem(storageKey, pending);
      mockUuid.mockReturnValue(newId);
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          code: 'P0404',
          message: 'unregistration request id belongs to a prior registration lifecycle',
        },
      });
      await expect(requestRefund()).rejects.toThrow('Earlier Registration');
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockEmit).not.toHaveBeenCalled();
      expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual({
        requestId: oldId,
        state: 'resolved',
      });
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: true,
          request_id: newId,
          registration_id: 'registration-2',
          refunded_chips: 200,
          returned_ticket_value: 0,
          wallet_chips_from_satellite_entitlements: 0,
        },
        error: null,
      });
      await expect(requestRefund()).resolves.toEqual({
        refundedChips: 200,
        returnedTicketValue: 0,
      });
      expect(mockRpc.mock.calls[1][1].p_request_id).toBe(newId);
    }
  );

  it.each([
    { code: 'P0404', message: 'registration financial journals disagree' },
    {
      code: 'NETWORK',
      message: 'unregistration request id belongs to a prior registration lifecycle',
    },
    { message: 'connection lost after commit' },
  ])(
    'retains the original request when the server has not proved its lifecycle obsolete: %o',
    async (error) => {
      mockRpc.mockResolvedValue({ data: null, error });
      await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).rejects.toThrow(
        'Could Not Confirm Tournament Unregistration'
      );
      const original = mockRpc.mock.calls[0][1].p_request_id;
      await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).rejects.toThrow(
        'Could Not Confirm Tournament Unregistration'
      );
      expect(mockRpc.mock.calls.every(([, params]) => params.p_request_id === original)).toBe(true);
      expect(mockUuid).toHaveBeenCalledTimes(1);
      expect(mockEmit).not.toHaveBeenCalled();
    }
  );

  it('accepts the exact satellite cash receipt after a lost response', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost after commit' } })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          request_id: '00000000-0000-4000-8000-000000000001',
          registration_id: 'registration-1',
          refunded_chips: 200,
          returned_ticket_value: 0,
          wallet_chips_from_satellite_entitlements: 200,
        },
        error: null,
      });
    await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).resolves.toEqual({
      refundedChips: 200,
      returnedTicketValue: 0,
    });
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
    expect(mockUuid).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls.filter(([name]) => name === 'BALANCE_UPDATED')).toHaveLength(1);
  });

  it.each([undefined, -1, Number.NaN])(
    'refuses invalid satellite-cash provenance %s',
    async (amount) => {
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          request_id: '00000000-0000-4000-8000-000000000001',
          registration_id: 'registration-1',
          refunded_chips: 200,
          returned_ticket_value: 0,
          wallet_chips_from_satellite_entitlements: amount,
        },
        error: null,
      });
      await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).rejects.toThrow(
        'Could Not Confirm Tournament Unregistration'
      );
      expect(mockEmit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
    }
  );

  it('rejects legacy, mismatched, or overstated satellite-cash receipts', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { ok: true, refunded: 110 },
      error: null,
    });
    await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).rejects.toThrow(
      'Could Not Confirm Tournament Unregistration'
    );

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        request_id: '00000000-0000-4000-8000-000000000099',
        registration_id: 'registration-1',
        refunded_chips: 110,
        returned_ticket_value: 0,
        wallet_chips_from_satellite_entitlements: 0,
      },
      error: null,
    });
    await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).rejects.toThrow(
      'Could Not Confirm Tournament Unregistration'
    );

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        request_id: '00000000-0000-4000-8000-000000000001',
        registration_id: 'registration-1',
        refunded_chips: 110,
        returned_ticket_value: 0,
        wallet_chips_from_satellite_entitlements: 111,
      },
      error: null,
    });
    await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).rejects.toThrow(
      'Could Not Confirm Tournament Unregistration'
    );
    expect(mockEmit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
  });

  it('applies the same replay-safe contract to a pre-start table seat release', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          request_id: '00000000-0000-4000-8000-000000000001',
          registration_id: 'registration-1',
          refunded_chips: 0,
          returned_ticket_value: 110,
          wallet_chips_from_satellite_entitlements: 0,
        },
        error: null,
      });

    await expect(
      tournamentService.leaveTournamentSeatAndRefund('table-1', 'user-1')
    ).resolves.toEqual({ refundedChips: 0, returnedTicketValue: 110 });
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'fn_leave_seat_and_refund', {
      p_table_id: 'table-1',
      p_request_id: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('fails a table seat release closed after two unknown outcomes', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'response lost' } });

    await expect(
      tournamentService.leaveTournamentSeatAndRefund('table-1', 'user-1')
    ).rejects.toThrow('Could Not Confirm Tournament Unregistration');
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
    expect(mockEmit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
  });

  it('retains a seat refund identity after exhausted transport retries and a later retry', async () => {
    mockRpc.mockRejectedValue(new Error('response lost after commit'));
    await expect(
      tournamentService.leaveTournamentSeatAndRefund('table-1', 'user-1')
    ).rejects.toThrow('Could Not Confirm Tournament Unregistration');
    const original = mockRpc.mock.calls[0][1].p_request_id;
    mockUuid.mockReturnValue('00000000-0000-4000-8000-000000000002');
    mockRpc.mockResolvedValue({
      data: {
        ok: true,
        request_id: original,
        registration_id: 'registration-1',
        refunded_chips: 110,
        returned_ticket_value: 0,
        wallet_chips_from_satellite_entitlements: 0,
      },
      error: null,
    });
    await expect(
      tournamentService.leaveTournamentSeatAndRefund('table-1', 'user-1')
    ).resolves.toEqual({ refundedChips: 110, returnedTicketValue: 0 });
    expect(mockRpc).toHaveBeenCalledTimes(3);
    expect(mockRpc.mock.calls[2]).toEqual(mockRpc.mock.calls[0]);
    expect(mockUuid).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls.filter(([name]) => name === 'BALANCE_UPDATED')).toHaveLength(1);
  });

  it('refuses a seat refund for a stale signed-in account before submitting', async () => {
    await expect(
      tournamentService.leaveTournamentSeatAndRefund('table-1', 'other-user')
    ).rejects.toThrow('Correct Account');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('explains the real start boundary without a one-minute rule', async () => {
    mockRpc.mockResolvedValue({
      data: { ok: false, reason: 'tournament_started' },
      error: null,
    });
    await expect(tournamentService.unregisterPlayer('tournament-1', 'user-1')).rejects.toThrow(
      'You can only unregister before it starts'
    );
  });
});
