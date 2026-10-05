/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PAUSED FLEET TAKES NO NEW SEAT - IN CASH OR IN A TOURNAMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * HorseFleetPolicy's contract words `enabled: false` as "stops NEW seatings"
 * and `pauseNewSeatings: true` as "stops NEW seatings without disabling the
 * fleet". Until 2026-10-05 only HorseFleetManager honoured it, and that seats
 * CASH tables. Nothing on the tournament side read the policy at all.
 *
 * Measured on production 2026-10-05, Deep Stack Society held with
 * `pause_new_seatings` true on its club row: cash was dark and no new game
 * could be created, yet 689 horse registrations sat across 49 scheduled MTTs
 * and the pre-start ramp replaced any that were refunded - 68 in two minutes.
 * An operator could stop a club being SOLD new games and still not stop it
 * PLAYING them.
 *
 * topUpWithHorses now reads the tournament's club policy and refuses the fill.
 * It never unseats a horse and never cancels an event, so the owner's
 * "TOURNAMENTS RUN. THEY DO NOT CANCEL." rule stands: a held club's existing
 * events run to their own end, they just stop being refilled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
type TableAnswer = { data: unknown; error: { message: string } | null };
let tableResults: Record<string, TableAnswer> = {};

vi.mock('./supabase/client.js', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'limit', 'order', 'neq', 'not', 'update', 'gt']) {
      b[m] = () => b;
    }
    const answer = () =>
      Promise.resolve(
        tableResults[table] ?? { data: null, error: { message: `no mock for ${table}` } }
      );
    b.maybeSingle = answer;
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => answer().then(ok, bad);
    return b;
  };
  const client = {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (table: string) => builder(table),
  };
  return { supabase: client, maintenanceSupabase: client };
});
const reportErrorMock = vi.fn();
vi.mock('./errorReporter.js', () => ({ reportError: (...a: unknown[]) => reportErrorMock(...a) }));

import { TournamentRecurringService } from './TournamentRecurringService.js';
import { _resetFleetPolicyCacheForTests } from './HorseFleetPolicy.js';

const HELD_CLUB = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
const SEAT_TABLE = 'bbbbbbbb-0000-4000-8000-000000000001';
const REFUSAL = 'TournamentRecurring.top_up_refused_fleet_held';

/** The effective-policy jsonb the RPC returns, in its real snake_case shape. */
function policyRow(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    enabled: true,
    pause_new_seatings: false,
    max_horses: null,
    max_per_table: null,
    occupancy_bias: 1.0,
    min_humans_to_seat: 0,
    stake_bands: null,
    variants: null,
    schedule: null,
    ...over,
  };
}

