import { emptyManagerWakeInbox } from './__fixtures__/emptyManagerWakeInbox.js';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SWEEP ASKS INDEPENDENT QUESTIONS TOGETHER (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A tournament elimination sweep is a chain of awaited PostgREST calls, so its
 * wall time is (sequential round trips) x (network trip + event-loop delay).
 * After the 06:57 boot of c58dfafd the process-wide scheduler held 553 of 597
 * managers in its queue with four slots, the main event loop's p50 delay read
 * 142 ms at 07:22 and 490 ms at 07:51, and a sweep with a bust to record spent
 * its whole 5 s budget on reads before its first elimination 161 times in 38
 * minutes. Every link that did not need to wait for the one before it was
 * therefore a slot held for nothing, by every sweep, for every manager.
 *
 * The transport below answers each request exactly TRIP_MS after it is sent,
 * so fake time elapsed IS the number of sequential round trips. It pins:
 *
 *   - the bust stage of a two-player event with one zero stack reaches its
 *     first elimination after five trips, not seven: the zero-chip-field
 *     guard and the ladder seed share one `status='playing'` count, and the
 *     taken-places list and the unplaced count travel together;
 *   - the chip-cap inputs (three independent high-water marks read at the
 *     head of every full sweep in a backlog) cost one trip, not three;
 *   - and every fail-closed answer those reads guard is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: fixture.from, rpc: fixture.rpc },
  maintenanceSupabase: { from: fixture.from, rpc: fixture.rpc },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: fixture.reportError }));
vi.stubGlobal(
  'fetch',
  vi.fn(() => {
    throw new Error('Network disabled in fixture');
  })
);

const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const { TournamentSweepWorkCursor } = await import('./TournamentSweepWorkCursor.js');

/** Every request is answered this long after it is sent, never sooner. */
const TRIP_MS = 100;
const tournamentId = '00000000-0000-4000-8000-000000000001';
const survivorId = '00000000-0000-4000-8000-000000000002';
const bustedId = '00000000-0000-4000-8000-000000000003';

interface Request {
  table: string;
  columns: string | null;
  head: boolean;
  filters: Array<[string, string, unknown]>;
  sentAt: number;
  limit?: number;
}
interface Answer {
  data?: unknown;
  count?: number | null;
  error?: unknown;
}

const has = (request: Request, column: string, op: string, value?: unknown): boolean =>
  request.filters.some(
    ([c, o, v]) => c === column && o === op && (value === undefined || v === value)
  );
const isPlayingCount = (r: Request): boolean =>
  r.table === 'tournament_players' && r.head && has(r, 'status', 'eq', 'playing');

/**
 * A PostgREST stand-in that records when each request left and answers it one
 * trip later. The builder is a thenable, exactly as supabase-js's is, so the
 * request is "sent" at the moment the manager awaits it - alone, or together
 * with others through Promise.all.
 */
function transport(answer: (request: Request) => Answer): Request[] {
  const sent: Request[] = [];
  const reply = (request: Request): Promise<Answer> => {
    request.sentAt = Date.now();
    sent.push(request);
    const response = { data: null, count: null, error: null, ...answer(request) };
    if (Array.isArray(response.data) && request.table === 'tournament_players') {
      const cursor = request.filters.find(([c, op]) => c === 'id' && op === 'gt')?.[2];
      response.data = response.data
        .filter((row: any) => cursor == null || row.id > String(cursor))
        .slice(0, Math.min(1000, request.limit ?? 1000));
    }
    return new Promise((resolve) => setTimeout(() => resolve(response), TRIP_MS));
  };
  fixture.from.mockImplementation((table: string) => {
    if (table === 'tournament_manager_wakes') return emptyManagerWakeInbox();
    const request: Request = { table, columns: null, head: false, filters: [], sentAt: -1 };
    const filter = (column: string, op: string, value: unknown): unknown => {
      request.filters.push([column, op, value]);
      return query;
    };
    const query: any = {
      select: (columns: string, options?: { head?: boolean }) => {
        request.columns = columns;
        request.head = options?.head === true;
        return query;
      },
      eq: (column: string, value: unknown) => filter(column, 'eq', value),
      lte: (column: string, value: unknown) => filter(column, 'lte', value),
      gt: (column: string, value: unknown) => filter(column, 'gt', value),
      limit: (value: number) => {
        request.limit = value;
        return query;
      },
      in: (column: string, value: unknown) => filter(column, 'in', value),
      is: (column: string, value: unknown) => filter(column, 'is', value),
      // An ORDER BY shapes the answer, not the trip.
      order: () => query,
      not: (column: string, op: string, value: unknown) => filter(column, `not.${op}`, value),
      then: (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) =>
        reply(request).then(resolve, reject),
    };
    return query;
  });
  fixture.rpc.mockImplementation((fn: string, args: unknown) =>
    reply({
      table: `rpc:${fn}`,
      columns: null,
      head: false,
      filters: [['args', 'eq', args]],
      sentAt: -1,
    })
  );
  return sent;
}

