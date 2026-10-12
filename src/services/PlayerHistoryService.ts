import { supabase } from '../lib/supabase';

export type HistoryKind = 'all' | 'roles' | 'status' | 'notes' | 'exports';
export interface HistoryCursor {
  createdAt: string;
  id: string;
}
export interface HistoryState {
  role?: string | null;
  status?: string | null;
  nickname_present?: boolean;
  remark_present?: boolean;
  nickname_length?: number;
  remark_length?: number;
  row_count?: number;
  selected_only?: boolean;
  selected_count?: number;
  filter?: string;
  sort?: string;
  search_used?: boolean;
}
export interface HistoryEntry {
  id: string;
  createdAt: string;
  clubId: string;
  targetUserId: string | null;
  actorId: string;
  actorName: string | null;
  actorRole: string;
  action: string;
  kind: Exclude<HistoryKind, 'all'>;
  before: HistoryState;
  after: HistoryState;
}
export interface HistoryPage {
  rows: HistoryEntry[];
  nextCursor: HistoryCursor | null;
  hasMore: boolean;
  scopeClubIds: string[];
}
export interface HistoryOptions {
  playerId?: string;
  kind?: HistoryKind;
  dateFrom?: string;
  dateTo?: string;
  cursor?: HistoryCursor | null;
  limit?: number;
}
const kinds = ['all', 'roles', 'status', 'notes', 'exports'];
const actions: Record<string, HistoryEntry['kind']> = {
  role_change: 'roles',
  set_member_role: 'roles',
  banned: 'status',
  unban_member: 'status',
  member_status_change: 'status',
  set_member_status: 'status',
  kick_member: 'status',
  member_left: 'status',
  depart_club_member: 'status',
  update_member_notes: 'notes',
  export_club_roster: 'exports',
};
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const timestamp = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) &&
  Number.isFinite(Date.parse(v));
// PostgreSQL orders microseconds; Date.parse alone discards three significant digits.
const instant = (v: string): bigint =>
  BigInt(Date.parse(v)) * 1000n +
  BigInt((v.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3, 6));
const count = (v: unknown): boolean =>
  (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) &&
  Number.isSafeInteger(Number(v)) &&
  Number(v) >= 0;