describe('a paused fleet takes no new seat in a tournament either', () => {
  let svc: TournamentRecurringService;
  let pick: ReturnType<typeof vi.spyOn>;

  /** A fillable seat-first board, so only the policy decides the outcome. */
  function boardIsFillable() {
    tableResults = {
      tournaments: {
        data: {
          variant: 'spin',
          format_contract: 'spin-v1',
          max_players: 3,
          club_id: HELD_CLUB,
          start_time: '2026-10-05T14:00:00.000Z',
          prize_pool_finalized: false,
          current_players: 0,
        },
        error: null,
      },
      table_seats: { data: [{ user_id: 'a', seat_number: 1 }], error: null },
      tables: { data: { max_players: 3 }, error: null },
    };
  }

  function policyAnswer(answer: () => { data: unknown; error: { message: string } | null }) {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'fn_ca_fleet_policy_effective') return answer();
      if (name === 'fn_tournament_primary_table') return { data: SEAT_TABLE, error: null };
      return { data: { ok: true, seat_number: 3 }, error: null };
    });
  }

  beforeEach(() => {
    rpcMock.mockReset();
    reportErrorMock.mockReset();
    _resetFleetPolicyCacheForTests();
    svc = new TournamentRecurringService();
    pick = vi
      .spyOn(svc as unknown as { pickFreeHorses: () => Promise<string[]> }, 'pickFreeHorses')
      .mockResolvedValue(['free-1', 'free-2', 'free-3']);
    vi.spyOn(
      svc as unknown as { unseatedRegistrantHorses: () => Promise<string[]> },
      'unseatedRegistrantHorses'
    ).mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    boardIsFillable();
  });
  afterEach(() => vi.restoreAllMocks());

  it('pause_new_seatings refuses the fill before it picks a horse, once per row', async () => {
    policyAnswer(() => ({ data: policyRow({ pause_new_seatings: true }), error: null }));
    const T = 'aaaaaaaa-0000-4000-8000-00000000f001';

    expect(await svc.topUpWithHorses(T, 3)).toBe(0);
    expect(await svc.topUpWithHorses(T, 3)).toBe(0);

    expect(pick).not.toHaveBeenCalled();
    expect(rpcMock.mock.calls.filter((c) => c[0] === 'fn_seat_horse_in_seat_first_game')).toEqual(
      []
    );
    expect(rpcMock.mock.calls.filter((c) => c[0] === 'fn_register_horse_for_tournament')).toEqual(
      []
    );
    // Said once for the row, not every backoff.
    expect(reportErrorMock.mock.calls.filter((c) => c[1] === REFUSAL)).toHaveLength(1);
  });

  it('enabled false refuses the fill too - the harder switch is not weaker', async () => {
    policyAnswer(() => ({ data: policyRow({ enabled: false }), error: null }));
    expect(await svc.topUpWithHorses('aaaaaaaa-0000-4000-8000-00000000f002', 3)).toBe(0);
    expect(pick).not.toHaveBeenCalled();
    expect(reportErrorMock.mock.calls.filter((c) => c[1] === REFUSAL)).toHaveLength(1);
  });

  it('an unheld club is filled exactly as before', async () => {
    policyAnswer(() => ({ data: policyRow(), error: null }));
    expect(await svc.topUpWithHorses('aaaaaaaa-0000-4000-8000-00000000f003', 3)).toBeGreaterThan(0);
    expect(pick).toHaveBeenCalled();
    expect(reportErrorMock.mock.calls.filter((c) => c[1] === REFUSAL)).toEqual([]);
  });

  it('FAILS OPEN: an unreadable policy fills exactly as today', async () => {
    /* HorseFleetPolicy's documented choice - "a database blip must never be
       able to empty the floor". This gate inherits it rather than inventing a
       stricter one, so a policy read that fails tops up as before. */
    policyAnswer(() => ({ data: null, error: { message: 'db down' } }));
    expect(await svc.topUpWithHorses('aaaaaaaa-0000-4000-8000-00000000f004', 3)).toBeGreaterThan(0);
    expect(pick).toHaveBeenCalled();
    expect(reportErrorMock.mock.calls.filter((c) => c[1] === REFUSAL)).toEqual([]);
  });

  it('does NOT spend a policy read on a board that was adding nobody anyway', async () => {
    /* The gate sits after every cheap refusal. aPastStartEventCountsItsRoster
       pins that an idle top-up touches the database not at all, and a full
       board reaches the same zero whatever the policy says. */
    policyAnswer(() => ({ data: policyRow({ pause_new_seatings: true }), error: null }));
    tableResults = {
      ...tableResults,
      // Roster already meets the target: nothing to add.
      table_seats: {
        data: [
          { user_id: 'a', seat_number: 1 },
          { user_id: 'b', seat_number: 2 },
          { user_id: 'c', seat_number: 3 },
        ],
        error: null,
      },
    };
    expect(await svc.topUpWithHorses('aaaaaaaa-0000-4000-8000-00000000f006', 3)).toBe(0);
    expect(rpcMock.mock.calls.filter((c) => c[0] === 'fn_ca_fleet_policy_effective')).toEqual([]);
  });

  it("reads the policy for the TOURNAMENT's club, not the global scope", async () => {
    policyAnswer(() => ({ data: policyRow({ pause_new_seatings: true }), error: null }));
    await svc.topUpWithHorses('aaaaaaaa-0000-4000-8000-00000000f005', 3);
    const calls = rpcMock.mock.calls.filter((c) => c[0] === 'fn_ca_fleet_policy_effective');
    expect(calls.length).toBeGreaterThan(0);
    expect((calls[0][1] as { p_club_id: string }).p_club_id).toBe(HELD_CLUB);
  });
});
