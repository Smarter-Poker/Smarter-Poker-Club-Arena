// One exact retired historical recording, never a generic financial exemption.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { classifyMigration, loadManifest } from './recording-only.mjs';

export const DSS_READER_SHA256 = 'cfd72fac9f76598ddebe0b4d4e765455970677ee58fda759655cf55f64fec3ee';
// Current reader workflow changes only the verified World Hub token owner after
// Club Arena transferred; retirement proof, historical bytes and grants are unchanged.
export const DSS_WORKFLOW_SHA256 =
  'dab96d5780e8d80cf26f34512becb8caa941f54dc59fcd0990e771bd4c98682f';
export const DSS_HISTORY_VERSION = '20261012040553';
export const DSS_HISTORY_FILE =
  'supabase/migrations/20261012040553_ops_dss_joins_midway_union_at_noon_20261012.sql';
export const DSS_HISTORY_MD5 = '1e37a105a1c11d7a6d7aa313c8c5053e';
export const DSS_RETIREMENT_FILE =
  'supabase/migrations/20261013120756_spent_dss_one_off_wallet_operations_are_retired.sql';
export const DSS_RETIREMENT_SHA256 =
  '17ea8934302b09312d3b96805a888a045f663dac497114ed8a82ab3bd9e3b462';
export const DSS_RETIREMENT_MD5 = '1a8a6470554d08dc02ddafcf3ed7aa48';

export function retiredDssRecordingIsBound(root) {
  try {
    const row = loadManifest(root).rows.get(DSS_HISTORY_VERSION);
    const retirement = row?.retiredBy;
    return (
      row?.file === DSS_HISTORY_FILE &&
      row?.md5 === DSS_HISTORY_MD5 &&
      classifyMigration(DSS_HISTORY_FILE, { repo: root }).manifestMatched === true &&
      retirement?.file === DSS_RETIREMENT_FILE &&
      retirement?.sha256 === DSS_RETIREMENT_SHA256 &&
      retirement?.liveReader === 'scripts/ci/check-recorded-migrations-evidence.mjs' &&
      createHash('sha256')
        .update(readFileSync(join(root, DSS_RETIREMENT_FILE)))
        .digest('hex') === DSS_RETIREMENT_SHA256 &&
      createHash('sha256')
        .update(readFileSync(join(root, 'scripts/ci/check-recorded-migrations-evidence.mjs')))
        .digest('hex') === DSS_READER_SHA256 &&
      createHash('sha256')
        .update(readFileSync(join(root, '.github/workflows/applied-migrations-recorded.yml')))
        .digest('hex') === DSS_WORKFLOW_SHA256
    );
  } catch {
    return false;
  }
}

export const SPENT_DSS_RETIREMENT_PROOF = `SELECT
 EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261013120756'
  AND md5(array_to_string(statements,chr(10)))='${DSS_RETIREMENT_MD5}')
 AND to_regprocedure('public.ops_dss_midway_sweep(text)') IS NULL
 AND to_regprocedure('public.ops_dss_midway_go_live()') IS NULL
 AND to_regprocedure('public.ops_ledger_reset_declarations()') IS NULL
 AND (SELECT count(*)=2 AND bool_and(status='retired') FROM public.ca_money_rpc_registry
  WHERE proname IN ('ops_dss_midway_sweep','ops_dss_midway_go_live'))
 AND NOT EXISTS (SELECT 1 FROM cron.job WHERE command ~* 'ops_dss_midway|ops_ledger_reset_declarations'
  OR jobname IN ('dss-midway-go-live','dss-midway-go-live-retry-1','dss-midway-go-live-retry-2'));`;

// query is a read-only transport; inability to read remains UNKNOWN, never a pass.
export async function verifySpentDssRetirement(query) {
  const answer = String(await query(SPENT_DSS_RETIREMENT_PROOF)).trim();
  if (answer === 't') return true;
  if (answer === 'f') return false;
  throw new Error('spent DSS retirement proof returned an unreadable answer');
}
