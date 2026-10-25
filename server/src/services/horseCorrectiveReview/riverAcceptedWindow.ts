/** Explicit, bounded private accepted-key enumeration. No card payload is read.
 * An exhausted page is not a complete eligible-decision or holdout certificate. */
import pg from 'pg';
import tls from 'node:tls';
import { SUPABASE_ROOT_2021_CA } from '../supabase/enginePgSession.js';
import { evidenceDigest } from './authority.js';
const LIMIT = 128;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const INDEX = `SELECT i.indisvalid AND i.indisready AND i.indrelid='public.hand_atomic_commits'::regclass
 AND regexp_replace(pg_get_indexdef(i.indexrelid),'\\s+','','g') =
 regexp_replace('CREATE INDEX horse_accepted_window_time ON public.hand_atomic_commits USING btree (committed_at, hand_id)','\\s+','','g') AS ready
 FROM pg_index i WHERE i.indexrelid=to_regclass('public.horse_accepted_window_time')`;
const FENCE = `SELECT (pg_has_role(current_user,'pg_read_all_stats','MEMBER') OR
 (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)) AS visibility,
 to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fence_at,
 NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
 AND xact_start < $1::timestamptz) AND
 NOT EXISTS(SELECT 1 FROM pg_prepared_xacts WHERE database=current_database()) AS clear`;
const QUERY = `SELECT c.hand_id::text AS hand_id,c.table_id::text AS table_id,c.hand_number::text AS hand_number,
 to_char(c.committed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS committed_at,
 c.payload_hash AS core_digest,c.post_commit_payload_hash AS payload_digest,
 r.status AS roster_status,r.post_commit_payload_hash AS roster_payload_digest,
 CASE WHEN r.roster IS NULL THEN NULL ELSE encode(extensions.digest(convert_to(r.roster::text,'UTF8'),'sha256'),'hex') END AS roster_digest
 FROM public.hand_atomic_commits c LEFT JOIN smarter_private.accepted_hand_rosters r
 ON r.table_id=c.table_id AND r.hand_number=c.hand_number AND r.hand_id=c.hand_id
 WHERE c.committed_at >= $1::timestamptz AND c.committed_at < $2::timestamptz
 AND ($3::timestamptz IS NULL OR (c.committed_at,c.hand_id)>($3::timestamptz,$4::uuid))
 ORDER BY c.committed_at,c.hand_id LIMIT 129`;
export interface AcceptedWindowCursor {
  committedAt: string;
  handId: string;
}
export interface AcceptedWindowRequest {
  startsAt: string;
  endsAt: string;
  after: AcceptedWindowCursor | null;
}
export interface AcceptedWindowKey extends AcceptedWindowCursor {
  tableId: string;
  handNumber: string;
  coreDigest: string;
  payloadDigest: string | null;
  rosterDigest: string | null;
  gaps: readonly string[];
}
const flags = {
  qualified: false as const,
  completePopulation: false as const,
  activationAllowed: false as const,
};
export type AcceptedWindowResult = typeof flags &
  (
    | {
        version: 1;
        status: 'accepted_window_page';
        startsAt: string;
        endsAt: string;
        after: AcceptedWindowCursor | null;
        readAt: string;
        finalityFenceAt: string;
        snapshotId: string;
        keys: readonly AcceptedWindowKey[];
        hasMore: boolean;
        next: AcceptedWindowCursor | null;
        pageDigest: string;
      }
    | {
        version: 1;
        status: 'unavailable';
        reason:
          | 'window_request_refused'
          | 'window_configuration_unavailable'
          | 'window_source_unavailable'
          | 'window_index_unavailable'
          | 'window_reply_refused'
          | 'window_finality_unavailable';
      }
  );
const no = (
  reason: Extract<AcceptedWindowResult, { status: 'unavailable' }>['reason']
): AcceptedWindowResult => Object.freeze({ version: 1, status: 'unavailable', reason, ...flags });
function instant(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:\d{3})?Z$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(Date.parse(v)).toISOString().slice(0, 23) === v.slice(0, 23)
  );
}
const order = (c: AcceptedWindowCursor) =>
  `${c.committedAt.replace(/\.(\d{3})Z$/, (_, ms: string) => '.' + ms + '000Z')}:${c.handId}`;
// PostgreSQL cursors and fences carry six fractional digits. Date.parse alone
// truncates the last three and can admit a fence before its actual boundary.
const micros = (value: string): bigint =>
  BigInt(Date.parse(value)) * 1000n + BigInt(value.match(/\.\d{3}(\d{3})?Z$/)![1] ?? '0');
const MAX_WINDOW_MICROS = 7n * 86400000000n;
/** Factory captures configured DATABASE_URL only. No network operation on import
 * or factory creation; each explicit invocation reads at most one bounded page. */
