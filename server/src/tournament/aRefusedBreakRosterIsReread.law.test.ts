/**
 * A REFUSED BREAK ROSTER IS RE-READ, NEVER RE-SENT (2026-09-28).
 *
 * `fn_f06_begin_break` refuses `F06_WHOLE_ROSTER_REQUIRED` / `F06_SOURCE_NOT_EXACT`
 * only after it has found the operation's manifest still NULL, and each is a
 * RAISE, so nothing was begun. The engine used to keep that refused proposal
 * as "pending" and `prepareParkedTournamentBreak` replayed it before reading
 * anything, so the break re-sent the same dead roster on every pass for ever
 * and its parked source table could never be merged. Production 2026-09-28
 * 03:20-03:51 UTC: eleven breaks in nine events, break cf0e43f3 (event
 * 700df3bc) refusing while its source held one live seat and one playing
 * registration. See docs/changelog/2026-09-28-a-refused-break-roster-is-reread.md.
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
const durableMember = (m: ReturnType<typeof inputMember>) => ({
  ...m,
  original_destination_table_id: m.destination_table_id,
  original_destination_seat_number: m.destination_seat_number,
  active_request_id: m.request_id,
  winner_request_id: null,
  winning_receipt: null,
  attempt_revision: 1,
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
const begun = (members: ReturnType<typeof inputMember>[]): any => ({
  ...parked(),
  state: 'begun',
  members: members.map(durableMember),
});
const ok = (data: unknown) => ({ data, error: null });
const wholeRoster = { data: null, error: { code: '22023', message: 'F06_WHOLE_ROSTER_REQUIRED' } };
const sourceNotExact = { data: null, error: { code: '55000', message: 'F06_SOURCE_NOT_EXACT' } };
const capacity = { data: null, error: { code: '55000', message: 'F06_CAPACITY_UNAVAILABLE' } };

function manager() {
  const m: any = new TournamentManager(id(1), {} as any, id(9), performance.now() + 60000);
  m.running = true;
  m.eliminationSweepDeadlineAt = 0;
  m.requestUrgentEliminationSweepAfter = vi.fn();
  return m;
}

/** One parked source engine and a live seat read the test controls. */
function parkedSource(m: any, seats: () => ReturnType<typeof inputMember>[]) {
  const engine = { parkForTournamentMove: vi.fn(async () => true) };
  m.tableEngines.set(SOURCE, engine);
  m.gameServer.ownsTournamentTableEngine = () => true;
  m.eligibleBreakDestinations = vi.fn(async () => [
    { tableId: id(8), playerCount: 1, maxSeats: 10, players: [] },
  ]);
  m.tableBalancer.breakTable = vi.fn((source: any) =>
    source.players.map((p: any, i: number) => ({
      playerId: p.userId,
      toTableId: id(8),
      toSeat: 2 + i,
    }))
  );
  const query: any = {
    select: () => query,
    eq: () => query,
    is: async () => ({
      data: seats().map((s) => ({
        id: s.source_seat_id,
        user_id: s.user_id,
        seat_number: s.source_seat_number,
        stack: 100,
        occupancy_id: s.occupancy_id,
      })),
      error: null,
    }),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(query);
  return engine;
}

afterEach(() => vi.restoreAllMocks());

describe('a refused break roster is re-read, never re-sent', () => {
  it.each([
    ['F06_WHOLE_ROSTER_REQUIRED', wholeRoster],
    ['F06_SOURCE_NOT_EXACT', sourceNotExact],
  ])('%s releases the refused proposal and keeps it only as history', async (_code, refusal) => {
    const m = manager();
    const two = [inputMember(4, 1), inputMember(5, 2, 3)];
    vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string) =>
      name === 'fn_f06_break_state' ? ok(parked()) : refusal) as any);
    const result = await m.beginTournamentBreak(BREAK, SOURCE, two);
    expect(result.state).toBe('park_requested');
    expect(m.pendingTournamentBreakBegins.has(BREAK)).toBe(false);
    expect(m.rejectedTournamentBreakBegins.has(BREAK)).toBe(false);
    expect(m.resolvedTournamentBreakProposals.get(BREAK)).toHaveLength(1);
    expect(m.lastBreakPreparationRefusal(BREAK)).toMatch(/^begin_refused:F06_/);
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });

  it('the cf0e43f3 shape: a retained two-player roster is refused and the one live player is begun in the same pass', async () => {
    const m = manager();
    const survivor = inputMember(4, 3);
    const busted = inputMember(5, 4, 3);
    // An earlier pass sent the two-player roster and lost the reply, so it is retained.
    m.pendingTournamentBreakBegins.set(BREAK, Object.freeze([survivor, busted]));
    const engine = parkedSource(m, () => [survivor]);
    const begins: any[] = [];
    vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
      if (name === 'fn_f06_break_state') return ok(parked());
      begins.push(p.p_members);
      return p.p_members.length === 1 ? ok(begun(p.p_members)) : wholeRoster;
    }) as any);
    const result = await m.prepareParkedTournamentBreak(parked());
    expect(begins.map((members) => members.length)).toEqual([2, 1]);
    expect(begins[1][0].user_id).toBe(survivor.user_id);
    expect(begins[1][0].request_id).not.toBe(survivor.request_id);
    expect(result.state).toBe('begun');
    expect(engine.parkForTournamentMove).toHaveBeenCalledTimes(1);
    expect(m.pendingTournamentBreakBegins.size).toBe(0);
    expect(m.resolvedTournamentBreakProposals.has(BREAK)).toBe(false);
  });

  it('never re-sends the refused roster on a later pass', async () => {
    const m = manager();
    const survivor = inputMember(4, 3);
    m.pendingTournamentBreakBegins.set(BREAK, Object.freeze([survivor, inputMember(5, 4, 3)]));
    parkedSource(m, () => [survivor]);
    const begins: any[] = [];
    let accept = false;
    vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
      if (name === 'fn_f06_break_state') return ok(parked());
      begins.push(p.p_members.length);
      // The fresh one-player roster meets a capacity race first.
      if (p.p_members.length === 1 && !accept) return capacity;
      return p.p_members.length === 1 ? ok(begun(p.p_members)) : wholeRoster;
    }) as any);
    await m.prepareParkedTournamentBreak(parked());
    accept = true;
    const result = await m.prepareParkedTournamentBreak(parked());
    expect(begins).toEqual([2, 1, 1]);
    expect(result.state).toBe('begun');
  });

  it('a capacity-rejected roster that has since lost a player no longer pins the break', async () => {
    const m = manager();
    const survivor = inputMember(4, 3);
    const busted = inputMember(5, 4, 3);
    let seats = [busted, survivor];
    parkedSource(m, () => seats);
    const begins: any[] = [];
    vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
      if (name === 'fn_f06_break_state') return ok(parked());
      begins.push(p.p_members);
      return begins.length === 1 ? capacity : ok(begun(p.p_members));
    }) as any);
    expect((await m.prepareParkedTournamentBreak(parked())).state).toBe('park_requested');
    seats = [survivor];
    const result = await m.prepareParkedTournamentBreak(parked());
    expect(result.state).toBe('begun');
    expect(begins[1]).toHaveLength(1);
    // The surviving player keeps the request identity the capacity race issued.
    expect(begins[1][0].request_id).toBe(
      begins[0].find((x: any) => x.user_id === survivor.user_id).request_id
    );
  });

  it('a delayed commit of the refused roster is still adopted by reconciliation', async () => {
    const m = manager();
    const two = [inputMember(4, 1), inputMember(5, 2, 3)];
    let durable = parked();
    vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string) =>
      name === 'fn_f06_break_state' ? ok(durable) : wholeRoster) as any);
    await m.beginTournamentBreak(BREAK, SOURCE, two);
    m.pendingTournamentBreakBegins.set(BREAK, Object.freeze([inputMember(4, 1)]));
    durable = begun(two);
    const next = await m.reconcileTournamentBreak(parked());
    expect(next.state).toBe('begun');
    expect(m.pendingTournamentBreakBegins.size).toBe(0);
  });

  it('a manifest nobody here sent is still refused', async () => {
    const m = manager();
    m.pendingTournamentBreakBegins.set(BREAK, Object.freeze([inputMember(4, 1)]));
    vi.spyOn(supabase, 'rpc').mockResolvedValue(ok(begun([inputMember(6, 1)])) as never);
    await expect(m.reconcileTournamentBreak(parked())).rejects.toThrow('membership mismatch');
  });

  it.each([
    { code: '55000', message: 'F06_WHOLE_ROSTER_REQUIRED' },
    { code: '22023', message: 'F06_SOURCE_NOT_EXACT' },
    { message: 'F06_WHOLE_ROSTER_REQUIRED' },
    { code: '22023', message: 'F06_CHANGED_MANIFEST' },
    { message: 'reply lost' },
  ])('keeps the exact proposal for anything but the correlated refusal %j', async (error) => {
    const m = manager();
    const two = [inputMember(4, 1), inputMember(5, 2, 3)];
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error } as never);
    await expect(m.beginTournamentBreak(BREAK, SOURCE, two)).rejects.toThrow('outcome unproven');
    await expect(m.beginTournamentBreak(BREAK, SOURCE, two)).rejects.toThrow('outcome unproven');
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
    expect(m.pendingTournamentBreakBegins.has(BREAK)).toBe(true);
  });

  it('a refusal whose reconciliation is not an unbegun park keeps the proposal', async () => {
    const m = manager();
    const two = [inputMember(4, 1), inputMember(5, 2, 3)];
    vi.spyOn(supabase, 'rpc')
      .mockResolvedValueOnce(wholeRoster as never)
      .mockResolvedValueOnce({ data: null, error: { message: 'lost read' } } as never);
    await expect(m.beginTournamentBreak(BREAK, SOURCE, two)).rejects.toThrow('lost read');
    expect(m.pendingTournamentBreakBegins.has(BREAK)).toBe(true);
  });
});

