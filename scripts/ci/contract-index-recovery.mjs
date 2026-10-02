/** Finite opt-in recovery of one observed interrupted migration; no SQL on import. */
import { createHash } from 'node:crypto';
export const RECOVERY_FILE = '20261001171339_archived_alert_contract_authority_lookup.sql';
export const RECOVERY_INDEX = 'public.managed_game_contract_versions_game_id_id_idx';
export function validRecoveryCutoff(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return false;
  const ms = Date.parse(value);
  return (
    Number.isFinite(ms) &&
    ms <= Date.now() &&
    new Date(ms).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z')
  );
}
export const RECOVERY_SHA = '6790ef3affa5f220d5613e5edcf50f0e1b0c1cd2260dbd6326336fe860b70c38';
export const EXPECTED_DEFINITION =
  'CREATE INDEX managed_game_contract_versions_game_id_id_idx ON public.managed_game_contract_versions USING btree (game_id, id)';
export function recoveryRequest(file, sql, index, oid, before, transientOid = null) {
  if (!index && !oid && !before && !transientOid) return null;
  if (
    (transientOid !== null &&
      (!/^[1-9][0-9]*$/.test(transientOid) ||
        BigInt(transientOid) > 4294967295n ||
        transientOid === oid)) ||
    !validRecoveryCutoff(before) ||
    file !== RECOVERY_FILE ||
    index !== RECOVERY_INDEX ||
    !/^[1-9][0-9]*$/.test(oid || '') ||
    BigInt(oid) > 4294967295n ||
    createHash('sha256').update(sql).digest('hex') !== RECOVERY_SHA
  ) {
    throw new Error('recovery requires exact migration bytes, approved index and observed OID');
  }
  return { index, oid, before, transientOid };
}
export const RECOVERY_CATALOG = `SELECT
 current_user='postgres' AS observer_authorized,
 c.oid::text AS oid, pg_get_userbyid(c.relowner) AS owner, pg_get_userbyid(t.relowner) AS table_owner,
 n.nspname AS schema, c.relname AS name, c.relkind,
 tn.nspname AS table_schema,t.relname AS table_name,
 i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live,
 i.indisreplident AS replica_identity,i.indisunique AS unique_index,i.indisprimary AS primary_index,i.indisexclusion AS exclusion_index,
 i.indnkeyatts AS key_count,i.indnatts AS attribute_count,
 i.indpred IS NULL AS no_predicate,i.indexprs IS NULL AS no_expression,
 pg_get_indexdef(c.oid) AS definition,
 ARRAY(SELECT s.relname::text FROM pg_class s WHERE s.relnamespace=c.relnamespace AND (s.relname LIKE 'managed_game_contract_versions_game_id_id_idx_ccnew%' OR s.relname LIKE 'managed_game_contract_versions_game_id_id_idx_ccold%') ORDER BY s.relname) AS transient_names,
 NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conindid=c.oid) AS no_constraints,
 NOT EXISTS(SELECT 1 FROM pg_class s WHERE s.relnamespace=c.relnamespace AND (s.relname LIKE 'managed_game_contract_versions_game_id_id_idx_ccnew%' OR s.relname LIKE 'managed_game_contract_versions_game_id_id_idx_ccold%')) AS no_transients,
 NOT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid=t.oid) AS no_builder
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_index i ON i.indexrelid=c.oid JOIN pg_class t ON t.oid=i.indrelid
 JOIN pg_namespace tn ON tn.oid=t.relnamespace
 WHERE c.oid=to_regclass('public.managed_game_contract_versions_game_id_id_idx')`;
