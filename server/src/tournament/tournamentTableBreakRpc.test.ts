import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../services/supabase.js';
import {
  TournamentTableBreakRpc,
  verifyTournamentTableBreakState,
} from './tournamentTableBreakRpc.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const state = () => ({
  ok: true,
  reason: null,
  break_id: id(2),
  tournament_id: id(1),
  source_table_id: id(3),
  lifecycle: '9007199254740993',
  state: 'begun',
  revision: '9007199254740995',
  custody_id: null,
  custody_generation: null,
  terminal_handoff_required: false,
  members: [
    {
      user_id: id(4),
      source_seat_id: id(5),
      source_seat_number: 1,
      occupancy_id: id(6),
      request_id: id(7),
      destination_table_id: id(8),
      destination_seat_number: 2,
      active_request_id: id(7),
      winner_request_id: null,
      attempt_revision: 1,
      original_destination_table_id: id(8),
      original_destination_seat_number: 2,
      winning_receipt: null,
    },
  ],
});
afterEach(() => vi.restoreAllMocks());
describe('F06 typed durable operation transport', () => {
  it('preserves lifecycle and revision beyond safe numeric precision', () => {
    const verified = verifyTournamentTableBreakState(state(), id(1), id(2));
    expect(verified.lifecycle).toBe('9007199254740993');
    expect(verified.revision).toBe('9007199254740995');
  });
  it.each([
    { tournament_id: id(99) },
    { break_id: id(99) },
    { lifecycle: 9007199254740992 },
    { revision: '1e3' },
    { custody_id: id(10) },
    { state: 'closed' },
    { members: [state().members[0], state().members[0]] },
  ])('refuses foreign or ambiguous evidence %j', (change) => {
    expect(() =>
      verifyTournamentTableBreakState({ ...state(), ...change }, id(1), id(2))
    ).toThrow();
  });
  it('preserves exact amendment identity on transport failure', async () => {
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: null, error: { message: 'lost' } } as never);
    const client = new TournamentTableBreakRpc(id(1), id(9));
    const amendment = {
      breakId: id(2),
      userId: id(4),
      expectedRequestId: id(7),
      amendmentId: id(10),
      newRequestId: id(11),
      destinationTableId: id(12),
      destinationSeatNumber: 3,
      reason: 'destination closed',
    };
    await expect(client.amend(amendment)).rejects.toThrow('outcome unproven');
    await expect(client.amend(amendment)).rejects.toThrow('outcome unproven');
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc.mock.calls[0]).toEqual([
      'fn_f06_amend_attempt',
      {
        p_tournament_id: id(1),
        p_lease_generation: id(9),
        p_break_id: id(2),
        p_user_id: id(4),
        p_expected_request_id: id(7),
        p_amendment_id: id(10),
        p_new_request_id: id(11),
        p_destination_table_id: id(12),
        p_destination_seat_number: 3,
        p_reason: 'destination closed',
      },
    ]);
  });
  it('retains conflict cursor evidence without claiming a successful page', async () => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: {
        ok: false,
        cursor_revision: '9007199254740997',
        reason: 'cursor_revision_conflict',
        wrapped: false,
        operations: [],
      },
      error: null,
    } as never);
    const page = await new TournamentTableBreakRpc(id(1), id(9)).discover('0', 20);
    expect(page.ok).toBe(false);
    expect(page.cursor_revision).toBe('9007199254740997');
  });
  it('refuses foreign operation in a discovery page', async () => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: {
        ok: true,
        cursor_revision: '1',
        wrapped: false,
        operations: [{ ...state(), tournament_id: id(99) }],
      },
      error: null,
    } as never);
    await expect(new TournamentTableBreakRpc(id(1), id(9)).discover('0', 20)).rejects.toThrow(
      'identity mismatch'
    );
  });
  it('verifies v3 winner provenance against the original occupancy and active-or-winning destination', () => {
    const base = state();
    const receipt = {
      request_id: id(10),
      tournament_id: id(1),
      user_id: id(4),
      source_table_id: id(3),
      destination_table_id: id(11),
      source_seat_id: id(5),
      source_seat_number: 1,
      destination_seat_id: id(12),
      destination_seat_number: 3,
      source_mode: 'live_source',
      stack: '100.00',
      moved_at: '2026-09-12T00:00:00Z',
      source_occupancy_id: id(6),
      source_lifecycle: base.lifecycle,
      break_id: id(2),
    };
    const winner = {
      ...base.members[0],
      active_request_id: null,
      winner_request_id: id(10),
      destination_table_id: id(11),
      destination_seat_number: 3,
      attempt_revision: 2,
      winning_receipt: receipt,
    };
    const verified = verifyTournamentTableBreakState(
      { ...base, state: 'close_confirmed', members: [winner] },
      id(1),
      id(2)
    );
    expect(verified.members[0].request_id).toBe(id(7));
    expect(verified.members[0].winner_request_id).toBe(id(10));
    expect(verified.members[0].winning_receipt?.stack).toBe(100);
    expect(() =>
      verifyTournamentTableBreakState(
        {
          ...base,
          members: [{ ...winner, winning_receipt: { ...receipt, source_occupancy_id: id(99) } }],
        },
        id(1),
        id(2)
      )
    ).toThrow('provenance');
  });
  it('keeps a semantic refusal distinct from fabricated operation evidence', async () => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { ok: false, reason: 'members_unresolved' },
      error: null,
    } as never);
    await expect(new TournamentTableBreakRpc(id(1), id(9)).close(id(2))).rejects.toThrow(
      'members_unresolved'
    );
  });
});
