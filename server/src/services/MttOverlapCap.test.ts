/**
 * AN MTT IS BOOKED AGAINST THE GAMES IT WILL BE PLAYED BESIDE (2026-09-22).
 *
 * The four-game cap was checked only at the door, and the door counts a
 * booking as a game only in the hour before its start. The pre-start ramp
 * books MTT fields up to 72 hours out, so a horse holding three frozen
 * tournament seats took four bookings for one afternoon, one at a time, and
 * was dealt into every one of them: horse 7f554d21 held seven chairs on
 * 2026-09-22.
 *
 * An MTT or satellite entry made by registerHorses now also needs its open
 * tournament seats plus its other bookings within MTT_OVERLAP_WINDOW_MS of the
 * event's start to stay under four. Cash seats do not count, and Spins and
 * SNGs register exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TournamentRecurringService,
  buildMttOverlapLoadMap,
  horseAtCapacity,
  HORSE_MAX_CONCURRENT_TABLES,
  MTT_OVERLAP_WINDOW_MS,
  MTT_PRESTART_RAMP_MS,
  REGISTRATION_LOAD_HORIZON_MS,
  rampQueueRotation,
  type LoadRef,
  type PendingBookingRef,
} from './TournamentRecurringService.js';
import { setHorseLanes } from './HorseBehavior.js';
import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => false }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
beforeEach(() => vi.mocked(reportError).mockClear());
afterEach(() => vi.restoreAllMocks());

const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
/** 2026-09-19 UTC, the day horse 7f554d21 was booked into four MTTs. */
const at = (hhmm: string) => `2026-09-19T${hhmm}:00.000Z`;

/* The measured rows, 2026-09-22. Three seats in tournaments frozen since
   2026-09-18, then four freezeout MTTs the next day. */
const HORSE = '7f554d21-df8a-4b3a-9eb4-45a081382e72';
const FROZEN_SEATS: LoadRef[] = [
  'a82a98c5-e41b-419e-8998-664148ee95ac', // 1 Chip Deep Stack Spin PLO4, 09-18 01:55
  'a565d424-5ddc-466c-874b-619dcb02f88c', // Morning Free Buy (NLH), 09-18 13:00
  '6c12bfb7-062f-4864-82f0-c2dac4b07498', // Afternoon Free Buy (NLH), 09-18 21:00
].map((tournament_id) => ({ user_id: HORSE, tournament_id }));
const MTTS: Array<[id: string, start: string]> = [
  ['b32d257f-b7ef-4768-a6d6-0b3d4a9f281e', at('09:16')], // Morning Grinder (PLO)
  ['5745831b-faae-4dd6-94dd-6b47231b2c94', at('11:00')], // $100 Freeroll 6:00 AM
  ['02377703-2da4-449d-b543-0ee7ac8a13b8', at('17:00')], // $100 Freeroll 12:00 PM
  ['0bb488ef-7e34-475d-ac1e-636fd078dcf5', at('23:00')], // $100 Freeroll 6:00 PM
];

const seatsFor = (user_id: string, n: number): LoadRef[] =>
  Array.from({ length: n }, (_, i) => ({ user_id, tournament_id: `${user_id}-seat-${i}` }));

describe('the window', () => {
  it('is six hours, an estimated MTT duration', () => {
    expect(MTT_OVERLAP_WINDOW_MS).toBe(6 * HOUR);
  });

  it('leaves the seat-first boards on the hour the database counts', () => {
    // The 2026-09-06/07 decisions stand: this cap is added for MTT and
    // satellite entries, it does not widen the load every board reads.
    expect(REGISTRATION_LOAD_HORIZON_MS).toBe(HOUR);
  });

  it('is shorter than the ramp, so a booking days out never costs a seat today', () => {
    expect(MTT_OVERLAP_WINDOW_MS).toBeLessThan(MTT_PRESTART_RAMP_MS);
  });
});

