/**
 * ONE FLEET READ PER DISCOVERY PASS (2026-09-11).
 *
 * Measured on production: every top-up in the REGISTERING walk re-read the
 * four-game load map, the whole fleet, the cash-room reserve and its club's
 * membership - ~11 of ~16 sequential round trips, 2.6 s median per call - and
 * a pass took 8-10 minutes, so every MTT start waited behind ~200 of them.
 * HorseTopUpPass holds those answers once per pass. This pins what it may hold,
 * when it must let go, and that the walk no longer queues starts behind fills.
 *
 * REVIEWED BEFORE LANDING (2026-09-11). The first draft ran eight top-ups at
 * once, held its answers for as long as the walk ran, spent an event's turn
 * before it knew the top-up would run, and let a pass that threw leave its
 * top-ups running into the next one. "holds an answer for seconds" and "the
 * top-ups beside the walk are bounded" pin the fixes: ten seconds at most,
 * four at once and a turn spent only by a launched top-up. The current walk
 * retains that bound across passes and transfers full continuation ownership
 * to its existing shutdown drain instead of blocking every new board read.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HorseTopUpPass, HORSE_TOP_UP_PASS_MAX_AGE_MS } from './TournamentRecurringService.js';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';
import { GameServer } from '../GameServer.js';
import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

const RECURRING = readFileSync(
  join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
  'utf8'
);
const GAME_SERVER = readFileSync(join(process.cwd(), 'src/GameServer.ts'), 'utf8');

const discoveryState = vi.hoisted(() => ({ frozen: false }));
vi.mock('../maintenance/freezeState.js', async (original) => ({
  ...(await original<object>()),
  isMaintenanceFrozen: () => discoveryState.frozen,
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
beforeEach(() => vi.mocked(reportError).mockClear());
afterEach(() => {
  discoveryState.frozen = false;
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flushDiscovery = () => new Promise<void>((resolve) => setImmediate(resolve));
const DISCOVERY_NOW = Date.UTC(2026, 8, 17, 1);
const boardRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id,
  variant: 'freezeout',
  tournament_type: 'MTT',
  start_time: new Date(DISCOVERY_NOW - 60_000).toISOString(),
  current_players: 24,
  min_players: 4,
  max_players: 200,
  prize_pool_finalized: false,
  ...overrides,
});

// Control only transport and the existing sleep boundary. The actual walk,
// funding ownership, admission coalescing and discovery-job drain execute.
function discoveryHarness(boards: ReturnType<typeof boardRow>[][]) {
  vi.spyOn(Date, 'now').mockReturnValue(DISCOVERY_NOW);
  const server = Object.create(GameServer.prototype) as any;
  const gates = boards.map(() => deferred<void>());
  const funding = new Map<string, ReturnType<typeof deferred<number>>>();
  const claims = new Map<string, ReturnType<typeof deferred<void>>>();
  const allFunding: Array<ReturnType<typeof deferred<number>>> = [];
  const allClaims: Array<ReturnType<typeof deferred<void>>> = [];
  const reads: Array<{ status: string | null; cursor: string | null }> = [];
  let pass = 0;
  let walking: Promise<void> | undefined;
  let failCompleting: Error | null = null;
  let boardEffect: (() => void) | null = null;
  let boardError = false;
  let ticketTargets: string[] = [];
  let lateRows: Array<ReturnType<typeof boardRow> & { status: string }> = [];
  const eligibilityRead = vi
    .spyOn(supabase, 'rpc')
    .mockResolvedValue({ data: true, error: null } as never);
  Object.assign(server, {
    running: true,
    lifecycleGeneration: 1,
    tournamentEngines: new Map(),
    tableEngines: new Map(),
    tournamentOwnedTables: new Set(),
    tournamentTopUpsInFlight: new Map(),
    tournamentManagerAdmissionOperations: new Map(),
    tournamentManagerAdmissionRetryTimers: new Map(),
    discoveryJobs: new Set(),
    engineStartBudget: 4,
    lastMttRampAt: new Map(),
    pastStartTopUpClock: new Map(),
    registeringButFinalizedReported: new Set(),
    finalizedFinishAttempt: new Map(),
    seatFirstFullSince: new Map(),
    completingFirstSeenAt: new Map(),
    // These unrelated existing business intervals are not due in this test.
    lastSeatFirstFinishSweepAt: DISCOVERY_NOW,
    lastClosedTableReopenSweepAt: DISCOVERY_NOW,
    lastOrphanSeatSweepAt: DISCOVERY_NOW,
    lastConservationAt: DISCOVERY_NOW,
    lastNoHandResultCheckAt: DISCOVERY_NOW,
    lastPlaceOverpayChargeAt: DISCOVERY_NOW,
    lastSpinExpireAt: DISCOVERY_NOW,
    lastFeeRequeueAt: DISCOVERY_NOW,
    readSeatFirstPaidSeats: vi.fn(async () => new Map()),
    sleep: vi.fn(async () => {
      const gate = gates[pass++];
      if (gate) await gate.promise;
      if (pass >= boards.length) server.running = false;
    }),
    performTournamentManagerAdmission: vi.fn((id: string) => {
      const claim = deferred<void>();
      claims.set(id, claim);
      allClaims.push(claim);
      return claim.promise;
    }),
    tournamentRecurring: {
      topUpWithHorses: vi.fn((id: string) => {
        const operation = deferred<number>();
        funding.set(id, operation);
        allFunding.push(operation);
        return operation.promise;
      }),
    },
  });
  vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
    let status: string | null = null;
    let cursor: string | null = null;
    let limit = 1000;
    let fields = '';
    let ids: string[] | null = null;
    const query = {
      select: (value: string) => {
        fields = value;
        return query;
      },
      in: (column: string, values: string[]) => {
        if (column === 'id') ids = values;
        return query;
      },
      is: () => query,
      not: () => query,
      eq: (column: string, value: string) => {
        if (column === 'status') status = value;
        return query;
      },
      gt: (column: string, value: string) => {
        if (column === 'id') cursor = value;
        return query;
      },
      lt: () => query,
      order: () => query,
      limit: (value: number) => {
        limit = value;
        return query;
      },
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            reads.push({ status, cursor });
            if (table === 'tournament_tickets') {
              const rows = ticketTargets
                .map((id, index) => ({
                  id: `ticket-${String(index).padStart(4, '0')}`,
                  source_tournament_id: id,
                }))
                .filter((row) => cursor === null || row.id > cursor);
              return { data: rows.slice(0, limit), error: null };
            }
            if (table !== 'tournaments') throw new Error(`Unexpected test read: ${table}`);
            if (
              fields ===
              'id, name, status, tournament_type, variant, max_players, prize_pool_finalized'
            ) {
              const rows = [...lateRows]
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((row) => ids?.includes(row.id) && (cursor === null || row.id > cursor));
              return { data: rows.slice(0, limit), error: null };
            }
            if (status === 'REGISTERING') {
              boardEffect?.();
              if (boardError) return { data: null, error: { message: 'unreadable board' } };
              const rows = [...boards[Math.min(pass, boards.length - 1)]]
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((row) => cursor === null || row.id > cursor);
              return { data: rows.slice(0, limit), error: null };
            }
            if (status === 'COMPLETING' && failCompleting) {
              const failure = failCompleting;
              failCompleting = null;
              throw failure;
            }
            if (status === 'COMPLETING' || status === 'RUNNING') {
              return { data: [], error: null };
            }
            throw new Error(`Unexpected tournament status: ${status}`);
          })
          .then(resolve, reject),
    };
    return query as never;
  });
  return {
    server,
    funding,
    claims,
    reads,
    eligibilityRead,
    withTickets: (ids: string[]) => {
      ticketTargets = ids;
    },
    withLateTargets: (rows: Array<ReturnType<typeof boardRow> & { status: string }>) => {
      lateRows = rows;
    },
    start: () => {
      walking = server.discoverTournaments();
    },
    advance: async (completedPass: number) => {
      gates[completedPass - 1].resolve();
      await flushDiscovery();
    },
    failNextCompletingRead: (error: Error) => {
      failCompleting = error;
    },
    onBoardRead: (effect: () => void) => {
      boardEffect = effect;
    },
    refuseBoard: () => {
      boardError = true;
    },
    close: async () => {
      server.running = false;
      for (const gate of gates) gate.resolve();
      for (const operation of allFunding) operation.resolve(0);
      for (const claim of allClaims) claim.resolve();
      await walking;
      await server.drainDiscoveryJobs();
    },
  };
}

describe('HorseTopUpPass holds an answer once, and only a known one', () => {
  it('concurrent callers share one read', async () => {
    const pass = new HorseTopUpPass();
    let reads = 0;
    const read = async () => {
      reads++;
      return 7;
    };
    const all = await Promise.all([1, 2, 3].map(() => pass.once('k', read, () => true)));
    expect(all).toEqual([7, 7, 7]);
    expect(await pass.once('k', read, () => true)).toBe(7);
    expect(reads).toBe(1);
  });

  it('never holds an unknown answer: the next caller asks again', async () => {
    const pass = new HorseTopUpPass();
    let reads = 0;
    const read = async () => (++reads === 1 ? null : 5);
    const known = (v: number | null) => v !== null;
    expect(await pass.once('k', read, known)).toBeNull();
    expect(await pass.once('k', read, known)).toBe(5);
    expect(await pass.once('k', read, known)).toBe(5);
    expect(reads).toBe(2);
  });

  it('never holds a failed read', async () => {
    const pass = new HorseTopUpPass();
    let reads = 0;
    const read = async () => {
      if (++reads === 1) throw new Error('boom');
      return 1;
    };
    await expect(pass.once('k', read, () => true)).rejects.toThrow('boom');
    expect(await pass.once('k', read, () => true)).toBe(1);
    expect(reads).toBe(2);
  });

  it('forgets everything the moment somebody is seated', async () => {
    const pass = new HorseTopUpPass();
    let reads = 0;
    const read = async () => ++reads;
    expect(await pass.once('k', read, () => true)).toBe(1);
    pass.forget();
    expect(await pass.once('k', read, () => true)).toBe(2);
  });
});

describe('HorseTopUpPass holds an answer for seconds, not for a walk', () => {
  // The pass only hears about ITS OWN seats. The fleet's cash seating, the
  // fast lane, the scheduler and humans move horses without telling it, and a
  // walk after a thaw runs for tens of seconds.
  it('reads again once an answer is older than its max age', async () => {
    let clock = 0;
    const pass = new HorseTopUpPass(10_000, () => clock);
    let reads = 0;
    const read = async () => ++reads;
    expect(await pass.once('k', read, () => true)).toBe(1);
    clock = 9_999;
    expect(await pass.once('k', read, () => true)).toBe(1);
    clock = 10_000;
    expect(await pass.once('k', read, () => true)).toBe(2);
    expect(reads).toBe(2);
  });

  it('the walk holds for ten seconds at most', () => {
    expect(HORSE_TOP_UP_PASS_MAX_AGE_MS).toBeGreaterThan(0);
    expect(HORSE_TOP_UP_PASS_MAX_AGE_MS).toBeLessThanOrEqual(10_000);
  });
});

describe('what a pass may hold', () => {
  it('the cash-room reserve only when it was READ, never its fail-open 0', () => {
    const reserve = sliceMethod(RECURRING, 'private async cashRoomReserve(');
    expect(reserve).toContain('(value) => value !== null');
    expect(reserve).toContain('return reserve ?? 0;');
    const read = sliceMethod(RECURRING, 'private async readCashRoomReserve(');
    expect(read).toContain('if (tErr || !cashTables) return null;');
    expect(read).not.toMatch(/catch \{\s*return 0;/);
  });

  it('club membership per club and union, not per tournament', () => {
    const club = sliceMethod(RECURRING, 'private async clubMemberIdsForTournament(');
    expect(club).toContain("`club-members:${hostClubId}:${unionId ?? ''}`");
  });

  it('nothing after a seat, a registration or a throw', () => {
    const top = sliceMethod(RECURRING, 'async topUpWithHorses(');
    expect(top).toContain('if (added > 0) pass?.forget();');
    // The whole catch body, comments aside - a structure, not a byte window.
    expect(blankNonCode(top)).toMatch(/catch \{\s*pass\?\.forget\(\);\s*return 0;\s*\}/);
  });
});

describe('the REGISTERING walk', () => {
  const walk = sliceMethod(GAME_SERVER, 'private async discoverTournaments(');

  it('holds one pass for every top-up it makes', () => {
    expect(walk).toContain('const topUpPass = new HorseTopUpPass();');
    expect((walk.match(/\{ pass: topUpPass(?:, redeemTickets)? \}/g) || []).length).toBe(2);
  });

  it('retains the existing funding cap, backoff and lifecycle owner', () => {
    const launch = sliceMethod(GAME_SERVER, 'private launchDiscoveryTopUp(');
    expect(launch).toContain('this.tournamentTopUpsInFlight.size >= PAST_START_TOP_UP_CONCURRENCY');
    expect(launch).toContain('this.launchDiscoveryJob(tracked, context, { tournamentId });');
    // Keep the existing empty-funding backoff, not a new retry clock.
    expect(walk).toContain('MTT_PRESTART_TICK_MS * 2 ** Math.min(misses, 4)');
    expect(walk).toContain('PAST_START_TOP_UP_MAX_INTERVAL_MS');
    expect(walk).toContain('misses: added > 0 ? 0 : misses + 1');
  });

  it('launches both funding callbacks under ownership without awaiting them in the walk', () => {
    expect((walk.match(/this\.launchDiscoveryTopUp\(/g) || []).length).toBe(2);
    expect(blankNonCode(walk)).not.toContain('await this.launchDiscoveryTopUp(');
  });

  it.each(['ramp', 'past-start'] as const)(
    'keeps pending %s funding owned while this pass and the next admit other events',
    async (kind) => {
      const short = boardRow('a-held', {
        current_players: 0,
        start_time: new Date(DISCOVERY_NOW + (kind === 'ramp' ? 300_000 : -120_000)).toISOString(),
      });
      const first = boardRow('b-first');
      const second = boardRow('c-second');
      const h = discoveryHarness([
        [short, first],
        [short, first, second],
      ]);
      try {
        h.start();
        await flushDiscovery();
        expect(h.server.sleep).toHaveBeenCalledTimes(1);
        expect(h.server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledOnce();
        expect(
          h.server.performTournamentManagerAdmission.mock.calls.map((c: unknown[]) => c[0])
        ).toEqual(['b-first']);
        const held = h.server.tournamentTopUpsInFlight.get('a-held');
        expect(held).toBeInstanceOf(Promise);
        // The actual common front door must not overlap this ID's funding.
        await h.server.ensureTournamentManagerAdmission('a-held', 'start', 'held', 1);
        expect(h.server.performTournamentManagerAdmission).toHaveBeenCalledOnce();
        await h.advance(1);
        expect(h.server.sleep).toHaveBeenCalledTimes(2);
        expect(
          h.server.performTournamentManagerAdmission.mock.calls.map((c: unknown[]) => c[0])
        ).toEqual(['b-first', 'c-second']);
        expect(h.server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledOnce();
        expect(h.server.tournamentTopUpsInFlight.get('a-held')).toBe(held);
        expect(h.server.tournamentManagerAdmissionOperations.size).toBe(2);
        expect(reportError).not.toHaveBeenCalled();
      } finally {
        await h.close();
      }
    }
  );

  it('uses the complete board and retained admission/retry capacity before optional funding', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) =>
      boardRow(`a${String(index).padStart(4, '0')}`, {
        start_time: new Date(DISCOVERY_NOW + 55_000).toISOString(),
      })
    );
    rows.push(
      boardRow('z-oldest', { start_time: new Date(DISCOVERY_NOW - 180_000).toISOString() })
    );
    const h = discoveryHarness([rows]);
    const existing = deferred<void>();
    h.server.engineStartBudget = 3;
    h.server.tournamentManagerAdmissionOperations.set('held-claim', existing.promise);
    h.server.tournamentManagerAdmissionRetryTimers.set('held-claim', {});
    h.server.tournamentManagerAdmissionRetryTimers.set('other-retry', {});
    try {
      h.start();
      await flushDiscovery();
      expect(h.reads.filter((read) => read.status === 'REGISTERING')).toEqual([
        { status: 'REGISTERING', cursor: null },
        { status: 'REGISTERING', cursor: 'a0999' },
      ]);
      expect(
        h.server.performTournamentManagerAdmission.mock.calls.map((c: unknown[]) => c[0])
      ).toEqual(['z-oldest']);
      expect(h.server.tournamentManagerAdmissionOperations.get('held-claim')).toBe(
        existing.promise
      );
      expect(h.server.tournamentManagerAdmissionRetryTimers.size).toBe(2);
      expect(h.server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
      expect(h.server.lastMttRampAt.size).toBe(0);
      expect(reportError).not.toHaveBeenCalled();
    } finally {
      existing.resolve();
      await h.close();
    }
  });

  it.each(['incomplete', 'freeze', 'generation'] as const)(
    'does not admit or fund a board that crosses %s',
    async (boundary) => {
      const h = discoveryHarness([[boardRow('due'), boardRow('short', { current_players: 0 })]]);
      if (boundary === 'incomplete') h.refuseBoard();
      else
        h.onBoardRead(() => {
          if (boundary === 'freeze') discoveryState.frozen = true;
          else h.server.lifecycleGeneration++;
        });
      try {
        h.start();
        if (boundary === 'incomplete') {
          await vi.waitFor(() => expect(h.server.sleep).toHaveBeenCalledOnce());
        } else await flushDiscovery();
        expect(h.server.performTournamentManagerAdmission).not.toHaveBeenCalled();
        expect(h.server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
        expect(h.server.lastMttRampAt.size + h.server.pastStartTopUpClock.size).toBe(0);
        if (boundary === 'incomplete') {
          expect(reportError).toHaveBeenCalledWith(
            expect.any(Error),
            'GameServer.registering_board_read_failed'
          );
        } else expect(reportError).not.toHaveBeenCalled();
      } finally {
        await h.close();
      }
    }
  );

  it('retains the actual zero-quota ticket writer through the next discovery pass', async () => {
    const ticket = boardRow('ticket-only', {
      start_time: new Date(DISCOVERY_NOW + 600_000).toISOString(),
      current_players: 24,
      buy_in_amount: 20,
      buy_in_fee: 2,
      guaranteed_prize: 0,
      prize_pool: 480,
    });
    const h = discoveryHarness([[ticket], [ticket, boardRow('ready')]]);
    h.withTickets(['ticket-only']);
    try {
      h.start();
      await flushDiscovery();
      expect(h.server.sleep).toHaveBeenCalledTimes(1);
      expect(h.server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledWith(
        'ticket-only',
        0,
        expect.objectContaining({ redeemTickets: true, pass: expect.any(HorseTopUpPass) })
      );
      const held = h.server.tournamentTopUpsInFlight.get('ticket-only');
      expect(held).toBeInstanceOf(Promise);
      await h.advance(1);
      expect(h.server.sleep).toHaveBeenCalledTimes(2);
      expect(h.server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledOnce();
      expect(h.server.tournamentTopUpsInFlight.get('ticket-only')).toBe(held);
      expect(h.server.performTournamentManagerAdmission).toHaveBeenCalledWith(
        'ready',
        'start',
        expect.any(String),
        1
      );
      expect(reportError).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('shares four retained slots between registration and running-ticket work without blocking the walk', async () => {
    const shorts = Array.from({ length: 3 }, (_, index) =>
      boardRow(`short-${index}`, { current_players: 0 })
    );
    const h = discoveryHarness([
      [...shorts, boardRow('ready-one')],
      [...shorts, boardRow('ready-two')],
      shorts,
    ]);
    h.withTickets(['late-a', 'late-b']);
    h.withLateTargets(['late-a', 'late-b'].map((id) => ({ ...boardRow(id), status: 'RUNNING' })));
    // A RUNNING target already has a manager. Ticket entry must not be
    // confused with creating another manager for a REGISTERING event.
    h.server.tournamentEngines.set('late-a', { isRunning: () => true });
    try {
      h.start();
      await flushDiscovery();
      expect(h.server.sleep).toHaveBeenCalledTimes(1);
      expect(
        h.server.tournamentRecurring.topUpWithHorses.mock.calls.map((call: unknown[]) => call[0])
      ).toEqual(['short-0', 'short-1', 'short-2', 'late-a']);
      expect(h.server.tournamentTopUpsInFlight.size).toBe(4);
      expect(h.eligibilityRead).toHaveBeenCalledOnce();
      expect(h.eligibilityRead).toHaveBeenCalledWith('fn_tournament_late_registration_open', {
        p_tournament_id: 'late-a',
      });
      const held = h.server.tournamentTopUpsInFlight.get('late-a');
      const lateCall = h.server.tournamentRecurring.topUpWithHorses.mock.calls[3];
      expect(lateCall[1]).toBe(0);
      expect(lateCall[2]).toEqual({ pass: expect.any(HorseTopUpPass), redeemTickets: true });
      expect(lateCall[2].pass).toBe(
        h.server.tournamentRecurring.topUpWithHorses.mock.calls[0][2].pass
      );
      expect(h.server.lastMttRampAt.has('late-b')).toBe(false);
      await h.advance(1);
      expect(h.server.sleep).toHaveBeenCalledTimes(2);
      expect(h.server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledTimes(4);
      expect(h.eligibilityRead).toHaveBeenCalledOnce();
      expect(h.server.tournamentTopUpsInFlight.get('late-a')).toBe(held);
      expect(
        h.server.performTournamentManagerAdmission.mock.calls.map((call: unknown[]) => call[0])
      ).toEqual(['ready-one', 'ready-two']);
      h.funding.get('short-0')!.resolve(0);
      await flushDiscovery();
      expect(h.server.tournamentTopUpsInFlight.size).toBe(3);
      await h.advance(2);
      expect(h.server.sleep).toHaveBeenCalledTimes(3);
      expect(h.server.tournamentTopUpsInFlight.size).toBe(4);
      expect(
        h.server.tournamentRecurring.topUpWithHorses.mock.calls.map((call: unknown[]) => call[0])
      ).toEqual(['short-0', 'short-1', 'short-2', 'late-a', 'late-b']);
      expect(h.eligibilityRead).toHaveBeenCalledTimes(2);
      const failure = new Error('actual late ticket outcome failed');
      h.funding.get('late-a')!.reject(failure);
      await flushDiscovery();
      expect(h.server.tournamentTopUpsInFlight.has('late-a')).toBe(false);
      expect(reportError).toHaveBeenCalledOnce();
      expect(reportError).toHaveBeenCalledWith(failure, 'GameServer.late_ticket_entry_failed', {
        tournamentId: 'late-a',
      });
    } finally {
      await h.close();
    }
  });

  it('keeps the late-ticket throttle after funding settles and the next board arrives', async () => {
    const h = discoveryHarness([[], [], []]);
    h.withTickets(['late']);
    h.withLateTargets([{ ...boardRow('late'), status: 'RUNNING' }]);
    try {
      h.start();
      await flushDiscovery();
      expect(h.eligibilityRead).toHaveBeenCalledOnce();
      h.funding.get('late')!.resolve(0);
      await flushDiscovery();
      expect(h.server.tournamentTopUpsInFlight.size).toBe(0);
      vi.mocked(Date.now).mockReturnValue(DISCOVERY_NOW + 44_999);
      await h.advance(1);
      expect(h.eligibilityRead).toHaveBeenCalledOnce();
      expect(h.server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledOnce();
      vi.mocked(Date.now).mockReturnValue(DISCOVERY_NOW + 45_000);
      await h.advance(2);
      expect(h.eligibilityRead).toHaveBeenCalledTimes(2);
      expect(h.server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledTimes(2);
    } finally {
      await h.close();
    }
  });

  it.each(['freeze', 'generation'] as const)(
    'owns a pending late eligibility read without funding after %s',
    async (boundary) => {
      const h = discoveryHarness([[boardRow('ready')], []]);
      const eligibility = deferred<{ data: boolean; error: null }>();
      h.withTickets(['late']);
      h.withLateTargets([{ ...boardRow('late'), status: 'RUNNING' }]);
      h.eligibilityRead.mockReturnValue(eligibility.promise as never);
      try {
        h.start();
        await flushDiscovery();
        expect(h.server.sleep).toHaveBeenCalledTimes(1);
        expect(h.server.tournamentTopUpsInFlight.size).toBe(1);
        expect(h.server.discoveryJobs.size).toBe(2); // admission and eligibility
        expect(h.server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
        if (boundary === 'freeze') discoveryState.frozen = true;
        else h.server.lifecycleGeneration++;
        eligibility.resolve({ data: true, error: null });
        await flushDiscovery();
        expect(h.server.tournamentRecurring.topUpWithHorses).not.toHaveBeenCalled();
        expect(h.server.tournamentTopUpsInFlight.size).toBe(0);
        expect(h.server.discoveryJobs.size).toBe(1); // unrelated admission still owned
        expect(reportError).not.toHaveBeenCalled();
      } finally {
        eligibility.resolve({ data: true, error: null });
        await h.close();
      }
    }
  );
});

describe('the top-ups beside the walk are bounded', () => {
  it('four at a time at most, and more than one', () => {
    const cap = Number(/const PAST_START_TOP_UP_CONCURRENCY = (\d+);/.exec(GAME_SERVER)?.[1]);
    // One at a time is the 8-10 minute pass this file exists for.
    expect(cap).toBeGreaterThanOrEqual(2);
    // A terminal authority takes the platform lane exclusively and waits for
    // the LONGEST seat in flight, with every later seat purchase behind it;
    // and each top-up beside another may claim from answers that one has
    // just changed (the cash-room reserve is enforced by nobody else).
    expect(cap).toBeLessThanOrEqual(4);
  });

  it("spends an event's turn only on a top-up that is actually launched across passes", async () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      boardRow(`short-${index}`, { current_players: 0 })
    );
    const h = discoveryHarness([rows, rows, rows]);
    try {
      h.start();
      await flushDiscovery();
      expect(h.server.sleep).toHaveBeenCalledTimes(1);
      expect(h.server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledTimes(4);
      expect(h.server.tournamentTopUpsInFlight.size).toBe(4);
      expect(h.server.pastStartTopUpClock.has('short-4')).toBe(false);
      await h.advance(1);
      expect(h.server.sleep).toHaveBeenCalledTimes(2);
      expect(h.server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledTimes(4);
      expect(h.server.tournamentTopUpsInFlight.size).toBe(4);
      expect(h.server.pastStartTopUpClock.has('short-4')).toBe(false);
      h.funding.get('short-0')!.resolve(0);
      await flushDiscovery();
      expect(h.server.tournamentTopUpsInFlight.size).toBe(3);
      expect(h.server.pastStartTopUpClock.get('short-0')).toEqual({ at: DISCOVERY_NOW, misses: 1 });
      await h.advance(2);
      expect(h.server.sleep).toHaveBeenCalledTimes(3);
      expect(
        h.server.tournamentRecurring.topUpWithHorses.mock.calls.map((c: unknown[]) => c[0])
      ).toEqual(['short-0', 'short-1', 'short-2', 'short-3', 'short-4']);
      expect(h.server.tournamentTopUpsInFlight.size).toBe(4);
      expect(h.server.pastStartTopUpClock.has('short-4')).toBe(true);
      expect(reportError).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('retains funding through a failed pass and releases only its real rejected continuation', async () => {
    const row = boardRow('short', { current_players: 0 });
    const h = discoveryHarness([[row], [row]]);
    const readFailure = new Error('controlled COMPLETING read failure');
    const fundingFailure = new Error('funding result failed');
    h.failNextCompletingRead(readFailure);
    try {
      h.start();
      await flushDiscovery();
      expect(h.server.sleep).toHaveBeenCalledTimes(1);
      const held = h.server.tournamentTopUpsInFlight.get('short');
      expect(held).toBeInstanceOf(Promise);
      expect(h.server.discoveryJobs.size).toBe(1);
      expect(reportError).toHaveBeenCalledWith(
        readFailure,
        'GameServer.Tournament_discovery_error'
      );
      await h.advance(1);
      expect(h.server.sleep).toHaveBeenCalledTimes(2);
      expect(h.server.tournamentRecurring.topUpWithHorses).toHaveBeenCalledOnce();
      expect(h.server.tournamentTopUpsInFlight.get('short')).toBe(held);
      h.funding.get('short')!.reject(fundingFailure);
      await flushDiscovery();
      expect(reportError).toHaveBeenCalledWith(
        fundingFailure,
        'GameServer.past_start_top_up_failed',
        {
          tournamentId: 'short',
        }
      );
      expect(reportError).toHaveBeenCalledTimes(2);
      expect(h.server.tournamentTopUpsInFlight.size).toBe(0);
      expect(h.server.discoveryJobs.size).toBe(0);
    } finally {
      await h.close();
    }
  });
});
