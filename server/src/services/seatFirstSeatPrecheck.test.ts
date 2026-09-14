/**
 * A SEAT THE HORSE ALREADY HOLDS IS NOT A CALL WORTH QUEUEING FOR.
 *
 * fn_seat_horse_in_seat_first_game takes the platform-wide EXCLUSIVE advisory
 * lock ('ca:tournament-terminal-settlement:v1') before it reads a row, and
 * every hand settlement holds that lock SHARED for its whole commit. Measured
 * 2026-09-10 03:05-03:40 UTC (pg_stat_statements, 2XL box):
 *
 *     1,533 calls   mean 590 ms   min 2.4 ms   max 5,889 ms   572 blocks/call
 *     pg_stat_activity at 100 ms: 100 of 110 samples in a Lock wait
 *     at most 579 seats for those 1,533 calls  ->  >= 60% answered
 *     already_seated / table_full / not seatable, after taking the lock
 *
 * The lock cannot be narrowed on the database side. The fix is on this side:
 * topUpWithHorses keeps the seat rows it already reads for the shortfall and
 * skips the RPC for a horse those rows show seated and for a table they show
 * full. The RPC stays the authority for everybody else and is called with the
 * SAME arguments as before. Horses are players (CLAUDE.md 10.5): no horse that
 * needs a seat loses one here - only calls whose answer was already known.
 *
 * AND A SKIP IS VERIFIED BEFORE IT IS TAKEN (follow-up to #4112). The rows
 * behind the ledger age by one locked call per candidate, so a skip is only
 * taken after a lock-free re-read of the same rows still supports it. A stale
 * row - a horse that left, a seat that opened after the RPC said table_full -
 * falls through to the RPC on THIS pass, exactly as before the pre-check
 * existed. The per-pass tally is also folded into /metrics
 * (poker_seat_first_precheck_total) so the saving is visible without log access.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rpcMock = vi.fn();
type TableAnswer = { data: unknown; error: { message: string } | null };
/**
 * Per-table results for the chainable query builder, keyed by table name. A
 * function is called once per query with the number of queries that table has
 * already answered, so a re-read can see the world move.
 */
let tableResults: Record<string, TableAnswer | ((n: number) => TableAnswer)> = {};
const tableReads: Record<string, number> = {};

vi.mock('./supabase/client.js', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'limit', 'order', 'neq', 'not', 'update']) {
      b[m] = () => b;
    }
    const answer = () => {
      const n = tableReads[table] ?? 0;
      tableReads[table] = n + 1;
      const r = tableResults[table];
      return Promise.resolve(
        (typeof r === 'function' ? r(n) : r) ?? {
          data: null,
          error: { message: `no mock for ${table}` },
        }
      );
    };
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
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

import {
  TournamentRecurringService,
  seatFirstLedgerRefresh,
  seatFirstNoteSeated,
  seatFirstNoteTableFull,
  seatFirstPrecheckLogLine,
  seatFirstSeatLedger,
  seatFirstSeatPrecheck,
} from './TournamentRecurringService.js';
import {
  SEAT_FIRST_PRECHECK_OUTCOMES,
  emptySeatFirstPrecheckTally,
  recordSeatFirstPrecheck,
  resetSeatFirstPrecheckTotalsForTests,
  seatFirstPrecheckPrometheusLines,
  seatFirstPrecheckTotals,
} from './seatFirstPrecheckMetrics.js';

const SRC = readFileSync(join(__dirname, 'TournamentRecurringService.ts'), 'utf8');

function topUpBody(): string {
  const start = SRC.indexOf('async topUpWithHorses(');
  expect(start, 'topUpWithHorses must still exist').toBeGreaterThan(-1);
  const next = SRC.indexOf('\n  private async ', start);
  return SRC.slice(start, next > -1 ? next : SRC.length);
}

function seatingLoopBody(): string {
  const body = topUpBody();
  const start = body.indexOf('for (const horse of candidates)');
  expect(start, 'the seating loop must still exist').toBeGreaterThan(-1);
  // The loop ends where the pass's log line begins. seatFirstFillOrder.test.ts
  // slices the same loop up to the first `} else {`, so the loop body must
  // not grow one: the verifying re-read is written without an else.
  const end = body.indexOf('seatFirstPrecheckLogLine(tournamentId, tally)', start);
  return body.slice(start, end > -1 ? end : body.length);
}

