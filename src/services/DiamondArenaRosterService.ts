/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND ARENA ROSTER SERVICE (2026-09-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The arena's Players page reads through here, and only through here:
 *
 *   fn_diamond_arena_counts()   members, online, seated and open tables, each
 *                               a number or NULL when the server cannot tell;
 *   fn_diamond_arena_roster()   the arena's players, a page at a time.
 *
 * Both are Diamond readers (migration 20260929214500). The chip roster's
 * ca_club_members_summary / ca_club_members_page are never asked about the
 * arena: they look the viewer up in club_members, where the arena has one
 * row with status `automatic`, and answer "approved members only".
 *
 * A ROW IS REDUCED TO WHAT THE ARENA SHOWS. Name, username, avatar, player
 * number and presence. Whatever else a future server answer carries is
 * dropped here, so no role, upline, fee, wallet or chip figure can reach the
 * page by accident.
 */
import { supabase } from '../lib/supabase';
import { parseDiamondArenaCounts, type DiamondArenaCounts } from '../lib/diamondArenaCounts';
import { runRosterReadWithRetry } from '../utils/rosterReadReliability';

export type DiamondRosterFilter = 'all' | 'seated';
export type DiamondRosterCursor = Record<string, string | number>;

export interface DiamondRosterPlayer {
  user_id: string;
  /** The Club Arena name: profiles.alias, then display name, then username. */
  alias: string;
  username: string;
  avatar_url: string | null;
  player_number: string | null;
  /** In a live seat at an open Diamond table. */
  is_seated: boolean;
  /** Seated, or shown by the presence feed in the last five minutes. */
  is_online: boolean;
}

export interface DiamondRosterPage {
  items: DiamondRosterPlayer[];
  next_cursor: DiamondRosterCursor | null;
  has_more: boolean;
  filtered_total: number;
}

export interface DiamondRosterQuery {
  search?: string;
  filter?: DiamondRosterFilter;
  cursor?: DiamondRosterCursor | null;
  limit?: number;
  signal?: AbortSignal;
}

const MAX_SEARCH_LENGTH = 120;

/** Thrown when the roster answers in a shape the page cannot read. */
export class DiamondRosterShapeError extends Error {
  constructor() {
    super('The Diamond Arena roster answered in a shape this page cannot read');
    this.name = 'DiamondRosterShapeError';
  }
}

/** One roster row, reduced to the seven fields the arena shows, or null if unusable. */
export function toDiamondRosterPlayer(raw: unknown): DiamondRosterPlayer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.user_id !== 'string' || row.user_id === '') return null;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const optional = (value: unknown) =>
    typeof value === 'string' && value.trim() !== '' ? value : null;
  return {
    user_id: row.user_id,
    alias: text(row.alias).trim() || 'Unknown',
    username: text(row.username),
    avatar_url: optional(row.avatar_url),
    player_number: optional(row.player_number),
    is_seated: row.is_seated === true,
    is_online: row.is_online === true,
  };
}

/**
 * Read one roster page. A page without an item list or a total is not an
 * empty roster, it is an answer this page cannot read: it throws, and the page
 * says the roster could not be loaded instead of printing "0 Results".
 */
export function toDiamondRosterPage(data: unknown): DiamondRosterPage {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new DiamondRosterShapeError();
  const page = data as Record<string, unknown>;
  const total = typeof page.filtered_total === 'number' ? page.filtered_total : Number.NaN;
  if (!Array.isArray(page.items) || !Number.isInteger(total) || total < 0) {
    throw new DiamondRosterShapeError();
  }
  const cursor =
    page.next_cursor && typeof page.next_cursor === 'object' && !Array.isArray(page.next_cursor)
      ? (page.next_cursor as DiamondRosterCursor)
      : null;
  return {
    items: page.items
      .map(toDiamondRosterPlayer)
      .filter((row): row is DiamondRosterPlayer => row !== null),
    next_cursor: cursor,
    has_more: page.has_more === true && cursor !== null,
    filtered_total: total,
  };
}

function withSignal<T>(request: T, signal: AbortSignal): T {
  const candidate = request as unknown as { abortSignal?: (value: AbortSignal) => T };
  return typeof candidate.abortSignal === 'function' ? candidate.abortSignal(signal) : request;
}

const DiamondArenaRosterService = {
  /** The four figures. A failed read throws; the page shows every figure as unknown. */
  async getCounts(signal?: AbortSignal): Promise<DiamondArenaCounts> {
    return runRosterReadWithRetry(
      async (attemptSignal) => {
        const { data, error } = await withSignal(
          supabase.rpc('fn_diamond_arena_counts'),
          attemptSignal
        );
        if (error) throw error;
        return parseDiamondArenaCounts(data);
      },
      { signal, timeoutMs: 8_000 }
    );
  },

  /** One page of the arena's players, filtered and searched on the server. */
  async getRosterPage(query: DiamondRosterQuery = {}): Promise<DiamondRosterPage> {
    return runRosterReadWithRetry(
      async (attemptSignal) => {
        const { data, error } = await withSignal(
          supabase.rpc('fn_diamond_arena_roster', {
            p_search: (query.search ?? '').trim().slice(0, MAX_SEARCH_LENGTH),
            p_filter: query.filter === 'seated' ? 'seated' : 'all',
            p_cursor: query.cursor ?? null,
            p_limit: query.limit ?? 80,
          }),
          attemptSignal
        );
        if (error) throw error;
        return toDiamondRosterPage(data);
      },
      { attempts: 1, signal: query.signal, timeoutMs: 20_000 }
    );
  },
};

export default DiamondArenaRosterService;
