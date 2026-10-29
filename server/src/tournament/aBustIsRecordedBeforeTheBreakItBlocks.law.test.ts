/**
 * A BUST IS RECORDED BEFORE THE BREAK IT BLOCKS IS RETRIED (2026-09-29).
 *
 * A hand's stack commit takes a busted player's seat and zeroes their
 * registration in one transaction; the registration stays `playing` until the
 * elimination sweep's bust stage records it. `fn_f06_begin_break` counts
 * `playing` registrations as well as live seats, so until that bust is
 * recorded no break of the player's last table can begin
 * (`F06_WHOLE_ROSTER_REQUIRED`). Two defects turned that ordering into a stall:
 *
 *  1. The engine proposed from the live seats alone and learned nothing from
 *     the refusal, which named nobody.
 *  2. The sweep's continuation cursor let the balance stage keep the manager
 *     for as long as each admission spent the whole work budget on the break,
 *     so the bust stage that would have unblocked it never ran.
 *
 * Production 2026-09-29 07:04-07:17 UTC: $100 Freeroll c65c414d (6 funded
 * players on 6 tables), $100 Freeroll cb8f2dd1 (26 on 26) and Morning Free Buy
 * 6a18ddaa held 6, 7 and 1 zero-chip `playing` players with no seat, none
 * recorded for over ten minutes; breaks 58d02750, 556f459a and f65919c7 had
 * refused `begin_refused:F06_WHOLE_ROSTER_REQUIRED`, and table c3294d1d of
 * $100 Freeroll 4dddfe78 held 3 live seats against 6 `playing` registrations.
 * See docs/changelog/2026-09-29-a-bust-is-recorded-before-the-break-it-blocks.md.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentSweepWorkCursor } from './TournamentSweepWorkCursor.js';
import { compareBreakSourceRoster } from './breakSourceRoster.js';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { TournamentManager } from './TournamentManager.js';
import { supabase } from '../services/supabase.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a refused movement admission yields to its own unrecorded bust', () => {
  function admission(error: any, rows: any[] | null, readError: any = null, loseOwner = false) {
    const m = manager();
    let current = true;
    m.tableBreakRpc = () => ({
      tableState: async () => ({ excluded: true, break_id: BREAK, lifecycle: '1' }),
      reconcile: async () => parked(),
    });
    vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error } as never);
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      lte: vi.fn(() => query),
      limit: vi.fn(async () => {
        if (readError instanceof Error) throw readError;
        if (loseOwner) current = false;
        return { data: rows, error: readError };
      }),
    };
    const read = vi.spyOn(supabase, 'from').mockReturnValue(query);
    const engine = { start: vi.fn(), installF06MovementAdmission: vi.fn() };
    m.eliminationSweepCursor.advanceTo(5);
    return {
      m,
      read,
      query,
      engine,
      run: () => m.startParkedMovementEngine(engine, SOURCE, '1', () => current),
    };
  }

  it.each(['F06_MOVEMENT_ELIMINATION_UNPROVEN', 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'])(
    '%s preserves the refusal and gives the original elimination stage its turn',
    async (message) => {
      const f = admission({ code: '55000', message }, [{ user_id: id(6) }]);
      await expect(f.run()).rejects.toThrow(message);
      expect(f.read).toHaveBeenCalledWith('tournament_players');
      expect(f.query.eq.mock.calls).toEqual([
        ['tournament_id', id(1)],
        ['table_id', SOURCE],
        ['status', 'playing'],
      ]);
      expect(f.query.lte).toHaveBeenCalledWith('chips', 0);
      expect(f.query.limit).toHaveBeenCalledWith(1);
      expect(f.m.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(0);
      expect(f.m.eliminationSweepNextStage).toBe(5);
      f.m.eliminationSweepCursor.beginAdmission();
      expect(f.m.eliminationSweepNextStage).toBe(0);
      expect(f.engine.start).not.toHaveBeenCalled();
      expect(f.engine.installF06MovementAdmission).not.toHaveBeenCalled();
    }
  );

  it.each([
    { rows: [], error: null, lost: false },
    { rows: null, error: { message: 'unreadable' }, lost: false },
    { rows: null, error: new Error('read transport failed'), lost: false },
    { rows: [{ user_id: id(6) }], error: null, lost: true },
  ])('unknown or stale evidence cannot rewind the cursor: %j', async (scenario) => {
    const f = admission(
      { code: '55000', message: 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' },
      scenario.rows,
      scenario.error,
      scenario.lost
    );
    await expect(f.run()).rejects.toThrow();
    f.m.eliminationSweepCursor.beginAdmission();
    expect(f.m.eliminationSweepNextStage).toBe(5);
    expect(f.m.requestUrgentEliminationSweepAfter).not.toHaveBeenCalled();
    expect(f.engine.start).not.toHaveBeenCalled();
  });

  it.each([
    { code: '57014', message: 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' },
    { code: '55000', message: 'F06_MOVEMENT_SEAT_CHANGED' },
    { code: '55000', message: 'F06_MOVEMENT_ELIMINATION_UNPROVEN_OTHER' },
  ])('other errors retain their refusal without inferring a bust: %j', async (error) => {
    const f = admission(error, [{ user_id: id(6) }]);
    await expect(f.run()).rejects.toThrow(error.message);
    expect(f.read).not.toHaveBeenCalled();
    f.m.eliminationSweepCursor.beginAdmission();
    expect(f.m.eliminationSweepNextStage).toBe(5);
    expect(f.m.requestUrgentEliminationSweepAfter).not.toHaveBeenCalled();
  });
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SOURCE = id(3);
const BREAK = id(2);

describe('the continuation cursor gives an earlier stage its turn back, never twice in a row', () => {
  it('applies a rewind at the next admission, not inside the running one', () => {
    const cursor = new TournamentSweepWorkCursor();
    cursor.advanceTo(5);
    cursor.rewindTo(0);
    expect(cursor.nextStage).toBe(5);
    cursor.beginAdmission();
    expect(cursor.nextStage).toBe(0);
    expect(cursor.interruptedStage).toBe(5);
  });

  it('the interrupted stage gets a fresh admission before a second rewind is applied', () => {
    const cursor = new TournamentSweepWorkCursor();
    cursor.advanceTo(5);
    cursor.rewindTo(0);
    cursor.beginAdmission(); // bust stage's turn
    cursor.advanceTo(1);
    cursor.advanceTo(2);
    cursor.rewindTo(0); // another bust while the rewound pass runs
    cursor.advanceTo(5); // the rewound pass reaches the balance stage and yields
    cursor.beginAdmission(); // balance stage's turn: the new rewind waits
    expect(cursor.nextStage).toBe(5);
    expect(cursor.interruptedStage).toBeNull();
    cursor.beginAdmission(); // then the bust stage again
    expect(cursor.nextStage).toBe(0);
  });

  it('a stage the rewound pass advanced past is served, so the next rewind applies at once', () => {
    const cursor = new TournamentSweepWorkCursor();
    cursor.advanceTo(5);
    cursor.rewindTo(0);
    cursor.beginAdmission();
    for (const stage of [1, 2, 3, 4, 5, 6, 7]) cursor.advanceTo(stage);
    cursor.rewindTo(0);
    cursor.beginAdmission();
    expect(cursor.nextStage).toBe(0);
  });

  it('never rewinds forward, and a completed cycle clears everything', () => {
    const cursor = new TournamentSweepWorkCursor();
    cursor.advanceTo(1);
    cursor.rewindTo(3);
    cursor.beginAdmission();
    expect(cursor.nextStage).toBe(1);
    cursor.advanceTo(5);
    cursor.rewindTo(0);
    cursor.reset();
    cursor.beginAdmission();
    expect(cursor.nextStage).toBe(0);
    expect(cursor.interruptedStage).toBeNull();
    cursor.advanceTo(5);
    cursor.beginAdmission();
    expect(cursor.nextStage).toBe(5);
  });

  /**
   * A STALLED STAGE STANDS IN FOR THE STAGE A REWIND INTERRUPTED (2026-10-26).
   *
   * Production 2026-10-26 02:40-02:44 UTC, Sunday Funday Mystery d5d373cb: a
   * rewind applied at 02:40:09 interrupted a stage AFTER the balancer, the
   * rewound pass climbed back to the balance stage and parked three tables
   * whose own busts were unrecorded, and every admission then yielded inside
   * that stage without advancing. The stage the rewind had interrupted could
   * not be reached while the balancer held the continuation, so the guard
   * never cleared and six busts' rewinds were held: the bust read did not run
   * once for 3m57s (edge logs, `status=eq.playing&chips=lte.0`), and 61 of the
   * night's 3,215 eliminations waited over a minute, 55 of them behind a break.
   */
  it('a stage that holds the continuation for a whole admission lets the next rewind apply', () => {
    const cursor = new TournamentSweepWorkCursor();
    cursor.advanceTo(7); // a tail stage holds the continuation
    cursor.rewindTo(0);
    cursor.beginAdmission(); // the bust stage's turn
    expect(cursor.nextStage).toBe(0);
    expect(cursor.interruptedStage).toBe(7);
    for (const stage of [1, 2, 3, 4, 5]) cursor.advanceTo(stage); // reaches the balancer, yields
    cursor.rewindTo(0); // a new bust while the balancer works its break
    cursor.beginAdmission(); // the balancer's fresh turn
    expect(cursor.nextStage).toBe(5);
    cursor.beginAdmission(); // it yielded again without advancing: it has had a whole admission
    expect(cursor.nextStage).toBe(5);
    cursor.beginAdmission(); // so the bust stage is served next, not after the break finishes
    expect(cursor.nextStage).toBe(0);
  });

  it('a pass that keeps advancing still reaches the interrupted stage before another rewind', () => {
    const cursor = new TournamentSweepWorkCursor();
    cursor.advanceTo(5);
    cursor.rewindTo(0);
    cursor.beginAdmission();
    cursor.advanceTo(2); // the rewound pass yields at stage 2
    cursor.rewindTo(0); // busts keep arriving
    for (const stage of [3, 4]) {
      cursor.beginAdmission(); // progress since the last admission: no stand-in
      expect(cursor.nextStage).toBe(stage - 1);
      cursor.advanceTo(stage);
    }
    cursor.beginAdmission();
    expect(cursor.nextStage).toBe(4);
    cursor.advanceTo(5); // the interrupted balancer is reached
    cursor.beginAdmission(); // and gets its admission
    expect(cursor.nextStage).toBe(5);
    cursor.beginAdmission(); // only then does the bust stage go again
    expect(cursor.nextStage).toBe(0);
  });

  it('refuses a nonsense stage', () => {
    const cursor = new TournamentSweepWorkCursor();
    cursor.advanceTo(4);
    cursor.rewindTo(-1);
    cursor.rewindTo(Number.NaN);
    cursor.beginAdmission();
    expect(cursor.nextStage).toBe(4);
  });
});

