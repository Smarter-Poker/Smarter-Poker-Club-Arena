/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN UNREADABLE TOURNAMENT MUST NOT BE WATERMARKED AS CHECKED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `runTournamentSentinel` assigned `newWatermark = t.ended_at` at the TOP of the
 * loop, before a single check had run, and each of the three integrity checks
 * was written `if (!err) { ... }` with no else, no reportError and no count. So
 * a transient PostgREST failure on one tournament's `tournament_players` prize
 * read skipped payout conservation for that event ENTIRELY, silently, and the
 * watermark still advanced past it. The next cycle reads `ended_at > mark`, so
 * the tournament was never scanned again: if it had minted or destroyed chips,
 * the sentinel that exists to catch exactly that within one cycle reported
 * nothing, permanently, with no trace. The same held for the stranded-player
 * and raked-hand reads.
 *
 * The contrast that proves the intent was always the other way: the sentinel's
 * own two top-level reads (daemon_state, tournaments) already return and skip
 * the whole cycle when they fail.
 *
 * These are the two halves that must hold together, because either alone is
 * satisfiable by doing nothing useful:
 *
 *   1. a failed sub-read SURFACES through the error reporter, and
 *   2. the durable watermark does NOT move past the tournament it could not
 *      check, so the next bounded cycle re-examines it,
 *
 * while a clean pass still advances normally — the sentinel must not be turned
 * into something that stalls on the first bad row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Op = [string, unknown[]];
interface Recorded {
  table: string;
  ops: Op[];
}

interface Tournament {
  id: string;
  name: string | null;
  prize_pool: number | null;
  variant: string | null;
  satellite_target_id: string | null;
  ended_at: string;
}

/** Per-tournament fixture behaviour, keyed by tournament id. */
interface Behaviour {
  /** tournament_players prize read — an error means check (1) could not run. */
  prizeError?: { message: string };
  prizeRows?: Array<{ prize: number }>;
  /** tournament_players entrant count — an error means check (2) could not run. */
  strandedError?: { message: string };
  stranded?: number;
  /** rake_records count — an error means check (3) could not run. */
  rakedError?: { message: string };
  raked?: number;
}

interface Scenario {
  watermark: string;
  tournaments: Tournament[];
  behaviour: Record<string, Behaviour>;
}

const { mockFrom, mockRpc, mockReportError, recorded, scenario } = vi.hoisted(() => {
  const recorded: Recorded[] = [];
  const scenario: { current: Scenario; respond: (r: Recorded) => unknown } = {
    current: { watermark: '', tournaments: [], behaviour: {} },
    respond: () => ({ data: null, error: null }),
  };

  // Same shape as the settler's own cursor suite: one thenable proxy models the
  // whole PostgrestFilterBuilder, so the test does not need editing every time
  // the production query grows a clause.
  const from = (table: string) => {
    const rec: Recorded = { table, ops: [] };
    recorded.push(rec);
    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== 'string') return undefined;
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => scenario.respond(rec))
                .then(resolve, reject);
          }
          return (...args: unknown[]) => {
            rec.ops.push([prop, args]);
            return chain;
          };
        },
      }
    );
    return chain;
  };

  return {
    mockFrom: vi.fn(from),
    mockRpc: vi.fn(),
    mockReportError: vi.fn(),
    recorded,
    scenario,
  };
});

vi.mock('./supabase.js', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

vi.mock('./errorReporter.js', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
  reportWarning: vi.fn(),
}));

import { RakebackSettlerService } from './RakebackSettlerService.js';

/**
 * ISO-8601 with millisecond precision, on purpose: the sentinel normalises its
 * stored mark through `new Date(hwm).toISOString()` before the `.gt('ended_at')`
 * read, so a fixture in Postgres' own `2026-09-19 04:00:00+00` rendering would
 * sort BELOW every normalised mark on a plain string compare (' ' < 'T') and the
 * batch would come back empty. Fixed width keeps lexicographic order equal to
 * chronological order, which is how both the service and this fake compare.
 */