describe('buildMttOverlapLoadMap', () => {
  const T = Date.parse(at('12:00'));
  const booking = (tournament_id: string, startMs: number | null, user_id = 'h') => ({
    user_id,
    tournament_id,
    start_time: startMs === null ? null : iso(startMs),
  });

  it('counts every open tournament seat, however long ago its event started', () => {
    const load = buildMttOverlapLoadMap(seatsFor('h', 3), [], T);
    expect(load.get('h')).toBe(3);
  });

  it('does not count a cash seat', () => {
    const cash: LoadRef[] = [
      { user_id: 'h', tournament_id: null },
      { user_id: 'h', tournament_id: null },
      { user_id: 'h', tournament_id: null },
      'h',
    ];
    expect(buildMttOverlapLoadMap(cash, [], T).get('h')).toBeUndefined();
    expect(buildMttOverlapLoadMap([...cash, ...seatsFor('h', 1)], [], T).get('h')).toBe(1);
  });

  it('counts a booking exactly six hours either side, and none a millisecond further', () => {
    const edge = (offset: number) =>
      buildMttOverlapLoadMap([], [booking('b', T + offset)], T).get('h') ?? 0;
    expect(edge(0)).toBe(1);
    expect(edge(MTT_OVERLAP_WINDOW_MS)).toBe(1);
    expect(edge(-MTT_OVERLAP_WINDOW_MS)).toBe(1);
    expect(edge(MTT_OVERLAP_WINDOW_MS + 1)).toBe(0);
    expect(edge(-MTT_OVERLAP_WINDOW_MS - 1)).toBe(0);
  });

  it('a booking for a chair the horse already holds is that chair, not a second game', () => {
    const load = buildMttOverlapLoadMap(
      [{ user_id: 'h', tournament_id: 'spin' }],
      [booking('spin', T)],
      T
    );
    expect(load.get('h')).toBe(1);
  });

  it('never counts the event being filled', () => {
    const load = buildMttOverlapLoadMap(
      [{ user_id: 'h', tournament_id: 'target' }],
      [booking('target', T)],
      T,
      'target'
    );
    expect(load.get('h')).toBeUndefined();
  });

  it('one tournament is one game however many rows it has', () => {
    const load = buildMttOverlapLoadMap([], [booking('b', T), booking('b', T)], T);
    expect(load.get('h')).toBe(1);
  });

  it('counts a booking whose start cannot be read, and every booking when the target start cannot', () => {
    // Under-counting is the direction that books a fifth game.
    expect(buildMttOverlapLoadMap([], [booking('b', null)], T).get('h')).toBe(1);
    expect(buildMttOverlapLoadMap([], [booking('b', T + 48 * HOUR)], Number.NaN).get('h')).toBe(1);
  });

  it('the measured horse: 09:16 and 17:00 fit beside three frozen seats, 11:00 and 23:00 do not', () => {
    const bookings: PendingBookingRef[] = [];
    const admitted: string[] = [];
    for (const [id, start] of MTTS) {
      const games =
        buildMttOverlapLoadMap(FROZEN_SEATS, bookings, Date.parse(start), id).get(HORSE) ?? 0;
      if (horseAtCapacity(games)) continue;
      admitted.push(start);
      bookings.push({ user_id: HORSE, tournament_id: id, start_time: start });
    }
    expect(admitted).toEqual([at('09:16'), at('17:00')]);
  });
});

/**
 * THE REGISTRATION PATH. topUpWithHorses -> registerHorses with every database
 * read stubbed at the service's own seams, so what is exercised is the real
 * decision: which horses reach fn_register_horse_for_tournament. The horses
 * are all tournament-lane (setHorseLanes), so the lane hash cannot pick the
 * outcome, and each registration lands as a booking in the commitments the
 * next fill reads, as it would in the database.
 */
