import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../services/supabase.js', () => ({ supabase: { rpc } }));

import {
  assignTournamentPlayerSeatAtomically,
  TournamentSeatAssignmentOutcomeUnknownError,
  TournamentSeatAssignmentRefusedError,
} from './tournamentSeatAssignmentRpc.js';

const input = {
  tournamentId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  tableId: '00000000-0000-4000-8000-000000000003',
  seatNumber: 4,
};

const receipt = {
  ok: true,
  tournament_id: input.tournamentId,
  user_id: input.userId,
  table_id: input.tableId,
  seat_id: '00000000-0000-4000-8000-000000000004',
  seat_number: input.seatNumber,
  stack: '1575',
  current_players: 7,
  assigned_at: '2026-09-08T23:12:34.000Z',
  replayed: false,
};

describe('atomic tournament seat assignment transport', () => {
  beforeEach(() => rpc.mockReset());

  it('accepts the exact database assignment receipt', async () => {
    rpc.mockResolvedValue({ data: receipt, error: null });

    await expect(assignTournamentPlayerSeatAtomically(input)).resolves.toEqual({
      tournamentId: input.tournamentId,
      userId: input.userId,
      tableId: input.tableId,
      seatId: receipt.seat_id,
      seatNumber: input.seatNumber,
      stack: 1575,
      currentPlayers: 7,
      assignedAt: receipt.assigned_at,
      replayed: false,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('fn_assign_tournament_player_seat_atomic', {
      p_tournament_id: input.tournamentId,
      p_user_id: input.userId,
      p_table_id: input.tableId,
      p_seat_number: input.seatNumber,
    });
  });

  it('treats a different valid database-selected chair as authoritative', async () => {
    const selected = {
      ...receipt,
      table_id: '00000000-0000-4000-8000-000000000009',
      seat_number: 8,
    };
    rpc.mockResolvedValue({ data: selected, error: null });

    await expect(assignTournamentPlayerSeatAtomically(input)).resolves.toMatchObject({
      tournamentId: input.tournamentId,
      userId: input.userId,
      tableId: selected.table_id,
      seatNumber: selected.seat_number,
    });
    expect(rpc).toHaveBeenCalledWith('fn_assign_tournament_player_seat_atomic', {
      p_tournament_id: input.tournamentId,
      p_user_id: input.userId,
      p_table_id: input.tableId,
      p_seat_number: input.seatNumber,
    });
  });

  it.each([
    ['tournament_id', '00000000-0000-4000-8000-000000000009'],
    ['user_id', '00000000-0000-4000-8000-000000000009'],
    ['table_id', 'not-a-uuid'],
    ['seat_number', 11],
    ['stack', 0],
    ['current_players', 0],
    ['assigned_at', 'not-a-date'],
    ['replayed', 'yes'],
  ])('rejects a malformed or mismatched %s receipt', async (field, wrong) => {
    rpc.mockResolvedValue({ data: { ...receipt, [field]: wrong }, error: null });

    await expect(assignTournamentPlayerSeatAtomically(input)).rejects.toBeInstanceOf(
      TournamentSeatAssignmentOutcomeUnknownError
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('classifies a database refusal without a compensating fallback', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '55000', message: 'seat_taken' },
    });

    await expect(assignTournamentPlayerSeatAtomically(input)).rejects.toBeInstanceOf(
      TournamentSeatAssignmentRefusedError
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('treats an unclassified transport response as unknown and leaves reread to the lifecycle', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '503', message: 'response lost' },
    });

    await expect(assignTournamentPlayerSeatAtomically(input)).rejects.toBeInstanceOf(
      TournamentSeatAssignmentOutcomeUnknownError
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
