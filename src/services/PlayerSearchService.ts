import { supabase } from '../lib/supabase';
import { ClubEntryTrustService } from './ClubEntryTrustService';

export type PlayerSearchScope = 'all' | 'friends' | 'clubs' | 'union' | 'managed';
export type PlayerPresenceFilter = 'all' | 'online' | 'playing';
export type PlayerSearchSort = 'relevance' | 'name';

export interface PlayerSearchTable {
  id: string;
  table_id: string;
  tournament_id?: string | null;
  name: string;
  game_variant: string;
  stakes: string;
  club_uuid: string;
  club_id?: number | null;
  club_slug?: string | null;
  club_name?: string;
  is_tournament?: boolean;
  membership_status?: string | null;
  can_watch: boolean;
  access_action:
    | 'play'
    | 'watch'
    | 'join'
    | 'request_join'
    | 'pending'
    | 'observers_restricted'
    | 'unavailable';
}

export interface PlayerSensitiveAccount {
  club_uuid: string;
  club_name: string;
  role: string;
  access: 'downline' | 'staff' | 'service';
  wallets: {
    chip_balance: number;
    player_wallet: number;
    agent_wallet: number;
    promo_wallet: number;
  };
  downline: { downline_direct: number; downline_total: number } | null;
  stats: {
    hands: number;
    mtt_hands: number;
    total_fee: number;
    mtt_fee: number;
    total_winnings: number;
    mtt_winnings: number;
    claimed_back: number;
    sent_out: number;
  } | null;
}

export interface PlayerSearchResult {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  relationship: 'self' | 'friend' | 'club' | 'union' | 'managed' | 'public';
  presence_status: 'online' | 'playing' | 'offline';
  tables: PlayerSearchTable[];
  sensitive_accounts: PlayerSensitiveAccount[];
}

export interface PlayerSearchPage {
  items: PlayerSearchResult[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
}

export interface TableWatchAccess {
  found: boolean;
  table_id?: string;
  club_uuid?: string;
  club_id?: number | null;
  club_slug?: string | null;
  club_name?: string;
  membership_status?: string | null;
  can_watch: boolean;
  action: PlayerSearchTable['access_action'];
}

export interface PlayerSearchPreferences {
  discoverable: boolean;
  showDisplayName: boolean;
  showPresence: boolean;
  showCurrentTable: boolean;
}

export async function searchPlayers(options: {
  query: string;
  limit?: number;
  offset?: number;
  scope?: PlayerSearchScope;
  presence?: PlayerPresenceFilter;
  sort?: PlayerSearchSort;
  signal?: AbortSignal;
}): Promise<PlayerSearchPage> {
  const startedAt = performance.now();
  let request = supabase.rpc('fn_search_players', {
    p_query: options.query.trim(),
    p_limit: options.limit ?? 20,
    p_offset: options.offset ?? 0,
    p_scope: options.scope ?? 'all',
    p_presence: options.presence ?? 'all',
    p_sort: options.sort ?? 'relevance',
  });
  if (options.signal) request = request.abortSignal(options.signal);
  const { data, error } = await request;
  if (error) {
    if (options.signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
    ClubEntryTrustService.track('find', 'searched', {
      outcome: 'failed',
      durationMs: Math.round(performance.now() - startedAt),
      metadata: { error_code: error.code || 'unknown' },
    });
    throw new Error(error.message || 'Player search failed.');
  }
  const page = (data || {}) as Record<string, unknown>;
  const result = {
    items: Array.isArray(page.items)
      ? (page.items as Array<Record<string, unknown>>).map((item) => ({
          ...(item as unknown as PlayerSearchResult),
          tables: Array.isArray(item.tables) ? (item.tables as PlayerSearchTable[]) : [],
          sensitive_accounts: Array.isArray(item.sensitive_accounts)
            ? (item.sensitive_accounts as PlayerSensitiveAccount[])
            : [],
        }))
      : [],
    total: Number(page.total) || 0,
    hasMore: page.has_more === true,
    offset: Number(page.offset) || 0,
    limit: Number(page.limit) || options.limit || 20,
  };
  ClubEntryTrustService.track('find', options.offset ? 'loaded_more' : 'searched', {
    outcome: 'succeeded',
    durationMs: Math.round(performance.now() - startedAt),
    metadata: { result_count: result.items.length },
  });
  return result;
}

/** Revalidate a search result at click time so stale presence or membership cannot route access. */
export async function getTableWatchAccess(tableId: string): Promise<TableWatchAccess> {
  const { data, error } = await supabase.rpc('fn_get_table_watch_access', {
    p_table_id: tableId,
  });
  if (error || !data || typeof data !== 'object') {
    throw new Error(error?.message || 'Could not verify table access.');
  }
  const value = data as Record<string, unknown>;
  return {
    ...(value as unknown as TableWatchAccess),
    found: value.found === true,
    can_watch: value.can_watch === true,
    action: (value.action || 'unavailable') as TableWatchAccess['action'],
  };
}

export async function getPlayerSearchPreferences(): Promise<PlayerSearchPreferences> {
  const { data, error } = await supabase.rpc('fn_get_player_search_preferences');
  if (error || !data || typeof data !== 'object') throw new Error('Could not load search privacy.');
  const value = data as Record<string, unknown>;
  return {
    discoverable: value.discoverable !== false,
    showDisplayName: value.show_display_name !== false,
    showPresence: value.show_presence !== false,
    showCurrentTable: value.show_current_table !== false,
  };
}

export async function setPlayerSearchPreferences(
  preferences: PlayerSearchPreferences
): Promise<PlayerSearchPreferences> {
  const { data, error } = await supabase.rpc('fn_set_player_search_preferences', {
    p_discoverable: preferences.discoverable,
    p_show_display_name: preferences.showDisplayName,
    p_show_presence: preferences.showPresence,
    p_show_current_table: preferences.showCurrentTable,
  });
  if (error || !data) throw new Error(error?.message || 'Could not save search privacy.');
  ClubEntryTrustService.track('find', 'privacy_saved', { outcome: 'succeeded' });
  return getPlayerSearchPreferences();
}

export const PlayerSearchService = {
  search: searchPlayers,
  getTableWatchAccess,
  getPreferences: getPlayerSearchPreferences,
  setPreferences: setPlayerSearchPreferences,
};