function harness(
  horses: string[],
  seed: { seats?: LoadRef[]; bookings?: PendingBookingRef[]; load?: Record<string, number> } = {}
) {
  setHorseLanes(horses.map((id) => ({ id, lane: 'events' })));
  const svc = new TournamentRecurringService() as any;
  const seats = [...(seed.seats ?? [])];
  const bookings = [...(seed.bookings ?? [])];
  // The hour-window load every format reads. Seeded per test.
  vi.spyOn(svc, 'horseLoadMap').mockResolvedValue(new Map(Object.entries(seed.load ?? {})));
  const commitmentsRead = vi
    .spyOn(svc, 'horseTournamentCommitments')
    .mockImplementation(async () => ({
      tournamentSeats: [...seats],
      pendingBookings: [...bookings],
    }));
  vi.spyOn(svc, 'clubMemberIdsForTournament').mockResolvedValue(new Set(horses));
  let row: Record<string, unknown> = {};
  const rpc = vi.fn(async (name: string, args: any): Promise<any> => {
    if (name === 'fn_horse_tournament_entry_ticket_hints') {
      return { data: { ok: true, holder_ids: [] }, error: null };
    }
    if (name === 'fn_register_horse_for_tournament') {
      bookings.push({
        user_id: args.p_user_id,
        tournament_id: args.p_tournament_id,
        start_time: row.start_time as string,
      });
      return { data: { ok: true, registration_id: 'registered' }, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  vi.spyOn(supabase, 'rpc').mockImplementation(rpc as never);
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    const b: Record<string, any> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'gt', 'order', 'limit', 'range', 'update'])
      b[m] = () => b;
    const answer = () => ({
      data:
        table === 'tournaments'
          ? row
          : table === 'profiles'
            ? horses.map((id) => ({ id, display_name: id, username: id, use_real_name: false }))
            : [],
      error: null,
      count: 0,
    });
    b.maybeSingle = async () => answer();
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
    return b as never;
  });
  const fill = (tournamentId: string, event: Record<string, unknown>, wanted = 1) => {
    row = {
      variant: 'freezeout',
      tournament_type: 'MTT',
      format_contract: 'mtt-v2',
      max_players: null,
      club_id: null,
      prize_pool_finalized: false,
      buy_in_amount: 0,
      buy_in_fee: 0,
      ...event,
    };
    return svc.topUpWithHorses(tournamentId, wanted) as Promise<number>;
  };
  const entries = () =>
    rpc.mock.calls
      .filter(([name]) => name === 'fn_register_horse_for_tournament')
      .map(([, a]) => ({ tournament: a.p_tournament_id, horse: a.p_user_id }));
  return { svc, fill, entries, commitmentsRead };
}

