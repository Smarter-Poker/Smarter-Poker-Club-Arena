#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ENGINE SHIPS ONLY WITH ITS DOORS (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Twice in two days a build went live calling a database function that
 * production did not have, and each time the failure was a silent loop:
 *
 *   2026-09-10  fn_move_tournament_player (7 args) - the engine half of PR
 *               #3716 deployed at the 20:55 break; the database half was never
 *               applied. Every tournament seat move failed, the lease loop
 *               starved, and the fleet wound down each hour
 *               (20260910051125_the_seat_move_door_the_engine_calls_exists).
 *   2026-09-11  fn_ca_reprice_unpaid_tournament_place - called by the engine's
 *               prize recalculation since #4066/#4105 and defined only in the
 *               unapplied M6 cutover 20260910000905. Any event whose prizes
 *               needed recertifying could never finish
 *               (20260911090347_the_prize_reprice_door_the_engine_calls_exists).
 *
 * The phantom-reference gate (check-phantom-tables.mjs) could not see either:
 * it checks names against a manifest that a branch may extend with a fragment
 * declaring the function it is about to create, and nothing checks that the
 * creation ever happened before the code that calls it goes live.
 *
 * So the deploy asks the one witness that cannot be declared into existence:
 * production's pg_proc, read immediately before the break gate. Every
 * `.rpc('<name>')` in server/src (tests excluded), and every literal assigned
 * to an `...rpcName` variable, must name a function in schema public. A
 * missing one fails the run before the SHA is handed to the durable Hetzner
 * intake. The build is not safe to ship until its migration is applied; it
 * can be dispatched again after the database has caught up.
 *
 * For targets without the continuation prerequisites below, deliberately
 * NOT a blocker:
 *   - an unreadable database (no DATABASE_URL, pg missing, network): a
 *     warning. This guard exists for one class of defect; it must never be
 *     the reason an urgent fix cannot ship because a connection blinked.
 *   - a rollback (ROLLBACK_REQUESTED=true): a warning. A rollback restores a
 *     build production already ran, and an emergency must not wait on this.
 *   - a name in scripts/ci/engine-doors.allowlist.json, each with a reason.
 *
 * A target calling a continuation RPC must additionally prove all exact
 * installed migration histories. Its new changed-function prerequisite cannot
 * be inferred from pg_proc name presence, and unknown history is a refusal.
 * This is a read-only gate in this existing job, before durable host intake.
 *
 * Usage:  node scripts/ci/check-engine-doors-exist.mjs
 * Exit:   0 proved / generic unreadable / generic rollback;
 *         1 missing door or unproved continuation prerequisite
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SCAN_ROOT = join(ROOT, 'server', 'src');
const ALLOWLIST = join(ROOT, 'scripts', 'ci', 'engine-doors.allowlist.json');

/** Removes // and /* *\/ comments so a JSDoc example is not a call site. */
export function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const RPC_CALL = /\.rpc\(\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1/g;
const RPC_NAME_ASSIGNMENT = /\b\w*[Rr]pc[Nn]ame\w*\s*=\s*([^;\n]+)/g;
// A literal compared against (`kind === 'mini' ? ...`) is a condition, not a
// door; only the literals the variable can take are.
const QUOTED_IDENT = /(?<![=!]==?\s*)(['"`])([A-Za-z_][A-Za-z0-9_]*)\1/g;

/** The database function names one source file calls. */
export function doorsIn(source) {
  const src = stripComments(source);
  const names = new Set();
  for (const m of src.matchAll(RPC_CALL)) names.add(m[2]);
  for (const m of src.matchAll(RPC_NAME_ASSIGNMENT)) {
    for (const q of m[1].matchAll(QUOTED_IDENT)) names.add(q[2]);
  }
  return names;
}

function isTestFile(path) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /[\\/]__tests__[\\/]/.test(path);
}

/** name -> the engine files that call it. */
export function engineDoors(root = SCAN_ROOT) {
  const doors = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      const st = statSync(path);
      if (st.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.[cm]?[jt]s$/.test(entry) || isTestFile(path)) continue;
      for (const name of doorsIn(readFileSync(path, 'utf8'))) {
        const files = doors.get(name) ?? [];
        files.push(relative(ROOT, path));
        doors.set(name, files);
      }
    }
  };
  walk(root);
  return doors;
}