function balanceStageManager() {
  const manager = Object.create(TournamentManagerEliminations.prototype) as any;
  manager.recoveredOriginalAdmissions = new Map();
  Object.assign(manager, {
    tournamentId: 'aaaaaaaa-0000-4000-8000-000000000001',
    running: true,
    pendingManagerWakes: new Map(),
    pendingManagerWakeGenerations: new Map(),
    eliminationSweepCursor: new TournamentSweepWorkCursor(),
    resumeCommittedTerminalCleanup: vi.fn().mockResolvedValue(false),
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
    tableEngines: new Map(),
    refreshChipCapInputs: vi.fn().mockResolvedValue(undefined),
    recoverPendingBountyObligations: vi.fn().mockResolvedValue(true),
    checkFinalTableDeal: vi.fn().mockResolvedValue(true),
    checkSatelliteQualifierCompletion: vi.fn().mockResolvedValue('continue'),
    // The c65c414d shape: every balance admission spends the whole budget.
    checkTableBalance: vi.fn(async () => {
      vi.setSystemTime(Date.now() + TournamentManagerBase.SWEEP_WORK_BUDGET_MS + 1);
    }),
    checkDynamicTableExpansion: vi.fn().mockResolvedValue(true),
  });
  manager.eliminationSweepCursor.advanceTo(5);
  return manager;
}

