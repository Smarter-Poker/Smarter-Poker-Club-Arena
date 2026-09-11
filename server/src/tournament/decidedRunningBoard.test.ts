/**
 * THE DECIDED-BUT-RUNNING SWEEP: ONE READ FOR EVERY COUNT, AND AN UNREAD
 * COUNT IS STILL UNKNOWN (2026-09-11).
 *
 * GameServer's discovery pass awaited one exact count per RUNNING tournament
 * to find the decided ones: 368 of them at ~110 ms on production tonight,
 * ~40 s of every pass. The counts now come from decidedRunningBoard.ts - the
 * `playing` rows for a chunk of tournaments at a time, keyset-paged and
 * counted - and these tests hold the three things that change could get
 * wrong:
 *
 *   - the answers: 0 and 1 playing are decided, 2 or more are live, for every
 *     tournament, exactly as the per-tournament count said;
 *   - the payout-integrity rule: a tournament whose chunk failed, or whose
 *     paging stopped short, is UNKNOWN and skipped, never read as zero;
 *   - the wiring: GameServer uses the batch, no longer awaits a count inside
 *     the loop, and keeps the log line, both recoveries and the spacing its
 *     reads used to give them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockReportError = vi.fn();
vi.mock('../services/errorReporter.js', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

import {
  DECIDED_PLAYING_MAX,
  DECIDED_RECOVERY_STAGGER_MS,
  decidedRunningVerdicts,
  readPlayingCounts,
  verdictFor,
  type DecidedRunningVerdict,
  type PlayingCountRead,
  type PlayingRow,
  type PlayingRowsPage,
} from './decidedRunningBoard.js';
import { POSTGREST_PAGE } from '../services/supabase/pagination.js';
import { IN_LIST_CHUNK } from '../services/supabase/chunkedIn.js';
import { blankNonCode, sliceBetween, sliceBlockAfter } from '../testHelpers/sourceWindow.js';

beforeEach(() => mockReportError.mockReset());

// ── fixtures ────────────────────────────────────────────────────────────────

/** Deterministic PRNG, so a failing seed can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lower-case hex uuids order the way Postgres orders uuid bytes. */
function uuidFactory(seed: number): () => string {
  const rng = mulberry32(seed);
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join('');
  return () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}

interface PlayerRow {
  id: string;
  tournament_id: string;
  status: 'playing' | 'eliminated' | 'registered';
}

interface PageCall {
  tournamentIds: string[];
  cursor: string | null;
  want: number;
}

/**
 * A PostgREST double for the sweep's query on `tournament_players`: status
 * `playing`, tournament_id in the chunk, `id > cursor`, ordered by id, and
 * never more than db-max-rows per response, which is what the server does.
 */
function fakePlayers(
  table: readonly PlayerRow[],
  opts: {
    fail?: (call: PageCall, n: number) => boolean;
    throwOn?: (call: PageCall, n: number) => boolean;
    dropCursorColumn?: boolean;
  } = {}
) {
  const calls: PageCall[] = [];
  const sorted = [...table].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const page: PlayingRowsPage = (tournamentIds, cursor, want) => {
    const call = { tournamentIds: [...tournamentIds], cursor, want };
    const n = calls.push(call) - 1;
    if (opts.throwOn?.(call, n)) throw new Error('fetch failed');
    if (opts.fail?.(call, n)) {
      return Promise.resolve({ data: null, error: { message: 'supabase_timeout' } });
    }
    const wanted = new Set(tournamentIds);
    const data = sorted
      .filter(
        (r) =>
          r.status === 'playing' &&
          wanted.has(r.tournament_id) &&
          (cursor === null || r.id > cursor)
      )
      .slice(0, Math.min(want, POSTGREST_PAGE))
      .map(({ id, tournament_id }) =>
        opts.dropCursorColumn ? ({ tournament_id } as unknown as PlayingRow) : { id, tournament_id }
      );
    return Promise.resolve({ data, error: null });
  };
  return { page, calls };
}