/** Two players left, one of them on zero, with the evidence the door needs. */
function oneBustOfTwo(overrides: (request: Request) => Answer | undefined = () => undefined) {
  return transport((request) => {
    const override = overrides(request);
    if (override) return override;
    if (request.table === 'tournament_players') {
      if (/^(id, )?user_id, chips$/.test(request.columns ?? ''))
        return { data: [{ user_id: bustedId, chips: 0 }] };
      if (isPlayingCount(request)) return { count: 2 };
      if (/^(id, )?position$/.test(request.columns ?? '')) return { data: [] };
      if (request.head && has(request, 'position', 'is', null)) return { count: 2 };
      if (request.head) return { count: 2 };
    }
    if (request.table === 'tournament_knockout_candidates') {
      // The generation the door binds, with the exact count the sweep asks for
      // so it can tell a complete read from one PostgREST cut short (bustOrder.ts).
      return {
        data: [
          {
            id: '00000000-0000-4000-8000-0000000000c1',
            eliminated_user_id: bustedId,
            hand_number: 7,
            stack_before: 1500,
            state: 'pending',
          },
        ],
        count: 1,
      };
    }
    if (request.table === 'rpc:fn_open_tournament_rebuy_decisions') {
      return { data: [{ user_id: bustedId, decision_open: false }] };
    }
    if (
      request.table === 'wallet_transactions' ||
      request.table === 'tournament_participant_funding_receipts'
    )
      return { count: 0 };
    throw new Error(`Unexpected request in bust-stage fixture: ${request.table}`);
  });
}

function bustStageManager() {
  const eliminated: Array<{ userId: string; place: number; at: number }> = [];
  const manager = Object.create(TournamentManagerEliminations.prototype) as any;
  Object.assign(manager, {
    pendingManagerWakes: new Map(),
    pendingManagerWakeGenerations: new Map(),
    running: true,
    isProcessingEliminations: false,
    tournamentId,
    tournamentCache: {
      variant: 'sng',
      tournament_type: 'SNG',
      is_rebuy: false,
      is_reentry: false,
      prize_pool_finalized: true,
    },
    tournamentEntryRepricePending: false,
    eliminationSweepCursor: new TournamentSweepWorkCursor(),
    bustRefusalStreak: new Map(),
    resumeCommittedTerminalCleanup: vi.fn().mockResolvedValue(false),
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
    // The first recorded bust ends this pass at the stage boundary, so the
    // clock below measures the bust stage and nothing after it.
    eliminationWorkBudgetExpired: vi.fn(() => eliminated.length > 0),
    eliminatePlayer: vi.fn(async (userId: string, place: number) => {
      eliminated.push({ userId, place, at: Date.now() });
      return true;
    }),
  });
  manager.eliminationSweepCursor.advanceTo(1); // straight to the bust stage
  return { manager, eliminated };
}

async function sweep(manager: any): Promise<number> {
  const startedAt = Date.now();
  const run = manager.runEliminationSweep(new AbortController().signal);
  await vi.runAllTimersAsync();
  await run;
  return startedAt;
}

