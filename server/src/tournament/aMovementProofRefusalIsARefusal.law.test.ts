/**
 * A MOVEMENT-PROOF REFUSAL OF A BEGIN IS A REFUSAL, NOT AN UNKNOWN OUTCOME (2026-10-02).
 *
 * When a park carries a movement admission, `fn_f06_begin_break` writes the
 * manifest and the `f06_movement_manifest` trigger runs
 * `smarter_private.f06_assert_movement`, which RAISEs a named
 * `F06_MOVEMENT_*` refusal (SQLSTATE 55000) when the live roster no longer
 * matches the proof. The raise rolls the whole begin back: nothing was begun.
 * The engine called it "outcome unproven" and re-sent the identical request
 * every pass. Production 2026-10-02 04:51-05:55 UTC: f8c6f298 break 7ef06537
 * (table 199a1efc, nine players frozen) logged
 * `F06 fn_f06_begin_break outcome unproven: F06_MOVEMENT_ROSTER_CHANGED`
 * on every pass. A named movement refusal now takes the refused-roster path:
 * the proposal becomes history, the refusal is noted, and the next pass
 * re-reads the roster.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { supabase } from '../services/supabase.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SOURCE = id(3);
const BREAK = id(2);

const inputMember = (user: number, seat: number, dest = 2) => ({
  user_id: id(user),
  source_seat_id: id(user + 100),
  source_seat_number: seat,
  occupancy_id: id(user + 200),
  request_id: id(user + 300),
  destination_table_id: id(8),
  destination_seat_number: dest,
});
const parked = (): any => ({
  ok: true,
  reason: null,
  break_id: BREAK,
  tournament_id: id(1),
  source_table_id: SOURCE,
  lifecycle: '1',
  state: 'park_requested',
  revision: '0',
  custody_id: null,
  custody_generation: null,
  terminal_handoff_required: false,
  members: [],
});
const ok = (data: unknown) => ({ data, error: null });

function manager() {
  const m: any = new TournamentManager(id(1), {} as any, id(9), performance.now() + 60000);
  m.running = true;
  m.eliminationSweepDeadlineAt = 0;
  m.requestUrgentEliminationSweepAfter = vi.fn();
  return m;
}

afterEach(() => vi.restoreAllMocks());

describe('a movement-proof refusal of a begin is a refusal', () => {
  it.each([
    'F06_MOVEMENT_ROSTER_CHANGED',
    'F06_MOVEMENT_ELIMINATION_CHANGED',
    'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED',
    'F06_MOVEMENT_BOUNDARY_CHANGED',
  ])('%s releases the refused proposal instead of re-sending it', async (message) => {
    const m = manager();
    const nine = Array.from({ length: 9 }, (_, i) => inputMember(10 + i, i + 1, i + 1));
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockImplementation((async (name: string) =>
        name === 'fn_f06_break_state'
          ? ok(parked())
          : { data: null, error: { code: '55000', message } }) as any);
    const result = await m.beginTournamentBreak(BREAK, SOURCE, nine);
    expect(result.state).toBe('park_requested');
    expect(m.pendingTournamentBreakBegins.has(BREAK)).toBe(false);
    expect(m.resolvedTournamentBreakProposals.get(BREAK)).toHaveLength(1);
    expect(m.lastBreakPreparationRefusal(BREAK)).toBe(`begin_refused:${message}`);
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
    expect(rpc.mock.calls.filter(([name]) => name === 'fn_f06_begin_break')).toHaveLength(1);
  });

  it.each([
    { code: '22023', message: 'F06_MOVEMENT_ROSTER_CHANGED' },
    { message: 'F06_MOVEMENT_ROSTER_CHANGED' },
    { code: '55000', message: 'F06_MOVEMENT_ROSTER_CHANGED_SOMETHING_ELSE' },
    { code: '55000', message: 'canceling statement due to statement timeout' },
  ])('anything but the exact named refusal %j stays outcome unproven', async (error) => {
    const m = manager();
    const two = [inputMember(4, 1), inputMember(5, 2, 3)];
    vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error } as never);
    await expect(m.beginTournamentBreak(BREAK, SOURCE, two)).rejects.toThrow('outcome unproven');
    expect(m.pendingTournamentBreakBegins.has(BREAK)).toBe(true);
  });
});