/** A bust read the test can see; answering an error ends the pass there. */
function watchBustReads() {
  const bustRead = vi.fn().mockResolvedValue({ data: null, error: { message: 'bust stage' } });
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    lte: vi.fn((...args: unknown[]) => {
      query.answer = bustRead(...args);
      return query;
    }),
    order: () => query,
    limit: () => query,
    gt: () => query,
    then: (resolve: any, reject: any) => query.answer.then(resolve, reject),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(query as never);
  return bustRead;
}

describe('a bust is not held behind a balance stage that spends every budget', () => {
  it('without a bust, the balance stage keeps its continuation (unchanged)', async () => {
    vi.useFakeTimers();
    const manager = balanceStageManager();
    const bustRead = watchBustReads();
    await manager.runEliminationSweep(new AbortController().signal);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.checkTableBalance).toHaveBeenCalledTimes(2);
    expect(bustRead).not.toHaveBeenCalled();
    expect(manager.eliminationSweepCursor.nextStage).toBe(5);
  });

  it('a bust observed while balance holds the cursor is read on the very next admission', async () => {
    vi.useFakeTimers();
    const manager = balanceStageManager();
    const bustRead = watchBustReads();
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.checkTableBalance).toHaveBeenCalledTimes(1);

    manager.bustAwaitsItsStage(); // a hand just left a player at zero
    await manager.runEliminationSweep(new AbortController().signal);
    expect(bustRead).toHaveBeenCalledWith('chips', 0);
    expect(manager.recoverPendingBountyObligations).toHaveBeenCalledTimes(1);
    expect(manager.checkTableBalance).toHaveBeenCalledTimes(1);
  });

  it('busts arriving every admission still leave the balancer every other admission', async () => {
    vi.useFakeTimers();
    const manager = balanceStageManager();
    // The bust stage now completes and the pass yields on the budget before balance.
    const bustRead = vi.fn(async (..._args: unknown[]) => {
      vi.setSystemTime(Date.now() + TournamentManagerBase.SWEEP_WORK_BUDGET_MS + 1);
      return { data: [], error: null };
    });
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      lte: vi.fn((...args: unknown[]) => {
        query.answer = bustRead(...args);
        return query;
      }),
      order: () => query,
      limit: () => query,
      gt: () => query,
      then: (resolve: any, reject: any) => query.answer.then(resolve, reject),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(query as never);
    const order: string[] = [];
    manager.checkTableBalance.mockImplementation(async () => {
      order.push('balance');
      vi.setSystemTime(Date.now() + TournamentManagerBase.SWEEP_WORK_BUDGET_MS + 1);
    });
    bustRead.mockImplementation(async () => {
      order.push('bust');
      vi.setSystemTime(Date.now() + TournamentManagerBase.SWEEP_WORK_BUDGET_MS + 1);
      return { data: [], error: null };
    });
    for (let admission = 0; admission < 8; admission++) {
      manager.bustAwaitsItsStage();
      await manager.runEliminationSweep(new AbortController().signal);
    }
    expect(order.filter((stage) => stage === 'balance').length).toBeGreaterThanOrEqual(2);
    expect(order.filter((stage) => stage === 'bust').length).toBeGreaterThanOrEqual(2);
  });

  it('the hand-complete wake asks for the bust stage before it wakes the sweep', async () => {
    const { readFileSync } = await import('node:fs');
    const base = readFileSync(new URL('./TournamentManagerBase.ts', import.meta.url), 'utf8');
    const wake = base.slice(base.indexOf('protected wireEliminationWake'));
    const zero = wake.slice(
      wake.indexOf('Number(player.stack) <= 0'),
      wake.indexOf('onPauseReady')
    );
    expect(zero.indexOf('this.bustAwaitsItsStage();')).toBeGreaterThan(0);
    expect(zero.indexOf('this.bustAwaitsItsStage();')).toBeLessThan(
      zero.indexOf('this.requestEliminationSweep();')
    );
  });
});