describe('the sweep asks independent questions together', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('reaches the first elimination of a one-bust event after five round trips, not seven', async () => {
    oneBustOfTwo();
    const { manager, eliminated } = bustStageManager();
    const startedAt = await sweep(manager);

    expect(eliminated).toHaveLength(1);
    expect(eliminated[0]).toMatchObject({ userId: bustedId, place: 2 });
    // busted list -> playing count -> knockout order -> rebuy decisions ->
    // (taken places + unplaced count). Two trips fewer than before.
    expect(eliminated[0].at - startedAt).toBe(5 * TRIP_MS);
    expect(fixture.reportError).not.toHaveBeenCalled();
  });

  it('reads the playing count once and lets it answer both the guard and the ladder', async () => {
    const sent = oneBustOfTwo();
    const { manager, eliminated } = bustStageManager();
    await sweep(manager);
    // The bust stage asks once. The bust it records leaves one player
    // standing, so the same admission goes on to the finish stage, which asks
    // its own post-elimination question (aDecidedGameIsPaidInTheAdmissionThatRecordsItsLastBust).
    expect(eliminated).toHaveLength(1);
    expect(sent.filter((r) => isPlayingCount(r) && r.sentAt < eliminated[0].at)).toHaveLength(1);
  });

  it('sends the taken-places list and the unplaced count in the same round trip', async () => {
    const sent = oneBustOfTwo();
    const { manager } = bustStageManager();
    await sweep(manager);
    const taken = sent.find(
      (r) => r.table === 'tournament_players' && /^(id, )?position$/.test(r.columns ?? '')
    );
    const unplaced = sent.find(
      (r) => r.table === 'tournament_players' && r.head && has(r, 'position', 'is', null)
    );
    expect(taken).toBeDefined();
    expect(unplaced).toBeDefined();
    expect(unplaced!.sentAt).toBe(taken!.sentAt);
  });

  it('still refuses a field that reads zero everywhere, from that one count', async () => {
    oneBustOfTwo((request) => (isPlayingCount(request) ? { count: 1 } : undefined));
    const { manager, eliminated } = bustStageManager();
    await sweep(manager);
    expect(eliminated).toHaveLength(0);
    expect(fixture.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.zero_chip_field_refused'
    );
  });

  it.each([1000, 1001, 9001])('refuses the entire %s-player zero-chip field', async (size) => {
    oneBustOfTwo((request) => {
      if (isPlayingCount(request)) return { count: size };
      if (/^(id, )?user_id, chips$/.test(request.columns ?? ''))
        return {
          data: Array.from({ length: size }, (_, i) => ({
            id: String(i).padStart(8, '0'),
            user_id: `bust-${i}`,
            chips: 0,
          })),
        };
      return undefined;
    });
    const { manager, eliminated } = bustStageManager();
    await sweep(manager);
    expect(eliminated).toHaveLength(0);
    expect(fixture.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.zero_chip_field_refused'
    );
  });

  it.each(['fault', 'stop'])(
    'does not act on a truncated bust roster after a later-page %s',
    async (mode) => {
      const { manager, eliminated } = bustStageManager();
      oneBustOfTwo((request) => {
        if (!/^(id, )?user_id, chips$/.test(request.columns ?? '')) return undefined;
        if (has(request, 'id', 'gt')) {
          if (mode === 'stop') manager.running = false;
          return mode === 'fault'
            ? { data: null, error: { message: 'later page failed' } }
            : { data: [] };
        }
        return {
          data: Array.from({ length: 1000 }, (_, i) => ({
            id: String(i).padStart(8, '0'),
            user_id: `bust-${i}`,
            chips: 0,
          })),
        };
      });
      await sweep(manager);
      expect(eliminated).toHaveLength(0);
      expect(fixture.rpc).not.toHaveBeenCalled();
      if (mode === 'fault')
        expect(fixture.reportError).toHaveBeenCalledWith(
          expect.any(Error),
          'Tournament.busted_list_unavailable'
        );
    }
  );

  it('does not reuse a finishing place beyond the first page', async () => {
    oneBustOfTwo((request) => {
      if (/^(id, )?position$/.test(request.columns ?? ''))
        return {
          data: Array.from({ length: 1001 }, (_, i) => ({
            id: String(i).padStart(8, '0'),
            position: i === 1000 ? 2 : i + 3,
          })),
        };
      return undefined;
    });
    const { manager, eliminated } = bustStageManager();
    await sweep(manager);
    expect(eliminated).toHaveLength(1);
    expect(eliminated[0].place).toBe(1003);
  });

  it('refuses an incomplete taken-places read before eliminating anyone', async () => {
    oneBustOfTwo((request) => {
      if (!/^(id, )?position$/.test(request.columns ?? '')) return undefined;
      if (has(request, 'id', 'gt')) return { data: null, error: { message: 'later page failed' } };
      return {
        data: Array.from({ length: 1000 }, (_, i) => ({
          id: String(i).padStart(8, '0'),
          position: i + 3,
        })),
      };
    });
    const { manager, eliminated } = bustStageManager();
    await sweep(manager);
    expect(eliminated).toHaveLength(0);
    expect(fixture.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.taken_places_unavailable'
    );
  });

  it('still defers every elimination when the count cannot be read - once, not twice', async () => {
    const sent = oneBustOfTwo((request) =>
      isPlayingCount(request) ? { count: null, error: { message: 'count failed' } } : undefined
    );
    const { manager, eliminated } = bustStageManager();
    await sweep(manager);
    expect(eliminated).toHaveLength(0);
    expect(sent.filter(isPlayingCount)).toHaveLength(1);
    expect(fixture.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.playing_count_unavailable'
    );
    expect(fixture.reportError).not.toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.zero_chip_field_refused'
    );
  });

  it.each([
    ['taken-places list', 'position', 'Tournament.taken_places_unavailable'],
    ['unplaced count', 'unplaced', 'Tournament.unplaced_count_unavailable'],
  ])('still defers every elimination when the %s cannot be read', async (_name, which, alert) => {
    oneBustOfTwo((request) => {
      if (request.table !== 'tournament_players') return undefined;
      if (which === 'position' && /^(id, )?position$/.test(request.columns ?? '')) {
        return { data: null, error: { message: 'read failed' } };
      }
      if (which === 'unplaced' && request.head && has(request, 'position', 'is', null)) {
        return { count: null, error: { message: 'read failed' } };
      }
      return undefined;
    });
    const { manager, eliminated } = bustStageManager();
    await sweep(manager);
    expect(eliminated).toHaveLength(0);
    expect(fixture.reportError).toHaveBeenCalledWith(expect.any(Error), alert);
  });
});

