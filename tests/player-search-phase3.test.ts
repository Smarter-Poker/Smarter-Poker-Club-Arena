import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migration = read(
  'supabase/migrations/20260831153000_player_search_global_downline_watch_access.sql'
);
const service = read('src/services/PlayerSearchService.ts');
const modal = read('src/components/modals/FindPlayerModal.tsx');
const home = read('src/pages/HomePage.tsx');
const stateHandler = read('server/src/handlers/state.ts');
const socketServer = read('server/src/transport/EngineWebSocketServer.ts');

describe('server-authoritative global player locator', () => {
  it('searches all profiles while deriving optional relationship scopes from auth.uid()', () => {
    expect(migration).toContain('v_uid uuid := auth.uid()');
    expect(migration).toContain('FROM public.profiles p');
    expect(migration).toContain('friend_ids AS');
    expect(migration).toContain('viewer_clubs AS MATERIALIZED');
    expect(migration).toContain('viewer_unions AS MATERIALIZED');
    expect(migration).toContain("p_scope NOT IN ('all', 'friends', 'clubs', 'union', 'managed')");
  });

  it('returns sensitive account data only through canonical downline authorization', () => {
    expect(migration).toContain('public.ca_club_roster_access(cm.club_id, pg.id)');
    expect(migration).toContain("IN ('staff', 'downline', 'service')");
    expect(migration).toContain('public.ca_club_member_detail(cm.club_id, pg.id, NULL, NULL)');
    expect(migration).toContain("'wallets', details.detail->'wallets'");
    expect(migration).toContain("'downline', details.detail->'downline'");
  });

  it('uses indexed live-seat lookup, stable pagination, and bounded page sizes', () => {
    expect(migration).toContain('idx_table_seats_live_user');
    expect(migration).toContain('idx_tournament_players_live_user_table');
    expect(migration).toContain('relevance');
    expect(migration).toContain('LIMIT v_limit OFFSET v_offset');
    expect(migration).toContain('least(greatest(coalesce(p_limit, 20), 1), 50)');
    expect(migration).toContain("p_sort NOT IN ('relevance', 'name')");
  });
});

describe('global locator and observer experience', () => {
  it('cancels stale suggestions and searches', () => {
    expect(service).toContain('abortSignal(options.signal)');
    expect(modal).toContain('searchAbortRef.current?.abort()');
    expect(modal).toContain('suggestionAbortRef.current?.abort()');
  });

  it('supports global/managed scopes, presence, sorting, and pagination', () => {
    expect(modal).toContain('PlayerSearchScope');
    expect(modal).toContain('PlayerPresenceFilter');
    expect(modal).toContain('PlayerSearchSort');
    expect(modal).toContain('Load More Players');
    expect(modal).toContain('My Managed Accounts');
    expect(modal).toContain('All Players');
  });

  it('routes members to the actual cash or tournament table as observers', () => {
    expect(modal).toContain('`/table/${table.table_id}?observer=1`');
    expect(service).toContain("supabase.rpc('fn_get_table_watch_access'");
    expect(modal).toContain('PlayerSearchService.getTableWatchAccess(table.table_id)');
    expect(migration).toContain("'table_id', live.table_id");
    expect(migration).toContain("'tournament_id', live.tournament_id");
    expect(migration).toContain('coalesce(t.is_anonymous, false) = false');
  });

  it('hands non-members to Join/Request and resumes immediate approvals at the table', () => {
    expect(modal).toContain('onMembershipRequired');
    expect(home).toContain('setJoinIntent({ code, watchTableId })');
    expect(home).toContain('watchTableId ? `/table/${watchTableId}?observer=1`');
  });

  it('enforces membership on HTTP and both websocket table-state paths', () => {
    expect(stateHandler).toContain('authorizeTableViewer(tableId, auth.userId)');
    expect(stateHandler).toContain('CLUB_MEMBERSHIP_REQUIRED');
    expect(stateHandler).toContain('OBSERVERS_RESTRICTED');
    expect(socketServer.match(/this\.authorizeConnection\(tableId,/g)).toHaveLength(2);
  });
});