const seat = (user: number, chair: number, stack = 100) => ({
  id: id(user + 100),
  user_id: id(user),
  seat_number: chair,
  stack,
  occupancy_id: id(user + 200),
});
const registration = (user: number, chair: number, chips: number, status = 'playing') => ({
  user_id: id(user),
  status,
  chips,
  seat_number: chair,
});

describe('the proposal counts the people the door counts', () => {
  it('agreement is no disagreement', () => {
    expect(
      compareBreakSourceRoster(
        [seat(4, 1), seat(5, 2)],
        [registration(4, 1, 100), registration(5, 2, 100.4)]
      )
    ).toBeNull();
  });

  it('the c65c414d shape: a zero-chip playing registration with no seat is a bust not yet recorded', () => {
    const result = compareBreakSourceRoster(
      [seat(4, 1), seat(5, 3)],
      [registration(4, 1, 100), registration(5, 3, 100), registration(6, 2, 0)]
    );
    expect(result?.unrecordedBusts).toEqual([id(6)]);
    expect(result?.conflicts).toEqual({});
    expect(result?.reason).toBe(`source_roster_disagrees:bust_unrecorded=${id(6).slice(0, 8)}`);
  });

  it.each([
    [
      'registration_without_seat',
      [seat(4, 1)],
      [registration(4, 1, 100), registration(5, 2, 250)],
      5,
    ],
    [
      'registration_without_seat',
      [seat(4, 1)],
      [registration(4, 1, 100), registration(5, 2, 0, 'registered')],
      5,
    ],
    ['seat_without_registration', [seat(4, 1), seat(5, 2)], [registration(4, 1, 100)], 5],
    ['seat_registration_differ', [seat(4, 1)], [registration(4, 1, 99)], 4],
    ['seat_registration_differ', [seat(4, 1)], [registration(4, 2, 100)], 4],
    ['seat_registration_differ', [seat(4, 1)], [registration(4, 1, 100, 'registered')], 4],
    ['seat_repeated', [seat(4, 1), seat(4, 2)], [registration(4, 1, 100)], 4],
  ])('a real disagreement stays a refusal and is named: %s', (kind, seats, registrations, user) => {
    const result = compareBreakSourceRoster(seats as any, registrations as any);
    expect(result?.unrecordedBusts).toEqual([]);
    expect(result?.conflicts[kind]).toContain(id(user));
    expect(result?.reason).toContain(`${kind}=`);
  });
});