const at = (millis: number) => `2026-09-19T04:00:00.${String(millis).padStart(3, '0')}Z`;
const tid = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;

function tournament(n: number, endedAt: number, over: Partial<Tournament> = {}): Tournament {
  return {
    id: tid(n),
    name: `Event ${n}`,
    prize_pool: 100,
    variant: 'freezeout',
    satellite_target_id: null,
    ended_at: at(endedAt),
    ...over,
  };
}

const argOf = (rec: Recorded, name: string, index = 0): unknown =>
  rec.ops.find(([n]) => n === name)?.[1][index];

const eqValue = (rec: Recorded, column: string): unknown =>
  rec.ops.find(([n, a]) => n === 'eq' && a[0] === column)?.[1][1];

const sentinelUpserts = () =>
  recorded.filter(
    (r) =>
      r.table === 'daemon_state' &&
      r.ops.some(
        ([n, a]) =>
          n === 'upsert' &&
          (a[0] as { daemon?: string } | undefined)?.daemon === 'tournament_sentinel'
      )
  );

/** The watermark this cycle actually made durable. */
const writtenWatermark = () => {
  const upserts = sentinelUpserts();
  expect(upserts).toHaveLength(1);
  return (upserts[0].ops.find(([n]) => n === 'upsert')![1][0] as { high_water_mark: string })
    .high_water_mark;
};

/** Which tournaments the NEXT cycle would read, applying the real `>` filter. */
const rescannedNextCycle = (s: Scenario) =>
  s.tournaments.filter((t) => t.ended_at > writtenWatermark()).map((t) => t.id);

const reportedContexts = () => mockReportError.mock.calls.map(([, context]) => context as string);

const reportedFor = (id: string) =>
  mockReportError.mock.calls
    .filter(([, , extra]) => (extra as { tournamentId?: string } | undefined)?.tournamentId === id)
    .map(([, context]) => context as string);

function install(s: Scenario) {
  scenario.current = s;
  scenario.respond = (rec: Recorded) => {
    if (rec.table === 'daemon_state') {
      if (rec.ops.some(([n]) => n === 'upsert')) return { data: null, error: null };
      const daemon = eqValue(rec, 'daemon');
      if (daemon === 'tournament_sentinel')
        return { data: { high_water_mark: s.watermark }, error: null };
      // Park every other daemon far in the future so this suite exercises the
      // tournament sentinel alone.
      return { data: { high_water_mark: '2999-12-27T00:00:00+00' }, error: null };
    }

    if (rec.table === 'tournaments') {
      const since = String(argOf(rec, 'gt', 1));
      const limit = Number(argOf(rec, 'limit') ?? s.tournaments.length);
      return {
        data: s.tournaments
          .filter((t) => t.ended_at > since)
          .sort((a, b) => a.ended_at.localeCompare(b.ended_at))
          .slice(0, limit),
        error: null,
      };
    }

    const id = String(eqValue(rec, 'tournament_id'));
    const b = s.behaviour[id] ?? {};

    if (rec.table === 'tournament_players') {
      // The prize read selects 'prize'; the stranded read is a head count on 'id'.
      const selected = String(argOf(rec, 'select') ?? '');
      if (selected === 'prize')
        return b.prizeError
          ? { data: null, error: b.prizeError }
          : { data: b.prizeRows ?? [{ prize: 100 }], error: null };
      return b.strandedError
        ? { data: null, count: null, error: b.strandedError }
        : { data: null, count: b.stranded ?? 0, error: null };
    }

    if (rec.table === 'rake_records')
      return b.rakedError
        ? { data: null, count: null, error: b.rakedError }
        : { data: null, count: b.raked ?? 0, error: null };

    return { data: [], count: 0, error: null };
  };
}

const runSentinel = () =>
  (
    new RakebackSettlerService() as unknown as { runTournamentSentinel(): Promise<void> }
  ).runTournamentSentinel();

