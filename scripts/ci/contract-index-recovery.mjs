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
export const CHICAGO_FILE = '20261023213635_today_win_loss_resets_at_chicago_midnight.sql';
export const CHICAGO_INDEX = 'public.ca_hand_facts_cash_member_time_idx';
export const CHICAGO_SHA = '3fb827d597941a0fe32260d9b0172e005cf86eea375d2bacaa888625a5339b5f';
export const FUNDING_FILE =
  '20261026161532_unpaid_lightning_earnings_follow_the_original_funding_club.sql';
export const FUNDING_INDEX = 'public.accounting_cash_club_week_player_cover';
export const FUNDING_SHA = 'c3206fd79746fcb8151e5aadfb074723b30aed8ca76904e3e694313a2c514d24';
export const CASH_HASH_FILE =
  '20261028184144_original_cash_proofs_select_their_union_before_the_hand_join.sql';
export const CASH_HASH_INDEX = 'public.union_pnl_cash_links_valid_union_hash';
export const CASH_HASH_FAILED_OID = '275975891';
export const CASH_HASH_SHA = 'dc7196271facd28499f5b6a56413d0ced4ccc4230fd9a5428a606db00b8dcce9';
export const CASH_HASH_OLD_DEFINITION =
  "CREATE INDEX union_pnl_cash_links_valid_union_hash ON public.union_pnl_cash_outcome_link_resolutions USING hash (((game_scope ->> 'game_union_id'::text))) WHERE (proof_md5 = md5((proof)::text))";
export function isCashHashRecovery(request) {
  return request?.index === CASH_HASH_INDEX;
}
export const CASH_PROOF_HAND_OID = '271236984';
export const CASH_PROOF_HAND_INDEX = 'public.union_pnl_cash_links_valid_proof_hand';
export const CASH_PROOF_HAND_DEFINITION =
  'CREATE INDEX union_pnl_cash_links_valid_proof_hand ON public.union_pnl_cash_outcome_link_resolutions USING btree (hand_id) INCLUDE (table_id, hand_number) WHERE (proof_md5 = md5((proof)::text))';
export const CASH_HASH_NEW_DEFINITION =
  "CREATE INDEX union_pnl_cash_links_valid_union_hash ON public.union_pnl_cash_outcome_link_resolutions USING hash (((game_scope ->> 'game_union_id'::text))) WHERE ((game_scope ->> 'game_union_id'::text) IS NOT NULL)";
