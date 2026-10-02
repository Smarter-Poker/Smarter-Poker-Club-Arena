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
export const RECOVERY_SNAPSHOTS = `SELECT statement_timestamp()::text AS observed_at, current_user='postgres' AS observer_authorized,
 NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid() AND backend_xmin IS NOT NULL AND (xact_start IS NULL OR xact_start <= statement_timestamp())) AS clear,
 NOT EXISTS(SELECT 1 FROM pg_prepared_xacts WHERE database=current_database()) AS no_prepared`;
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
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0].observer_authorized !== true ||
    rows[0].clear !== true ||
    rows[0].no_prepared !== true
  )
    throw new Error('older/unknown snapshot or prepared transaction prevents recovery');
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
