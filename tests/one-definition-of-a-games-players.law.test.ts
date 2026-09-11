/**
 * ONE DEFINITION OF A GAME'S PLAYERS AND TABLES (2026-09-06).
 *
 * Three places answered "how many players and tables are in this cash game"
 * and all three answered differently. `fn_cash_cluster_census` is
 * authoritative - it is what `fn_cash_cluster_tick` reads to decide what the
 * game IS: how many tables it has, which is Main 1, when a feeder opens and
 * when one breaks. A read path that disagrees with it shows the player a
 * different game from the one the controller is running.
 *
 *                          is_deleted   status IN (...)   lifecycle <> closed
 *   fn_cash_cluster_census    yes            yes                 yes
 *   get_club_home.players     NO             NO                  yes
 *   get_club_home.tables      NO             yes                 yes
 *   fn_cash_game_lobby        yes            NO                  yes
 *
 * `get_club_home` disagreed WITH ITSELF: a seat on a table it did not count
 * as a table was still counted as a player, which is the shape of the
 * original "50 players, one sitting" complaint.
 *
 * Migration 20260906163151 gives all three the census predicate. On the board
 * the day it shipped nothing changed (108 games, zero counts moved) - they
 * agreed by luck, and this is what makes them agree by construction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cashEntry,
  clusterFigures,
  isCensusTable,
  withClusterFigures,
  type LobbyTableRow,
} from '../src/components/lobby/lobbyEntries';
import { lobbyPlayerStateOf } from '../src/components/lobby/lobbyCardContext';
import {
  FILTER_SPECS,
  emptyFilterValue,
  rowPassesFilter,
} from '../src/components/lobby/advancedFilterSpec';

const SQL = readFileSync(
  join(
    __dirname,
    '..',
    'supabase/migrations/20260906163151_one_definition_of_a_games_players_and_tables.sql'
  ),
  'utf8'
);

/* The file carries three things that all mention the predicate: the header
   prose, the two function bodies, and the VERIFY block. Only the BODIES are
   the rule, so each window is the function it is about - never the file, and
   never a byte count (tests/helpers/sourceWindow). */
