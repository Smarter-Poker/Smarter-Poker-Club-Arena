/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HELD CLUB IS NOT PUBLISHED FOR - THE FREE BUY BOARD HAS A DATABASE GATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every other generator on this platform can be stopped for one club with a
 * database write. The Spin and SNG boards read activatedSpinOwners(), which
 * fn_spin_deactivate empties. The pre-start tournament ramp reads the club's
 * effective fleet policy. The Free Buy board read neither: FREE_BUY_HOSTS is a
 * module constant, so on 2026-10-04 holding one club cost a full governed
 * delivery, and in the meantime that club gained a Free Buy MTT per due slot
 * while everything else about it was already dark.
 *
 * checkAndCreateFreeBuys now reads each host's policy and declines to PUBLISH
 * for a held one. FREE_BUY_HELD_HOSTS is untouched and still the hard hold -
 * a constant no database write can undo - so the two brakes are independent.
 *
 * THE DIRECTION OF FAILURE IS THE POINT. This gate fails CLOSED where the
 * ramp's fails open, and the asymmetry is deliberate: refusing a seat strands
 * a game that already exists and was paid for, while refusing to create an
 * event strands nothing. An event wrongly published onto a held club is
 * seeded with horses within seconds and then has to be refunded one entry at
 * a time - which is exactly the cleanup this gate exists to prevent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
const insertMock = vi.fn();
let existingCount = 0;

vi.mock('./supabase/client.js', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'limit', 'order', 'neq', 'not', 'update', 'gt']) {
      b[m] = () => b;
    }
    b.insert = (row: unknown) => {
      insertMock(table, row);
      const ins: Record<string, unknown> = {};
      ins.select = () => ins;
      ins.maybeSingle = () => Promise.resolve({ data: { id: 'new-id' }, error: null });
      return ins;
    };
    const answer = () => Promise.resolve({ data: null, error: null, count: existingCount });
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
vi.mock('./errorReporter.js', () => ({
  reportError: (...a: unknown[]) => reportErrorMock(...a),
  reportWarning: () => undefined,
  describeError: (e: unknown) => String(e),
}));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => false }));

import {
  MIDWAY_BOARD_IS_ON_THE_FIXED_SCHEDULE,
  TournamentRecurringService,
} from './TournamentRecurringService.js';
import { _resetFleetPolicyCacheForTests } from './HorseFleetPolicy.js';
import { FREE_BUY_HOSTS, freeBuySlotsDue } from './FreeBuy.js';

const REFUSAL = 'TournamentRecurring.free_buy_publish_refused_fleet_held';

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

/**
 * 10:30 UTC = 05:30 Chicago (CDT), three hours before the 08:30 slot, so
 * exactly one slot sits inside FREE_BUY_PUBLISH_LEAD_MS. Asserted below
 * rather than assumed, so a change to the slot table fails here loudly
 * instead of quietly testing nothing.
 */
const AT_FIVE_THIRTY_AM_CHICAGO = Date.parse('2026-10-05T10:30:00.000Z');

describe('a held club is not published for', () => {
  let svc: TournamentRecurringService;

  const tick = () =>
    (svc as unknown as { checkAndCreateFreeBuys: () => Promise<void> }).checkAndCreateFreeBuys();

  function policyAnswer(answer: () => { data: unknown; error: { message: string } | null }) {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'fn_ca_fleet_policy_effective') return answer();
      return { data: null, error: null };
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AT_FIVE_THIRTY_AM_CHICAGO);
    rpcMock.mockReset();
    insertMock.mockReset();
    reportErrorMock.mockReset();
    existingCount = 0;
    _resetFleetPolicyCacheForTests();
    svc = new TournamentRecurringService();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('has exactly one slot due at the test clock, so the cases below are real', () => {
    expect(freeBuySlotsDue(AT_FIVE_THIRTY_AM_CHICAGO)).toHaveLength(1);
    expect(FREE_BUY_HOSTS).toHaveLength(1);
  });

  /**
   * THE FIXED BOARD (Dan 2026-10-15): "TOURNAMENTS CAN NEVER FAIL, AND MUST
   * ALWAYS RUN AND SPAWN ... PUT THEM ON A HARD CODED SCHEDULE." The Midway
   * Union's five Free Buys are tournament_schedules rows at fixed Chicago
   * times now (theBoardIsAFixedSchedule.law.test.ts). This timer is the path
   * that went dark on 2026-10-13, so for the Midway Union it publishes
   * nothing, in every fleet state, and does not even read the policy: a
   * horse-fleet hold can no longer decide whether a Free Buy exists.
   */
  it('the only host is the Midway Union, which the fixed schedule owns', () => {
    expect(MIDWAY_BOARD_IS_ON_THE_FIXED_SCHEDULE).toBe(true);
    expect(FREE_BUY_HOSTS[0].clubId).toBe('fade0000-0000-0000-0000-000000000001');
  });

  for (const [label, row] of [
    ['an unheld fleet', policyRow()],
    ['pause_new_seatings', policyRow({ pause_new_seatings: true })],
    ['enabled false', policyRow({ enabled: false })],
  ] as const) {
    it(`publishes nothing for the Midway Union under ${label}`, async () => {
      policyAnswer(() => ({ data: row, error: null }));
      await tick();
      await tick();
      expect(insertMock).not.toHaveBeenCalled();
      expect(reportErrorMock.mock.calls.filter((c) => c[1] === REFUSAL)).toEqual([]);
    });
  }

  it('publishes nothing for the Midway Union on an unreadable policy either', async () => {
    policyAnswer(() => ({ data: null, error: { message: 'read timed out' } }));
    await tick();
    expect(insertMock).not.toHaveBeenCalled();
    expect(reportErrorMock.mock.calls.filter((c) => c[1] === REFUSAL)).toEqual([]);
  });

  it('never reads the fleet policy for a host the fixed schedule owns', async () => {
    policyAnswer(() => ({ data: policyRow({ pause_new_seatings: true }), error: null }));
    await tick();
    expect(rpcMock.mock.calls.filter((c) => c[0] === 'fn_ca_fleet_policy_effective')).toEqual([]);
  });
});