// The original-controller runtime also depends on a changed EXISTING clock
// function. Name presence cannot prove that installation. Read the exact
// target files, then require all ordinary applier history rows byte-for-byte
// by their single-statement text digest. No body pin forbids a later compatible
// owner from legitimately extending the installed abort function.
const CONTINUATION_DOORS = new Set([
  'fn_f06_retain_hand_continuation',
  'fn_f06_claim_hand_continuation',
  'fn_f06_claim_legacy_river_continuation',
]);
const CONTINUATION_MIGRATIONS = [
  '20261028233353_durable_private_hand_continuation.sql',
  '20261029004521_keep_generation_recovery_at_the_highest_genuinely_played_lev.sql',
  '20261029170914_original_claim_attests_exact_authorized_chairs.sql',
];
const MTT_DEPTH_MIGRATIONS = [
  '20261029202310_all_new_mtt_tournaments_pay_the_top_fifteen_percent.sql',
  '20261029202847_unfinalized_mtt_fields_adopt_fifteen_percent_payout_depth.sql',
];
let mttDepthTarget = false;
let continuationTarget = false;
let retainedCheckpointTarget = false;
const RETAINED_CHECKPOINT_GUARD = 'server/scripts/retained-original-checkpoint-guard.mjs';
const FROZEN_ATTESTATION_MIGRATION =
  '20261029093051_attest_frozen_original_hand_continuation_custody.sql';
const FROZEN_ATTESTATION_CONTRACTS = [
  {
    schema_name: 'public',
    proname: 'fn_f06_attest_frozen_hand_continuation',
    body_md5: 'd47f131bbecd7fd7aaba9873af68285e',
    acl: '{postgres=X/postgres,service_role=X/postgres}',
    service_execute: true,
  },
  {
    schema_name: 'smarter_private',
    proname: 'attest_frozen_hand_continuation',
    body_md5: '7e5ebd0b8f622ba6daa596c2d2e45db0',
    acl: '{postgres=X/postgres}',
    service_execute: false,
  },
];

function continuationRequirements() {
  const files = [
    ...(continuationTarget ? CONTINUATION_MIGRATIONS : []),
    ...(mttDepthTarget ? MTT_DEPTH_MIGRATIONS : []),
    ...(retainedCheckpointTarget ? [FROZEN_ATTESTATION_MIGRATION] : []),
  ];
  return files.map((file) => ({
    version: file.slice(0, 14),
    name: file.slice(15, -4),
    sql_md5: createHash('md5')
      .update(readFileSync(join(ROOT, 'supabase', 'migrations', file)))
      .digest('hex'),
  }));
}