describe('seatFirstSeatLedger - the RPC conditions, read without the lock', () => {
  it('names the seated horses and the taken seat numbers from the live rows', () => {
    const l = seatFirstSeatLedger(
      [
        { user_id: 'h1', seat_number: 1 },
        { user_id: 'h2', seat_number: 3 },
      ],
      3,
      3
    );
    expect([...l.seatedUsers].sort()).toEqual(['h1', 'h2']);
    expect([...l.occupiedSeats].sort()).toEqual([1, 3]);
    expect(l.capacity).toBe(3);
    expect(l.rpcSaidFull).toBe(false);
  });

  it('uses the capacity expression the RPC uses: COALESCE(NULLIF(tables.max_players, 0), tournaments.max_players, 3)', () => {
    expect(seatFirstSeatLedger([], 6, 3).capacity).toBe(6);
    expect(seatFirstSeatLedger([], 0, 2).capacity).toBe(2);
    expect(seatFirstSeatLedger([], null, 2).capacity).toBe(2);
    expect(seatFirstSeatLedger([], null, null).capacity).toBe(3);
    expect(seatFirstSeatLedger([], 0, undefined).capacity).toBe(3);
  });

  it('an unreadable table row is UNKNOWN capacity, which never skips a call', () => {
    const l = seatFirstSeatLedger([{ user_id: 'h1', seat_number: 1 }], undefined, 1);
    expect(l.capacity).toBeNull();
    expect(seatFirstSeatPrecheck(l, 'h2')).toBe('call');
  });

  it('ignores rows without a usable id or seat number', () => {
    const l = seatFirstSeatLedger([{ user_id: null, seat_number: 0 }, {}, null as never], 3, 3);
    expect(l.seatedUsers.size).toBe(0);
    expect(l.occupiedSeats.size).toBe(0);
  });
});

describe('seatFirstSeatPrecheck - exactly the two answers the RPC gives without seating', () => {
  const ledger = () =>
    seatFirstSeatLedger(
      [
        { user_id: 'seated-a', seat_number: 1 },
        { user_id: 'seated-b', seat_number: 2 },
      ],
      3,
      3
    );

  it('a horse the rows show seated is already_seated', () => {
    expect(seatFirstSeatPrecheck(ledger(), 'seated-a')).toBe('already_seated');
  });

  it('a horse the rows do not show seated, at a table with a free seat, goes to the RPC', () => {
    expect(seatFirstSeatPrecheck(ledger(), 'free-horse')).toBe('call');
  });

  it('a table with no free seat number in 1..capacity is table_full', () => {
    const l = ledger();
    seatFirstNoteSeated(l, 'seated-c', 3);
    expect(seatFirstSeatPrecheck(l, 'free-horse')).toBe('table_full');
  });

  it('a seated horse at a full table reads already_seated, in the order the RPC checks', () => {
    const l = ledger();
    seatFirstNoteSeated(l, 'seated-c', 3);
    expect(seatFirstSeatPrecheck(l, 'seated-a')).toBe('already_seated');
  });

  it('a seat number outside 1..capacity does not make the table full', () => {
    const l = seatFirstSeatLedger([{ user_id: 'x', seat_number: 7 }], 2, 2);
    expect(seatFirstSeatPrecheck(l, 'free-horse')).toBe('call');
  });

  it('a seat granted by the RPC this pass is remembered for the rest of it', () => {
    const l = seatFirstSeatLedger([], 2, 2);
    seatFirstNoteSeated(l, 'h1', 1);
    expect(seatFirstSeatPrecheck(l, 'h1')).toBe('already_seated');
    expect(seatFirstSeatPrecheck(l, 'h2')).toBe('call');
    seatFirstNoteSeated(l, 'h2', 2);
    expect(seatFirstSeatPrecheck(l, 'h3')).toBe('table_full');
  });

  it('once the RPC has answered table_full, the rest of the pass believes it', () => {
    const l = seatFirstSeatLedger([], 3, 3);
    expect(seatFirstSeatPrecheck(l, 'h1')).toBe('call');
    seatFirstNoteTableFull(l);
    expect(seatFirstSeatPrecheck(l, 'h1')).toBe('table_full');
    expect(seatFirstSeatPrecheck(l, 'h2')).toBe('table_full');
  });

  it('never looks at whether the id is a horse - the seat rows are the only input', () => {
    const fn = SRC.slice(
      SRC.indexOf('export function seatFirstSeatLedger('),
      SRC.indexOf('export function seatFirstPrecheckLogLine(')
    );
    expect(fn).not.toMatch(/is_horse/);
  });
});

