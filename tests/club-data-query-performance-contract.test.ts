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
    expect(page).toContain("p_limit: gameSort === 'recent' ? GAME_PAGE_SIZE * 2 : 1");
    expect(page).toContain('p_limit: GAME_PAGE_SIZE * 2');
    expect(page).toContain('prefetchedGamePageRef.current');
    expect(page).toMatch(/gameSort === 'recent'[\s\S]{0,80}\? recentCursor\(sourceRows\)/);
    expect(page).toMatch(/setPlayersLoading\(true\);\s*setPlayersError\(null\);/);
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

  it('keeps complete browsing server-sorted and DOM-windowed', () => {
    expect(page).toContain("supabase.rpc('ca_club_game_page'");
    expect(page).toContain("supabase.rpc('ca_club_player_page'");
    expect(page).toContain('p_cursor: gameCursor');
    expect(page).toContain('p_cursor: playerCursor');
    expect(page).toContain('useVirtualScroll(gameRows');
    expect(page).toContain('useVirtualScroll(sortedPlayers');
    expect(page).toContain('aria-setsize={snapshot?.row_count}');
    expect(page).toContain('aria-setsize={players?.player_count}');
  });
});