function manager() {
  const m: any = new TournamentManager(id(1), {} as any, id(9), performance.now() + 60000);
  m.running = true;
  m.eliminationSweepDeadlineAt = 0;
  m.requestUrgentEliminationSweepAfter = vi.fn();
  return m;
}
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

function source(m: any, seats: any[], registrations: any[]) {
  const engine = { parkForTournamentMove: vi.fn(async () => true) };
  m.tableEngines.set(SOURCE, engine);
  m.gameServer.ownsTournamentTableEngine = () => true;
  m.eligibleBreakDestinations = vi.fn(async () => [
    { tableId: id(8), playerCount: 2, maxSeats: 10, players: [] },
  ]);
  m.tableBalancer.breakTable = vi.fn((s: any) =>
    s.players.map((p: any, i: number) => ({ playerId: p.userId, toTableId: id(8), toSeat: 3 + i }))
  );
  const tables: string[] = [];
  const query: any = {
    select: () => query,
    eq: () => query,
    is: async () => ({ data: seats, error: null }),
    in: async () => ({ data: registrations, error: null }),
  };
  vi.spyOn(supabase, 'from').mockImplementation(((table: string) => {
    tables.push(table);
    return query;
  }) as any);
  return tables;
}

describe('a break whose source still holds an unrecorded bust asks for the bust stage', () => {
  it('refuses before the door, names the busted player, and rewinds the sweep', async () => {
    const m = manager();
    const tables = source(m, [seat(4, 1)], [registration(4, 1, 100), registration(6, 2, 0)]);
    m.eliminationSweepCursor.advanceTo(5);
    const rpc = vi.spyOn(supabase, 'rpc');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await m.prepareParkedTournamentBreak(parked())).toBeNull();
    expect(tables).toEqual(['table_seats', 'tournament_players']);
    expect(rpc).not.toHaveBeenCalled();
    expect(m.lastBreakPreparationRefusal(BREAK)).toBe(
      `source_roster_disagrees:bust_unrecorded=${id(6).slice(0, 8)}`
    );
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(0);
    m.eliminationSweepCursor.beginAdmission();
    expect(m.eliminationSweepCursor.nextStage).toBe(0);
  });

  it('a real disagreement is refused by name without rewinding the sweep', async () => {
    const m = manager();
    source(m, [seat(4, 1)], [registration(4, 1, 100), registration(5, 2, 300)]);
    m.eliminationSweepCursor.advanceTo(5);
    const rpc = vi.spyOn(supabase, 'rpc');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await m.prepareParkedTournamentBreak(parked())).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(m.lastBreakPreparationRefusal(BREAK)).toBe(
      `source_roster_disagrees:registration_without_seat=${id(5).slice(0, 8)}`
    );
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(
      TournamentManagerBase.BALANCE_REDRIVE_MS
    );
    m.eliminationSweepCursor.beginAdmission();
    expect(m.eliminationSweepCursor.nextStage).toBe(5);
  });

  it('an unreadable registration list is not agreement', async () => {
    const m = manager();
    source(m, [seat(4, 1)], []);
    const query: any = {
      select: () => query,
      eq: () => query,
      is: async () => ({ data: [seat(4, 1)], error: null }),
      in: async () => ({ data: null, error: { message: 'statement timeout' } }),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(query);
    const rpc = vi.spyOn(supabase, 'rpc');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await m.prepareParkedTournamentBreak(parked())).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(m.lastBreakPreparationRefusal(BREAK)).toBe(
      'source_registrations_unread:statement timeout'
    );
  });

  it('once the bust is recorded the same break begins with the one live player', async () => {
    const m = manager();
    source(m, [seat(4, 1)], [registration(4, 1, 100)]);
    const begins: any[] = [];
    vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
      if (name === 'fn_f06_break_state') return { data: parked(), error: null };
      begins.push(p.p_members);
      return {
        data: {
          ...parked(),
          state: 'begun',
          members: p.p_members.map((x: any) => ({
            ...x,
            original_destination_table_id: x.destination_table_id,
            original_destination_seat_number: x.destination_seat_number,
            active_request_id: x.request_id,
            winner_request_id: null,
            winning_receipt: null,
            attempt_revision: 1,
          })),
        },
        error: null,
      };
    }) as any);
    const result = await m.prepareParkedTournamentBreak(parked());
    expect(result.state).toBe('begun');
    expect(begins).toHaveLength(1);
    expect(begins[0].map((x: any) => x.user_id)).toEqual([id(4)]);
  });
});