describe('seatFirstLedgerRefresh - fresh rows replace the ledger before a skip is taken', () => {
  it('a horse the fresh rows no longer show seated goes back to the RPC', () => {
    const l = seatFirstSeatLedger([{ user_id: 'h1', seat_number: 1 }], 3, 3);
    expect(seatFirstSeatPrecheck(l, 'h1')).toBe('already_seated');
    seatFirstLedgerRefresh(l, []);
    expect(seatFirstSeatPrecheck(l, 'h1')).toBe('call');
  });

  it('a seat the fresh rows show open reopens a table the RPC had called full', () => {
    const l = seatFirstSeatLedger(
      [
        { user_id: 'a', seat_number: 1 },
        { user_id: 'b', seat_number: 2 },
      ],
      3,
      3
    );
    seatFirstNoteTableFull(l);
    expect(seatFirstSeatPrecheck(l, 'h')).toBe('table_full');
    seatFirstLedgerRefresh(l, [
      { user_id: 'a', seat_number: 1 },
      { user_id: 'b', seat_number: 2 },
    ]);
    expect(l.rpcSaidFull).toBe(false);
    expect(seatFirstSeatPrecheck(l, 'h')).toBe('call');
  });

  it('fresh rows that still fill 1..capacity keep the skip', () => {
    const l = seatFirstSeatLedger([], 2, 2);
    seatFirstNoteTableFull(l);
    seatFirstLedgerRefresh(l, [
      { user_id: 'a', seat_number: 1 },
      { user_id: 'b', seat_number: 2 },
    ]);
    expect(seatFirstSeatPrecheck(l, 'h')).toBe('table_full');
  });

  it("with the capacity unknown the RPC's table_full stands - the rows cannot say otherwise", () => {
    const l = seatFirstSeatLedger([], undefined, 3);
    expect(l.capacity).toBeNull();
    seatFirstNoteTableFull(l);
    seatFirstLedgerRefresh(l, []);
    expect(l.rpcSaidFull).toBe(true);
    expect(seatFirstSeatPrecheck(l, 'h')).toBe('table_full');
  });

  it('keeps the capacity it was built with', () => {
    const l = seatFirstSeatLedger([], 6, 3);
    seatFirstLedgerRefresh(l, [{ user_id: 'a', seat_number: 1 }]);
    expect(l.capacity).toBe(6);
    expect([...l.seatedUsers]).toEqual(['a']);
  });
});