// SNAPSHOT ADMISSION BY AGE (2026-10-02). The first rule refused while ANY
// other backend held a snapshot. Production always has some: dry run
// 37040440084 refused, and six samples found 20, 2, 3, 11, 3 and 3 PostgREST,
// pg_cron and autovacuum backends holding snapshots, the oldest about 34 s.
// DROP/REINDEX INDEX CONCURRENTLY wait for older snapshots; they do not fail
// on them. Only a LONG holder (the weekly-close readers behind both 600 s
// timeouts) can exhaust the budget, so admission now refuses only:
//   - any prepared transaction in this database (unchanged);
//   - any other backend here holding a snapshot (backend_xmin), an xid or an
//     open transaction whose age exceeds MAX_SNAPSHOT_AGE_SECONDS;
//   - any such backend whose age cannot be determined (unknown = refuse).
// Age is measured against fresh server time, clock_timestamp(), from
// xact_start, or from backend_start when no transaction start is reported
// (connection age can only overstate how long a snapshot has been held).
export const RECOVERY_SNAPSHOTS = `SELECT clock_timestamp()::text AS observed_at, current_user='postgres' AS observer_authorized,
 count(*)::int AS holders,
 count(*) FILTER (WHERE h.age_seconds IS NULL)::int AS unknown_age,
 max(h.age_seconds)::float8 AS oldest_age_seconds,
 NOT EXISTS(SELECT 1 FROM pg_prepared_xacts WHERE database=current_database()) AS no_prepared
 FROM (SELECT extract(epoch FROM clock_timestamp()-coalesce(xact_start,backend_start))::float8 AS age_seconds
  FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid()
  AND (backend_xmin IS NOT NULL OR backend_xid IS NOT NULL OR xact_start IS NOT NULL)) h`;
// 60 s, from this tool's own budget: every DDL statement shares one 600 s
// statement_timeout, and admission demands a 12-minute (720 s) runway before
// the :50 break window, so even an exhausted budget ends before the window.
// A holder already older than 60 s is evidence of a long reader (refuse). The
// bound sits ~1.8x above the oldest normal holder seen (~34 s) and is 10% of
// the 600 s budget, so admitted normal traffic leaves at least 540 s of the
// budget for the build itself. A holder that is young now but runs long is
// the same after-admission race the old rule could not prevent either: the
// shared budget ends the wait, the run exits UNKNOWN and nothing retries.
// The check still runs fresh before EACH DDL statement.
export const MAX_SNAPSHOT_AGE_SECONDS = 60;
// Fixed aggregate vocabulary only. Never reflect catalog/session fields such
// as pid, user, query or prepared-transaction GID into retained workflow logs.
export function recoverySnapshotDiagnostic(rows) {
  const r = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  const holders = Number.isSafeInteger(r?.holders) && r.holders >= 0 ? r.holders : 'unknown';
  const unknownAge =
    Number.isSafeInteger(r?.unknown_age) && r.unknown_age >= 0 ? r.unknown_age : 'unknown';
  const oldest =
    r?.oldest_age_seconds === null
      ? 'none'
      : typeof r?.oldest_age_seconds === 'number' &&
          Number.isFinite(r.oldest_age_seconds) &&
          r.oldest_age_seconds >= 0
        ? r.oldest_age_seconds
        : 'unknown';
  const prepared = r?.no_prepared === true ? 'no' : r?.no_prepared === false ? 'yes' : 'unknown';
  let category = 'unknown';
  if (r?.observer_authorized === true && prepared === 'yes') category = 'prepared-transaction';
  else if (
    r?.observer_authorized === true &&
    prepared === 'no' &&
    holders !== 'unknown' &&
    unknownAge !== 'unknown'
  ) {
    category =
      unknownAge > 0 ||
      oldest === 'unknown' ||
      (holders === 0 ? oldest !== 'none' : oldest === 'none' || oldest > MAX_SNAPSHOT_AGE_SECONDS)
        ? 'older-or-unknown-holder'
        : 'clear';
  }
  return `category=${category}; holders=${holders}; unknown_age=${unknownAge}; oldest_age_seconds=${oldest}; prepared=${prepared}`;
}
export function validateRecoveryCatalog(rows, request, recovered = false) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('unknown recovery catalog');
  const r = rows[0];
  if (
    r.observer_authorized !== true ||
    r.owner !== 'postgres' ||
    r.table_owner !== 'postgres' ||
    r.replica_identity !== false ||
    r.schema !== 'public' ||
    r.name !== 'managed_game_contract_versions_game_id_id_idx' ||
    r.relkind !== 'i' ||
    r.table_schema !== 'public' ||
    r.table_name !== 'managed_game_contract_versions' ||
    r.definition !== EXPECTED_DEFINITION ||
    r.valid !== recovered ||
    r.ready !== true ||
    r.live !== true ||
    r.unique_index !== false ||
    r.primary_index !== false ||
    r.exclusion_index !== false ||
    r.key_count !== 2 ||
    r.attribute_count !== 2 ||
    r.no_predicate !== true ||
    r.no_expression !== true ||
    r.no_constraints !== true ||
    r.no_transients !== true ||
    r.no_builder !== true ||
    !/^[1-9][0-9]*$/.test(r.oid || '') ||
    (recovered ? r.oid === request.oid : r.oid !== request.oid)
  )
    throw new Error('recovery catalog identity/shape/state differs');
  return r;
}
export function validateRecoverySnapshots(rows) {
  const r = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  const oldest = r ? r.oldest_age_seconds : undefined;
  if (!r || r.observer_authorized !== true || r.no_prepared == null)
    throw new Error('recovery admission state is unknown');
  if (r.no_prepared === false) throw new Error('prepared transaction prevents recovery');
  if (r.no_prepared !== true || !Number.isSafeInteger(r.holders) || r.holders < 0)
    throw new Error('recovery admission state is unknown');
  if (
    !Number.isSafeInteger(r.unknown_age) ||
    r.unknown_age !== 0 ||
    (r.holders === 0
      ? oldest !== null
      : typeof oldest !== 'number' ||
        !Number.isFinite(oldest) ||
        oldest < 0 ||
        oldest > MAX_SNAPSHOT_AGE_SECONDS)
  )
    throw new Error('older/unknown snapshot prevents recovery');
  return r;
}

