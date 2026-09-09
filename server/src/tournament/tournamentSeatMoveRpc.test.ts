import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../services/supabase.js', () => ({ supabase: { rpc } }));

import {
  moveTournamentPlayerAtomically,
  TournamentSeatMoveOutcomeUnknownError,
  TournamentSeatMoveRefusedError,
} from './tournamentSeatMoveRpc.js';

const input = {
  requestId: '00000000-0000-4000-8000-000000000001',
  tournamentId: '00000000-0000-4000-8000-000000000002',
  userId: '00000000-0000-4000-8000-000000000003',
  sourceTableId: '00000000-0000-4000-8000-000000000004',
  destinationTableId: '00000000-0000-4000-8000-000000000005',
  destinationSeatNumber: 4,
  sourceMode: 'live_source' as const,
};

const receipt = {
  ok: true,
  request_id: input.requestId,
  tournament_id: input.tournamentId,
  user_id: input.userId,
  source_table_id: input.sourceTableId,
  destination_table_id: input.destinationTableId,
  source_seat_id: '00000000-0000-4000-8000-000000000006',
  destination_seat_id: '00000000-0000-4000-8000-000000000007',
  source_seat_number: 2,
  destination_seat_number: 4,
  stack: '1075.5',
  moved_at: '2026-09-08T22:12:34.000Z',
  replayed: true,
  source_mode: input.sourceMode,
};

describe('atomic tournament seat move transport', () => {
  beforeEach(() => rpc.mockReset());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('replays the identical operation identity after a lost response', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } })
      .mockResolvedValueOnce({ data: receipt, error: null });

    await expect(moveTournamentPlayerAtomically(input)).resolves.toMatchObject({
      requestId: input.requestId,
      stack: 1075.5,
      replayed: true,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc).toHaveBeenCalledWith('fn_move_tournament_player', {
      p_request_id: input.requestId,
      p_tournament_id: input.tournamentId,
      p_user_id: input.userId,
      p_source_table_id: input.sourceTableId,
      p_destination_table_id: input.destinationTableId,
      p_destination_seat_number: input.destinationSeatNumber,
      p_source_mode: input.sourceMode,
    });
  });

  it('does not accept a malformed or mismatched receipt', async () => {
    rpc.mockResolvedValue({
      data: { ...receipt, destination_seat_number: 8 },
      error: null,
    });
    await expect(moveTournamentPlayerAtomically(input)).rejects.toBeInstanceOf(
      TournamentSeatMoveOutcomeUnknownError
    );
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('classifies a repeated database refusal without any compensation path', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0404', message: 'source chips are not exact' },
    });
    await expect(moveTournamentPlayerAtomically(input)).rejects.toBeInstanceOf(
      TournamentSeatMoveRefusedError
    );
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('keeps an earlier ambiguous commit fenced when the retry is refused before receipt lookup', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost after commit' } })
      .mockResolvedValueOnce({
        data: null,
        error: { code: '28000', message: 'engine identity is no longer admitted' },
      });

    await expect(moveTournamentPlayerAtomically(input)).rejects.toBeInstanceOf(
      TournamentSeatMoveOutcomeUnknownError
    );
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });

  it('never lets a later refusal erase an ambiguity retained from an earlier invocation', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '28000', message: 'engine identity is no longer admitted' },
    });

    await expect(
      moveTournamentPlayerAtomically(input, { outcomeWasAlreadyUnknown: true })
    ).rejects.toBeInstanceOf(TournamentSeatMoveOutcomeUnknownError);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('resolves an exact committed receipt through ordinary service authority after lease loss', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://database.example.test/');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
    const fetchReceipt = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(receipt), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchReceipt);
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost after commit' } })
      .mockResolvedValueOnce({
        data: null,
        error: { code: '42501', message: 'tournament manager lease expired' },
      });

    await expect(moveTournamentPlayerAtomically(input)).resolves.toMatchObject({
      requestId: input.requestId,
      replayed: true,
    });

    expect(fetchReceipt).toHaveBeenCalledTimes(1);
    const [url, init] = fetchReceipt.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://database.example.test/rest/v1/rpc/fn_resolve_committed_tournament_seat_move'
    );
    const headers = new Headers(init.headers);
    expect(headers.get('x-smarter-data-actor')).toBe('service');
    expect(headers.get('x-smarter-data-protocol')).toBe('1');
    expect(headers.has('x-smarter-tournament-id')).toBe(false);
    expect(headers.has('x-smarter-tournament-lease-generation')).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({
      p_request_id: input.requestId,
      p_tournament_id: input.tournamentId,
      p_user_id: input.userId,
      p_source_table_id: input.sourceTableId,
      p_destination_table_id: input.destinationTableId,
      p_destination_seat_number: input.destinationSeatNumber,
      p_source_mode: input.sourceMode,
    });
  });

  it('keeps the exact UUID fenced when the service resolver sees no committed receipt', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://database.example.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
    const fetchReceipt = vi.fn().mockResolvedValue(
      new Response('null', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchReceipt);
    rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'tournament manager lease expired' },
    });

    await expect(
      moveTournamentPlayerAtomically(input, { outcomeWasAlreadyUnknown: true })
    ).rejects.toBeInstanceOf(TournamentSeatMoveOutcomeUnknownError);
    expect(fetchReceipt).toHaveBeenCalledTimes(1);
  });
});
