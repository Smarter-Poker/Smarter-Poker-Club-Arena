/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE HORSE FILL PATHS, AUDITED 2026-09-11 (lane D)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Five defects, each measured on production before it was changed:
 *
 *  1. A REGISTERING row whose prize pool is finalized (39 seat-first games and
 *     one MTT dealt on 2026-09-08, left REGISTERING with started_at NULL when
 *     that engine stopped at :53) was topped up every backoff: ~2,965 locked
 *     RPCs an hour that both doors refuse, 298 "CANNOT FILL" alarms an hour
 *     naming the wrong cause. Every healthy REGISTERING row reads
 *     finalized=false, so the column is the separator.
 *  2. The held-empty hold outlived a fillable board ten to one (30-minute
 *     bucket plus a ten-minute backoff against a four-minute life), so 149 of
 *     158 open seat-first boards were empty against Dan's 33%/50%. The hold
 *     is now the human window, Dan's "90-350 seconds max" (2026-09-05).
 *  3. seedOpenSeatTable opened horses on the house board only; 82 of 83 Deep
 *     Stack Society boards had no seat sold. The pool has been club-scoped
 *     since 2026-09-01, so the guard protected nothing.
 *  4. registerHorses rotated its queue by hour alone, so every event ramped
 *     in one hour started at the same horse: one horse, 34 bookings in an hour.
 *  5. The bankroll gate read the wallet at tournaments.club_id, which for a
 *     union event is the union's house row that the database never debits.
 *
 * Plus the picker's booking horizon (30 min) disagreeing with the trigger's
 * (60 min): pinned in HorseConcurrency.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

import {
  SEAT_FIRST_EMPTY_BUCKET_MS,
  TournamentRecurringService,
  rampQueueRotation,
  seatFirstHeldEmpty,
} from './TournamentRecurringService.js';

const SRC = readFileSync(join(__dirname, 'TournamentRecurringService.ts'), 'utf8');
const GAME_SERVER = readFileSync(join(__dirname, '..', 'GameServer.ts'), 'utf8');