describe('a break preparation that does nothing says why', () => {
  it.each([
    [
      'source_engine_absent',
      (m: any) => {
        m.tableEngines.clear();
      },
    ],
    [
      'source_park_probe_missed',
      (m: any) => {
        m.tableEngines.get(SOURCE).parkForTournamentMove = vi.fn(async () => false);
      },
    ],
    [
      'source_roster_empty',
      (m: any) => {
        const query: any = { select: () => query, eq: () => query, is: async () => ok([]) };
        vi.spyOn(supabase, 'from').mockReturnValue(query);
      },
    ],
    [
      'destinations_unread',
      (m: any) => {
        m.eligibleBreakDestinations = vi.fn(async () => null);
      },
    ],
    [
      'destinations_full:0_of_1_placed_across_1_tables',
      (m: any) => {
        m.tableBalancer.breakTable = vi.fn(() => []);
      },
    ],
  ])('%s', async (reason, arrange) => {
    const m = manager();
    parkedSource(m, () => [inputMember(4, 1)]);
    arrange(m);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rpc = vi.spyOn(supabase, 'rpc');
    expect(await m.prepareParkedTournamentBreak(parked())).toBeNull();
    expect(await m.prepareParkedTournamentBreak(parked())).toBeNull();
    expect(m.lastBreakPreparationRefusal(BREAK)).toBe(reason);
    expect(rpc).not.toHaveBeenCalled();
    // Named once per change, not once per pass.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(reason))).toHaveLength(1);
  });
});