describe('poker_seat_first_precheck_total - the same numbers on /metrics', () => {
  beforeEach(() => resetSeatFirstPrecheckTotalsForTests());

  it('exposes every outcome from the first scrape, at zero', () => {
    const lines = seatFirstPrecheckPrometheusLines();
    expect(lines[0]).toMatch(/^# HELP poker_seat_first_precheck_total /);
    expect(lines[1]).toBe('# TYPE poker_seat_first_precheck_total counter');
    for (const k of SEAT_FIRST_PRECHECK_OUTCOMES) {
      expect(lines).toContain(`poker_seat_first_precheck_total{outcome="${k}"} 0`);
    }
    expect(SEAT_FIRST_PRECHECK_OUTCOMES).toEqual(
      expect.arrayContaining(['rpc_called', 'skipped_already_seated', 'skipped_table_full'])
    );
  });

  it('accumulates one pass after another and never goes down', () => {
    const t = emptySeatFirstPrecheckTally();
    t.rpcCalled = 2;
    t.skippedAlreadySeated = 3;
    t.skippedTableFull = 1;
    t.verifyReads = 4;
    t.seated = 2;
    recordSeatFirstPrecheck(t);
    recordSeatFirstPrecheck(t);
    const totals = seatFirstPrecheckTotals();
    expect(totals.rpc_called).toBe(4);
    expect(totals.skipped_already_seated).toBe(6);
    expect(totals.skipped_table_full).toBe(2);
    expect(totals.verify_reads).toBe(8);
    expect(totals.seated).toBe(4);
    expect(totals.rpc_table_full).toBe(0);
    expect(seatFirstPrecheckPrometheusLines()).toContain(
      'poker_seat_first_precheck_total{outcome="skipped_already_seated"} 6'
    );
  });

  it('is rendered by GameServer.getPrometheusMetrics, the always-on exposition', () => {
    const gameServer = readFileSync(join(__dirname, '..', 'GameServer.ts'), 'utf8');
    expect(gameServer).toContain('...seatFirstPrecheckPrometheusLines()');
    expect(gameServer).toMatch(
      /import \{ seatFirstPrecheckPrometheusLines \} from '\.\/services\/seatFirstPrecheckMetrics\.js';/
    );
  });
});

describe('seatFirstPrecheckLogLine - the grep-able evidence', () => {
  it('carries every counter under a stable prefix', () => {
    const line = seatFirstPrecheckLogLine('0123456789abcdef', {
      rpcCalled: 2,
      skippedAlreadySeated: 3,
      skippedTableFull: 1,
      verifyReads: 4,
      seated: 1,
      rpcAlreadySeated: 0,
      rpcTableFull: 1,
      rpcRefused: 0,
      rpcOtherNoop: 0,
    });
    expect(line).toContain('seat-first-precheck 01234567:');
    expect(line).toContain('rpc_called=2');
    expect(line).toContain('skipped_already_seated=3');
    expect(line).toContain('skipped_table_full=1');
    expect(line).toContain('verify_reads=4');
    expect(line).toContain('rpc_table_full=1');
    // Ids only: the line carries no name, no wallet, no email.
    expect(line).not.toMatch(/@|name=|wallet/);
  });
});

/**
 * The wiring, run for real: topUpWithHorses against a mocked client, with the
 * two candidate pickers stubbed so the pass is about the seating loop alone.
 */
describe('topUpWithHorses - the pre-check in front of the RPC', () => {
  const T = 'aaaaaaaa-0000-4000-8000-000000000001';
  const TABLE = 'bbbbbbbb-0000-4000-8000-000000000001';
  let svc: TournamentRecurringService;
  let logSpy: MockInstance<typeof console.log>;

  function seatRows(rows: Array<{ user_id: string; seat_number: number }>): void {
    tableResults = {
      tournaments: { data: { variant: 'spin', max_players: 3, club_id: 'club' }, error: null },
      table_seats: { data: rows, error: null },
      tables: { data: { max_players: 3 }, error: null },
    };
  }

  function candidates(own: string[], pool: string[]): void {
    vi.spyOn(
      svc as unknown as { unseatedRegistrantHorses: () => Promise<string[]> },
      'unseatedRegistrantHorses'
    ).mockResolvedValue(own);
    vi.spyOn(
      svc as unknown as { pickFreeHorses: () => Promise<string[]> },
      'pickFreeHorses'
    ).mockResolvedValue(pool);
  }

  const seatCalls = () =>
    rpcMock.mock.calls
      .filter((c) => c[0] === 'fn_seat_horse_in_seat_first_game')
      .map((c) => c[1] as { p_tournament_id: string; p_user_id: string });

  beforeEach(() => {
    for (const k of Object.keys(tableReads)) delete tableReads[k];
    resetSeatFirstPrecheckTotalsForTests();
    rpcMock.mockReset();
    rpcMock.mockImplementation(async (name: string, args: { p_user_id?: string }) => {
      if (name === 'fn_tournament_primary_table') return { data: TABLE, error: null };
      if (name === 'fn_seat_horse_in_seat_first_game') {
        return { data: { ok: true, table_id: TABLE, seat_number: 3, seats_taken: 3 }, error: null };
      }
      return { data: null, error: null };
    });
    svc = new TournamentRecurringService();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a horse the seat rows show seated is never sent to the RPC', async () => {
    seatRows([
      { user_id: 'seated-a', seat_number: 1 },
      { user_id: 'seated-b', seat_number: 2 },
    ]);
    // The pool routinely draws a horse already sitting at this very table:
    // pickFreeHorses excludes only the four-game cap, not this game.
    candidates([], ['seated-a', 'seated-b', 'free-1']);
    const added = await svc.topUpWithHorses(T, 3);
    expect(seatCalls()).toEqual([{ p_tournament_id: T, p_user_id: 'free-1' }]);
    expect(added).toBe(1);
    const line = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('seat-first-precheck'));
    expect(line).toContain('rpc_called=1');
    expect(line).toContain('skipped_already_seated=2');
    expect(line).toContain('verify_reads=2');
    expect(line).toContain('seated=1');
    // One initial read for the shortfall, one verifying re-read per skip.
    expect(tableReads.table_seats).toBe(3);
    const totals = seatFirstPrecheckTotals();
    expect(totals.rpc_called).toBe(1);
    expect(totals.skipped_already_seated).toBe(2);
    expect(totals.seated).toBe(1);
  });

  it('a horse that left its seat between the read and its turn is NOT skipped - it goes to the RPC this pass', async () => {
    // The rows at the shortfall read show seated-a in seat 1; by the time the
    // loop reaches seated-a it has stood up. Before the pre-check existed the
    // RPC seated it here; the pre-check must not turn that into a five-second
    // wait. Horses are players (CLAUDE.md 10.5).
    seatRows([
      { user_id: 'seated-a', seat_number: 1 },
      { user_id: 'seated-b', seat_number: 2 },
    ]);
    tableResults.table_seats = (n) =>
      n === 0
        ? {
            data: [
              { user_id: 'seated-a', seat_number: 1 },
              { user_id: 'seated-b', seat_number: 2 },
            ],
            error: null,
          }
        : { data: [{ user_id: 'seated-b', seat_number: 2 }], error: null };
    candidates([], ['seated-a', 'free-1', 'free-2']);
    const added = await svc.topUpWithHorses(T, 3);
    expect(seatCalls().map((c) => c.p_user_id)).toEqual(['seated-a']);
    expect(added).toBe(1);
    const line = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('seat-first-precheck'));
    expect(line).toContain('skipped_already_seated=0');
    expect(line).toContain('verify_reads=1');
  });

  it('a skip is only ever taken on rows fresher than the answer: the loop re-reads before it skips', async () => {
    seatRows([
      { user_id: 'seated-a', seat_number: 1 },
      { user_id: 'seated-b', seat_number: 2 },
    ]);
    candidates([], ['seated-a', 'free-1']);
    await svc.topUpWithHorses(T, 3);
    // Shortfall read, then the verifying read for seated-a; free-1 needs none.
    expect(tableReads.table_seats).toBe(2);
    expect(seatCalls().map((c) => c.p_user_id)).toEqual(['free-1']);
  });

  it('when the verifying re-read fails, nothing is skipped - the RPC decides', async () => {
    seatRows([
      { user_id: 'seated-a', seat_number: 1 },
      { user_id: 'seated-b', seat_number: 2 },
    ]);
    tableResults.table_seats = (n) =>
      n === 0
        ? {
            data: [
              { user_id: 'seated-a', seat_number: 1 },
              { user_id: 'seated-b', seat_number: 2 },
            ],
            error: null,
          }
        : { data: null, error: { message: 'connection reset' } };
    rpcMock.mockImplementation(async (name: string, args: { p_user_id?: string }) => {
      if (name === 'fn_tournament_primary_table') return { data: TABLE, error: null };
      if (args?.p_user_id === 'seated-a')
        return { data: { ok: true, already_seated: true }, error: null };
      return { data: { ok: true, seat_number: 3 }, error: null };
    });
    candidates([], ['seated-a', 'free-1']);
    const added = await svc.topUpWithHorses(T, 3);
    expect(seatCalls().map((c) => c.p_user_id)).toEqual(['seated-a', 'free-1']);
    expect(added).toBe(1);
  });

  it('an unseated horse goes through the same RPC with the same arguments as before', async () => {
    seatRows([{ user_id: 'seated-a', seat_number: 1 }]);
    candidates(['own-1'], ['free-1', 'free-2']);
    const added = await svc.topUpWithHorses(T, 3);
    // Two seats short: the first two candidates are seated, the third is spare.
    expect(seatCalls()).toEqual([
      { p_tournament_id: T, p_user_id: 'own-1' },
      { p_tournament_id: T, p_user_id: 'free-1' },
    ]);
    expect(added).toBe(2);
  });

  it('a table the rows show full gets no call at all', async () => {
    // Three seats taken at a three-seat table while the caller asks for four:
    // the RPC would say table_full for every candidate, after the lock.
    tableResults = {
      tournaments: { data: { variant: 'spin', max_players: 4, club_id: 'club' }, error: null },
      table_seats: {
        data: [
          { user_id: 'a', seat_number: 1 },
          { user_id: 'b', seat_number: 2 },
          { user_id: 'c', seat_number: 3 },
        ],
        error: null,
      },
      tables: { data: { max_players: 3 }, error: null },
    };
    candidates([], ['free-1', 'free-2', 'free-3']);
    const added = await svc.topUpWithHorses(T, 4);
    expect(seatCalls()).toEqual([]);
    expect(added).toBe(0);
    const line = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('seat-first-precheck'));
    expect(line).toContain('rpc_called=0');
    expect(line).toContain('skipped_table_full=3');
  });

  it('when the table row is unreadable every candidate still goes to the RPC', async () => {
    seatRows([
      { user_id: 'a', seat_number: 1 },
      { user_id: 'b', seat_number: 2 },
      { user_id: 'c', seat_number: 3 },
    ]);
    tableResults.tables = { data: null, error: { message: 'boom' } };
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'fn_tournament_primary_table') return { data: TABLE, error: null };
      return { data: { ok: false, reason: 'table_full' }, error: null };
    });
    candidates([], ['free-1']);
    await svc.topUpWithHorses(T, 4);
    // Unknown is not "full": the call is made and the RPC decides.
    expect(seatCalls()).toEqual([{ p_tournament_id: T, p_user_id: 'free-1' }]);
  });

  it('once the RPC answers table_full, the spare candidates do not queue for the same answer', async () => {
    // Another seeder took seat 3 on the same tick: the shortfall read saw two
    // seats, the RPC says full, and the verifying re-read agrees.
    seatRows([
      { user_id: 'a', seat_number: 1 },
      { user_id: 'b', seat_number: 2 },
    ]);
    tableResults.table_seats = (n) =>
      n === 0
        ? {
            data: [
              { user_id: 'a', seat_number: 1 },
              { user_id: 'b', seat_number: 2 },
            ],
            error: null,
          }
        : {
            data: [
              { user_id: 'a', seat_number: 1 },
              { user_id: 'b', seat_number: 2 },
              { user_id: 'c', seat_number: 3 },
            ],
            error: null,
          };
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'fn_tournament_primary_table') return { data: TABLE, error: null };
      return { data: { ok: false, reason: 'table_full' }, error: null };
    });
    candidates([], ['free-1', 'free-2', 'free-3']);
    const added = await svc.topUpWithHorses(T, 3);
    expect(seatCalls()).toEqual([{ p_tournament_id: T, p_user_id: 'free-1' }]);
    expect(added).toBe(0);
    const line = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('seat-first-precheck'));
    expect(line).toContain('skipped_table_full=2');
    expect(line).toContain('rpc_table_full=1');
  });

  it('a seat that opens after the RPC said table_full is filled on THIS pass, not the next', async () => {
    // free-1 hears table_full; then b stands up. The verifying re-read for
    // free-2 sees seat 2 open, so free-2 goes to the RPC and takes it.
    seatRows([
      { user_id: 'a', seat_number: 1 },
      { user_id: 'b', seat_number: 2 },
    ]);
    tableResults.table_seats = (n) =>
      n === 0
        ? {
            data: [
              { user_id: 'a', seat_number: 1 },
              { user_id: 'b', seat_number: 2 },
            ],
            error: null,
          }
        : {
            data: [
              { user_id: 'a', seat_number: 1 },
              { user_id: 'c', seat_number: 3 },
            ],
            error: null,
          };
    rpcMock.mockImplementation(async (name: string, args: { p_user_id?: string }) => {
      if (name === 'fn_tournament_primary_table') return { data: TABLE, error: null };
      if (args?.p_user_id === 'free-1')
        return { data: { ok: false, reason: 'table_full' }, error: null };
      return { data: { ok: true, seat_number: 2 }, error: null };
    });
    candidates([], ['free-1', 'free-2', 'free-3']);
    const added = await svc.topUpWithHorses(T, 3);
    expect(seatCalls().map((c) => c.p_user_id)).toEqual(['free-1', 'free-2']);
    expect(added).toBe(1);
  });

  it('a stale ledger is corrected by the RPC: already_seated seats nobody and the next candidate is tried', async () => {
    seatRows([
      { user_id: 'a', seat_number: 1 },
      { user_id: 'b', seat_number: 2 },
    ]);
    rpcMock.mockImplementation(async (name: string, args: { p_user_id?: string }) => {
      if (name === 'fn_tournament_primary_table') return { data: TABLE, error: null };
      if (args?.p_user_id === 'free-1')
        return { data: { ok: true, already_seated: true }, error: null };
      return { data: { ok: true, seat_number: 3 }, error: null };
    });
    candidates([], ['free-1', 'free-2', 'free-3']);
    const added = await svc.topUpWithHorses(T, 3);
    expect(seatCalls().map((c) => c.p_user_id)).toEqual(['free-1', 'free-2']);
    // The seat that was already counted in the shortfall is not counted again.
    expect(added).toBe(1);
  });
});

