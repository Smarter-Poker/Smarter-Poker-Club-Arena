/**
 * Production-volume guard for Club Data's two authenticated ledgers.
 *
 * On 2026-08-30 Shark Club's 14-day Games and Players requests were both
 * cancelled by the authenticated role's 8 second statement_timeout.  The game
 * helper executed per-rake-row entrant counts over 80k+ tournament rake rows,
 * and the snapshot then ran that helper three times.  CI has no production
 * database, so these source contracts pin the structural parts of the fix.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceBetween, sliceCall } from './helpers/sourceWindow';

const migration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260830235959_club_data_query_path_bounded.sql'),
  'utf8'
);
const cashIndex = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260830235960_club_data_player_cash_index.sql'),
  'utf8'
);
const playersRpc = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260830235961_club_data_player_single_wallet_pass.sql'
  ),
  'utf8'
);
const playerCoveringIndex = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260830235962_club_data_player_covering_wallet_window.sql'
  ),
  'utf8'
);
const page = readFileSync(resolve(__dirname, '../src/pages/club/ClubDataPage.tsx'), 'utf8');
const reportingFacts = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260831010000_club_data_incremental_reporting_facts.sql'
  ),
  'utf8'
);
const attributionParity = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260831010001_club_data_rollup_attribution_parity.sql'
  ),
  'utf8'
);
const cashScope = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260831010002_club_data_cash_scope_and_search_plan.sql'
  ),
  'utf8'
);
const unsearchedFastPath = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260831010003_club_data_unsearched_fast_path.sql'),
  'utf8'
);
const customGamePlan = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260831010004_club_data_custom_game_plan.sql'),
  'utf8'
);
const boundedSnapshot = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260831010005_club_data_bounded_snapshot_pipeline.sql'
  ),
  'utf8'
);
const cursorPages = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260831020000_club_data_cursor_pages.sql'),
  'utf8'
);
const snapshotCursorOrder = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260831020001_club_data_snapshot_cursor_order.sql'),
  'utf8'
);
const defaultSnapshotFastPath = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260831020002_club_data_default_snapshot_fast_path.sql'
  ),
  'utf8'
);
const exportStatementBudget = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260831181000_club_data_export_statement_budget.sql'),
  'utf8'
);
const narrowRank = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260907042418_the_ranked_club_data_page_ranks_a_narrow_key_set.sql'
  ),
  'utf8'
);

describe('Club Data reporting stays inside the authenticated query budget', () => {
  it('covers both high-volume tournament fact reads with partial indexes', () => {
    expect(migration).toContain('idx_rake_records_club_data_tournament_window');
    expect(migration).toMatch(
      /idx_wallet_tx_club_data_tournament_user_window[\s\S]*WHERE category IN \('tournament_buyin', 'prize', 'bounty'\)/
    );
    expect(cashIndex).toMatch(
      /idx_wallet_tx_club_data_cash_user_window[\s\S]*WHERE category IN \('buyin', 'cashout'\)/
    );
  });

  it('shares untagged tournament rake with set-based entrant totals', () => {
    expect(migration).toContain('tournament_rake_source AS MATERIALIZED');
    expect(migration).toContain('tournament_entrants AS');
    expect(migration).toMatch(/count\(a\.user_id\)::numeric AS club_players/);

    const helper = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_club_games'),
      migration.indexOf('CREATE OR REPLACE FUNCTION public.ca_club_data_snapshot')
    );
    expect(helper).not.toMatch(/SELECT count\(\*\) FROM tournament_players/);
  });

  it('materializes the current game set once for both summary and rows', () => {
    const snapshotStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.ca_club_data_snapshot'
    );
    const snapshot = migration.slice(
      snapshotStart,
      migration.indexOf('$function$;', snapshotStart) + '$function$;'.length
    );
    expect(snapshot).toContain('current_games AS MATERIALIZED');
    expect(snapshot.match(/fn_ca_club_games\(/g)).toHaveLength(2);
    expect(snapshot).toContain("'rows', v_rows");
  });

  it('keeps the internal helper unreachable from browser roles', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_club_games[\s\S]*FROM PUBLIC, anon, authenticated;/
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ca_club_data_snapshot[\s\S]*TO authenticated, service_role;/
    );
  });

  it('aggregates both player net columns in one wallet ledger pass', () => {
    expect(playersRpc).toContain('wallet_pnl AS (');
    expect(playersRpc).toMatch(/AS cash_net,[\s\S]*AS tournament_net/);
    expect(playersRpc.match(/FROM wallet_transactions wt/g)).toHaveLength(1);
    expect(playersRpc).toContain('merged AS MATERIALIZED');
    expect(playerCoveringIndex).toContain('idx_wallet_tx_club_data_player_window');
    expect(playerCoveringIndex).toMatch(
      /INCLUDE \(category, type, amount, table_id, related_entity_id\)/
    );
  });

  it('keeps the first browser render bounded while allowing queued ledger traffic to finish', () => {
    expect(page).toContain('const PLAYER_PAGE_SIZE = 100;');
    expect(page).toContain('p_limit: PLAYER_PAGE_SIZE');
    expect(page).toContain('const PLAYER_REQUEST_TIMEOUT_MS = 25_000;');
    expect(page).toContain('const COLD_READ_ATTEMPT_TIMEOUT_MS = 12_000;');
    expect(page).toContain('const COLD_READ_RETRY_DELAY_MS = 350;');
    expect(page).toMatch(/retryFetch\([\s\S]*maxRetries,[\s\S]*baseDelayMs/);
    expect(page).toMatch(/coldRead\([\s\S]*'Club data request timed out'/);
    expect(page).toMatch(/coldRead\([\s\S]*'Player data request timed out'/);
    expect(page).toContain("p_limit: gameSort === 'recent' ? GAME_PAGE_SIZE : 1");
    expect(page).toContain('p_limit: GAME_PAGE_SIZE * 2');
    expect(page).toContain('prefetchedGamePageRef.current');
    expect(page).toMatch(/gameSort === 'recent'[\s\S]{0,80}\? recentCursor\(rows\)/);
    // Moved 2026-09-07 to the mechanism that replaced it. The rule is
    // unchanged and is what this line always guarded: a background refresh
    // that already has rows on screen must not pull a skeleton over them. It
    // is the condition now rather than a setState argument, because the same
    // flag also had to stop being clearable by a background poll. See "lets
    // only a foreground request raise and clear the players skeleton" below.
    expect(page).toContain('const showSpinner = !preserveOnError || !playersRef.current;');
    expect(sliceCall(page, 'const loadPlayers = useCallback(')).toMatch(
      /if \(showSpinner\) \{\s*playersSpinnerVersion\.current = myVersion;\s*setPlayersLoading\(true\);/
    );
    expect(page).toContain('if (manualRefreshingRef.current) return;');
    expect(page).toContain('disabled={manualRefreshing || !clubUuid || isHydrating}');
  });

  it('serves both reports from incrementally maintained daily facts', () => {
    expect(reportingFacts).toContain('CREATE TABLE IF NOT EXISTS public.ca_club_player_daily');
    expect(reportingFacts).toContain('CREATE TABLE IF NOT EXISTS public.ca_club_tournament_daily');
    expect(reportingFacts).toContain(
      'CREATE TABLE IF NOT EXISTS public.ca_club_tournament_player_daily'
    );
    expect(reportingFacts).toContain('CREATE TRIGGER ca_reporting_wallet_insert');
    expect(reportingFacts).toContain('CREATE TRIGGER ca_reporting_rake_insert');
    expect(reportingFacts).toContain('pg_advisory_xact_lock(918273645)');

    const gamesStart = reportingFacts.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_club_games');
    const gamesEnd = reportingFacts.indexOf('$function$;', gamesStart);
    const games = reportingFacts.slice(gamesStart, gamesEnd);
    expect(games).toContain('public.ca_club_tournament_daily');
    expect(games).toContain('public.ca_club_tournament_player_daily');
    expect(games).not.toContain('public.wallet_transactions');
    expect(games).not.toContain('public.rake_records');

    const playersStart = reportingFacts.indexOf(
      'CREATE OR REPLACE FUNCTION public.ca_club_player_breakdown'
    );
    const playersEnd = reportingFacts.indexOf('$function$;', playersStart);
    const players = reportingFacts.slice(playersStart, playersEnd);
    expect(players).toContain('public.ca_club_player_daily');
    expect(players).not.toContain('public.wallet_transactions');
    expect(players).toContain("'is_horse',COALESCE(pr.is_horse,false)");
  });

  it('gives exact immutable exports enough time without weakening the browser role globally', () => {
    expect(exportStatementBudget).toMatch(
      /ALTER FUNCTION public\.ca_club_game_export_start[\s\S]*SET statement_timeout TO '120s'/
    );
    expect(exportStatementBudget).toMatch(
      /ALTER FUNCTION public\.ca_club_player_export_start[\s\S]*SET statement_timeout TO '120s'/
    );
    expect(exportStatementBudget).not.toMatch(/ALTER ROLE/);
  });

  it('preserves tournament home-club attribution without leaking cross-club hands', () => {
    expect(attributionParity).toContain(
      'CREATE OR REPLACE FUNCTION public.ca_reporting_tournament_clubs_for_user'
    );
    expect(attributionParity).toContain('tb.union_id IS NOT NULL');
    expect(attributionParity).toContain('WHERE s.club_id=p_club_id');
    expect(attributionParity).toContain("'is_horse',COALESCE(pr.is_horse,false)");
  });

  it('keeps tournament tables out of cash and avoids per-row creator probes', () => {
    expect(cashScope).toContain('tb.tournament_id IS NULL');
    expect(cashScope).toContain('v_is_tournament_table');
    expect(cashScope).toContain("COALESCE(pr.username,'') creator_username");
    expect(cashScope).not.toContain('SELECT 1 FROM public.profiles pr');
  });

  it('gives empty-search requests a plan with no search expressions', () => {
    expect(unsearchedFastPath).toContain('public.fn_ca_club_games_unsearched');
    const unsearchedStart = unsearchedFastPath.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_ca_club_games_unsearched'
    );
    const unsearchedEnd = unsearchedFastPath.indexOf('$function$;', unsearchedStart);
    const unsearched = unsearchedFastPath.slice(unsearchedStart, unsearchedEnd);
    expect(unsearched).not.toContain('p_search');
    expect(unsearched).not.toContain('||btrim(p_search)||');
    expect(unsearchedFastPath).toContain("IF NULLIF(btrim(COALESCE(p_search,'')),'') IS NULL THEN");
  });

  it('replans the game fact query with its actual club and date values', () => {
    expect(customGamePlan).toContain('RETURN QUERY EXECUTE $query$');
    expect(customGamePlan).toContain('$query$ USING p_club_id,p_start,p_end,p_game,p_stakes');
    expect(customGamePlan).toContain('d.club_id=$1');
    expect(customGamePlan).toContain('d.stat_date BETWEEN $2 AND $3');
  });

  it('aggregates totals in-database and bounds rows before JSON crosses the RPC', () => {
    expect(boundedSnapshot).toContain('public.fn_ca_club_game_summary');
    expect(boundedSnapshot).toContain('public.fn_ca_club_game_rows');
    expect(boundedSnapshot).toContain('ORDER BY r.started_at DESC NULLS LAST LIMIT $7');
    expect(boundedSnapshot).toContain(
      'v_rows:=public.fn_ca_club_game_rows(p_club_id,v_start,v_end,v_game,v_stakes,v_q,v_lim)'
    );
  });

  it('uses the page cursor tie-breakers on the bounded recent snapshot', () => {
    expect(snapshotCursorOrder).toContain(
      'ORDER BY r.started_at DESC NULLS LAST,r.kind DESC,r.id DESC LIMIT $7'
    );
    expect(snapshotCursorOrder).toContain(
      'ORDER BY q.started_at DESC NULLS LAST,q.kind DESC,q.id DESC'
    );
  });

  it('keeps concurrent default first paint off the complete filtered game plan', () => {
    expect(defaultSnapshotFastPath).toContain('fn_ca_club_game_summary_filtered');
    expect(defaultSnapshotFastPath).toContain('fn_ca_club_game_rows_filtered');
    expect(defaultSnapshotFastPath).toMatch(/count\(DISTINCT d\.tournament_id\)::bigint games/);
    expect(defaultSnapshotFastPath).toContain('recent_tournament_ids AS MATERIALIZED');
    expect(defaultSnapshotFastPath).toContain('ORDER BY tr.start_time DESC NULLS LAST,tr.id DESC');
    expect(defaultSnapshotFastPath).toContain(
      'ORDER BY r.started_at DESC NULLS LAST,r.kind DESC,r.id DESC'
    );
    expect(defaultSnapshotFastPath).toContain(
      "OR NULLIF(btrim(COALESCE(p_search,'')),'') IS NOT NULL THEN"
    );
  });

  it('pages both ledgers with authorized deterministic keyset cursors', () => {
    expect(cursorPages).toContain('public.ca_club_game_page');
    expect(cursorPages).toContain('public.ca_club_player_page');
    expect(cursorPages.match(/ca_can_view_club_finances\(p_club_id\)/g)).toHaveLength(2);
    expect(cursorPages).toContain('ROW(s.sort_value,s.sort_time,s.kind,s.id) < ROW(');
    expect(cursorPages).toContain('ROW(s.sort_value,s.user_id::text) <');
    expect(cursorPages).toContain("v_sort NOT IN ('recent','fee','winnings','hands')");
    expect(cursorPages).toContain("v_sort NOT IN ('winners','losers','rake','hands')");
    expect(cursorPages).toMatch(
      /REVOKE ALL ON FUNCTION public\.ca_club_game_page[\s\S]*FROM PUBLIC,anon;/
    );
    expect(cursorPages).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ca_club_player_page[\s\S]*TO authenticated,service_role;/
    );
  });

  /**
   * 2026-09-07. `ca_club_game_page` returns 100 rows and was carrying every
   * presentation column through three MATERIALIZED copies of the whole window
   * and a full sort to find them. On Shark Club that is 90,649 rows a
   * fortnight: 42 MB materialised three times, 5,862 temp blocks per read, and
   * a cold call measured at 15,493 ms against a 12,000 ms client attempt
   * budget - so the read timed out and each retry started another full-window
   * scan beside the one still running.
   *
   * Paired production measurement, alternating calls in one session:
   * cold 4,064 -> 842 ms, warm 1,151 -> 688 ms, buffers 317,658 -> 125,851,
   * temp blocks 5,862 -> 861. Live after the migration: 709-874 ms on all four
   * sorts.
   */
  it('ranks a narrow key set and joins presentation only for the visible page', () => {
    expect(narrowRank).toContain('keys AS MATERIALIZED');
    expect(narrowRank).toContain('detail AS (');
    // The ranking set must not carry a presentation column. If one comes back,
    // the whole window pays for it again.
    const rankingSet = sliceBetween(
      narrowRank,
      '), keys AS MATERIALIZED (',
      '), filtered AS MATERIALIZED ('
    );
    expect(rankingSet.length).toBeGreaterThan(0);
    for (const presentation of [
      'rake_percent',
      'avatar_url',
      'small_blind',
      "game_variant,'nlh'",
      'tr.variant,tr.game_type',
      'c.players',
      'tp.players',
    ]) {
      expect(rankingSet).not.toContain(presentation);
    }
    // tournament_players is a 90k row count(DISTINCT). It is joined for the
    // visible page, never merged into every row of the window.
    const visibleJoin = sliceBetween(narrowRank, '), detail AS (', 'SELECT jsonb_build_object(');
    expect(visibleJoin).toContain('LEFT JOIN tournament_players tp');
    expect(visibleJoin).toContain('FROM visible v');
    // Same contract as before it was made cheaper.
    expect(narrowRank).toContain('ca_can_view_club_finances(p_club_id)');
    expect(narrowRank).toContain('STABLE SECURITY DEFINER');
    expect(narrowRank).toContain("v_sort NOT IN ('recent','fee','winnings','hands')");
    expect(narrowRank).toContain('ROW(s.sort_value,s.sort_time,s.kind,s.id) < ROW(');
    expect(narrowRank).toContain("'filtered_count',(SELECT count(*) FROM filtered)");
    // CREATE OR REPLACE keeps the grants a live function has, so restating
    // them protects the next database this file is replayed into, where a bare
    // CREATE would hand EXECUTE to PUBLIC.
    expect(narrowRank).toMatch(
      /REVOKE ALL ON FUNCTION public\.ca_club_game_page\([^)]*\) FROM PUBLIC,anon;/
    );
    expect(narrowRank).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ca_club_game_page\([^)]*\) TO authenticated,service_role;/
    );
  });

  /**
   * THE SKELETON BELONGS TO A FOREGROUND REQUEST.
   *
   * `loading` used to be cleared only by whichever request was newest when it
   * settled - background polls included. On Shark Club a realtime row lands on
   * one of four watched tables almost continuously, so every read was
   * superseded before it finished and `setLoading(false)` was never reached by
   * anybody. The page stayed in `loading` for its whole life, which disables
   * Load More while it still reads "Load More Games - 100 Of 90,372". Five
   * consecutive Post-Deploy E2E runs died on that button
   * (club-data-deep.spec.ts:147, locator.click, 180s).
   */
  it('lets only a foreground request raise and clear the ledger skeleton', () => {
    const load = sliceCall(page, 'const load = useCallback(');
    expect(load.length).toBeGreaterThan(0);
    expect(load).toContain('spinnerVersion.current = myVersion;');
    expect(load).toContain(
      'if (!cancelledRef.current && showSpinner && spinnerVersion.current === myVersion)'
    );
    // A background read must never be the one holding the skeleton up, and a
    // second background read may not stack another full-window scan beside the
    // first.
    expect(load).toContain('if (!showSpinner && backgroundLedgerInFlight.current) return true;');
    expect(load).toMatch(
      /if \(!showSpinner && loadVersion\.current === myVersion\)\s*backgroundLedgerInFlight\.current = false;/
    );
    // One clearer, and the assertion above says what guards it. Two would mean
    // some other path can put the skeleton away again.
    expect(load.match(/setLoading\(false\)/g)).toHaveLength(1);
  });

  /**
   * A debounce that restarts on every event is a promise, not a schedule.
   * Shark Club never went quiet for 750ms, so the queued refresh was cleared
   * and re-armed for ever and the ledger only updated when the 60s recovery
   * poll happened to land.
   */
  it('bounds how long a burst of realtime rows may defer a queued refresh', () => {
    expect(page).toContain('const EVENT_REFRESH_DEBOUNCE_MS = 750;');
    expect(page).toMatch(/const EVENT_REFRESH_MAX_WAIT_MS = [\d_]+;/);
    const queue = sliceCall(page, 'const queueEventRefresh = useCallback(');
    expect(queue.length).toBeGreaterThan(0);
    expect(queue).toContain('eventRefreshDeadlineRef.current = now + EVENT_REFRESH_MAX_WAIT_MS;');
    expect(queue).toContain(
      'Math.min(EVENT_REFRESH_DEBOUNCE_MS, eventRefreshDeadlineRef.current - now)'
    );
    expect(queue).toContain('}, delay);');
    expect(queue).not.toContain('}, 750);');
  });

  /**
   * The games ledger was fixed first and the players ledger was left with the
   * identical fault, which is what Post-Deploy E2E found next: Load More
   * Players clicked, and the label never moved off
   * "Load More Players - 100 Of 571" for sixty seconds. `loadMorePlayers`
   * refuses to run while `playersLoading` is true, and `playersLoading` was
   * cleared only by the newest read of any kind. 10.86 rule 4: a fix that
   * leaves the same trap one level over has not landed.
   */
  it('lets only a foreground request raise and clear the players skeleton', () => {
    const loadPlayers = sliceCall(page, 'const loadPlayers = useCallback(');
    expect(loadPlayers).toContain('playersSpinnerVersion.current = myVersion;');
    expect(loadPlayers).toContain(
      'if (!cancelledRef.current && showSpinner && playersSpinnerVersion.current === myVersion)'
    );
    expect(loadPlayers).toContain(
      'if (preserveOnError && backgroundPlayersInFlight.current) return true;'
    );
    expect(loadPlayers.match(/setPlayersLoading\(false\)/g)).toHaveLength(1);
  });

  /**
   * A REFRESH IS NOT A NEW QUESTION. Both Load More paths captured the read
   * version and discarded their page if anything bumped it mid-flight - which
   * the 60s poll and every realtime row do. That check belongs to a sort or
   * filter change, where the page really does belong to a ledger nobody is
   * looking at; a refresh of the same query must not throw away the page the
   * operator just asked for, and must never leave its own spinner up.
   */
  it('keys pagination to the question, not to every read', () => {
    for (const [fn, epoch] of [
      ['const loadMoreGames = useCallback(', 'gamesQueryEpoch'],
      ['const loadMorePlayers = useCallback(', 'playersQueryEpoch'],
    ] as const) {
      const body = sliceCall(page, fn);
      expect(body).toContain(`const myEpoch = ${epoch}.current;`);
      expect(body).toContain(`${epoch}.current !== myEpoch`);
      // The read-ordering version must not be what pagination watches.
      expect(body).not.toContain('loadVersion.current !== myVersion');
      expect(body).not.toContain('playersVersion.current !== myVersion');
    }
    // Foreground loads and query changes retire pagination; background
    // refreshes of the same question do not.
    const load = sliceCall(page, 'const load = useCallback(');
    expect(load).toContain('if (!preserveOnError) gamesQueryEpoch.current += 1;');
    const loadPlayers = sliceCall(page, 'const loadPlayers = useCallback(');
    expect(loadPlayers).toContain('if (!preserveOnError) playersQueryEpoch.current += 1;');
    // Query changes retire both spinners; stale pages cannot clear successors.
    expect(sliceCall(page, 'const loadMoreGames = useCallback(')).toMatch(
      /finally \{\s*if \(!stale\(\)\) \{\s*gamesMoreRef\.current = false;\s*setGamesLoadingMore\(false\);/
    );
    expect(sliceCall(page, 'const loadMorePlayers = useCallback(')).toMatch(
      /finally \{\s*if \(!stale\(\)\) \{\s*playersMoreRef\.current = false;\s*setPlayersLoadingMore\(false\);/
    );
  });

  it('keeps complete browsing server-sorted and DOM-windowed', () => {
    expect(page).toContain("supabase.rpc('ca_club_game_page'");
    expect(page).toContain("supabase.rpc('ca_club_player_page'");
    const gamesPage = sliceCall(page, 'const loadMoreGames = useCallback(');
    expect(gamesPage).toContain('const cursor = gameCursorRef.current;');
    expect(gamesPage).toContain('p_cursor: cursor');
    const playersPage = sliceCall(page, 'const loadMorePlayers = useCallback(');
    expect(playersPage).toContain('const cursor = playerCursorRef.current;');
    expect(playersPage).toContain('p_cursor: cursor');
    expect(page).toContain('useVirtualScroll(gameRows');
    expect(page).toContain('useVirtualScroll(sortedPlayers');
    expect(page).toContain('aria-setsize={snapshot?.row_count}');
    expect(page).toContain('aria-setsize={players?.player_count}');
  });
});