/** A board: tournament id -> how many are still playing (plus some who are not). */
function buildBoard(fields: ReadonlyMap<string, number>, seed: number): PlayerRow[] {
  const uuid = uuidFactory(seed);
  const rows: PlayerRow[] = [];
  for (const [tournamentId, playing] of fields) {
    for (let i = 0; i < playing; i++) {
      rows.push({ id: uuid(), tournament_id: tournamentId, status: 'playing' });
    }
    // Busted players are rows too, and must never count.
    rows.push({ id: uuid(), tournament_id: tournamentId, status: 'eliminated' });
    rows.push({ id: uuid(), tournament_id: tournamentId, status: 'eliminated' });
  }
  return rows;
}

/** What the old per-tournament exact count would have said, as a verdict. */
function oldCountVerdict(playing: number): DecidedRunningVerdict {
  return playing > 1
    ? { kind: 'live', playingCount: playing }
    : { kind: 'decided', playingCount: playing };
}

const read = (
  tournamentIds: string[],
  rows: Array<{ tournament_id: string }>,
  complete = true
): PlayingCountRead => ({ tournamentIds, rows, complete });

const times = (tournamentId: string, n: number) =>
  Array.from({ length: n }, () => ({ tournament_id: tournamentId }));

// ── the verdicts ────────────────────────────────────────────────────────────

describe('decidedRunningVerdicts', () => {
  it('reads 0 and 1 playing as decided and 2 or more as live, with the exact count', () => {
    const verdicts = decidedRunningVerdicts([
      read(
        ['none', 'one', 'two', 'field'],
        [...times('one', 1), ...times('two', 2), ...times('field', 37)]
      ),
    ]);

    expect(verdictFor(verdicts, 'none')).toEqual({ kind: 'decided', playingCount: 0 });
    expect(verdictFor(verdicts, 'one')).toEqual({ kind: 'decided', playingCount: 1 });
    expect(verdictFor(verdicts, 'two')).toEqual({ kind: 'live', playingCount: 2 });
    expect(verdictFor(verdicts, 'field')).toEqual({ kind: 'live', playingCount: 37 });
    // The boundary is the old loop's `if (playingCount > 1) continue;`.
    expect(DECIDED_PLAYING_MAX).toBe(1);
  });

  it('an incomplete read is UNKNOWN for every tournament in it, whatever it saw', () => {
    // The dangerous shape: `none` came back with no rows and `one` with one
    // row. Trusted, that is "decided (0)" and "decided (1)" - two false
    // recoveries on the strength of a read that never finished.
    const verdicts = decidedRunningVerdicts([
      read(['none', 'one', 'two'], [...times('one', 1), ...times('two', 2)], false),
    ]);

    for (const id of ['none', 'one', 'two']) {
      expect(verdictFor(verdicts, id)).toEqual({ kind: 'unknown' });
    }
  });

  it('a failed chunk leaves every other chunk standing', () => {
    const verdicts = decidedRunningVerdicts([
      read(['a', 'b'], [...times('a', 1), ...times('b', 3)]),
      read(['c', 'd'], [], false),
      read(['e'], []),
    ]);

    expect(verdictFor(verdicts, 'a')).toEqual({ kind: 'decided', playingCount: 1 });
    expect(verdictFor(verdicts, 'b')).toEqual({ kind: 'live', playingCount: 3 });
    expect(verdictFor(verdicts, 'c')).toEqual({ kind: 'unknown' });
    expect(verdictFor(verdicts, 'd')).toEqual({ kind: 'unknown' });
    expect(verdictFor(verdicts, 'e')).toEqual({ kind: 'decided', playingCount: 0 });
  });

  it('a tournament no read asked about is unknown, never zero', () => {
    const verdicts = decidedRunningVerdicts([read(['a'], [])]);
    expect(verdictFor(verdicts, 'never-asked')).toEqual({ kind: 'unknown' });
    expect(verdictFor(decidedRunningVerdicts([]), 'a')).toEqual({ kind: 'unknown' });
  });

  it('does not count a row for a tournament its read did not ask about', () => {
    const verdicts = decidedRunningVerdicts([read(['a'], [...times('a', 1), ...times('x', 5)])]);
    expect(verdictFor(verdicts, 'a')).toEqual({ kind: 'decided', playingCount: 1 });
    expect(verdictFor(verdicts, 'x')).toEqual({ kind: 'unknown' });
  });

  it('unknown wins whenever any read of a tournament did not finish, in either order', () => {
    const complete = read(['a'], times('a', 1));
    const failed = read(['a'], [], false);
    expect(verdictFor(decidedRunningVerdicts([complete, failed]), 'a').kind).toBe('unknown');
    expect(verdictFor(decidedRunningVerdicts([failed, complete]), 'a').kind).toBe('unknown');
  });
});