describe('registerHorses holds an MTT or satellite entry to the overlap cap', () => {
  it('the measured horse 7f554d21, registered in start order: 09:16 and 17:00 only', async () => {
    // horseLoadMap reads 3: the frozen seats. None of the four bookings is
    // inside the hour, which is exactly why the old door let all four in.
    const h = harness([HORSE], { seats: FROZEN_SEATS, load: { [HORSE]: 3 } });
    const added: number[] = [];
    for (const [id, start] of MTTS) added.push(await h.fill(id, { start_time: start }));
    expect(added).toEqual([1, 0, 1, 0]);
    expect(h.entries()).toEqual([
      { tournament: MTTS[0][0], horse: HORSE },
      { tournament: MTTS[2][0], horse: HORSE },
    ]);
  });

  it.each<[string, number, Record<string, unknown>]>([
    ['an MTT in thirty minutes', 0.5 * HOUR, {}],
    ['an MTT three days out', 71 * HOUR, {}],
    [
      'a satellite tomorrow',
      24 * HOUR,
      { tournament_type: 'SATELLITE', variant: 'satellite', format_contract: 'mtt-v2' },
    ],
    ['a legacy mtt-v1 field', 5 * HOUR, { format_contract: 'mtt-v1', max_players: 200 }],
  ])(
    'a horse holding four tournament seats is never registered for %s',
    async (_l, lead, event) => {
      // The hour-window load is left EMPTY here so the overlap cap alone has to
      // refuse the horse; in production that load reads four as well.
      const h = harness(['four-seats', 'free'], { seats: seatsFor('four-seats', 4) });
      await h.fill('event', { start_time: iso(Date.now() + lead), ...event }, 2);
      expect(h.entries().map((e) => e.horse)).toEqual(['free']);
      expect(h.commitmentsRead).toHaveBeenCalledTimes(1);
    }
  );

  it('cash seats do not count: one cash seat, two tournament seats and a booking four hours on still enter', async () => {
    const T = Date.parse(at('12:00'));
    const h = harness(['h'], {
      // A cash row cannot come back from the read, and would not count if it did.
      seats: [{ user_id: 'h', tournament_id: null }, ...seatsFor('h', 2)],
      bookings: [{ user_id: 'h', tournament_id: 'later', start_time: iso(T + 4 * HOUR) }],
      load: { h: 3 },
    });
    expect(await h.fill('event', { start_time: iso(T) })).toBe(1);
    expect(h.entries()).toEqual([{ tournament: 'event', horse: 'h' }]);
  });

  it.each<[string, number, number]>([
    ['exactly six hours after', 0, MTT_OVERLAP_WINDOW_MS],
    ['exactly six hours before', 0, -MTT_OVERLAP_WINDOW_MS],
    ['six hours and a minute after', 1, MTT_OVERLAP_WINDOW_MS + 60_000],
    ['six hours and a minute before', 1, -MTT_OVERLAP_WINDOW_MS - 60_000],
  ])('three seats and a booking starting %s this one: %i registered', async (_l, n, offset) => {
    const T = Date.parse(at('12:00'));
    const h = harness(['h'], {
      seats: seatsFor('h', 3),
      bookings: [{ user_id: 'h', tournament_id: 'other', start_time: iso(T + offset) }],
      load: { h: 3 },
    });
    expect(await h.fill('event', { start_time: iso(T) })).toBe(n);
  });

  it('drops the horse exactly as the four-game rule drops one, and asks for no more entries', async () => {
    // The queue rotates by the hour; hold it still so both walks see one queue.
    vi.spyOn(Date.prototype, 'getUTCHours').mockReturnValue(5);
    const pool = ['p0', 'p1', 'p2', 'p3'];
    // The horse this event's queue takes first when nobody is excluded.
    const head = pool[rampQueueRotation('event', 5, pool.length)];
    const T = Date.now() + 10 * HOUR;
    // Out by the overlap cap: three seats and a booking an hour after this start...
    const overlap = harness(pool, {
      seats: seatsFor(head, 3),
      bookings: [{ user_id: head, tournament_id: 'x', start_time: iso(T + HOUR) }],
    });
    expect(await overlap.fill('event', { start_time: iso(T) }, 2)).toBe(2);
    const byOverlap = overlap.entries();
    // ...and out by the four-game load the registrar already honoured.
    const fourGames = harness(pool, { load: { [head]: HORSE_MAX_CONCURRENT_TABLES } });
    expect(await fourGames.fill('event', { start_time: iso(T) }, 2)).toBe(2);
    expect(byOverlap).toEqual(fourGames.entries());
    expect(byOverlap.map((e) => e.horse)).not.toContain(head);
  });

  it('declines the pass when the commitments cannot be read, rather than treating them as none', async () => {
    const h = harness(['h']);
    h.svc.horseTournamentCommitments.mockResolvedValue(null);
    expect(await h.fill('event', { start_time: iso(Date.now() + 2 * HOUR) })).toBe(0);
    expect(h.entries()).toEqual([]);
  });
});