describe('topUpWithHorses - the wiring, pinned in the source', () => {
  it('reads the seat rows it already needed for the shortfall, on the same index, and keeps them', () => {
    const body = topUpBody();
    const read = body.slice(
      body.indexOf(".from('table_seats')"),
      body.indexOf('liveCount = liveSeatRows.length')
    );
    expect(read).toMatch(/\.select\('user_id, seat_number'\)/);
    expect(read).toMatch(/\.eq\('table_id', primaryTableId\)/);
    expect(read).toMatch(/\.is\('left_at', null\)/);
  });

  it('re-reads the seat rows, lock-free, between the pre-check and the skip', () => {
    const loop = seatingLoopBody();
    const pre = loop.indexOf('seatFirstSeatPrecheck(ledger, horse)');
    const skip = loop.indexOf("precheck === 'already_seated'");
    const rpc = loop.indexOf("'fn_seat_horse_in_seat_first_game'");
    expect(pre).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(pre);
    expect(rpc).toBeGreaterThan(skip);
    const verify = loop.slice(pre, skip);
    expect(verify).toMatch(/\.from\('table_seats'\)/);
    expect(verify).toMatch(/\.select\('user_id, seat_number'\)/);
    expect(verify).toMatch(/\.is\('left_at', null\)/);
    expect(verify).toContain('seatFirstLedgerRefresh(ledger,');
    // A failed re-read verifies nothing and therefore skips nothing: the
    // verdict is reset to 'call' before the read and only a successful read
    // may put a skip back.
    const reset = verify.indexOf("precheck = 'call';");
    const read = verify.indexOf(".from('table_seats')");
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(read);
    expect(verify).toMatch(/if \(!freshErr\) \{\s*seatFirstLedgerRefresh\(ledger,/);
    expect(verify).not.toMatch(/\.rpc\(/);
  });

  it('asks the pre-check before the RPC and skips with a continue, never a break', () => {
    const loop = seatingLoopBody();
    const pre = loop.indexOf('seatFirstSeatPrecheck(ledger, horse)');
    const rpc = loop.indexOf("'fn_seat_horse_in_seat_first_game'");
    expect(pre).toBeGreaterThan(-1);
    expect(pre, 'the pre-check must run before the call').toBeLessThan(rpc);
    const skip = loop.slice(pre, rpc);
    expect(skip).toMatch(/already_seated'\)\s*\{[\s\S]*?continue;/);
    expect(skip).toMatch(/table_full'\)\s*\{[\s\S]*?continue;/);
    expect(skip).not.toMatch(/\bbreak\s*;/);
  });

  it('calls the RPC with the same arguments it always did', () => {
    expect(seatingLoopBody()).toMatch(
      /rpc\(\s*'fn_seat_horse_in_seat_first_game',\s*\{\s*p_tournament_id:\s*tournamentId,\s*p_user_id:\s*horse\s*\}/
    );
  });

  it('the pre-check never filters on is_horse', () => {
    expect(seatingLoopBody()).not.toMatch(/is_horse/);
  });

  it('logs skipped versus called once per pass that had candidates, and folds the same tally into /metrics', () => {
    const body = topUpBody();
    expect(body).toContain('seatFirstPrecheckLogLine(tournamentId, tally)');
    expect(body).toContain('recordSeatFirstPrecheck(tally)');
  });
});
