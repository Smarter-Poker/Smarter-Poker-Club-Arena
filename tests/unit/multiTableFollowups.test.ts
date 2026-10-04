/**
 * MULTI-TABLE FOLLOW-UPS (2026-10-04)
 *
 * Eight defects found reviewing the day's tournament work on the tab strip,
 * each pinned here:
 *
 *   1. The lobby tab's landing list is ONE-SHOT. It used to stay stamped, so
 *      every later remount of the lobby in that tab was sent to tournaments.
 *   2. A second Browse Full Lobby for the same list lands again.
 *   3. A move is announced once per MOVE, not once per destination per mount.
 *   4. A tournament list nobody could read is not "No Open Tournaments".
 *   5. The tournament chunk download is inside the Quick Join timeout.
 *   6. A cash table that was READ as cash never gets the tournament sheet.
 *   7. A move onto a table already open as a tab stamps that tab as moved.
 *   8. The seat-row move keeps the buy-in; a failed tournament sheet falls to
 *      the tournament list.
 *
 * Source pins are bounded by structures (a declaration to the next one), never
 * by a character count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween, sliceMethod } from '../helpers/sourceWindow';
import { claimMoveAnnouncement, quickJoinIsTournament } from '../../src/lib/quickJoinRanking';

const h = vi.hoisted(() => ({
  getTournaments: vi.fn(),
  reportError: vi.fn(),
  tableRead: { data: null as unknown, error: null as unknown },
  tournamentRead: { data: null as unknown, error: null as unknown },
}));

vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: { getTournaments: h.getTournaments },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: h.reportError }));

vi.mock('../../src/lib/supabase', () => {
  const chain = (many: () => unknown, one: () => unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'limit', 'order']) c[m] = () => c;
    c.maybeSingle = () => Promise.resolve(one());
    c.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      Promise.resolve(many()).then(ok, bad);
    return c;
  };
  const empty = { data: [], error: null };
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'tables') {
          return chain(
            () => empty,
            () => h.tableRead
          );
        }
        if (table === 'tournaments') {
          return chain(
            () => empty,
            () => h.tournamentRead
          );
        }
        return chain(
          () => empty,
          () => ({ data: null, error: null })
        );
      },
    },
  };
});

import { quickJoinTournamentRows, readTournamentContext } from '../../src/lib/quickJoinTournaments';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');
const MULTI = read('src/pages/MultiTablePage.tsx');
const HOME = read('src/pages/ClubHomePage.tsx');
const HANDLER = sliceBetween(
  MULTI,
  'const handleAddTable = useCallback(',
  'const handleQuickJoinPick'
);

beforeEach(() => {
  h.getTournaments.mockReset();
  h.reportError.mockReset();
  h.tableRead = { data: null, error: null };
  h.tournamentRead = { data: null, error: null };
});

// ─── 1 + 2: the landing list is one-shot, and every request lands ────────────

describe('Browse Full Lobby lands on its list once per request', () => {
  const open = sliceBetween(
    MULTI,
    'const openLobbyTabOn = useCallback(',
    'const consumeLobbyLanding = useCallback('
  );
  const consume = sliceBetween(
    MULTI,
    'const consumeLobbyLanding = useCallback(',
    'const handleAddTable = useCallback('
  );

  it('every request stamps the list AND a fresh nonce, the same list included', () => {
    expect(open).toContain('lobbyLandingNonceRef.current += 1;');
    expect(open).toContain('lobbyGameType: list, lobbyLandingNonce: nonce');
    // The old guard made a repeat request for the same list a no-op.
    expect(open).not.toContain('t.lobbyGameType !== list');
    expect(open).toContain('cur.some(isLobbyTab)');
  });

  it('the page is keyed on the request, not on the list', () => {
    expect(MULTI).toContain('key={`${selectedClub}:${table.lobbyLandingNonce ?? 0}`}');
    expect(MULTI).not.toContain("${table.lobbyGameType ?? ''}");
    expect(MULTI).toContain('onInitialGameTypeConsumed={() => consumeLobbyLanding(table.id)}');
  });

  it('consuming clears the list and keeps the nonce, so nothing remounts', () => {
    expect(consume).toContain('{ ...t, lobbyGameType: undefined }');
    expect(consume).not.toContain('lobbyLandingNonce:');
    // An already-clear tab returns the same array: no render, no loop.
    expect(consume).toContain('t.id === tabId && t.lobbyGameType !== undefined');
  });

  it('neither moves the active tab', () => {
    for (const block of [open, consume]) expect(block).not.toContain('setActiveIndex');
  });

  it('the lobby page holds the landing for its own mount and reports it applied once', () => {
    expect(HOME).toContain(
      'const landingGameTypeRef = useRef<EmbeddedLobbyList | undefined>(initialGameType);'
    );
    const effect = sliceBetween(
      HOME,
      'if (viewPrefsOwner.current === resolvedClubId) return;',
      'Record a preference and write it through in the same breath.'
    );
    expect(effect).toContain("const tab = landingGameTypeRef.current ?? p.tab ?? 'ALL';");
    const applied = effect.indexOf('if (!viewPrefsTouched.current) applyView(saved);');
    const reported = effect.indexOf('onInitialGameTypeConsumedRef.current?.()');
    expect(applied).toBeGreaterThan(0);
    expect(reported).toBeGreaterThan(applied);
    expect(effect).toContain('if (!landingReportedRef.current) {');
    // The cleared prop must not re-run this effect: that would cancel the
    // database's correction of the saved view for this visit.
    expect(effect).toContain('}, [resolvedClubId]);');
    // A club switch inside one mount drops the landing with the old club.
    expect(effect).toContain('if (switchingClubs) landingGameTypeRef.current = undefined;');
    // The wrapper hands the callback to the page content.
    expect(HOME.match(/onInitialGameTypeConsumed=\{onInitialGameTypeConsumed\}/g)).toHaveLength(1);
  });
});

// ─── 3: one announcement per move ────────────────────────────────────────────

describe('claimMoveAnnouncement', () => {
  it('A to B, back to A, then to B again is three announcements', () => {
    const said = new Set<string>();
    expect(claimMoveAnnouncement(said, 'A', 'B')).toBe(true);
    expect(claimMoveAnnouncement(said, 'B', 'A')).toBe(true);
    expect(claimMoveAnnouncement(said, 'A', 'B')).toBe(true);
    expect(claimMoveAnnouncement(said, 'B', 'A')).toBe(true);
  });

  it('one move heard on both transports is one announcement', () => {
    const said = new Set<string>();
    expect(claimMoveAnnouncement(said, 'A', 'B')).toBe(true);
    expect(claimMoveAnnouncement(said, 'A', 'B')).toBe(false);
    // ... and still one after the next move has been heard twice too.
    expect(claimMoveAnnouncement(said, 'B', 'C')).toBe(true);
    expect(claimMoveAnnouncement(said, 'B', 'C')).toBe(false);
  });

  it('two tabs moving at once do not silence or double each other', () => {
    const said = new Set<string>();
    expect(claimMoveAnnouncement(said, 'A', 'B')).toBe(true);
    expect(claimMoveAnnouncement(said, 'C', 'D')).toBe(true);
    expect(claimMoveAnnouncement(said, 'A', 'B')).toBe(false);
    expect(claimMoveAnnouncement(said, 'C', 'D')).toBe(false);
  });

  it('remembers only moves into tables the hero has not left', () => {
    const said = new Set<string>();
    for (const [from, to] of [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'A'],
      ['A', 'B'],
    ]) {
      claimMoveAnnouncement(said, from, to);
    }
    expect(Array.from(said)).toEqual(['A->B']);
  });

  it('both transports claim the move with its source, through the one announcer', () => {
    const announcer = sliceBetween(
      MULTI,
      'const announceTournamentMove = useCallback(',
      'const announceTournamentMoveRef = useRef'
    );
    expect(announcer).toContain(
      'if (!claimMoveAnnouncement(announcedMovesRef.current, fromId, destinationId)) return;'
    );
    expect(announcer).not.toContain('announcedMovesRef.current.has(destinationId)');
    // The seat-row path knows the tab it re-pointed ...
    expect(MULTI).toContain('announceTournamentMove(oldTab.id, newId, name);');
    // ... and the socket path knows the table that reported the move.
    expect(MULTI).toMatch(
      /announceTournamentMoveRef\.current\(\s*tableId,\s*updates\.movedToTableId\s*\)/
    );
  });
});

// ─── 4: an unreadable list is not an empty list ──────────────────────────────

describe('quickJoinTournamentRows when the list cannot be read', () => {
  const context = { id: 'current', clubId: 'club-1', buyIn: 55, variant: 'nlh', format: 'mtt' };
  const row = (id: string) => ({
    id,
    name: `event ${id}`,
    game_type: 'nlh',
    format_contract: 'mtt-v2',
    buy_in_amount: 50,
    buy_in_fee: 5,
    start_time: new Date(Date.now() + 3600_000).toISOString(),
    status: 'REGISTERING',
    current_players: 12,
    max_players: null,
    late_reg_mins: 0,
    late_reg_levels: 0,
  });

  it('asks the service to throw rather than answer [] for a failure', async () => {
    h.getTournaments.mockResolvedValue([]);
    await quickJoinTournamentRows(['club-1'], context as never, 'user-1');
    expect(h.getTournaments).toHaveBeenCalledWith('club-1', { throwOnError: true });
  });

  it('is null when EVERY club read failed, and each failure is reported', async () => {
    h.getTournaments.mockRejectedValue({ message: 'timeout' });
    await expect(
      quickJoinTournamentRows(['hub', 'club-1'], context as never, 'user-1')
    ).resolves.toBeNull();
    const reported = h.reportError.mock.calls.filter(
      (c) => c[1] === 'QuickJoinTournaments.list_read_failed'
    );
    expect(reported.map((c) => c[2])).toEqual([{ clubId: 'hub' }, { clubId: 'club-1' }]);
  });

  it('keeps a partial answer: one readable club is a list', async () => {
    h.getTournaments.mockImplementation(async (clubId: string) => {
      if (clubId === 'hub') throw new Error('timeout');
      return [row('open')];
    });
    const rows = await quickJoinTournamentRows(['hub', 'club-1'], context as never, 'user-1');
    expect(rows?.map((r) => r.id)).toEqual(['open']);
  });

  it('a club that was read and is empty is still an empty LIST', async () => {
    h.getTournaments.mockResolvedValue([]);
    await expect(quickJoinTournamentRows(['club-1'], context as never, 'user-1')).resolves.toEqual(
      []
    );
  });

  it('the service throws only when asked, before its "no rows" answer', () => {
    const method = sliceMethod(read('src/services/TournamentService.ts'), 'async getTournaments(');
    expect(method).toContain('options?: { throwOnError?: boolean }');
    const guard = sliceBetween(method, 'if (error) {', '// Also fetch XMTT tournaments');
    const thrown = guard.indexOf('if (options?.throwOnError) throw error;');
    expect(thrown).toBeGreaterThan(0);
    expect(guard.indexOf('return [];')).toBeGreaterThan(thrown);
  });

  it('null takes the stalled exit, which lands on the tournament list', () => {
    const exit = sliceBetween(HANDLER, 'if (tournamentRows === null) {', 'setQuickJoin((q) =>');
    expect(exit).toContain('openLobbyTabOn(lobbyList);');
    expect(exit).toContain('return;');
  });
});

// ─── 5: the chunk download is inside the timeout ─────────────────────────────

describe('the tournament module load cannot hold the sheet', () => {
  const IMPORT = "import('../lib/quickJoinTournaments')";

  it('every dynamic import of it is inside a withTimeout call', () => {
    const parts = HANDLER.split(IMPORT);
    expect(parts.length - 1).toBe(2);
    // Walk back from each import to the nearest `withTimeout(` and check its
    // parenthesis is still open at the import.
    let offset = 0;
    for (const before of parts.slice(0, -1)) {
      offset += before.length;
      const upTo = HANDLER.slice(0, offset);
      const call = upTo.lastIndexOf('withTimeout(');
      expect(call).toBeGreaterThan(0);
      let depth = 0;
      for (const ch of upTo.slice(call + 'withTimeout'.length)) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
      }
      expect(depth).toBeGreaterThan(0);
      offset += IMPORT.length;
    }
  });

  it('the first ask is one timed chain: module, then the table read', () => {
    const ask = sliceBetween(HANDLER, 'const tournamentAsk = activeIsTable', 'const [spinRows');
    expect(ask).toMatch(/\? withTimeout\(\s*import\('\.\.\/lib\/quickJoinTournaments'\)\.then\(/);
    expect(ask).toContain('ctx: await mod.readTournamentContext(activeTableId),');
  });
});

// ─── 6: a table read as cash is cash ─────────────────────────────────────────

describe('a cash table that was read is never a tournament sheet', () => {
  it('readTournamentContext tells "read as cash" from "could not be read"', async () => {
    h.tableRead = { data: { id: 't1', tournament_id: null }, error: null };
    await expect(readTournamentContext('t1')).resolves.toEqual({ format: 'cash' });

    h.tableRead = { data: null, error: { message: 'timeout' } };
    await expect(readTournamentContext('t1')).resolves.toBeNull();
    expect(h.reportError).toHaveBeenCalledWith(
      { message: 'timeout' },
      'QuickJoinTournaments.table_read_failed',
      { activeTableId: 't1' }
    );

    // A row this viewer cannot see is not evidence of a cash table.
    h.tableRead = { data: null, error: null };
    await expect(readTournamentContext('t1')).resolves.toBeNull();
    await expect(readTournamentContext(null)).resolves.toBeNull();
  });

  it('a tournament table whose event will not load is unreadable, not cash', async () => {
    h.tableRead = { data: { id: 't1', tournament_id: 'tour-1' }, error: null };
    h.tournamentRead = { data: null, error: { message: 'rls' } };
    await expect(readTournamentContext('t1')).resolves.toBeNull();
    expect(h.reportError).toHaveBeenCalledWith(
      { message: 'rls' },
      'QuickJoinTournaments.tournament_read_failed',
      { activeTableId: 't1' }
    );
  });

  it('the row outranks the tab; the tab decides only when the row is unreadable', () => {
    // A cash game named "MTT Warmup": the tab guesses tournament, the row says cash.
    expect(quickJoinIsTournament({ format: 'cash' }, true)).toBe(false);
    expect(quickJoinIsTournament({ format: 'cash' }, false)).toBe(false);
    // Unreadable: the guess is all there is.
    expect(quickJoinIsTournament(null, true)).toBe(true);
    expect(quickJoinIsTournament(null, false)).toBe(false);
    // Read as a tournament: either witness was enough, and a Spin keeps its own sheet.
    expect(quickJoinIsTournament({ format: 'mtt' }, false)).toBe(true);
    expect(quickJoinIsTournament({ format: 'sng' }, false)).toBe(true);
    expect(quickJoinIsTournament({ format: 'unknown' }, false)).toBe(true);
    expect(quickJoinIsTournament({ format: 'spin' }, true)).toBe(false);
  });

  it('the handler decides with that rule and never ranks against a cash "context"', () => {
    expect(HANDLER).toContain(
      'const inTournament = quickJoinIsTournament(tableRead, tabSaysTournament);'
    );
    expect(HANDLER).toContain(
      "const tournamentCtx = tableRead && tableRead.format !== 'cash' ? tableRead : null;"
    );
  });
});

// ─── 7: a move onto an already-open tab ──────────────────────────────────────

describe('a tournament move onto a table already open as a tab', () => {
  const branch = sliceBetween(
    MULTI,
    'if (prev.some((t) => t.id === dest)) {',
    'const next = prev.slice();'
  );

  it('closes the old tab and stamps the open one as moved and seated', () => {
    // A cash must-move closes the old tab and says nothing more, as before.
    expect(branch).toContain(
      'if (!current.isTournament) return prev.filter((t) => t.id !== tableId);'
    );
    expect(branch).toMatch(/return prev\s*\.filter\(\(t\) => t\.id !== tableId\)\s*\.map\(/);
    expect(branch).toMatch(
      /t\.id === dest \? \{ \.\.\.t, arrivedByMoveAt: Date\.now\(\), seated: true \} : t/
    );
  });

  it('touches no active index', () => {
    expect(branch).not.toContain('setActiveIndex');
  });
});

// ─── 8: the buy-in survives the seat-row move; a failed sheet keeps its list ──

describe('the seat-row move and the failure exit', () => {
  it('the re-pointed tab carries the tournament buy-in', () => {
    const repoint = sliceBetween(
      MULTI,
      "event: 'INSERT',",
      'announceTournamentMove(oldTab.id, newId, name);'
    );
    const literal = repoint.slice(repoint.indexOf('t.id === oldTab.id'));
    expect(literal).toContain('arrivedByMoveAt: Date.now(),');
    expect(literal).toContain('tournamentBuyIn: t.tournamentBuyIn,');
  });

  it('an exception under a tournament sheet opens the tournament list', () => {
    const tail = HANDLER.slice(HANDLER.lastIndexOf('} catch {'));
    expect(tail).toContain('if (sheetTournamentList) openLobbyTabOn(sheetTournamentList);');
    expect(tail).toContain("else masterBus.emit('OPEN_LOBBY_TAB', {});");
  });

  it('the list follows the sheet: set by the tab, corrected by the row, dropped for cash', () => {
    expect(HANDLER).toMatch(
      /let sheetTournamentList: 'MTT' \| 'SNG' \| null = tabSaysTournament\s*\? tournamentLobbyFor\(\)\s*: null;/
    );
    const decided = sliceBetween(HANDLER, 'if (inTournament) {', '/* A cash table after all.');
    expect(decided).toContain('sheetTournamentList = lobbyList;');
    const cash = sliceBetween(HANDLER, '/* A cash table after all.', 'const [res, favIds]');
    expect(cash).toContain('sheetTournamentList = null;');
  });
});
