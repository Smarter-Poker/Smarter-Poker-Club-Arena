/** Explicit, bounded public progress reads. Ordinary health probes stay compact. */
export const MAX_PUBLIC_LIVENESS_TABLES = 32;
export type PublicTableLivenessQuery =
  | { kind: 'tables'; tableIds: readonly string[] }
  | { kind: 'tournament'; gameFormat: 'mtt' | 'spin' | 'sng'; clubIds: readonly string[] };

export interface PublicTableLiveness {
  tableId: string;
  gameFormat: 'cash' | 'mtt' | 'spin' | 'sng' | null;
  clubId: string | null;
  seated: number;
  dealable: number;
  handCount: number;
  msSinceProgress: number;
  loopPhase: string;
  paused: boolean;
}

export function parsePublicTableLivenessQuery(
  params: URLSearchParams
): { ok: true; query?: PublicTableLivenessQuery } | { ok: false } {
  const allowed = ['liveness_table_ids', 'liveness_format', 'liveness_club_ids'];
  const keys = [...params.keys()].filter((key) => key.startsWith('liveness_'));
  if (keys.length === 0) return { ok: true };
  if (keys.some((key) => !allowed.includes(key) || params.getAll(key).length !== 1))
    return { ok: false };
  const ids = (raw: string | null, limit: number): string[] | null => {
    if (!raw || raw.length > limit * 37) return null;
    const values = raw.split(',');
    if (
      values.length > limit ||
      values.some((v) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
    )
      return null;
    return [...new Set(values.map((v) => v.toLowerCase()))];
  };
  if (params.has('liveness_table_ids')) {
    if (keys.length !== 1) return { ok: false };
    const tableIds = ids(params.get('liveness_table_ids'), MAX_PUBLIC_LIVENESS_TABLES);
    return tableIds ? { ok: true, query: { kind: 'tables', tableIds } } : { ok: false };
  }
  const gameFormat = params.get('liveness_format');
  const clubIds = ids(params.get('liveness_club_ids'), 2);
  return keys.length === 2 &&
    clubIds &&
    (gameFormat === 'mtt' || gameFormat === 'spin' || gameFormat === 'sng')
    ? { ok: true, query: { kind: 'tournament', gameFormat, clubIds } }
    : { ok: false };
}

/** Select from the same snapshot as health and release identity. Never expose
 * private manager rows, leases, holdings or an unbounded fleet array.
 */
export function selectPublicTableLiveness(
  tables: readonly PublicTableLiveness[],
  query: PublicTableLivenessQuery
): PublicTableLiveness[] {
  const selected =
    query.kind === 'tables'
      ? (() => {
          const byId = new Map(tables.map((table) => [table.tableId, table]));
          return [...new Set(query.tableIds)]
            .slice(0, MAX_PUBLIC_LIVENESS_TABLES)
            .map((id) => byId.get(id))
            .filter((table): table is PublicTableLiveness => Boolean(table));
        })()
      : tables
          .filter(
            (table) =>
              table.gameFormat === query.gameFormat &&
              table.clubId !== null &&
              query.clubIds.includes(table.clubId)
          )
          .sort(
            (a, b) =>
              b.dealable - a.dealable || b.seated - a.seated || a.tableId.localeCompare(b.tableId)
          )
          .slice(0, MAX_PUBLIC_LIVENESS_TABLES);
  return selected.map((table) => ({
    tableId: table.tableId,
    gameFormat: table.gameFormat,
    clubId: table.clubId,
    seated: table.seated,
    dealable: table.dealable,
    handCount: table.handCount,
    msSinceProgress: table.msSinceProgress,
    loopPhase: table.loopPhase.slice(0, 160),
    paused: table.paused,
  }));
}