export function recoveryRequest(
  file,
  sql,
  index,
  oid,
  before,
  transientOid = null,
  selectorOid = null
) {
  if (file === CASH_HASH_FILE && !isCashHashMigration(file, sql))
    throw new Error('Cash HASH installer requires exact qualified migration bytes');
  if (file === CASH_HASH_FILE && index === CASH_PROOF_HAND_INDEX) {
    if (oid !== CASH_PROOF_HAND_OID || transientOid)
      throw new Error('Retirement-only request requires exact old proof-hand OID');
    return { ...cashHashRetirementRequest(file, sql, selectorOid, before), retirementOnly: true };
  }
  if (selectorOid)
    throw new Error('Selector OID belongs only to explicit retirement-only recovery');

  if (file === CASH_HASH_FILE && index === CASH_HASH_INDEX) {
    if (
      transientOid ||
      !validRecoveryCutoff(before) ||
      oid !== CASH_HASH_FAILED_OID ||
      createHash('sha256').update(sql).digest('hex') !== CASH_HASH_SHA
    )
      throw new Error(
        'Cash HASH replacement requires exact corrected migration and observed failed OID'
      );
    return { index, oid, before, transientOid: null };
  }
  if (file === FUNDING_FILE && index === FUNDING_INDEX) {
    if (
      transientOid ||
      !validRecoveryCutoff(before) ||
      !/^[1-9][0-9]*$/.test(oid || '') ||
      BigInt(oid) > 4294967295n ||
      createHash('sha256').update(sql).digest('hex') !== FUNDING_SHA
    )
      throw new Error('Funding cover recovery requires exact migration bytes and observed OID');
    return { index, oid, before, transientOid: null };
  }

  if (file === CHICAGO_FILE && index === CHICAGO_INDEX) {
    if (
      transientOid ||
      !validRecoveryCutoff(before) ||
      !/^[1-9][0-9]*$/.test(oid || '') ||
      BigInt(oid) > 4294967295n ||
      createHash('sha256').update(sql).digest('hex') !== CHICAGO_SHA
    )
      throw new Error('Chicago recovery requires exact migration bytes and observed OID');
    return { index, oid, before, transientOid: null };
  }
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
export function recoveryCatalog(request) {
  if (isCashHashRecovery(request) && request.retirementOnly)
    throw new Error('Retirement-only mode cannot inspect or replace the valid selector');
  if (isCashHashRecovery(request))
    return RECOVERY_CATALOG.replaceAll(
      'managed_game_contract_versions_game_id_id_idx',
      'union_pnl_cash_links_valid_union_hash'
    )
      .replaceAll('managed_game_contract_versions', 'union_pnl_cash_outcome_link_resolutions')
      .replace(
        'NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conindid=c.oid) AS no_constraints,',
        `NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conindid=c.oid) AS no_constraints,
       (SELECT count(*)=1 AND bool_and(convalidated) FROM pg_constraint
        WHERE conrelid=t.oid AND conname='union_pnl_cash_outcome_link_resolutions_check'
        AND pg_get_constraintdef(oid)='CHECK ((proof_md5 = md5((proof)::text)))') AS cash_proof_check_validated,`
      );
  if (request?.index === FUNDING_INDEX)
    return RECOVERY_CATALOG.replaceAll(
      'managed_game_contract_versions_game_id_id_idx',
      'accounting_cash_club_week_player_cover'
    ).replaceAll('managed_game_contract_versions', 'accounting_cash_rake_sources');

  if (request?.index !== CHICAGO_INDEX) return RECOVERY_CATALOG;
  return RECOVERY_CATALOG.replaceAll(
    'managed_game_contract_versions_game_id_id_idx',
    'ca_hand_facts_cash_member_time_idx'
  ).replaceAll('managed_game_contract_versions', 'ca_hand_facts');
}
export function validateRecoveryCatalog(rows, request, recovered = false) {
  if (isCashHashRecovery(request) && request.retirementOnly)
    throw new Error('Retirement-only mode cannot qualify failed-selector removal');
  if (isCashHashRecovery(request)) {
    if (
      request.oid !== CASH_HASH_FAILED_OID ||
      request.transientOid ||
      !validRecoveryCutoff(request.before)
    )
      throw new Error('Unbound cash HASH replacement');
    if (recovered) {
      if (!Array.isArray(rows) || rows.length !== 0)
        throw new Error('Cash HASH removal is unproven');
      return { oid: 'absent' };
    }
    if (!Array.isArray(rows) || rows.length !== 1)
      throw new Error('Unknown failed cash HASH catalog');
    const r = rows[0];
    if (
      r.oid !== request.oid ||
      r.observer_authorized !== true ||
      r.owner !== 'postgres' ||
      r.table_owner !== 'postgres' ||
      r.schema !== 'public' ||
      r.name !== 'union_pnl_cash_links_valid_union_hash' ||
      r.relkind !== 'i' ||
      r.table_schema !== 'public' ||
      r.table_name !== 'union_pnl_cash_outcome_link_resolutions' ||
      r.definition !== CASH_HASH_OLD_DEFINITION ||
      r.valid !== false ||
      r.ready !== false ||
      r.live !== true ||
      r.replica_identity !== false ||
      r.unique_index !== false ||
      r.primary_index !== false ||
      r.exclusion_index !== false ||
      r.key_count !== 1 ||
      r.attribute_count !== 1 ||
      r.no_predicate !== false ||
      r.no_expression !== false ||
      r.no_constraints !== true ||
      r.no_transients !== true ||
      r.no_builder !== true ||
      r.cash_proof_check_validated !== true ||
      !Array.isArray(r.transient_names) ||
      r.transient_names.length !== 0
    )
      throw new Error('Failed cash HASH identity/shape/state differs');
    return r;
  }
  if (request?.index === FUNDING_INDEX) {
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('unknown funding cover catalog');
    const r = rows[0];
    if (
      r.name !== 'accounting_cash_club_week_player_cover' ||
      r.table_name !== 'accounting_cash_rake_sources' ||
      r.definition !==
        'CREATE INDEX accounting_cash_club_week_player_cover ON public.accounting_cash_rake_sources USING btree (club_id, earned_at) INCLUDE (player_id, id)' ||
      r.attribute_count !== 4
    )
      throw new Error('Funding cover index shape differs');
    validateRecoveryCatalog(
      [
        {
          ...r,
          name: 'managed_game_contract_versions_game_id_id_idx',
          table_name: 'managed_game_contract_versions',
          definition: EXPECTED_DEFINITION,
          attribute_count: 2,
        },
      ],
      { ...request, index: RECOVERY_INDEX },
      recovered
    );
    return r;
  }

  if (request?.index === CHICAGO_INDEX) {
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('unknown Chicago catalog');
    const r = rows[0];
    if (
      r.definition !==
        'CREATE INDEX ca_hand_facts_cash_member_time_idx ON public.ca_hand_facts USING btree (user_id, played_at) WHERE (tournament_id IS NULL)' ||
      r.name !== 'ca_hand_facts_cash_member_time_idx' ||
      r.table_name !== 'ca_hand_facts' ||
      r.no_predicate !== false
    )
      throw new Error('Chicago index shape differs');
    // Reuse every established identity, validity, constraint and OID guard.
    validateRecoveryCatalog(
      [
        {
          ...r,
          name: 'managed_game_contract_versions_game_id_id_idx',
          table_name: 'managed_game_contract_versions',
          definition: EXPECTED_DEFINITION,
          no_predicate: true,
        },
      ],
      { ...request, index: RECOVERY_INDEX },
      recovered
    );
    return r;
  }
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
  if (isCashHashRecovery(request) && request.retirementOnly)
    throw new Error('Retirement-only mode cannot touch the valid selector');
  if (isCashHashRecovery(request)) {
    if (
      request.oid !== CASH_HASH_FAILED_OID ||
      request.transientOid ||
      !validRecoveryCutoff(request.before)
    )
      throw new Error('Unbound cash HASH removal');
    return 'DROP INDEX CONCURRENTLY public.union_pnl_cash_links_valid_union_hash';
  }
  if (request?.index === FUNDING_INDEX) {
    recoveryStatement({ ...request, index: RECOVERY_INDEX });
    if (request.transientOid) throw new Error('Funding transient recovery is not admitted');
    return 'REINDEX INDEX CONCURRENTLY public.accounting_cash_club_week_player_cover';
  }

  if (request?.index === CHICAGO_INDEX) {
    recoveryStatement({ ...request, index: RECOVERY_INDEX });
    if (request.transientOid) throw new Error('Chicago transient recovery is not admitted');
    return 'REINDEX INDEX CONCURRENTLY public.ca_hand_facts_cash_member_time_idx';
  }
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

const CASH_LINK_CONSTRAINTS = [
  [
    'union_pnl_cash_outcome_link_resoluti_outcome_evidence_md5_check',
    "CHECK ((outcome_evidence_md5 ~ '^[0-9a-f]{32}$'::text))",
    true,
  ],
  [
    'union_pnl_cash_outcome_link_resolutions_check',
    'CHECK ((proof_md5 = md5((proof)::text)))',
    true,
  ],
  [
    'union_pnl_cash_outcome_link_resolutions_check1',
    "CHECK (((roster_source = 'manifest'::text) = (manifest_id IS NOT NULL)))",
    true,
  ],
  [
    'union_pnl_cash_outcome_link_resolutions_check2',
    "CHECK ((((proof ->> 'status'::text) = 'proven'::text) AND ((proof ->> 'resolution_kind'::text) = 'cash_outcome_provenance_link'::text) AND ((proof ->> 'table_id'::text) = (table_id)::text) AND (((proof ->> 'hand_number'::text))::bigint = hand_number) AND ((proof ->> 'hand_id'::text) = (hand_id)::text) AND ((proof ->> 'outcome_payload_hash'::text) = outcome_payload_hash) AND ((proof ->> 'outcome_evidence_md5'::text) = outcome_evidence_md5) AND ((proof ->> 'roster_source'::text) = roster_source) AND (NOT ((proof ->> 'manifest_id'::text) IS DISTINCT FROM (manifest_id)::text)) AND ((proof -> 'game_scope'::text) = game_scope) AND ((proof -> 'evidence'::text) = evidence) AND ((evidence -> 'game_scope'::text) = game_scope)))",
    true,
  ],
  [
    'union_pnl_cash_outcome_link_resolutions_evidence_check',
    "CHECK (((jsonb_typeof(evidence) = 'object'::text) AND ((evidence ->> 'provenance_link'::text) = 'resolved'::text)))",
    true,
  ],
  [
    'union_pnl_cash_outcome_link_resolutions_game_scope_check',
    "CHECK (((jsonb_typeof(game_scope) = 'object'::text) AND (game_scope ?& ARRAY['game_union_id'::text, 'host_club_id'::text, 'tournament_id'::text, 'is_private'::text, 'asset'::text, 'unit_scale'::text])))",
    true,
  ],
  ['union_pnl_cash_outcome_link_resolutions_hand_id_key', 'UNIQUE (hand_id)', true],
  ['union_pnl_cash_outcome_link_resolutions_pkey', 'PRIMARY KEY (table_id, hand_number)', true],
  [
    'union_pnl_cash_outcome_link_resolutions_reason_check',
    'CHECK ((length(btrim(reason)) >= 20))',
    true,
  ],
  [
    'union_pnl_cash_outcome_link_resolutions_roster_source_check',
    "CHECK ((roster_source = ANY (ARRAY['manifest'::text, 'seat_inventory'::text, 'lightning_pool'::text])))",
    true,
  ],
];
const CASH_LINK_BEFORE_INDEXES = [
  'CREATE INDEX union_pnl_cash_links_valid_proof_hand ON public.union_pnl_cash_outcome_link_resolutions USING btree (hand_id) INCLUDE (table_id, hand_number) WHERE (proof_md5 = md5((proof)::text))',
  'CREATE UNIQUE INDEX union_pnl_cash_outcome_link_resolutions_hand_id_key ON public.union_pnl_cash_outcome_link_resolutions USING btree (hand_id)',
  'CREATE UNIQUE INDEX union_pnl_cash_outcome_link_resolutions_pkey ON public.union_pnl_cash_outcome_link_resolutions USING btree (table_id, hand_number)',
];
export function cashHashRetirementCatalog(request) {
  if (
    !isCashHashRecovery(request) ||
    request.oid !== CASH_HASH_FAILED_OID ||
    request.transientOid ||
    !validRecoveryCutoff(request.before)
  )
    throw new Error('Unbound proof-hand retirement');
  if (!isCashHashRecovery(request)) throw new Error('Unbound proof-hand retirement');
  return RECOVERY_CATALOG.replaceAll(
    'managed_game_contract_versions_game_id_id_idx',
    'union_pnl_cash_links_valid_proof_hand'
  )
    .replaceAll('managed_game_contract_versions', 'union_pnl_cash_outcome_link_resolutions')
    .replace(
      'NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conindid=c.oid) AS no_constraints,',
      `NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conindid=c.oid) AS no_constraints,
       NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.refclassid='pg_class'::regclass AND d.refobjid=c.oid) AS no_incoming_dependencies,
       (SELECT count(*)=5 AND bool_and(d.classid='pg_class'::regclass AND d.objsubid=0 AND d.refclassid='pg_class'::regclass AND d.refobjid=t.oid AND d.deptype='a') AND array_agg(d.refobjsubid ORDER BY d.refobjsubid)=ARRAY[1,2,3,10,11]::integer[] FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid) AS exact_auto_dependencies,
       (SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid),convalidated) ORDER BY conname) FROM pg_constraint WHERE conrelid=t.oid) AS original_constraints,
       (SELECT jsonb_agg(pg_get_indexdef(i2.indexrelid) ORDER BY pg_get_indexdef(i2.indexrelid)) FROM pg_index i2 WHERE i2.indrelid=t.oid AND i2.indexrelid<>to_regclass('public.union_pnl_cash_links_valid_union_hash')) AS original_indexes,
       EXISTS(SELECT 1 FROM pg_index ni JOIN pg_class nc ON nc.oid=ni.indexrelid
        WHERE nc.oid=to_regclass('public.union_pnl_cash_links_valid_union_hash') AND ni.indrelid=t.oid
        AND ni.indisvalid AND ni.indisready AND ni.indislive AND NOT ni.indisunique AND NOT ni.indisprimary AND NOT ni.indisexclusion
        AND nc.relowner='postgres'::regrole AND pg_get_indexdef(nc.oid)=` +
        "'" +
        CASH_HASH_NEW_DEFINITION.replaceAll("'", "''") +
        "'" +
        `) AS new_selector_valid,
       (SELECT nc.oid::text FROM pg_class nc WHERE nc.oid=to_regclass('public.union_pnl_cash_links_valid_union_hash')) AS new_selector_oid,`
    );
}
export function validateCashHashRetirement(rows, request, removed = false) {
  if (
    !isCashHashRecovery(request) ||
    request.oid !== CASH_HASH_FAILED_OID ||
    request.transientOid ||
    !validRecoveryCutoff(request.before)
  )
    throw new Error('Unbound proof-hand retirement');
  if (
    !/^[1-9][0-9]*$/.test(request.selectorOid || '') ||
    BigInt(request.selectorOid) > 4294967295n ||
    request.selectorOid === CASH_HASH_FAILED_OID ||
    request.selectorOid === CASH_PROOF_HAND_OID
  )
    throw new Error('Unbound observed selector OID');
  if (removed) {
    if (!Array.isArray(rows) || rows.length !== 0)
      throw new Error('Proof-hand retirement unproven');
    return;
  }
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('Unknown proof-hand retirement catalog');
  const r = rows[0];
  if (
    r.oid !== CASH_PROOF_HAND_OID ||
    r.observer_authorized !== true ||
    r.owner !== 'postgres' ||
    r.table_owner !== 'postgres' ||
    r.schema !== 'public' ||
    r.name !== 'union_pnl_cash_links_valid_proof_hand' ||
    r.relkind !== 'i' ||
    r.table_schema !== 'public' ||
    r.table_name !== 'union_pnl_cash_outcome_link_resolutions' ||
    r.definition !== CASH_PROOF_HAND_DEFINITION ||
    r.valid !== true ||
    r.ready !== true ||
    r.live !== true ||
    r.replica_identity !== false ||
    r.unique_index !== false ||
    r.primary_index !== false ||
    r.exclusion_index !== false ||
    r.key_count !== 1 ||
    r.attribute_count !== 3 ||
    r.no_predicate !== false ||
    r.no_expression !== true ||
    r.no_constraints !== true ||
    r.no_transients !== true ||
    r.no_builder !== true ||
    r.no_incoming_dependencies !== true ||
    r.exact_auto_dependencies !== true ||
    r.new_selector_valid !== true ||
    r.new_selector_oid !== request.selectorOid ||
    !Array.isArray(r.transient_names) ||
    r.transient_names.length !== 0 ||
    JSON.stringify(r.original_constraints) !== JSON.stringify(CASH_LINK_CONSTRAINTS) ||
    JSON.stringify(r.original_indexes) !== JSON.stringify(CASH_LINK_BEFORE_INDEXES)
  )
    throw new Error('Proof-hand retirement identity/dependencies/selector/state differs');
  return r;
}
export function cashHashRetirementStatement(request) {
  if (
    !isCashHashRecovery(request) ||
    request.oid !== CASH_HASH_FAILED_OID ||
    request.transientOid ||
    !validRecoveryCutoff(request.before)
  )
    throw new Error('Unbound proof-hand retirement');
  if (
    !/^[1-9][0-9]*$/.test(request?.selectorOid || '') ||
    BigInt(request.selectorOid) > 4294967295n ||
    request.selectorOid === CASH_HASH_FAILED_OID ||
    request.selectorOid === CASH_PROOF_HAND_OID
  )
    throw new Error('Unbound observed selector OID');
  if (!isCashHashRecovery(request)) throw new Error('Unbound proof-hand retirement');
  return 'DROP INDEX CONCURRENTLY public.union_pnl_cash_links_valid_proof_hand';
}

export function isCashHashMigration(file, sql) {
  return (
    file === CASH_HASH_FILE && createHash('sha256').update(sql).digest('hex') === CASH_HASH_SHA
  );
}
export function cashHashRetirementRequest(file, sql, selectorOid, before) {
  if (
    !isCashHashMigration(file, sql) ||
    !validRecoveryCutoff(before) ||
    !/^[1-9][0-9]*$/.test(selectorOid || '') ||
    BigInt(selectorOid) > 4294967295n ||
    selectorOid === CASH_HASH_FAILED_OID ||
    selectorOid === CASH_PROOF_HAND_OID
  )
    throw new Error(
      'Retirement requires exact qualified migration and freshly observed valid selector OID'
    );
  return {
    index: CASH_HASH_INDEX,
    oid: CASH_HASH_FAILED_OID,
    before,
    transientOid: null,
    selectorOid,
  };
}

// Read-only physical completion witness. It is also used before skipping CCI:
// an already valid selector is never rebuilt to finish pure qualification/history.
export function cashHashSelectorStateCatalog() {
  return `SELECT current_user='postgres' AS observer_authorized,
  pg_get_userbyid(t.relowner) AS table_owner,nc.oid::text AS selector_oid,
  to_regclass('public.union_pnl_cash_links_valid_proof_hand') IS NOT NULL AS old_proof_present,
  COALESCE(ni.indrelid=t.oid AND ni.indisvalid AND ni.indisready AND ni.indislive AND NOT ni.indisunique AND NOT ni.indisprimary AND NOT ni.indisexclusion
   AND nc.relowner='postgres'::regrole AND nc.relkind='i' AND nc.relpersistence='p'
   AND pg_get_indexdef(nc.oid)='${CASH_HASH_NEW_DEFINITION.replaceAll("'", "''")}',false) AS new_selector_valid,
  NOT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid=t.oid) AS no_builder,
  (SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid),convalidated) ORDER BY conname) FROM pg_constraint WHERE conrelid=t.oid) AS original_constraints,
  (SELECT jsonb_agg(pg_get_indexdef(i2.indexrelid) ORDER BY pg_get_indexdef(i2.indexrelid)) FROM pg_index i2
   WHERE i2.indrelid=t.oid AND i2.indexrelid<>COALESCE(to_regclass('public.union_pnl_cash_links_valid_union_hash'),0::oid)
   AND i2.indexrelid<>COALESCE(to_regclass('public.union_pnl_cash_links_valid_proof_hand'),0::oid)) AS remaining_indexes,
  (SELECT count(*)=2 AND bool_and(i2.indisvalid AND i2.indisready AND i2.indislive AND c2.relowner='postgres'::regrole)
   FROM pg_index i2 JOIN pg_class c2 ON c2.oid=i2.indexrelid WHERE i2.indrelid=t.oid
   AND i2.indexrelid<>COALESCE(to_regclass('public.union_pnl_cash_links_valid_union_hash'),0::oid)
   AND i2.indexrelid<>COALESCE(to_regclass('public.union_pnl_cash_links_valid_proof_hand'),0::oid)) AS remaining_indexes_valid
 FROM pg_class t LEFT JOIN pg_index ni ON ni.indexrelid=to_regclass('public.union_pnl_cash_links_valid_union_hash')
 LEFT JOIN pg_class nc ON nc.oid=ni.indexrelid WHERE t.oid=to_regclass('public.union_pnl_cash_outcome_link_resolutions') AND t.relkind='r' AND t.relpersistence='p'`;
}
export function validateCashHashSelectorState(rows, request, oldMustBeAbsent = false) {
  if (
    !isCashHashRecovery(request) ||
    request.oid !== CASH_HASH_FAILED_OID ||
    request.transientOid ||
    !validRecoveryCutoff(request.before) ||
    !/^[1-9][0-9]*$/.test(request.selectorOid || '') ||
    BigInt(request.selectorOid) > 4294967295n
  )
    throw new Error('Unbound completed selector witness');
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('Unknown completed selector witness');
  const r = rows[0],
    remaining = CASH_LINK_BEFORE_INDEXES.filter(
      (x) => !x.startsWith('CREATE INDEX union_pnl_cash_links_valid_proof_hand ')
    );
  if (
    r.observer_authorized !== true ||
    r.table_owner !== 'postgres' ||
    r.selector_oid !== request.selectorOid ||
    r.new_selector_valid !== true ||
    r.no_builder !== true ||
    r.remaining_indexes_valid !== true ||
    typeof r.old_proof_present !== 'boolean' ||
    (oldMustBeAbsent && r.old_proof_present !== false) ||
    JSON.stringify(r.original_constraints) !== JSON.stringify(CASH_LINK_CONSTRAINTS) ||
    JSON.stringify(r.remaining_indexes) !== JSON.stringify(remaining)
  )
    throw new Error('Completed selector identity/remaining constraints/indexes differ');
  return r;
}