// October 23 Coffee Break sources, represented by eleven independent hand
// callbacks. The manager/cursor/stage execution is real; transport and the
// financial write are isolated (the PostgreSQL suites own their proof).
describe('every table records busts behind a blocked later-stage rewind', () => {
  it.each([6, 7, 8])(
    'serves eleven sources before interrupted stage %i can advance',
    async (stage) => {
      vi.useFakeTimers();
      const m = balanceStageManager();
      const pending = new Set<string>();
      const placed = new Map<string, number>();
      const callbacks: Array<(id: string, stacks: any[]) => void> = [];
      Object.assign(m, {
        tournamentCache: { tournament_type: 'MTT', variant: 'plo4', is_rebuy: false },
        bustRefusalStreak: new Map(),
        isCohortSatellite: () => false,
        mysteryActivationMayOpenOnBust: () => false,
        declareFieldDecidedIfOneStackRemains: vi.fn(),
        horseRebuyOfferMayHaveOpened: vi.fn(),
        tryTournamentRebuys: vi.fn(async () => ({ rebought: new Set(), deferredUntil: new Map() })),
        eliminatePlayer: vi.fn(async (uid: string, position: number) => {
          expect(pending.has(uid)).toBe(true);
          expect(placed.has(uid)).toBe(false);
          pending.delete(uid);
          placed.set(uid, position);
          return true;
        }),
        finishTournament: vi.fn(),
        gameServer: { handTournamentToSuccessorGeneration: vi.fn() },
      });
      for (let i = 0; i < 11; i++) {
        const engine = {
          onHandComplete: (callback: (id: string, stacks: any[]) => void) =>
            callbacks.push(callback),
          onPauseReady: vi.fn(),
          onRestartRequired: vi.fn(),
        };
        m.tableEngines.set(id(i + 20), engine);
        m.wireEliminationWake(engine);
      }
      vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
        let columns = '';
        let head = false;
        const q: any = {
          select: (s: string, o?: { head?: boolean }) => {
            columns = s;
            head = o?.head === true;
            return q;
          },
          eq: () => q,
          lte: () => q,
          in: () => q,
          is: () => q,
          not: () => q,
          order: () => q,
          limit: () => q,
          gt: () => q,
          then: (resolve: (answer: unknown) => unknown, reject: (error: unknown) => unknown) => {
            let data: unknown = null;
            let count: number | null = null;
            if (table === 'tournament_players') {
              if (head) count = 100 - placed.size;
              else if (columns === 'id, user_id, chips')
                data = [...pending].map((user_id) => ({ user_id, chips: 0 }));
              else if (columns === 'id, position')
                data = [...placed.values()].map((position) => ({ position }));
              else throw new Error(`Unexpected player read: ${columns}`);
            } else if (table === 'tournament_knockout_candidates') {
              data = [...pending].map((uid) => ({
                id: uid,
                eliminated_user_id: uid,
                hand_number: 1,
                stack_before: 100,
                state: 'pending',
              }));
              count = pending.size;
            } else throw new Error(`Unexpected table: ${table}`);
            return Promise.resolve({ data, count, error: null }).then(resolve, reject);
          },
        };
        return q;
      });
      vi.spyOn(supabase, 'rpc').mockImplementation((name: string) => {
        if (name !== 'fn_open_tournament_rebuy_decisions')
          throw new Error(`Unexpected RPC: ${name}`);
        return Promise.resolve({
          data: [...pending].map((user_id) => ({ user_id, decision_open: false })),
          error: null,
        }) as any;
      });
      m.eliminationSweepCursor.advanceTo(stage);
      for (let source = 0; source < 11; source++) {
        const uid = id(source + 40);
        pending.add(uid);
        callbacks[source](id(source + 20), [{ userId: uid, stack: 0 }]);
        // No maintenance, manager replacement or break expiry: a fresh hand
        // callback must get its own elimination stage within bounded admissions.
        for (let pass = 0; pass < 4 && pending.size; pass++)
          await m.runEliminationSweep(new AbortController().signal);
        expect(placed.size, `source ${source} waits for the break it blocks`).toBe(source + 1);
        expect(pending.size).toBe(0);
      }
      expect(m.eliminatePlayer).toHaveBeenCalledTimes(11);
      expect(new Set(placed.values()).size).toBe(11);
      expect(Math.min(...placed.values())).toBeGreaterThan(1);
      expect(m.checkTableBalance.mock.calls.length).toBeGreaterThanOrEqual(10);
      expect(m.gameServer.handTournamentToSuccessorGeneration).not.toHaveBeenCalled();
      expect(m.finishTournament).not.toHaveBeenCalled();
    }
  );
});