// ── the read ────────────────────────────────────────────────────────────────

describe('readPlayingCounts', () => {
  it('reads the 368-tournament board in two requests instead of 368', async () => {
    const fields = new Map<string, number>();
    const uuid = uuidFactory(368);
    for (let i = 0; i < 368; i++) fields.set(uuid(), i % 3); // 0, 1, 2, 0, 1, 2, ...
    const fake = fakePlayers(buildBoard(fields, 1));

    const verdicts = decidedRunningVerdicts(await readPlayingCounts([...fields.keys()], fake.page));

    expect(fake.calls).toHaveLength(Math.ceil(368 / IN_LIST_CHUNK));
    for (const [id, playing] of fields) {
      expect(verdictFor(verdicts, id)).toEqual(oldCountVerdict(playing));
    }
  });

  it('gives every tournament the verdict its own exact count would have, on any board', async () => {
    // Random boards shaped like production: mostly Spins and SNGs with 0-3
    // playing, a tail of MTTs up to 1,500, so chunks cross the 1,000-row page.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rng = mulberry32(seed);
      const uuid = uuidFactory(seed * 101);
      const size = 1 + Math.floor(rng() * 900);
      const fields = new Map<string, number>();
      for (let i = 0; i < size; i++) {
        const roll = rng();
        const playing =
          roll < 0.55
            ? Math.floor(rng() * 2) // 0 or 1: decided
            : roll < 0.9
              ? 2 + Math.floor(rng() * 8)
              : 10 + Math.floor(rng() * 1491);
        fields.set(uuid(), playing);
      }
      const chunkSize = rng() < 0.5 ? IN_LIST_CHUNK : 1 + Math.floor(rng() * IN_LIST_CHUNK);
      const fake = fakePlayers(buildBoard(fields, seed * 7));

      const reads = await readPlayingCounts([...fields.keys()], fake.page, { chunkSize });
      const verdicts = decidedRunningVerdicts(reads);

      expect(reads.every((r) => r.complete)).toBe(true);
      for (const [id, playing] of fields) {
        expect(verdictFor(verdicts, id), `seed ${seed}, ${id}`).toEqual(oldCountVerdict(playing));
      }
      // One request per chunk, plus one for every full page a chunk fills:
      // never one per tournament.
      const expectedCalls = reads.reduce(
        (sum, r) => sum + 1 + Math.floor(r.rows.length / POSTGREST_PAGE),
        0
      );
      expect(fake.calls).toHaveLength(expectedCalls);
      expect(reads).toHaveLength(Math.ceil(size / chunkSize));
    }
  });

  it('pages a chunk past the 1,000-row cap by keyset, and counts every page', async () => {
    const fields = new Map([
      ['mtt', 1_500],
      ['spin', 1],
      ['empty', 0],
    ]);
    const table = buildBoard(fields, 11);
    const fake = fakePlayers(table);

    const reads = await readPlayingCounts([...fields.keys()], fake.page);
    const verdicts = decidedRunningVerdicts(reads);

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].cursor).toBeNull();
    // The second page starts after the last id of the first, not at an offset.
    const playingIds = table
      .filter((r) => r.status === 'playing')
      .map((r) => r.id)
      .sort();
    expect(fake.calls[1].cursor).toBe(playingIds[POSTGREST_PAGE - 1]);
    expect(verdictFor(verdicts, 'mtt')).toEqual({ kind: 'live', playingCount: 1_500 });
    expect(verdictFor(verdicts, 'spin')).toEqual({ kind: 'decided', playingCount: 1 });
    expect(verdictFor(verdicts, 'empty')).toEqual({ kind: 'decided', playingCount: 0 });
  });

  it('a page that fails part-way through a chunk leaves the WHOLE chunk unknown', async () => {
    // The Spin has two players still playing. One sorts onto page one, the
    // other onto page two, and page two never arrives: page one alone says
    // "one playing - decided". So does the empty SNG's "none". Both must be
    // unknown, because the read that would have said otherwise did not finish.
    const table: PlayerRow[] = [
      { id: '0000-spin-a', tournament_id: 'spin', status: 'playing' },
      ...Array.from({ length: 1_200 }, (_, i) => ({
        id: `5000-mtt-${String(i).padStart(4, '0')}`,
        tournament_id: 'mtt',
        status: 'playing' as const,
      })),
      { id: '9999-spin-b', tournament_id: 'spin', status: 'playing' },
    ];
    const fake = fakePlayers(table, { fail: (call) => call.cursor !== null });

    const reads = await readPlayingCounts(['spin', 'mtt', 'sng'], fake.page, { pageAttempts: 1 });
    const verdicts = decidedRunningVerdicts(reads);

    expect(reads).toEqual([expect.objectContaining({ complete: false })]);
    // What the partial rows would have claimed, had anything trusted them:
    expect(reads[0].rows.filter((r) => r.tournament_id === 'spin')).toHaveLength(1);
    for (const id of ['spin', 'mtt', 'sng']) {
      expect(verdictFor(verdicts, id)).toEqual({ kind: 'unknown' });
    }
    expect(mockReportError).toHaveBeenCalledWith(
      expect.anything(),
      'GameServer.decidedRunningBoard.page_failed'
    );
  });

  it('a chunk that fails leaves the chunks around it read and answered', async () => {
    const uuid = uuidFactory(450);
    const ids = Array.from({ length: 450 }, () => uuid());
    const fields = new Map(ids.map((id, i) => [id, i % 4]));
    const secondChunk = new Set(ids.slice(IN_LIST_CHUNK, 2 * IN_LIST_CHUNK));
    const fake = fakePlayers(buildBoard(fields, 3), {
      fail: (call) => secondChunk.has(call.tournamentIds[0]),
    });

    const reads = await readPlayingCounts(ids, fake.page, { pageAttempts: 1 });
    const verdicts = decidedRunningVerdicts(reads);

    expect(reads.map((r) => r.complete)).toEqual([true, false, true]);
    for (const [id, playing] of fields) {
      expect(verdictFor(verdicts, id)).toEqual(
        secondChunk.has(id) ? { kind: 'unknown' } : oldCountVerdict(playing)
      );
    }
  });

  it('a transient failure is retried before anything is called unknown', async () => {
    // fetchAllRows re-asks a failed page (PAGE_ATTEMPTS). One dropped packet
    // must not cost a chunk its answers.
    const fields = new Map([
      ['spin', 1],
      ['sng', 3],
    ]);
    const fake = fakePlayers(buildBoard(fields, 5), { fail: (_call, n) => n === 0 });

    const verdicts = decidedRunningVerdicts(await readPlayingCounts([...fields.keys()], fake.page));

    expect(fake.calls).toHaveLength(2);
    expect(verdictFor(verdicts, 'spin')).toEqual({ kind: 'decided', playingCount: 1 });
    expect(verdictFor(verdicts, 'sng')).toEqual({ kind: 'live', playingCount: 3 });
  });

  it('a query that throws is an unknown chunk, never an exception out of the pass', async () => {
    const uuid = uuidFactory(250);
    const ids = Array.from({ length: 250 }, () => uuid());
    const fields = new Map(ids.map((id) => [id, 1]));
    const fake = fakePlayers(buildBoard(fields, 9), { throwOn: (_call, n) => n === 0 });

    const reads = await readPlayingCounts(ids, fake.page, { pageAttempts: 1 });
    const verdicts = decidedRunningVerdicts(reads);

    expect(reads.map((r) => r.complete)).toEqual([false, true]);
    for (const id of ids.slice(0, IN_LIST_CHUNK)) {
      expect(verdictFor(verdicts, id).kind).toBe('unknown');
    }
    for (const id of ids.slice(IN_LIST_CHUNK)) {
      expect(verdictFor(verdicts, id)).toEqual({ kind: 'decided', playingCount: 1 });
    }
    expect(mockReportError).toHaveBeenCalledWith(
      expect.any(Error),
      'GameServer.decidedRunningBoard.threw',
      expect.objectContaining({ chunkAt: 0, tournaments: 250 })
    );
  });

  it('a full page without its cursor column cannot be walked past, so it is unknown', async () => {
    const fields = new Map([
      ['mtt', 1_000],
      ['spin', 1],
    ]);
    const fake = fakePlayers(buildBoard(fields, 13), { dropCursorColumn: true });

    const verdicts = decidedRunningVerdicts(await readPlayingCounts([...fields.keys()], fake.page));

    expect(verdictFor(verdicts, 'spin')).toEqual({ kind: 'unknown' });
    expect(verdictFor(verdicts, 'mtt')).toEqual({ kind: 'unknown' });
    expect(mockReportError).toHaveBeenCalledWith(
      expect.any(Error),
      'GameServer.decidedRunningBoard.missing_cursor_key'
    );
  });

  it('a chunk that reaches the row ceiling is unknown, not truncated into an answer', async () => {
    const fields = new Map([
      ['sng', 7],
      ['spin', 1],
    ]);
    const fake = fakePlayers(buildBoard(fields, 17));

    const verdicts = decidedRunningVerdicts(
      await readPlayingCounts([...fields.keys()], fake.page, { maxRowsPerChunk: 5 })
    );

    expect(verdictFor(verdicts, 'sng').kind).toBe('unknown');
    expect(verdictFor(verdicts, 'spin').kind).toBe('unknown');
    expect(mockReportError).toHaveBeenCalledWith(
      expect.any(Error),
      'GameServer.decidedRunningBoard.row_ceiling'
    );
  });

  it('asks about each tournament once, never with a blank id, and never above the id-list cap', async () => {
    const fake = fakePlayers([]);
    const reads = await readPlayingCounts(['a', 'a', '', null, undefined, 'b'], fake.page, {
      chunkSize: 10_000,
    });
    expect(fake.calls.map((c) => c.tournamentIds)).toEqual([['a', 'b']]);
    expect(reads).toEqual([{ tournamentIds: ['a', 'b'], rows: [], complete: true }]);

    const uuid = uuidFactory(999);
    const many = Array.from({ length: 3 * IN_LIST_CHUNK + 1 }, () => uuid());
    const wide = fakePlayers([]);
    await readPlayingCounts(many, wide.page, { chunkSize: 10_000 });
    expect(wide.calls.map((c) => c.tournamentIds.length)).toEqual([
      IN_LIST_CHUNK,
      IN_LIST_CHUNK,
      IN_LIST_CHUNK,
      1,
    ]);
  });

  it('an empty board asks nothing', async () => {
    const fake = fakePlayers([]);
    expect(await readPlayingCounts([], fake.page)).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});