async function liveFunctions(names, requirements) {
  // Test seam: a JSON array of the function names "production" has, so the
  // law test can run the real script end to end without a database.
  const fixture = process.env.ENGINE_DOORS_LIVE_FIXTURE;
  if (fixture) {
    const migrationFixture = process.env.ENGINE_DOORS_MIGRATIONS_FIXTURE;
    const checkpointFixture = process.env.ENGINE_DOORS_CHECKPOINT_FIXTURE;
    return {
      found: new Set(JSON.parse(readFileSync(fixture, 'utf8'))),
      migrations: migrationFixture ? JSON.parse(readFileSync(migrationFixture, 'utf8')) : [],
      checkpointFunctions: checkpointFixture
        ? JSON.parse(readFileSync(checkpointFixture, 'utf8'))
        : [],
    };
  }
  const url = process.env.DATABASE_URL;
  if (!url) return { unreadable: 'DATABASE_URL is not set' };
  let Client;
  try {
    ({ Client } = (await import('pg')).default ?? (await import('pg')));
  } catch {
    return { unreadable: 'the pg client is not installed' };
  }
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 15000,
    statement_timeout: 15000,
  });
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT DISTINCT p.proname
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
      [names]
    );
    let migrations = [];
    if (requirements.length) {
      ({ rows: migrations } = await client.query(
        `SELECT version, name, cardinality(statements)::integer AS statement_count,
                md5(statements[1]) AS sql_md5
           FROM supabase_migrations.schema_migrations
          WHERE version = ANY($1::text[])`,
        [requirements.map((r) => r.version)]
      ));
    }
    let checkpointFunctions = [];
    if (retainedCheckpointTarget) {
      ({ rows: checkpointFunctions } = await client.query(
        `SELECT n.nspname AS schema_name, p.proname,
                oidvectortypes(p.proargtypes) AS argument_types,
                md5(p.prosrc) AS body_md5, pg_get_userbyid(p.proowner) AS owner,
                p.prosecdef AS security_definer, p.provolatile AS volatility,
                p.prorettype::regtype::text AS return_type,
                p.proacl::text AS acl, p.proconfig AS config,
                has_function_privilege('anon',p.oid,'execute') AS anon_execute,
                has_function_privilege('authenticated',p.oid,'execute') AS authenticated_execute,
                has_function_privilege('service_role',p.oid,'execute') AS service_execute,
                has_table_privilege('service_role','smarter_private.hand_continuations','SELECT') AS service_private_read
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE p.oid IN (to_regprocedure($1),to_regprocedure($2))`,
        FROZEN_ATTESTATION_CONTRACTS.map(
          (r) => `${r.schema_name}.${r.proname}(uuid,uuid,uuid,bigint,bigint,text)`
        )
      ));
    }
    return { found: new Set(rows.map((r) => r.proname)), migrations, checkpointFunctions };
  } catch (err) {
    return { unreadable: `production could not be asked: ${err?.message || err}` };
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  // One closed serialized guard is an engine caller too. Do not scan arbitrary
  // control scripts or make old targets depend on a newly installed contract.
  const guardPath = join(ROOT, RETAINED_CHECKPOINT_GUARD);
  retainedCheckpointTarget = existsSync(guardPath);
  // Only a target containing this policy has its installation dependency.
  // Existing targets/rollbacks do not acquire a future migration requirement.
  mttDepthTarget = existsSync(join(ROOT, 'supabase', 'migrations', MTT_DEPTH_MIGRATIONS[0]));
  const doors = engineDoors();
  if (retainedCheckpointTarget) {
    for (const name of doorsIn(readFileSync(guardPath, 'utf8'))) {
      const files = doors.get(name) ?? [];
      files.push(RETAINED_CHECKPOINT_GUARD);
      doors.set(name, files);
    }
  }
  const names = [...doors.keys()].sort();
  continuationTarget = names.some((name) => CONTINUATION_DOORS.has(name));
  const requirements = continuationRequirements();
  const allow = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, 'utf8')) : {};
  const rollback = process.env.ROLLBACK_REQUESTED === 'true';
  const live = await liveFunctions(names, requirements);
  if (live.unreadable && (continuationTarget || retainedCheckpointTarget || mttDepthTarget)) {
    console.log(
      `::error title=CONTINUATION PREREQUISITES UNCHECKED::${live.unreadable}. Exact target migration histories and any selected frozen-checkpoint custody contract must be proved before this target enters Hetzner.`
    );
    return 1;
  }
  if (live.unreadable) {
    console.log(
      `::warning title=DATABASE DOORS UNCHECKED::${live.unreadable}. The ${names.length} functions this build calls were not verified against production.`
    );
    return 0;
  }
  const missing = names.filter((n) => !live.found.has(n) && !allow[n]);
  let prerequisitesProved = true;
  for (const expected of requirements) {
    const rows = live.migrations.filter((row) => row.version === expected.version);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row.name !== expected.name ||
      row.statement_count !== 1 ||
      row.sql_md5 !== expected.sql_md5
    ) {
      prerequisitesProved = false;
      console.log(
        `::error title=CONTINUATION MIGRATION UNPROVED::${expected.version} must have exactly the target migration name and single-statement SQL MD5 ${expected.sql_md5}. Apply and verify the protected migration before this target enters Hetzner.`
      );
    }
  }
  if (!prerequisitesProved) return 1;
  if (continuationTarget)
    console.log('OK - all exact continuation migration histories are installed.');
  if (mttDepthTarget)
    console.log('OK - both exact fifteen-percent MTT policy migrations are installed.');
  if (retainedCheckpointTarget) {
    for (const expected of FROZEN_ATTESTATION_CONTRACTS) {
      const rows = live.checkpointFunctions?.filter(
        (row) => row.schema_name === expected.schema_name && row.proname === expected.proname
      );
      const row = rows?.[0];
      if (
        !Array.isArray(rows) ||
        rows.length !== 1 ||
        row.argument_types !== 'uuid, uuid, uuid, bigint, bigint, text' ||
        row.body_md5 !== expected.body_md5 ||
        row.owner !== 'postgres' ||
        row.security_definer !== true ||
        row.volatility !== 's' ||
        row.return_type !== 'jsonb' ||
        row.acl !== expected.acl ||
        JSON.stringify(row.config) !==
          JSON.stringify(['search_path=pg_catalog, public, smarter_private']) ||
        row.anon_execute !== false ||
        row.authenticated_execute !== false ||
        row.service_execute !== expected.service_execute ||
        row.service_private_read !== false
      ) {
        console.log(
          `::error title=FROZEN ORIGINAL ATTESTATION UNPROVED::${expected.schema_name}.${expected.proname} must match the qualified body, read-only owner/configuration, service/browser grants and private-table denial before the retained-original checkpoint enters Hetzner.`
        );
        return 1;
      }
    }
    console.log(
      'OK - frozen original attestation history and both exact read-only custody doors are installed.'
    );
  }
  if (missing.length === 0) {
    console.log(
      `OK - all ${names.length} database functions this build calls exist in production.`
    );
    return 0;
  }
  const level = rollback ? 'warning' : 'error';
  for (const name of missing) {
    console.log(
      `::${level} title=MISSING DATABASE DOOR::${name}() is called by ${doors.get(name).join(', ')} and does not exist in production. Apply its migration before this build ships.`
    );
  }
  if (rollback) {
    console.log(
      'Rollback: reported, not blocked. A rollback restores a build production already ran.'
    );
    return 0;
  }
  console.log(
    `${missing.length} of ${names.length} database functions this build calls are missing in production. Nothing was deployed.`
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      if (continuationTarget || retainedCheckpointTarget) {
        console.log(`::error title=CONTINUATION PREREQUISITES UNCHECKED::${err?.message || err}`);
        process.exit(1);
      }
      console.log(`::warning title=DATABASE DOORS UNCHECKED::${err?.message || err}`);
      process.exit(0);
    }
  );
}
