import {
  fetchMyLightningSession,
  hasLightningRoom,
  type LightningMySession,
} from './lightningSession';

export interface RecoverableSeatTable {
  id: string;
  cluster_id?: string | null;
  tournament_id?: string | null;
}

/** Resolve the durable admission to its private room before mounting any socket.
 * A failed session read is unknown, never permission to restore an observer.
 * No registry writes here: the caller must reject stale account/read results first.
 */
export async function resolveLightningSeatRooms<T extends RecoverableSeatTable>(
  rows: readonly T[],
  readSession: (clusterId: string) => Promise<LightningMySession> = fetchMyLightningSession,
  keepAnchors: ReadonlySet<string> = new Set()
): Promise<{ rows: T[]; rooms: { poolSessionId: string; clusterId: string; meta: null }[] }> {
  const clusters = [
    ...new Set(
      rows
        .filter((r) => !keepAnchors.has(r.id) && !r.tournament_id && r.cluster_id)
        .map((r) => r.cluster_id!)
    ),
  ];
  const sessions = new Map(
    await Promise.all(clusters.map(async (id) => [id, await readSession(id)] as const))
  );
  const rooms: { poolSessionId: string; clusterId: string; meta: null }[] = [];
  return {
    rows: rows.map((row) => {
      const session = row.cluster_id ? sessions.get(row.cluster_id) : null;
      if (
        !keepAnchors.has(row.id) &&
        !row.tournament_id &&
        session &&
        hasLightningRoom(session) &&
        session.anchorTableId === row.id &&
        session.poolSessionId &&
        row.cluster_id
      ) {
        rooms.push({ poolSessionId: session.poolSessionId, clusterId: row.cluster_id, meta: null });
        return { ...row, id: session.poolSessionId };
      }
      return row;
    }),
    rooms,
  };
}