const fnBody = (name: string): string => {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not re-emitted by this migration`).toBeGreaterThan(-1);
  const open = SQL.indexOf('$function$', start);
  const close = SQL.indexOf('$function$', open + '$function$'.length);
  expect(close).toBeGreaterThan(open);
  return SQL.slice(open, close);
};
const CLUB_HOME = fnBody('get_club_home');
const LOBBY = fnBody('fn_cash_game_lobby');

describe('all three carry the census predicate', () => {
  it('get_club_home filters is_deleted in BOTH cluster subqueries', () => {
    const hits = CLUB_HOME.match(/COALESCE\(t2\.is_deleted, false\) = false/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it('get_club_home filters status in BOTH cluster subqueries', () => {
    const hits = CLUB_HOME.match(/t2\.status IN \('waiting','running','active'\)/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it('fn_cash_game_lobby lists only tables the controller counts', () => {
    expect(LOBBY).toContain("AND t.status IN ('waiting', 'running', 'active')");
    expect(LOBBY).toContain('coalesce(t.is_deleted, false) = false');
  });

  it('every one of them still excludes a closed lifecycle', () => {
    expect((CLUB_HOME.match(/lifecycle <> 'closed'/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(LOBBY).toContain("lifecycle <> 'closed'");
  });
});

describe('the migration proves it against the live board, not just its own text', () => {
  it('asserts every enabled game agrees with fn_cash_cluster_census', () => {
    expect(SQL).toContain('public.fn_cash_cluster_census(g.id)');
    expect(SQL).toContain('still disagrees with fn_cash_cluster_census');
    // Every enabled game, not a sample.
    expect(SQL).toContain('FROM public.cash_games g\n     WHERE g.enabled');
  });

  it('is one transaction, as the production DDL policy requires', () => {
    expect((SQL.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((SQL.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CLIENT WAS THE FOURTH ANSWER (2026-09-09, must-move audit lane G)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The three SQL readers were made to agree in 2026-09-06. The BOARD was not
 * one of them: `cashEntry` read `cluster_tables ?? 1` and
 * `cluster_players ?? current_players ?? 0`, so a row the fast path had not
 * painted printed "1 Table" and Main 1's own seat count as the whole game's.
 * And the figure the fast path DID paint never moved again - it is computed
 * inside get_club_home, it is not a column, so no realtime UPDATE and no
 * chain reload can refresh it, and the fast path is skipped on a warm reload.
 *
 * The board now derives both figures from the rows it holds, under the census
 * predicate and nothing else, so it tracks the database between reads instead
 * of freezing at first paint.
 */
describe('the board counts the game the controller runs', () => {
  const row = (over: Partial<LobbyTableRow> = {}): LobbyTableRow =>
    ({
      id: 't1',
      name: 'NLH 1/2 Action',
      game_variant: 'nlh',
      small_blind: 1,
      big_blind: 2,
      min_buy_in: 100,
      max_buy_in: 400,
      current_players: 0,
      max_players: 6,
      status: 'running',
      lifecycle: 'live',
      cluster_id: 'g1',
      role: 'main',
      main_index: 1,
      cluster_must_move: true,
      cluster_template: 'action',
      ...over,
    }) as LobbyTableRow;

  it('isCensusTable is the SQL predicate, clause for clause', () => {
    expect(isCensusTable(row())).toBe(true);
    expect(isCensusTable(row({ status: 'waiting' }))).toBe(true);
    expect(isCensusTable(row({ status: 'active' }))).toBe(true);
    // The three ways a table leaves the census.
    expect(isCensusTable(row({ is_deleted: true }))).toBe(false);
    expect(isCensusTable(row({ status: 'closed' }))).toBe(false);
    expect(isCensusTable(row({ status: 'paused' }))).toBe(false);
    expect(isCensusTable(row({ lifecycle: 'closed' }))).toBe(false);
    /* `lifecycle <> 'closed'` is NULL - and therefore false - in SQL for a
       null lifecycle. The client says the same, or the two count differently
       on a pre-cutover row. */
    expect(isCensusTable(row({ lifecycle: null }))).toBe(false);
    // 'opening' is a live lifecycle: a feeder being opened is part of the game.
    expect(isCensusTable(row({ lifecycle: 'opening' }))).toBe(true);
  });

  it('players is the sum of the seats on the census tables, tables is their count', () => {
    const board = [
      row({ id: 'm1', current_players: 6 }),
      row({ id: 'm2', role: 'main', main_index: 2, current_players: 5 }),
      row({ id: 'f1', role: 'feeder', main_index: null, current_players: 2 }),
      // Out of the census: neither is counted.
      row({ id: 'dead', role: 'feeder', main_index: null, current_players: 9, lifecycle: 'closed' }),
      row({ id: 'gone', role: 'feeder', main_index: null, current_players: 4, is_deleted: true }),
      // Another game, and a table in no game at all.
      row({ id: 'x1', cluster_id: 'g2', current_players: 3 }),
      row({ id: 'solo', cluster_id: null, current_players: 4 }),
    ];
    const figures = clusterFigures(board);
    expect(figures.get('g1')).toEqual({ players: 13, tables: 3 });
    expect(figures.get('g2')).toEqual({ players: 3, tables: 1 });
    expect(figures.has('solo')).toBe(false);
  });

  it('the stamp overwrites a stale read, and leaves a table of no game alone', () => {
    const board = withClusterFigures([
      // What get_club_home painted when the board was quieter.
      row({ id: 'm1', current_players: 6, cluster_players: 4, cluster_tables: 1 }),
      row({ id: 'f1', role: 'feeder', main_index: null, current_players: 2 }),
      row({ id: 'solo', cluster_id: null, current_players: 4, cluster_players: 99 }),
    ]);
    expect(board[0].cluster_players).toBe(8);
    expect(board[0].cluster_tables).toBe(2);
    expect(board[1].cluster_players).toBe(8);
    // A row outside every cluster keeps whatever it had; it is its own game.
    expect(board[2].cluster_players).toBe(99);
  });

  it('cashEntry has no fallback arithmetic left: no "?? 1", no "?? current_players"', () => {
    const SRC = readFileSync(
      join(__dirname, '..', 'src/components/lobby/lobbyEntries.ts'),
      'utf8'
    );
    const start = SRC.indexOf('export function cashEntry(');
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf('\nexport function tournamentEntry('));
    expect(body).not.toMatch(/cluster_tables\s*\?\?/);
    expect(body).not.toMatch(/cluster_players\s*\?\?\s*t\.current_players/);
  });

  it('a game with no seats is PLAYERS 0 TABLES 1, never 0 tables (OPORD 1.4 s2.8)', () => {
    const dormant = withClusterFigures([row({ current_players: 0 })])[0];
    const e = cashEntry(dormant);
    expect(e.players).toBe(0);
    expect(e.game?.tables).toBe(1);
    expect(e.status).toBe('open');
  });

  it('the club home stamps before it filters, so what is counted is what is rendered', () => {
    const PAGE = readFileSync(join(__dirname, '..', 'src/pages/ClubHomePage.tsx'), 'utf8');
    expect(PAGE).toMatch(/const boardTables = useMemo\(/);
    expect(PAGE).toMatch(/\(t\) => !t\.cluster_id \|\| isCensusTable\(t\)/);
    expect(PAGE).toMatch(/return withClusterFigures\(rows\)/);
    // And the two consumers read the stamped rows, not the raw state.
    expect(PAGE).toMatch(/countStylesOnBoard\(\s*\(boardTables as unknown as LobbyTableRow\[\]\)/);
    expect(PAGE).toMatch(/const tables = boardTables;/);
  });
});

/**
 * A DISABLED GAME IS NOT TAKING PLAYERS, AND THE BOARD SAYS SO.
 *
 * `fn_cash_game_join` raises GAME_CLOSED for `NOT g.enabled` and
 * JOIN_GAME_REFUSALS has always carried the sentence for it - but no board
 * state could reach it: the cluster branch derived status from the player
 * count alone and `enabled` was not selected by either read. 41 disabled
 * games exist in production (read 2026-09-09); any of them still holding a
 * live table rendered as a joinable "Open" game whose Join can only throw.
 */
describe('a game the host has closed is not offered', () => {
  const closedGame = (over: Partial<LobbyTableRow> = {}): LobbyTableRow =>
    ({
      id: 'm1',
      name: 'FLO8 0.50/1 Action',
      game_variant: 'flo8',
      small_blind: 0.5,
      big_blind: 1,
      min_buy_in: 50,
      max_buy_in: 200,
      current_players: 0,
      max_players: 6,
      status: 'waiting',
      lifecycle: 'live',
      cluster_id: 'g-dead',
      role: 'main',
      main_index: 1,
      cluster_must_move: true,
      cluster_enabled: false,
      ...over,
    }) as LobbyTableRow;

  it('reads Closed rather than Open or Running', () => {
    expect(cashEntry(closedGame()).status).toBe('closed');
    expect(cashEntry(closedGame()).statusLabel).toBe('Closed');
    // Even with players still finishing their hands inside it.
    expect(cashEntry(closedGame({ current_players: 4 })).status).toBe('closed');
  });

  it('an enabled game is unaffected, and a null enabled is not a closure', () => {
    expect(cashEntry(closedGame({ cluster_enabled: true })).status).toBe('open');
    expect(cashEntry(closedGame({ cluster_enabled: null })).status).toBe('open');
  });

  it('the club home reads enabled from the game row on EVERY load, not only the fast path', () => {
    const PAGE = readFileSync(join(__dirname, '..', 'src/pages/ClubHomePage.tsx'), 'utf8');
    expect(PAGE).toContain('cluster:cash_games!tables_cluster_id_fkey(');
    expect(PAGE).toMatch(/template_name, must_move, state, enabled/);
    expect(PAGE).toMatch(/cluster_enabled: game\.enabled \?\? null/);
  });

  it('every surface that offers the action refuses instead of offering it', () => {
    const TABLE = readFileSync(
      join(__dirname, '..', 'src/components/lobby/LobbyTable.tsx'),
      'utf8'
    );
    expect(TABLE).toMatch(/const closed = !seated && e\.status === 'closed';/);
    expect(TABLE).toMatch(/\{!closed && full && ctx\.onWaitlistToggle/);
    expect(TABLE).toMatch(/\{!closed && !full && ctx\.onJoinTable/);

    const CARD = readFileSync(
      join(__dirname, '..', 'src/components/lobby/game-cards/ArenaLobbyGameCard.tsx'),
      'utf8'
    );
    expect(CARD).toMatch(/if \(entry\.status === 'closed'\)/);

    const PANEL = readFileSync(
      join(__dirname, '..', 'src/components/lobby/GameLobbyPanel.tsx'),
      'utf8'
    );
    expect(PANEL).toMatch(/entry\.status === 'closed'\)\s*\n\s*return \{/);
  });
});

/**
 * A PLAYER ALREADY IN THE GAME IS NOT A PROSPECT.
 *
 * R10 makes the game's row its Main 1, so `seatedIds.has(entry.id)` - a TABLE
 * id test - could never match a player sitting on Main 2 or the feeder. The
 * board offered them Join Game for a game they are playing in; the door
 * answers `action: 'seated'` and sends them back, a dead-looking tap.
 */
describe('a seat anywhere in the game is a seat in the game', () => {
  const ctx = {
    waitlistedIds: new Set<string>(),
    seatedIds: new Set<string>(),
    registeredIds: new Set<string>(),
    favoriteIds: new Set<string>(),
  };
  const gameRow = {
    id: 'main-1',
    kind: 'cash' as const,
    game: { id: 'g1', mustMove: true, template: 'action', tables: 3, state: 'live' },
  };

  it('matches on the GAME id, not only on Main 1 table id', () => {
    expect(
      lobbyPlayerStateOf(gameRow as never, { ...ctx, seatedIds: new Set(['g1']) })
    ).toBe('seated');
    expect(
      lobbyPlayerStateOf(gameRow as never, { ...ctx, seatedIds: new Set(['main-1']) })
    ).toBe('seated');
    expect(lobbyPlayerStateOf(gameRow as never, ctx)).toBeNull();
  });

  it('a table of no game is unchanged: its own id and nothing else', () => {
    const solo = { id: 't1', kind: 'cash' as const };
    expect(lobbyPlayerStateOf(solo as never, { ...ctx, seatedIds: new Set(['g1']) })).toBeNull();
    expect(lobbyPlayerStateOf(solo as never, { ...ctx, seatedIds: new Set(['t1']) })).toBe(
      'seated'
    );
  });

  it('the action column asks playerStateOf rather than re-spelling the rule', () => {
    const TABLE = readFileSync(
      join(__dirname, '..', 'src/components/lobby/LobbyTable.tsx'),
      'utf8'
    );
    expect(TABLE).toMatch(/const seated = playerStateOf\(e, ctx\) === 'seated';/);
  });
});

/**
 * A TABLE THE CONTROLLER CLOSED LEAVES THE BOARD.
 *
 * The cluster controller closes a table by flipping `lifecycle`, and it does
 * not always move `status`: two rows sat at `status='waiting',
 * lifecycle='closed'` on production 2026-09-09. The realtime drop rule only
 * knew about `status`, so the card survived until the next reload.
 */
describe('the realtime admission rules and the census agree', () => {
  it('an UPDATE that closes a lifecycle drops the row', () => {
    const PAGE = readFileSync(join(__dirname, '..', 'src/pages/ClubHomePage.tsx'), 'utf8');
    const start = PAGE.indexOf('const handleTableChange');
    const body = PAGE.slice(start, PAGE.indexOf('const handleTournamentChange'));
    expect(body).toMatch(/updated\.lifecycle === 'closed'/);
  });

  it('the boot cache generation was bumped, so a pre-embed entry cannot paint', () => {
    const PAGE = readFileSync(join(__dirname, '..', 'src/pages/ClubHomePage.tsx'), 'utf8');
    const m = PAGE.match(/const CLUB_HOME_CACHE_VER = 'v(\d+)';/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(4);
  });
});

/**
 * A MUST-MOVE GAME IS NEVER FULL (R10), SO THE FILTER MUST NOT SAY IT IS.
 *
 * The cash status chips compared Main 1's seats to Main 1's capacity, so a
 * busy game answered Full and failed Open Seats - and a player filtering for
 * Open Seats had every busy game on the board hidden from them.
 */
describe('the status chips judge the game, not its Main 1', () => {
  const spec = FILTER_SPECS.HOLDEM;
  const value = (statuses: string[]) => ({ ...emptyFilterValue(spec), statuses });
  const gameRow = (taken: number) => ({
    variant: 'nlh',
    price: 2,
    seats: 6,
    seatsTaken: taken,
    game: true,
    name: 'NLH 1/2 Action',
    style: 'action',
    row: {},
    settings: {},
  });

  it('a full-to-the-brim game is never Full and always has Open Seats', () => {
    expect(rowPassesFilter(spec, value(['full']), gameRow(57))).toBe(false);
    expect(rowPassesFilter(spec, value(['open']), gameRow(57))).toBe(true);
  });

  it('Empty means nobody is in the whole game', () => {
    expect(rowPassesFilter(spec, value(['empty']), gameRow(0))).toBe(true);
    expect(rowPassesFilter(spec, value(['empty']), gameRow(1))).toBe(false);
  });

  it('a single table is judged exactly as it was', () => {
    const table = { ...gameRow(6), game: false };
    expect(rowPassesFilter(spec, value(['full']), table)).toBe(true);
    expect(rowPassesFilter(spec, value(['open']), table)).toBe(false);
    expect(rowPassesFilter(spec, value(['open']), { ...table, seatsTaken: 3 })).toBe(true);
  });

  it('the club home passes the game-wide count and the game flag', () => {
    const PAGE = readFileSync(join(__dirname, '..', 'src/pages/ClubHomePage.tsx'), 'utf8');
    expect(PAGE).toMatch(/game: isClusterFront\(table as unknown as LobbyTableRow\),/);
    expect(PAGE).toMatch(/\? Number\(table\.cluster_players\) \|\| 0/);
  });
});

/**
 * THE PANEL PRINTS A GAME'S SHAPE, NOT A TABLE'S.
 *
 * R10 sets a game row's capacity to 0, so "Players 57 / -" and a twelve-pip
 * seat meter were a table's furniture on a game.
 */
describe('the game lobby panel says players and tables', () => {
  it('the plaque takes the game shape and drops the denominator and the pips', () => {
    const PLAQUE = readFileSync(
      join(__dirname, '..', 'src/components/lobby/CasinoPlaque.tsx'),
      'utf8'
    );
    const start = PLAQUE.indexOf('export function PlaqueSeats');
    const body = PLAQUE.slice(start, PLAQUE.indexOf('if (bareCount) {', start));
    expect(body).toMatch(/gameTables\?: number \| null;/);
    expect(body).toMatch(/cplaque__seats--game/);
    expect(body).not.toMatch(/cplaque__seats-pips/);
  });

  it('the panel hands it the count and prints Tables beside Players', () => {
    const PANEL = readFileSync(
      join(__dirname, '..', 'src/components/lobby/GameLobbyPanel.tsx'),
      'utf8'
    );
    expect(PANEL).toMatch(/gameTables=\{entry\.game \? entry\.game\.tables : null\}/);
    expect(PANEL).toMatch(/<dt>Tables<\/dt>/);
  });
});
