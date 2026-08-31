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
    expect(page).toContain('const SNAPSHOT_REQUEST_TIMEOUT_MS = 25_000;');
    expect(page).toMatch(/'Club data request timed out',\s*SNAPSHOT_REQUEST_TIMEOUT_MS/);
    expect(page).toContain('const PLAYER_REQUEST_TIMEOUT_MS = 25_000;');
    expect(page).toMatch(/'Player data request timed out',\s*PLAYER_REQUEST_TIMEOUT_MS/);
    expect(page).toMatch(/setPlayersLoading\(true\);\s*setPlayersError\(null\);/);
  });
});