export function recoveryStatement(request) {
  if (
    !request ||
    request.index !== RECOVERY_INDEX ||
    !validRecoveryCutoff(request.before) ||
    !/^[1-9][0-9]*$/.test(request.oid || '') ||
    BigInt(request.oid) > 4294967295n
  )
    throw new Error('unbound recovery command');
  return 'REINDEX INDEX CONCURRENTLY public.managed_game_contract_versions_game_id_id_idx';
}

// before is retained provenance only: each admission query uses its own server timestamp.
export const TRANSIENT_INDEX = RECOVERY_INDEX + '_ccnew';
export const RECOVERY_TRANSIENT_CATALOG = RECOVERY_CATALOG.replace(
  "WHERE c.oid=to_regclass('public.managed_game_contract_versions_game_id_id_idx')",
  "WHERE c.oid=to_regclass('public.managed_game_contract_versions_game_id_id_idx_ccnew')"
);
export function cleanupStatement(request) {
  recoveryStatement(request);
  if (
    !/^[1-9][0-9]*$/.test(request.transientOid || '') ||
    BigInt(request.transientOid) > 4294967295n ||
    request.transientOid === request.oid
  )
    throw new Error('unbound transient cleanup');
  return 'DROP INDEX CONCURRENTLY public.managed_game_contract_versions_game_id_id_idx_ccnew';
}
export function validateRecoveryPair(originalRows, transientRows, request) {
  cleanupStatement(request);
  if (
    !Array.isArray(originalRows) ||
    originalRows.length !== 1 ||
    !Array.isArray(transientRows) ||
    transientRows.length !== 1
  )
    throw new Error('unknown original/transient pair');
  const original = originalRows[0],
    transient = transientRows[0];
  const sole = ['managed_game_contract_versions_game_id_id_idx_ccnew'];
  for (const r of [original, transient])
    if (r.no_transients !== false || JSON.stringify(r.transient_names) !== JSON.stringify(sole))
      throw new Error('unexpected transient inventory');
  validateRecoveryCatalog([{ ...original, no_transients: true }], request);
  if (
    transient.name !== sole[0] ||
    transient.oid !== request.transientOid ||
    transient.definition !==
      EXPECTED_DEFINITION.replace('game_id_id_idx ON', 'game_id_id_idx_ccnew ON')
  )
    throw new Error('transient identity differs');
  validateRecoveryCatalog(
    [{ ...transient, name: original.name, definition: EXPECTED_DEFINITION, no_transients: true }],
    { ...request, oid: request.transientOid }
  );
  return { original, transient };
}