// ── the wiring in GameServer ────────────────────────────────────────────────

/*
 * GameServer's discovery pass has no seam a unit test can drive, so the
 * wiring is pinned by reading the source, the way the other discovery-pass
 * laws are (aStalledTournamentIsNoticed.law.test.ts). Windows are sliced by
 * structure (sourceWindow.ts), and every one is taken inside its own test so
 * that a missing anchor fails that pin and not the whole file.
 */
const GAME_SERVER = readFileSync(join(__dirname, '..', 'GameServer.ts'), 'utf8');
/** Comments out, strings kept: the query's column names are strings. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sweep = () =>
  code(
    sliceBetween(
      GAME_SERVER,
      '// ── STALLED DECIDED-BUT-RUNNING RECOVERY',
      '// ── STARTED-BUT-NEVER-DEALT RECOVERY'
    )
  );
const loop = () => sliceBlockAfter(GAME_SERVER, 'for (const t of decidedBoard)');

describe('the discovery pass reads the decided board through the batch', () => {
  it('builds its verdicts from one batched read', () => {
    expect(GAME_SERVER).toContain("from './tournament/decidedRunningBoard.js'");
    const src = sweep();
    expect(src).toMatch(
      /const decidedVerdicts = decidedRunningVerdicts\(\s*await readPlayingCounts\(/
    );
    expect(src).toContain('decidedBoard.map((t) => String(t.id))');
    expect(src).toContain('const verdict = verdictFor(decidedVerdicts, String(t.id));');
  });

  it('no longer awaits a count - or any read - inside the loop', () => {
    const body = blankNonCode(loop());
    expect(body).not.toContain('supabase');
    expect(body).not.toContain('.from(');
    expect(body).not.toContain('.rpc(');
    expect(body).not.toMatch(/\bcount\s*:/);
    expect(body).not.toMatch(/\bhead\s*:/);
    // The one await left in the loop is the spacing between recoveries.
    expect(body.match(/\bawait\b/g) ?? []).toHaveLength(1);
    expect(loop()).toContain('await this.sleep(DECIDED_RECOVERY_STAGGER_MS);');
  });

  it('reads the same rows the old count counted, keyset-paged on the primary key', () => {
    const src = sweep();
    expect(src).toContain(".from('tournament_players')");
    expect(src).toContain(".select('id, tournament_id')");
    expect(src).toContain(".eq('status', 'playing')");
    expect(src).toContain(".in('tournament_id', chunk)");
    expect(src).toContain(".order('id', { ascending: true })");
    expect(src).toContain('.limit(want)');
    expect(src).toContain("if (cursor) q = q.gt('id', cursor);");
  });

  it('skips an unread tournament before it logs or recovers anything', () => {
    const body = code(loop());
    const unknownAt = body.indexOf("if (verdict.kind === 'unknown') {");
    const liveAt = body.indexOf("if (verdict.kind === 'live') continue;");
    const logAt = body.indexOf('is decided (${playingCount} playing) - recovering the winner');
    const wakeAt = body.indexOf("idleTm.requestEliminationSweep('stalled_decided_survivor');");
    const admitAt = body.indexOf('this.ensureTournamentManagerAdmission(');
    expect(unknownAt).toBeGreaterThan(-1);
    expect(liveAt).toBeGreaterThan(unknownAt);
    expect(logAt).toBeGreaterThan(liveAt);
    expect(wakeAt).toBeGreaterThan(logAt);
    expect(admitAt).toBeGreaterThan(logAt);
    expect(sliceBlockAfter(body, "if (verdict.kind === 'unknown') {")).toMatch(
      /decidedUnread\+\+;\s*continue;/
    );
  });

  it('keeps the log line and both recoveries as they were', () => {
    const body = loop();
    expect(body).toContain(
      '`[GameServer] RUNNING tournament ${t.name} (${t.id.slice(0, 8)}) is decided (${playingCount} playing) - recovering the winner`'
    );
    expect(body).toContain('const idleTm = this.tournamentEngines.get(String(t.id));');
    expect(body).toMatch(
      /if \(idleTm\) \{\s*idleTm\.requestEliminationSweep\('stalled_decided_survivor'\);\s*\} else \{\s*this\.launchDiscoveryJob\(\s*this\.ensureTournamentManagerAdmission\(\s*String\(t\.id\),\s*'resume',\s*`Resuming decided tournament through its finish owner: \$\{t\.name\}`,\s*generation\s*\),\s*'GameServer\.stalled_decided_resume_failed',\s*\{ tournamentId: String\(t\.id\) \}\s*\);/
    );
  });

  it('keeps the spacing the reads gave the recoveries, and never waits before the first', () => {
    const body = code(loop());
    expect(body).toMatch(
      /if \(decidedRecoveries\+\+ > 0\) \{\s*await this\.sleep\(DECIDED_RECOVERY_STAGGER_MS\);\s*if \(!this\.directAdmissionIsCurrent\(generation\)\) break;\s*\}/
    );
    // It waits before the recovery it spaces, and looks the manager up after
    // the wait, the way the old loop looked it up after its count.
    const sleepAt = body.indexOf('await this.sleep(DECIDED_RECOVERY_STAGGER_MS);');
    expect(sleepAt).toBeGreaterThan(body.indexOf("if (verdict.kind === 'live') continue;"));
    expect(
      body.indexOf('const idleTm = this.tournamentEngines.get(String(t.id));')
    ).toBeGreaterThan(sleepAt);
    // No faster than one recovery per round trip of the count it replaced.
    expect(DECIDED_RECOVERY_STAGGER_MS).toBeGreaterThanOrEqual(110);
  });

  it('says so when a count could not be read', () => {
    const src = sweep();
    expect(src).toMatch(
      /if \(decidedUnread > 0\) \{\s*console\.warn\(\s*`\[GameServer\] Decided-but-RUNNING sweep could not read the playing count of \$\{decidedUnread\} of \$\{decidedBoard\.length\} tournament\(s\) - skipped this pass, not treated as decided`/
    );
  });
});