function invalid(): never {
  throw new Error('Player History Response Was Incomplete');
}
function state(v: unknown): HistoryState {
  if (!object(v)) return invalid();
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) {
    if (['role', 'status'].includes(key)) {
      if (value !== null && !text(value)) return invalid();
      result[key] = value;
    } else if (
      ['nickname_present', 'remark_present', 'selected_only', 'search_used'].includes(key)
    ) {
      if (typeof value !== 'boolean') return invalid();
      result[key] = value;
    } else if (['nickname_length', 'remark_length', 'selected_count', 'row_count'].includes(key)) {
      if (!count(value)) return invalid();
      result[key] = Number(value);
    } else if (['filter', 'sort'].includes(key)) {
      if (!text(value)) return invalid();
      result[key] = value;
    } else return invalid();
  }
  return result as HistoryState;
}
function cursor(v: unknown): HistoryCursor {
  if (!object(v) || !timestamp(v.created_at) || !uuid(v.id)) return invalid();
  return { createdAt: v.created_at, id: v.id };
}
function decode(
  value: unknown,
  limit: number,
  clubId: string,
  options: HistoryOptions
): HistoryPage {
  if (
    !object(value) ||
    value.club_id !== clubId ||
    !Array.isArray(value.scope_club_ids) ||
    value.scope_club_ids.length === 0 ||
    !value.scope_club_ids.every(uuid) ||
    !Array.isArray(value.rows) ||
    value.rows.length > limit ||
    typeof value.has_more !== 'boolean'
  )
    return invalid();
  const scope = new Set(value.scope_club_ids);
  const rows = value.rows.map((v): HistoryEntry => {
    if (
      !object(v) ||
      !uuid(v.id) ||
      !timestamp(v.created_at) ||
      !uuid(v.club_id) ||
      !uuid(v.actor_id) ||
      !text(v.actor_role) ||
      !text(v.action) ||
      !kinds.slice(1).includes(String(v.kind)) ||
      (v.target_user_id !== null && !uuid(v.target_user_id)) ||
      (v.actor_name !== null && !text(v.actor_name))
    )
      return invalid();
    if (
      !scope.has(v.club_id) ||
      actions[v.action] !== v.kind ||
      (options.kind && options.kind !== 'all' && options.kind !== v.kind) ||
      (options.playerId && v.target_user_id !== options.playerId)
    )
      return invalid();
    const before = state(v.before),
      after = state(v.after);
    const expected =
      v.kind === 'roles'
        ? ['role']
        : v.kind === 'status'
          ? ['status']
          : v.kind === 'notes'
            ? ['nickname_present', 'remark_present', 'nickname_length', 'remark_length']
            : ['row_count', 'selected_only', 'selected_count', 'filter', 'sort', 'search_used'];
    if (
      !expected.every((key) => key in after) ||
      (v.kind !== 'exports' && !expected.every((key) => key in before)) ||
      (v.kind === 'exports' && (v.target_user_id !== null || Object.keys(before).length !== 0))
    )
      return invalid();
    if (
      Object.keys(after).some((key) => !expected.includes(key)) ||
      Object.keys(before).some((key) => !expected.includes(key))
    )
      return invalid();
    const day = new Date(v.created_at).toISOString().slice(0, 10);
    if ((options.dateFrom && day < options.dateFrom) || (options.dateTo && day > options.dateTo))
      return invalid();
    return {
      id: v.id,
      createdAt: v.created_at,
      clubId: v.club_id,
      targetUserId: v.target_user_id as string | null,
      actorId: v.actor_id,
      actorName: v.actor_name as string | null,
      actorRole: v.actor_role,
      action: v.action,
      kind: v.kind as HistoryEntry['kind'],
      before,
      after,
    };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length) return invalid();
  const nextCursor = value.next_cursor === null ? null : cursor(value.next_cursor);
  const last = rows[rows.length - 1];
  for (let i = 0; i < rows.length; i++) {
    const previous =
      i === 0 ? options.cursor : { createdAt: rows[i - 1].createdAt, id: rows[i - 1].id };
    if (previous) {
      const a = instant(previous.createdAt),
        b = instant(rows[i].createdAt);
      if (b > a || (b === a && rows[i].id.toLowerCase() >= previous.id.toLowerCase()))
        return invalid();
    }
  }
  if (
    value.has_more !== (nextCursor !== null) ||
    (value.has_more && rows.length !== limit) ||
    (nextCursor && (!last || nextCursor.id !== last.id || nextCursor.createdAt !== last.createdAt))
  )
    return invalid();
  return { rows, nextCursor, hasMore: value.has_more, scopeClubIds: [...scope] as string[] };
}
function date(v: string | undefined): string | null {
  if (v === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v)
    throw new Error('Invalid History Date');
  return v;
}
export default {
  async getPlayerHistory(
    clubId: string,
    options: HistoryOptions = {},
    signal?: AbortSignal
  ): Promise<HistoryPage> {
    if (!uuid(clubId) || (options.playerId !== undefined && !uuid(options.playerId)))
      throw new Error('Invalid History Scope');
    const kind = options.kind ?? 'all';
    if (!kinds.includes(kind)) throw new Error('Invalid History Kind');
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new Error('Invalid History Page Size');
    const from = date(options.dateFrom),
      to = date(options.dateTo);
    if (from && to && from > to) throw new Error('Invalid History Date Range');
    if (options.cursor && (!uuid(options.cursor.id) || !timestamp(options.cursor.createdAt)))
      throw new Error('Invalid History Cursor');
    const { runRosterReadWithRetry } = await import('../utils/rosterReadReliability');
    return runRosterReadWithRetry(
      async (attemptSignal) => {
        const { data, error } = await supabase
          .rpc('ca_club_player_history', {
            p_club_id: clubId,
            p_target_user_id: options.playerId ?? null,
            p_kind: kind,
            p_from: from,
            p_to: to,
            p_cursor: options.cursor
              ? { created_at: options.cursor.createdAt, id: options.cursor.id }
              : null,
            p_limit: limit,
          })
          .abortSignal(attemptSignal);
        if (error) throw error;
        return decode(data, limit, clubId, options);
      },
      { attempts: 1, timeoutMs: 8_000, signal }
    );
  },
};