describe('the tournament sentinel and reads it could not complete', () => {
  beforeEach(() => {
    recorded.length = 0;
    mockFrom.mockClear();
    mockRpc.mockReset();
    mockReportError.mockReset();
  });

  it('advances across a batch it fully checked, and reports nothing', async () => {
    const s: Scenario = {
      watermark: at(100),
      tournaments: [tournament(1, 200), tournament(2, 300), tournament(3, 400)],
      behaviour: {},
    };
    install(s);
    await runSentinel();

    expect(reportedContexts()).toEqual([]);
    expect(writtenWatermark()).toBe(at(400));
    expect(rescannedNextCycle(s)).toEqual([]);
  });

  it.each([
    ['payout conservation', 'prizeError', 'TournamentSentinel.payout_conservation_unchecked'],
    ['stranded players', 'strandedError', 'TournamentSentinel.stranded_players_unchecked'],
    ['raked hands', 'rakedError', 'TournamentSentinel.raked_tournament_hands_unchecked'],
  ] as const)(
    'reports the failed %s read AND holds the watermark behind that tournament',
    async (_label, key, context) => {
      const s: Scenario = {
        watermark: at(100),
        tournaments: [tournament(1, 200), tournament(2, 300), tournament(3, 400)],
        behaviour: { [tid(2)]: { [key]: { message: 'PostgREST 503' } } },
      };
      install(s);
      await runSentinel();

      // 1. the failure SURFACES — silence here is the original defect.
      expect(reportedFor(tid(2))).toContain(context);

      // 2. the watermark never crosses the tournament nobody could check, so the
      //    next bounded cycle reads it again. It still keeps the checked prefix.
      expect(writtenWatermark()).toBe(at(200));
      expect(rescannedNextCycle(s)).toEqual([tid(2), tid(3)]);
    }
  );

  it('keeps checking the rest of the batch instead of stalling on one bad row', async () => {
    const s: Scenario = {
      watermark: at(100),
      tournaments: [tournament(1, 200), tournament(2, 300), tournament(3, 400)],
      behaviour: {
        [tid(2)]: { prizeError: { message: 'PostgREST 503' } },
        // A genuine breach on a LATER tournament must still be reported in this
        // same pass, not deferred behind the unreadable one.
        [tid(3)]: { prizeRows: [{ prize: 40 }], stranded: 2, raked: 1 },
      },
    };
    install(s);
    await runSentinel();

    expect(reportedFor(tid(3))).toEqual([
      'TournamentSentinel.payout_conservation',
      'TournamentSentinel.stranded_players',
      'TournamentSentinel.raked_tournament_hands',
    ]);
    expect(rescannedNextCycle(s)).toEqual([tid(2), tid(3)]);
  });

  it('does not step over an unreadable tournament that ties an already checked one', async () => {
    // Equal ended_at is the case a naive "hold the mark where it is" gets wrong:
    // the next read filters `ended_at > mark`, so a mark EQUAL to the unchecked
    // tournament's finish time skips it just as surely as one past it.
    const s: Scenario = {
      watermark: at(100),
      tournaments: [tournament(1, 300), tournament(2, 300), tournament(3, 400)],
      behaviour: { [tid(2)]: { strandedError: { message: 'PostgREST 503' } } },
    };
    install(s);
    await runSentinel();

    expect(reportedFor(tid(2))).toContain('TournamentSentinel.stranded_players_unchecked');
    expect(writtenWatermark() < at(300)).toBe(true);
    expect(rescannedNextCycle(s)).toContain(tid(2));
  });

  it('still advances past a tournament whose skipped pool check is a deliberate exemption', async () => {
    // A satellite is EXEMPT from check (1) by design — it never reads prizes at
    // all, so there is no failed read and nothing to hold the mark back.
    const s: Scenario = {
      watermark: at(100),
      tournaments: [tournament(1, 200, { variant: 'satellite' }), tournament(2, 300)],
      behaviour: {},
    };
    install(s);
    await runSentinel();

    expect(reportedContexts()).toEqual([]);
    expect(writtenWatermark()).toBe(at(300));
    expect(rescannedNextCycle(s)).toEqual([]);
  });
});