function method(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} must still exist`).toBeGreaterThan(-1);
  const next = src.indexOf('\n  private async ', start + signature.length);
  return src.slice(start, next > -1 ? next : src.length);
}

/**
 * A tournament id the hold rolls HELD for at `nowMs`, or NOT held - in this
 * bucket AND the next, so a test that straddles a bucket boundary cannot flake.
 */
function idWithHold(seats: number, held: boolean, nowMs: number): string {
  for (let i = 1; i < 10_000; i++) {
    const id = `c0ffee00-1af3-4576-959b-${i.toString(16).padStart(12, '0')}`;
    if (
      seatFirstHeldEmpty(id, seats, nowMs) === held &&
      seatFirstHeldEmpty(id, seats, nowMs + SEAT_FIRST_EMPTY_BUCKET_MS) === held
    )
      return id;
  }
  throw new Error('no id rolled the requested hold');
}

describe('1. a finalized prize pool is not filled', () => {
  const TABLE = 'bbbbbbbb-0000-4000-8000-000000000001';
  let svc: TournamentRecurringService;
  let pick: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rpcMock.mockReset();
    reportErrorMock.mockReset();
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'fn_tournament_primary_table') return { data: TABLE, error: null };
      return { data: { ok: true, seat_number: 3 }, error: null };
    });
    svc = new TournamentRecurringService();
    pick = vi
      .spyOn(svc as unknown as { pickFreeHorses: () => Promise<string[]> }, 'pickFreeHorses')
      .mockResolvedValue(['free-1', 'free-2', 'free-3']);
    vi.spyOn(
      svc as unknown as { unseatedRegistrantHorses: () => Promise<string[]> },
      'unseatedRegistrantHorses'
    ).mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('refuses before it picks or calls, and says so once per row', async () => {
    const T = 'aaaaaaaa-0000-4000-8000-000000000001';
    tableResults = {
      tournaments: {
        data: {
          variant: 'spin',
          format_contract: 'spin-v1',
          max_players: 3,
          club_id: 'club',
          start_time: '2026-09-08T14:39:54.323Z',
          prize_pool_finalized: true,
        },
        error: null,
      },
      table_seats: {
        data: [
          { user_id: 'a', seat_number: 1 },
          { user_id: 'b', seat_number: 2 },
        ],
        error: null,
      },
      tables: { data: { max_players: 3 }, error: null },
    };
    expect(await svc.topUpWithHorses(T, 3)).toBe(0);
    expect(await svc.topUpWithHorses(T, 3)).toBe(0);
    expect(pick).not.toHaveBeenCalled();
    expect(rpcMock.mock.calls.filter((c) => c[0] === 'fn_seat_horse_in_seat_first_game')).toEqual(
      []
    );
    const refusals = reportErrorMock.mock.calls.filter(
      (c) => c[1] === 'TournamentRecurring.top_up_refused_pool_finalized'
    );
    expect(refusals).toHaveLength(1);
  });

  it('an ordinary board (finalized false) is filled exactly as before', async () => {
    const T = 'aaaaaaaa-0000-4000-8000-000000000002';
    tableResults = {
      tournaments: {
        data: {
          variant: 'spin',
          format_contract: 'spin-v1',
          max_players: 3,
          club_id: 'club',
          start_time: '2026-09-08T14:39:54.323Z',
          prize_pool_finalized: false,
        },
        error: null,
      },
      table_seats: {
        data: [
          { user_id: 'a', seat_number: 1 },
          { user_id: 'b', seat_number: 2 },
        ],
        error: null,
      },
      tables: { data: { max_players: 3 }, error: null },
    };
    expect(await svc.topUpWithHorses(T, 3)).toBe(1);
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it('the seat RPC answer that is neither seated nor table_full is named in the log', async () => {
    const T = 'aaaaaaaa-0000-4000-8000-000000000003';
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'fn_tournament_primary_table') return { data: TABLE, error: null };
      return { data: { ok: false, reason: 'tournament_full' }, error: null };
    });
    tableResults = {
      tournaments: {
        data: {
          variant: 'spin',
          format_contract: 'spin-v1',
          max_players: 3,
          club_id: 'club',
          start_time: '2026-09-08T14:39:54.323Z',
        },
        error: null,
      },
      table_seats: {
        data: [
          { user_id: 'a', seat_number: 1 },
          { user_id: 'b', seat_number: 2 },
        ],
        error: null,
      },
      tables: { data: { max_players: 3 }, error: null },
    };
    expect(await svc.topUpWithHorses(T, 3)).toBe(0);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('answered ok:false'));
    expect(line).toContain('tournament_full x3');
  });

  it('GameServer withholds the ramp and the past-start top-up from such a row, and keeps its start gate', () => {
    const walk = method(GAME_SERVER, 'private async discoverTournaments(');
    expect(walk).toContain('prize_pool_finalized');
    expect(walk).toContain('const poolFinalized = tournament.prize_pool_finalized === true;');
    expect(walk).toContain(
      'if (!poolFinalized && msUntilStart > 0 && msUntilStart <= MTT_PRESTART_RAMP_MS)'
    );
    // The past-start top-up is withheld from a finalized row. Since
    // 2026-09-24 the field is the roster (fieldCount), not the counter.
    expect(walk).toContain(
      'const needsPastStartTopUp = !poolFinalized && isPastStart && fieldCount < minPlayers;'
    );
    expect(walk).toContain('if (needsPastStartTopUp) {');
    // Reported once, never a `continue` that would also skip the start gate.
    //
    // AND THE START GATE NOW ACTUALLY RECOVERS ONE (2026-09-11). This comment
    // used to say a launch that finalized its pool and lost its engine "is
    // recovered there". It was not: both arms of the gate count a field that
    // has not played yet, and a played game's field has shrunk to its
    // survivor, so not one of the forty rows dealt on 2026-09-08 satisfied
    // either. The gate has a third arm now, `finishingADealtGame`, and the
    // database decides it.
    const report = walk.indexOf("'GameServer.registering_with_finalized_pool'");
    const gate = walk.indexOf('const shouldStart =');
    expect(walk).toContain('|| finishingADealtGame;');
    expect(walk).toContain('const finishingADealtGame =');
    expect(report).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(report);
    expect(walk.slice(report, gate)).not.toMatch(/poolFinalized\)\s*\{[^}]*continue;/);
    // The board read is paged, and carries the column.
    expect(walk).toContain("{ label: 'GameServer.registeringBoard', maxRows: 50_000 }");
    expect(walk).toContain('const classified = registeringPage.rows.filter(');
    expect(walk).toContain('readPersistedTournamentFormatContract(row)');
    expect(walk).toMatch(
      /const registering = registeringPage\.complete\s*\? await projectTournamentAdmission\(classified\)\s*:\s*\[\]/
    );
    const lane = method(GAME_SERVER, 'private async discoverSeatFirstStarts(');
    expect(lane).toContain('if (!finalized && seats > 0 && paid > 0 && paid < seats)');
  });

  it('the fast lane re-reads a short board before it alarms, so a board the walk just filled is not "CANNOT FILL"', () => {
    // 64 of 103 boards alarmed in one hour were live boards the main walk had
    // filled seconds earlier (`seated=3` in the fill pass, then the alarm).
    const topUp = method(GAME_SERVER, 'private async topUpPartialSeatFirst(');
    const reread = topUp.indexOf('await this.readSeatFirstPaidSeats([{ id: tournamentId }])');
    const alarm = topUp.indexOf("'GameServer.seat_first_human_waiting'");
    expect(reread).toBeGreaterThan(-1);
    expect(alarm).toBeGreaterThan(reread);
    expect(topUp).toContain('if (fresh !== undefined && fresh >= seats) shortfall = 0;');
  });
});

describe('2. the held-empty hold is the human window', () => {
  const TABLE = 'bbbbbbbb-0000-4000-8000-000000000002';
  let svc: TournamentRecurringService;
  let pick: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'fn_tournament_primary_table') return { data: TABLE, error: null };
      return { data: { ok: true, seat_number: 1 }, error: null };
    });
    svc = new TournamentRecurringService();
    pick = vi
      .spyOn(svc as unknown as { pickFreeHorses: () => Promise<string[]> }, 'pickFreeHorses')
      .mockResolvedValue(['h1', 'h2', 'h3']);
    vi.spyOn(
      svc as unknown as { unseatedRegistrantHorses: () => Promise<string[]> },
      'unseatedRegistrantHorses'
    ).mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  function emptyBoard(startTime: string): void {
    tableResults = {
      tournaments: {
        data: {
          variant: 'spin',
          format_contract: 'spin-v1',
          max_players: 3,
          club_id: 'club',
          start_time: startTime,
        },
        error: null,
      },
      table_seats: { data: [], error: null },
      tables: { data: { max_players: 3 }, error: null },
    };
  }

  it('a held board is left empty while its window is open', async () => {
    const id = idWithHold(3, true, Date.now());
    emptyBoard(new Date(Date.now() + 120_000).toISOString());
    expect(await svc.topUpWithHorses(id, 3)).toBe(0);
    expect(pick).not.toHaveBeenCalled();
  });

  it('a held board fills like any other once its window has closed', async () => {
    const id = idWithHold(3, true, Date.now());
    emptyBoard(new Date(Date.now() - 1_000).toISOString());
    expect(await svc.topUpWithHorses(id, 3)).toBe(3);
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it('a board that did not roll held fills inside its window too (the gate is only the hold)', async () => {
    const id = idWithHold(3, false, Date.now());
    emptyBoard(new Date(Date.now() + 120_000).toISOString());
    expect(await svc.topUpWithHorses(id, 3)).toBe(3);
  });

  it('the source keeps the hold to a board with nobody in it, inside the window', () => {
    const top = method(SRC, 'async topUpWithHorses(');
    const gate = top.lastIndexOf('seatFirstHeldEmpty(');
    const before = top.slice(gate - 200, gate);
    expect(before).toMatch(/liveCount === 0 &&/);
    expect(before).toMatch(/humanWindowOpen &&/);
    expect(top).toContain('heldStartMs > Date.now()');
  });
});

describe('3. a club board opens with its own members', () => {
  it('seedOpenSeatTable no longer gates the opening horses on the house board', () => {
    const body = method(SRC, 'private async seedOpenSeatTable(');
    expect(body).not.toContain('isHouseBoard');
    expect(body).toMatch(/const opening = !seatFirstHeldEmpty\(tournament\.id, seats\)/);
    // The pool is what scopes the club: the tournament id reaches the picker.
    expect(body).toContain('this.pickFreeHorses(opening, false, tournament.id)');
  });
});

describe('4. the ramp queue rotates per event', () => {
  it('two events ramped in the same hour do not start at the same horse', () => {
    const pool = 300;
    const starts = new Set<number>();
    for (let i = 0; i < 200; i++) {
      starts.add(rampQueueRotation(`event-${i}-0000-4000-8000-000000000000`, 0, pool));
    }
    // 200 draws over 300 slots: well over half distinct, never one value.
    expect(starts.size).toBeGreaterThan(100);
  });

  it('is stable for one event within an hour and moves between hours', () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000009';
    expect(rampQueueRotation(id, 5, 100)).toBe(rampQueueRotation(id, 5, 100));
    const byHour = new Set<number>();
    for (let h = 0; h < 24; h++) byHour.add(rampQueueRotation(id, h, 100));
    expect(byHour.size).toBeGreaterThan(12);
  });

  it('never indexes outside the pool', () => {
    expect(rampQueueRotation('x', 3, 0)).toBe(0);
    for (let n = 1; n < 20; n++) {
      const r = rampQueueRotation('aaaaaaaa-0000-4000-8000-000000000001', 7, n);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(n);
    }
  });

  it('registerHorses uses it for both queues', () => {
    const body = method(SRC, 'private async registerHorses(');
    expect(body).toContain('rampQueueRotation(tournamentId, hour, ticketPool.length)');
    expect(body).toContain('rampQueueRotation(tournamentId, hour, walletPool.length)');
    expect(body).not.toMatch(/\(hour \* 7919\) %/);
  });
});

describe('5. the bankroll gate reads the wallet the database debits', () => {
  it('reads every member-club wallet the resolver could pick and judges the smallest', () => {
    const body = method(SRC, 'private async registerHorses(');
    expect(body).toContain("select('club_id, union_id, buy_in_amount, buy_in_fee')");
    expect(body).toContain('await this.walletClubsForScope(clubId, unionId)');
    expect(body).toContain(".in('club_id', walletClubs)");
    expect(body).toContain("select('user_id, club_id, chip_balance')");
    expect(body).toContain('rolls.set(r.user_id, prev === undefined ? v : Math.min(prev, v));');
    // The fail-open shape the bankroll suite pins is untouched.
    expect(body).toMatch(/if \(roll === undefined\) return true;/);
    expect(body).toMatch(/if \(rollPage\.complete\) \{/);
  });

  it('a standalone club is its own wallet; a union event is its member clubs', () => {
    const helper = method(SRC, 'private async walletClubsForScope(');
    expect(helper).toContain('if (!unionId) return [hostClubId];');
    expect(helper).toContain("from('union_clubs')");
    expect(helper).toContain('if (joined.error) return null;');
  });
});