describe('Spins and SNGs register exactly as before', () => {
  it('a six-max SNG, filled through registerHorses, never reads or applies the overlap cap', async () => {
    // Four tournament seats would refuse an MTT; the hour-window load reads 3.
    const h = harness(['h'], { seats: seatsFor('h', 4), load: { h: 3 } });
    const added = await h.fill('sng', {
      variant: 'sng',
      tournament_type: 'SNG',
      format_contract: 'sng-v1',
      max_players: 6,
      start_time: iso(Date.now() + 60_000),
    });
    expect(added).toBe(1);
    expect(h.commitmentsRead).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown> | undefined]>([
    ['no row (createSNG)', undefined],
    ['a Spin row', { format_contract: 'spin-v1', start_time: null }],
    [
      'a seat-first satellite row',
      { format_contract: 'seat-first-satellite-v1', start_time: null },
    ],
    ['a six-max SNG row', { format_contract: 'sng-v1', max_players: 6, start_time: null }],
  ])('registerHorses given %s keeps the hour-window rule alone', async (_l, target) => {
    const h = harness(['h'], { seats: seatsFor('h', 4), load: { h: 3 } });
    expect(await h.svc.registerHorses('game', 1, false, undefined, false, target)).toBe(1);
    expect(h.commitmentsRead).not.toHaveBeenCalled();
  });

  it('the hour-window rule still refuses a horse at four for every format', async () => {
    const h = harness(['h'], { load: { h: HORSE_MAX_CONCURRENT_TABLES } });
    expect(await h.svc.registerHorses('game', 1)).toBe(0);
    expect(h.entries()).toEqual([]);
  });

  it('the seat-first fill and createSNG never reach the overlap cap', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
      'utf8'
    );
    const pick = src.slice(
      src.indexOf('private async pickFreeHorses('),
      src.indexOf('const candidates = selectHorseCandidates')
    );
    expect(pick).not.toContain('horseTournamentCommitments');
    expect(pick).not.toContain('buildMttOverlapLoadMap');
    expect(src).toContain('registered = await this.registerHorses(sng.id, seatPlan.horses);');
  });
});

describe('the commitments read', () => {
  function recordingFrom(rows: Record<string, unknown[]>, failOn?: string) {
    const calls: Record<string, Array<[string, unknown[]]>> = {};
    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      const log: Array<[string, unknown[]]> = (calls[table] ??= []);
      const b: Record<string, any> = {};
      for (const m of ['select', 'is', 'neq', 'not', 'in', 'or', 'order', 'range'])
        b[m] = (...args: unknown[]) => {
          log.push([m, args]);
          return b;
        };
      b.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          table === failOn
            ? { data: null, error: { message: 'boom' } }
            : { data: rows[table] ?? [], error: null }
        ).then(resolve);
      return b as never;
    });
    return calls;
  }

  it('reads tournament seats only, and every pending booking however far out', async () => {
    const svc = new TournamentRecurringService() as any;
    const calls = recordingFrom({
      table_seats: [
        { user_id: 'h', table_id: 'a', tables: { status: 'running', tournament_id: 't1' } },
        // A cash row the filter should have kept out; it still never counts.
        { user_id: 'h', table_id: 'b', tables: { status: 'running', tournament_id: null } },
      ],
      tournament_players: [
        {
          user_id: 'h',
          tournament_id: 'far',
          tournaments: { status: 'REGISTERING', start_time: '2026-09-25T00:00:00.000Z' },
        },
      ],
    });
    const read = await svc.horseTournamentCommitments();
    expect(calls.table_seats).toContainEqual(['not', ['tables.tournament_id', 'is', null]]);
    expect(calls.table_seats).toContainEqual(['neq', ['tables.status', 'closed']]);
    expect(calls.tournament_players).toContainEqual([
      'in',
      ['tournaments.status', ['ANNOUNCED', 'REGISTERING']],
    ]);
    // No start-time bound: the window is measured per event.
    expect(calls.tournament_players.map(([m]) => m)).not.toContain('or');
    const load = buildMttOverlapLoadMap(
      read.tournamentSeats,
      read.pendingBookings,
      Date.parse('2026-09-25T03:00:00.000Z')
    );
    expect(load.get('h')).toBe(2);
  });

  it.each<string>(['table_seats', 'tournament_players'])(
    'is unknown, not empty, when the %s page fails',
    async (table) => {
      const svc = new TournamentRecurringService() as any;
      recordingFrom({}, table);
      expect(await svc.horseTournamentCommitments()).toBeNull();
      expect(reportError).toHaveBeenCalled();
    }
  );
});