describe('the chip-cap inputs travel together', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  function capManager() {
    const manager = Object.create(TournamentManagerEliminations.prototype) as any;
    Object.assign(manager, {
      tournamentId,
      lastChipCapRefreshAt: 0,
      entrantCountForChipCap: 0,
      rebuysGrantedForChipCap: 0,
      addonsGrantedForChipCap: 0,
    });
    return manager;
  }

  it.each([2, 6])(
    'costs one round trip and does not double-count %s funding receipts',
    async (receiptCount) => {
      const sent = transport((request) => {
        if (request.table === 'tournament_players') return { count: 40 };
        if (has(request, 'category', 'in')) return { count: 6 };
        if (request.table === 'tournament_participant_funding_receipts')
          return { count: has(request, 'operation', 'in') ? receiptCount : 2 };
        if (has(request, 'category', 'eq', 'addon')) return { count: 3 };
        throw new Error(`Unexpected request: ${request.table}`);
      });
      const manager = capManager();
      const startedAt = Date.now();
      const refresh = manager.refreshChipCapInputs();
      await vi.runAllTimersAsync();
      await refresh;

      expect(Date.now() - startedAt).toBe(TRIP_MS);
      expect(sent).toHaveLength(5);
      expect(new Set(sent.map((r) => r.sentAt)).size).toBe(1);
      expect(manager.entrantCountForChipCap).toBe(40);
      expect(manager.rebuysGrantedForChipCap).toBe(6);
      expect(manager.addonsGrantedForChipCap).toBe(3);
    }
  );

  it('keeps a mark whose read failed and never lowers one', async () => {
    transport((request) => {
      if (request.table === 'tournament_players') return { count: 10 };
      if (has(request, 'category', 'in') || has(request, 'operation', 'in'))
        return { count: null, error: { message: 'x' } };
      return { count: 1 };
    });
    const manager = capManager();
    Object.assign(manager, {
      entrantCountForChipCap: 25,
      rebuysGrantedForChipCap: 4,
      addonsGrantedForChipCap: 0,
    });
    const refresh = manager.refreshChipCapInputs();
    await vi.runAllTimersAsync();
    await refresh;

    expect(manager.entrantCountForChipCap).toBe(25);
    expect(manager.rebuysGrantedForChipCap).toBe(4);
    expect(manager.addonsGrantedForChipCap).toBe(1);
  });
  it.each([0, 4])(
    'counts Diamond rebuy grants and %s add-ons after a manager restart',
    async (addons) => {
      const sent = transport((request) => {
        if (request.table === 'tournament_players') return { count: 523 };
        if (request.table === 'wallet_transactions') return { count: 0 };
        if (request.table === 'tournament_participant_funding_receipts')
          return { count: has(request, 'operation', 'in') ? 244 : addons };
        throw new Error(`Unexpected request: ${request.table}`);
      });
      const manager = capManager();
      manager.tournamentCache = { starting_chips: 3000, rebuy_chips: 3000, addon_chips: 3000 };
      const refresh = manager.refreshChipCapInputs();
      await vi.runAllTimersAsync();
      await refresh;
      expect(manager.rebuysGrantedForChipCap).toBe(244);
      expect(manager.addonsGrantedForChipCap).toBe(addons);
      expect(manager.chipsInPlayEstimate()).toBe(2_301_000 + addons * 3000);
      const funding = sent.filter((r) => r.table === 'tournament_participant_funding_receipts');
      expect(funding).toHaveLength(2);
      expect(funding.every((r) => has(r, 'tournament_id', 'eq', tournamentId))).toBe(true);
      expect(
        funding.some((r) =>
          r.filters.some(
            ([c, o, v]) =>
              c === 'operation' && o === 'in' && JSON.stringify(v) === '["rebuy","reentry"]'
          )
        )
      ).toBe(true);
    }
  );
});
