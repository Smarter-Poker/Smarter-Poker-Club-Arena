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
export function recoveryRequest(file, sql, index, oid, before) {
  if (!index && !oid && !before) return null;
  if (
    !validRecoveryCutoff(before) ||
    file !== RECOVERY_FILE ||
    index !== RECOVERY_INDEX ||
    !/^[1-9][0-9]*$/.test(oid || '') ||
    BigInt(oid) > 4294967295n ||
    createHash('sha256').update(sql).digest('hex') !== RECOVERY_SHA
  ) {
    throw new Error('recovery requires exact migration bytes, approved index and observed OID');
  }
  return { index, oid, before };
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
 NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conindid=c.oid) AS no_constraints,
 NOT EXISTS(SELECT 1 FROM pg_class s WHERE s.relnamespace=c.relnamespace AND (s.relname LIKE 'managed_game_contract_versions_game_id_id_idx_ccnew%' OR s.relname LIKE 'managed_game_contract_versions_game_id_id_idx_ccold%')) AS no_transients,
 NOT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid=t.oid) AS no_builder
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_index i ON i.indexrelid=c.oid JOIN pg_class t ON t.oid=i.indrelid
 JOIN pg_namespace tn ON tn.oid=t.relnamespace
 WHERE c.oid=to_regclass('public.managed_game_contract_versions_game_id_id_idx')`;
export const RECOVERY_SNAPSHOTS = `SELECT current_user='postgres' AS observer_authorized,
 NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid() AND backend_xmin IS NOT NULL AND (xact_start IS NULL OR xact_start <= $1::timestamptz)) AS clear,
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