export function createRiverAcceptedWindowReader(
  environment: Readonly<Record<string, string | undefined>>
) {
  let connectionString: string | null = null;
  try {
    const raw = environment.DATABASE_URL;
    if (!raw || raw.length > 8192 || raw !== raw.trim() || /[\r\n\0]/.test(raw)) throw Error();
    const url = new URL(raw);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      !url.pathname ||
      url.hash
    )
      throw Error();
    for (const key of [...url.searchParams.keys()])
      if (/^ssl/i.test(key)) url.searchParams.delete(key);
    connectionString = url.href;
  } catch {
    /* Fixed configuration refusal. */
  }
  let busy = false;
  return async (request: AcceptedWindowRequest): Promise<AcceptedWindowResult> => {
    if (
      !request ||
      Object.keys(request).sort().join(',') !== 'after,endsAt,startsAt' ||
      !instant(request.startsAt) ||
      !instant(request.endsAt) ||
      micros(request.startsAt) >= micros(request.endsAt) ||
      micros(request.endsAt) - micros(request.startsAt) > MAX_WINDOW_MICROS ||
      (request.after !== null &&
        (!request.after ||
          Object.keys(request.after).sort().join(',') !== 'committedAt,handId' ||
          !instant(request.after.committedAt) ||
          !UUID.test(request.after.handId) ||
          micros(request.after.committedAt) < micros(request.startsAt) ||
          micros(request.after.committedAt) >= micros(request.endsAt)))
    )
      return no('window_request_refused');
    if (!connectionString) return no('window_configuration_unavailable');
    if (busy) return no('window_source_unavailable');
    const captured = structuredClone(request),
      client = new pg.Client({
        connectionString,
        ssl: { ca: [...tls.rootCertificates, SUPABASE_ROOT_2021_CA], rejectUnauthorized: true },
        connectionTimeoutMillis: 5000,
        statement_timeout: 2000,
        lock_timeout: 250,
        query_timeout: 3000,
        application_name: 'horse-phase14-accepted-window',
      });
    busy = true;
    let begun = false;
    try {
      await client.connect();
      // Fence BEFORE creating the enumeration snapshot: a pre-end writer that
      // commits during this read is visible to the subsequent fresh snapshot.
      const fenceReply = await client.query(FENCE, [captured.endsAt]);
      const fence = fenceReply.rows[0];
      if (
        fenceReply.rows.length !== 1 ||
        fence.visibility !== true ||
        fence.clear !== true ||
        !instant(fence.fence_at) ||
        micros(fence.fence_at) < micros(captured.endsAt) ||
        micros(fence.fence_at) - micros(captured.startsAt) > MAX_WINDOW_MICROS
      )
        return no('window_finality_unavailable');
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      begun = true;
      const index = await client.query(INDEX);
      if (index.rows.length !== 1 || index.rows[0].ready !== true)
        return no('window_index_unavailable');
      const clock = await client.query(
        `SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at,pg_current_snapshot()::text AS snapshot_id`
      );
      const meta = clock.rows[0];
      if (
        clock.rows.length !== 1 ||
        !instant(meta.read_at) ||
        typeof meta.snapshot_id !== 'string' ||
        !/^[0-9]+:[0-9]+:[0-9,]*$/.test(meta.snapshot_id) ||
        meta.snapshot_id.length > 8192 ||
        micros(meta.read_at) < micros(captured.endsAt)
      )
        return no('window_reply_refused');
      const reply = await client.query(QUERY, [
        captured.startsAt,
        captured.endsAt,
        captured.after?.committedAt ?? null,
        captured.after?.handId ?? null,
      ]);
      if (
        reply.rows.length > LIMIT + 1 ||
        Buffer.byteLength(JSON.stringify(reply.rows)) > 256 * 1024
      )
        return no('window_reply_refused');
      const keys: AcceptedWindowKey[] = [];
      let previous = captured.after ? order(captured.after) : null;
      for (const row of reply.rows) {
        if (
          Object.keys(row).sort().join(',') !==
            'committed_at,core_digest,hand_id,hand_number,payload_digest,roster_digest,roster_payload_digest,roster_status,table_id' ||
          !UUID.test(row.hand_id) ||
          !UUID.test(row.table_id) ||
          typeof row.hand_number !== 'string' ||
          !/^[1-9][0-9]{0,18}$/.test(row.hand_number) ||
          !instant(row.committed_at) ||
          micros(row.committed_at) < micros(captured.startsAt) ||
          micros(row.committed_at) >= micros(captured.endsAt) ||
          !HASH.test(row.core_digest) ||
          (row.payload_digest !== null && !HASH.test(row.payload_digest)) ||
          (row.roster_digest !== null && !HASH.test(row.roster_digest)) ||
          (row.roster_payload_digest !== null && !HASH.test(row.roster_payload_digest)) ||
          (row.roster_status !== null && typeof row.roster_status !== 'string')
        )
          return no('window_reply_refused');
        const cursor = { committedAt: row.committed_at, handId: row.hand_id },
          current = order(cursor);
        if (previous !== null && current <= previous) return no('window_reply_refused');
        previous = current;
        const gaps: string[] = [];
        if (row.payload_digest === null) gaps.push('accepted_payload_missing');
        if (row.roster_status !== 'captured' || row.roster_digest === null)
          gaps.push('accepted_roster_missing');
        if (row.roster_payload_digest !== row.payload_digest)
          gaps.push('accepted_roster_payload_mismatch');
        keys.push(
          Object.freeze({
            ...cursor,
            tableId: row.table_id,
            handNumber: row.hand_number,
            coreDigest: row.core_digest,
            payloadDigest: row.payload_digest,
            rosterDigest: row.roster_digest,
            gaps: Object.freeze(gaps),
          })
        );
      }
      const hasMore = keys.length > LIMIT;
      if (hasMore) keys.pop();
      const last = keys.at(-1),
        next =
          hasMore && last
            ? Object.freeze({ committedAt: last.committedAt, handId: last.handId })
            : null;
      await client.query('COMMIT');
      begun = false;
      const page = {
        version: 1 as const,
        status: 'accepted_window_page' as const,
        ...captured,
        readAt: meta.read_at,
        finalityFenceAt: fence.fence_at,
        snapshotId: meta.snapshot_id,
        keys: Object.freeze(keys),
        hasMore,
        next,
        ...flags,
      };
      return Object.freeze({ ...page, pageDigest: evidenceDigest(page) });
    } catch {
      return no('window_source_unavailable');
    } finally {
      if (begun)
        try {
          await client.query('ROLLBACK');
        } catch {}
      try {
        await client.end();
      } catch {}
      busy = false;
    }
  };
}
