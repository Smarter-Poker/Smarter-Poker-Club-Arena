import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { schemaCataloguePayload } from '../native/component-semantic-observations.mjs';
import { assertSchemaOnly, schemaHash } from './schema-compose.mjs';

export const CAPTURE_FILES = Object.freeze(['schema.sql', 'candidate-fixture.json',
  'schema-capture-manifest.json', 'production-catalogue.json', 'role-catalogue.json',
  'composition-manifest.json']);
const requireCapture = (value) => { if (!value) throw new Error('ISOLATED_SCHEMA_CAPTURE_REFUSED'); };
const MAX_SCHEMA_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const DEADLINE_MS = 45000;
// Reserve the existing five-second Node query budget for snapshot closure and
// private output finalization. The enclosing 45-second deadline stays fixed.
const FINALIZE_RESERVE_MS = 5000;
export function remainingDumpBudget(deadlineAt, now) {
  const remaining = deadlineAt - now - FINALIZE_RESERVE_MS;
  requireCapture(Number.isSafeInteger(deadlineAt) && Number.isSafeInteger(now) &&
    remaining > 0 && remaining <= DEADLINE_MS - FINALIZE_RESERVE_MS);
  return remaining;
}
// Reuse the maintained official public trust root from the existing migration
// provider. Neither the connection URL nor an environment value selects a CA.
const PROVIDER_CA_PATH = fileURLToPath(new URL('../../../scripts/ci/certificates/supabase-prod-ca-2021.crt', import.meta.url));
const PROVIDER_CA_SHA256 = '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7';
function providerCA() {
  const pem = readFileSync(PROVIDER_CA_PATH, 'utf8');
  requireCapture(schemaHash(pem) === PROVIDER_CA_SHA256);
  return pem;
}
const safeFailures = new Set(['ISOLATED_SCHEMA_CAPTURE_REFUSED', 'ISOLATED_SCHEMA_DUMP_FAILED',
  'ISOLATED_NATIVE_TRANSPORT_FAILED', 'SCHEMA_COMPOSITION_PREIMAGE_REQUIRED', 'SCHEMA_CATALOGUE_BYTES_REQUIRED']);
const connectionFailures = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
  '28P01', '28000', '53300', '57P03', '08001', '08006']);

// Driver messages, addresses and nested errors stay private. Bounded traversal
// handles Node's AggregateError connection failures without publishing them.
export function connectionFailureCode(error) {
  const pending = [error], seen = new Set(), codes = new Set();
  for (let inspected = 0; pending.length && inspected < 16; inspected++) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (connectionFailures.has(item.code)) codes.add(item.code);
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 8));
  }
  return codes.size === 1 ? [...codes][0] : codes.size > 1 ? 'MULTIPLE_KNOWN_FAILURES' : 'UNKNOWN';
}

const dumpFailureKinds = new Set(['DEADLINE', 'STDOUT_LIMIT', 'STDERR_LIMIT', 'SPAWN',
  'STDIN', 'FACTS_REFUSED',
  'TLS_VERIFICATION', 'PERMISSION_DENIED', 'LOCK_TIMEOUT', 'STATEMENT_TIMEOUT',
  'AUTHENTICATION_FAILED', 'VERSION_MISMATCH', 'CONNECTION_FAILED', 'SNAPSHOT_IMPORT',
  'INVALID_OPTION', 'QUERY_FAILED', 'CONCURRENT_CATALOG_CHANGE', 'UNKNOWN']);
export function dumpFailureKind(stderr) {
  const diagnostic = stderr.toLowerCase();
  return [
    ['TLS_VERIFICATION', /certificate verify failed|ssl error[^\n]*certificate/],
    ['PERMISSION_DENIED', /permission denied|must be (?:owner|superuser)/],
    ['LOCK_TIMEOUT', /lock timeout|lock wait timeout/],
    ['STATEMENT_TIMEOUT', /statement timeout/],
    ['AUTHENTICATION_FAILED', /authentication failed/],
    ['VERSION_MISMATCH', /version mismatch/],
    ['SNAPSHOT_IMPORT', /invalid snapshot|cannot import a snapshot|could not import the requested snapshot|snapshot[^\n]*does not exist/],
    ['INVALID_OPTION', /unrecognized option|invalid option|invalid connection option/],
    ['CONNECTION_FAILED', /connection to server|server closed the connection/],
    ['CONCURRENT_CATALOG_CHANGE', /concurrently updated/],
    ['QUERY_FAILED', /query failed/],
  ].find(([, pattern]) => pattern.test(diagnostic))?.[0] ?? 'UNKNOWN';
}
export function safeDumpDiagnostic(value) {
  const count = (number) => Number.isSafeInteger(number) && number >= 0 && number <= 1024 * 1024 * 1024 ? number : null;
  return { kind: dumpFailureKinds.has(value?.kind) ? value.kind : 'UNKNOWN',
    exit_code: Number.isInteger(value?.exit_code) && value.exit_code >= 0 && value.exit_code <= 255 ? value.exit_code : null,
    signal: ['SIGINT','SIGKILL','SIGTERM','SIGABRT','NONE'].includes(value?.signal) ? value.signal : 'UNKNOWN',
    elapsed_ms: count(value?.elapsed_ms), stdout_bytes: count(value?.stdout_bytes), stderr_bytes: count(value?.stderr_bytes),
    ...(value?.cancellation ? {cancellation:safeCancellation(value.cancellation)} : {}) };
}

function safeCancellation(value) {
  const bool = item => typeof item==='boolean' ? item : 'UNKNOWN';
  return {sigint_attempted:bool(value?.sigint_attempted),sigint_os_accepted:bool(value?.sigint_os_accepted),
    sigkill_attempted:bool(value?.sigkill_attempted),sigkill_os_accepted:bool(value?.sigkill_os_accepted),
    child_close_observed:bool(value?.child_close_observed),
    server_cancel_acknowledgement:value?.sigint_attempted===false && value?.sigkill_attempted===false ? 'NOT_REQUESTED' : 'NOT_OBSERVED'};
}

// Native PG17 clients handle SIGINT by attempting cancellation on their own
// connection. Neither OS signal acceptance nor process exit proves server ACK.
// The grace period is INSIDE the original hard deadline, never an extension.
function nativeCancellation(child, deadlineMs, onAbort) {
  const started=performance.now();let closed=false,softTimer,hardTimer,graceTimer;
  const facts={sigint_attempted:false,sigint_os_accepted:false,sigkill_attempted:false,
    sigkill_os_accepted:false,child_close_observed:false,server_cancel_acknowledgement:'NOT_REQUESTED'};
  const clear=()=>{clearTimeout(softTimer);clearTimeout(hardTimer);clearTimeout(graceTimer);};
  const hard=()=>{
    if(closed || facts.sigkill_attempted)return;
    facts.sigkill_attempted=true;
    try{facts.sigkill_os_accepted=child.kill('SIGKILL')===true;}catch{}
  };
  const abort=kind=>{
    onAbort(kind);
    if(closed || facts.sigint_attempted)return;
    facts.sigint_attempted=true;facts.server_cancel_acknowledgement='NOT_OBSERVED';
    try{facts.sigint_os_accepted=child.kill('SIGINT')===true;}catch{}
    if(!closed)graceTimer=setTimeout(hard,Math.max(0,Math.min(1000,deadlineMs-(performance.now()-started))));
  };
  child.once('close',()=>{closed=true;facts.child_close_observed=true;clear();});
  softTimer=setTimeout(()=>abort('DEADLINE'),Math.max(0,deadlineMs-1000));
  hardTimer=setTimeout(hard,deadlineMs);
  return {abort,clear,facts:()=>safeCancellation(facts)};
}

export function captureContext(env) {
  requireCapture(env.GITHUB_REPOSITORY_ID === '1132369872' &&
    env.GITHUB_REPOSITORY === 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_WORKFLOW_REF === 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena/.github/workflows/schema-manifest-refresh.yml@refs/heads/main' &&
    /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? ''));
  return { repository_id: 1132369872, repository: env.GITHUB_REPOSITORY,
    source_sha: env.GITHUB_SHA, build_run_id: env.GITHUB_RUN_ID,
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT), scope: 'same-job-private-schema-capture' };
}

export function databaseConfiguration(value) {
  let url;
  try { url = new URL(value); } catch { requireCapture(false); }
  const direct = url.hostname === 'db.kuklfnapbkmacvwxktbh.supabase.co';
  const pooler = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname);
  requireCapture(['postgres:', 'postgresql:'].includes(url.protocol) && (direct || pooler) &&
    (url.port === '' || url.port === '5432') && url.pathname === '/postgres' && !url.hash);
  const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
  requireCapture(user === (direct ? 'postgres' : 'postgres.kuklfnapbkmacvwxktbh') &&
    password.length > 0 && password.length <= 4096);
  for (const [key, setting] of url.searchParams)
    requireCapture(key === 'sslmode' && ['require', 'verify-full'].includes(setting));
  return { host: url.hostname, port: 5432, database: 'postgres', user, password,
    ssl: { rejectUnauthorized: true, ca: providerCA() }, connectionTimeoutMillis: 5000,
    query_timeout: 5000, statement_timeout: 5000,
    application_name: 'isolated-schema-readonly-capture',
    options: '-c default_transaction_read_only=on -c lock_timeout=1000 -c idle_in_transaction_session_timeout=45000' };
}

// Metadata only. Never pg_authid, role passwords, pg_user_mappings options,
// subscription connection strings, auth rows, vault rows or cron job rows.
const safetySQL = `SELECT current_database() AS database,
 current_setting('server_version_num')::integer AS server_version_num,
 current_setting('transaction_read_only') AS read_only,
 (SELECT count(*)::integer FROM pg_catalog.pg_foreign_server) AS foreign_servers,
 (SELECT count(*)::integer FROM pg_catalog.pg_user_mapping) AS user_mappings,
 (SELECT count(*)::integer FROM pg_catalog.pg_subscription) AS subscriptions,
 (SELECT count(*)::integer FROM pg_catalog.pg_seclabel) AS security_labels,
 (SELECT count(*)::integer FROM pg_catalog.pg_db_role_setting WHERE setdatabase<>0
  AND setdatabase<>(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())) AS other_database_settings,
 (SELECT jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,
   'schema',n.nspname,'owner',pg_get_userbyid(e.extowner)) ORDER BY e.extname)
 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace) AS extensions`;
const rolesSQL = `SELECT jsonb_build_object('version',1,'scope','password-free-role-catalogue',
 'roles',(SELECT jsonb_agg(jsonb_build_object('name',rolname,'superuser',rolsuper,
 'inherit',rolinherit,'create_role',rolcreaterole,'create_db',rolcreatedb,'login',rolcanlogin,
 'replication',rolreplication,'bypass_rls',rolbypassrls,'connection_limit',rolconnlimit,
 'valid_until',rolvaliduntil::text,'configuration',(SELECT jsonb_agg(jsonb_build_object(
 'key',split_part(c,'=',1),'value',CASE WHEN split_part(c,'=',1) IN
 ('search_path','statement_timeout','lock_timeout','idle_in_transaction_session_timeout',
 'default_transaction_read_only','log_statement','pgrst.db_pre_request','session_preload_libraries','app.settings.jwt_exp')
 THEN substr(c,strpos(c,'=')+1) END,'value_md5',md5(substr(c,strpos(c,'=')+1)))
 ORDER BY split_part(c,'=',1)) FROM unnest(rolconfig) c)) ORDER BY rolname) FROM pg_catalog.pg_roles),
 'memberships',(SELECT jsonb_agg(jsonb_build_object('role',pg_get_userbyid(roleid),
 'member',pg_get_userbyid(member),'grantor',pg_get_userbyid(grantor),'admin',admin_option,
 'inherit',inherit_option,'set',set_option) ORDER BY pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor)) FROM pg_catalog.pg_auth_members),
 'role_settings',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN s.setrole=0 THEN 'ALL' ELSE pg_get_userbyid(s.setrole) END,
 'database',CASE WHEN s.setdatabase=0 THEN 'ALL' WHEN s.setdatabase=(SELECT oid FROM pg_catalog.pg_database
 WHERE datname=current_database()) THEN 'OWNED_DATABASE' ELSE 'OTHER_DATABASE' END,
 'key',split_part(c,'=',1),'value',CASE WHEN split_part(c,'=',1) IN
 ('search_path','statement_timeout','lock_timeout','idle_in_transaction_session_timeout',
 'default_transaction_read_only','log_statement','pgrst.db_pre_request','session_preload_libraries','app.settings.jwt_exp')
 THEN substr(c,strpos(c,'=')+1) END,'value_md5',md5(substr(c,strpos(c,'=')+1)))
 ORDER BY CASE WHEN s.setrole=0 THEN 'ALL' ELSE pg_get_userbyid(s.setrole) END,CASE WHEN s.setdatabase=0 THEN 'ALL' ELSE 'OWNED_DATABASE' END,
 split_part(c,'=',1)) FROM pg_catalog.pg_db_role_setting s,
 LATERAL unnest(s.setconfig) c),
 'default_acl',(SELECT jsonb_agg(jsonb_build_object('creator',pg_get_userbyid(d.defaclrole),
 'schema',CASE WHEN d.defaclnamespace=0 THEN 'GLOBAL' ELSE n.nspname END,'type',d.defaclobjtype,
 'acl',(SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
 'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
 'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY pg_get_userbyid(a.grantor),
 CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)
 FROM aclexplode(d.defaclacl) a)) ORDER BY pg_get_userbyid(d.defaclrole),
 CASE WHEN d.defaclnamespace=0 THEN 'GLOBAL' ELSE n.nspname END,d.defaclobjtype)
 FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace),
 'contains_passwords_or_user_rows',false) AS catalogue`;

// The genuine isolated preflight uses this same query and normalized names,
// including role/default/DB settings, rather than a second reduced role graph.
// Caller supplies its already-owned read-only transaction/connection.
export async function captureRoleCatalogue(db) {
  const value = (await db.query(`SELECT CASE WHEN pg_catalog.octet_length(catalogue::text) <= ${MAX_METADATA_BYTES}
    THEN catalogue END AS catalogue FROM (${rolesSQL}) bounded_role_catalogue`)).rows[0].catalogue;
  requireCapture(value && typeof value === 'object' && !Array.isArray(value));
  return value;
}

function databaseChildEnvironment(config, applicationName) {
  // Construct libpq's environment explicitly; no URL, token, arbitrary
  // PGOPTIONS or inherited DATABASE_URL enters argv or the child environment.
  return { PATH: process.env.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    PGHOST: config.host, PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: config.user,
    PGPASSWORD: config.password, PGSSLMODE: 'verify-full', PGSSLROOTCERT: PROVIDER_CA_PATH, PGCONNECT_TIMEOUT: '5',
    PGAPPNAME: applicationName,
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' };
}

function nativeTransportReceipt(elapsed) {
  requireCapture(Number.isSafeInteger(elapsed) && elapsed >= 0 && elapsed <= 5000);
  return {status:'passed',client_major:17,database_postgres:true,read_only:true,
    repeatable_read:true,snapshot_imported:true,application_name_matches:true,
    statement_timeout_ms:5000,lock_timeout_ms:1000,elapsed_ms:elapsed};
}

const nativeFactNames=Object.freeze(['database_postgres','read_only','repeatable_read',
  'statement_timeout_5s','lock_timeout_1s','application_name_matches']);
function safeNativeFacts(value) {
  if(!value || typeof value!=='object' || Object.keys(value).length!==nativeFactNames.length ||
    !nativeFactNames.every(key=>Object.hasOwn(value,key) && typeof value[key]==='boolean'))return null;
  return Object.fromEntries(nativeFactNames.map(key=>[key,value[key]]));
}
function parseNativeFacts(text) {
  if(!/^[tf](?:\|[tf]){5}\n$/.test(text))return null;
  const fields=text.slice(0,-1).split('|');
  return Object.fromEntries(nativeFactNames.map((key,index)=>[key,fields[index]==='t']));
}

export async function verifyNativeSnapshotTransport(config, snapshot, {spawnProcess = spawn, deadlineMs = 5000} = {}) {
  requireCapture(/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/.test(snapshot) &&
    Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 5000);
  const env = databaseChildEnvironment(config, 'isolated-schema-readonly-native-transport');
  const child = spawnProcess('/usr/lib/postgresql/17/bin/psql',
    ['--no-psqlrc','--no-password','--quiet','--tuples-only','--no-align','--field-separator=|','--set=ON_ERROR_STOP=1'],
    {env,stdio:['pipe','pipe','pipe']});
  const started = performance.now(), stdout = [], stderr = [];
  let outputBytes = 0, errorBytes = 0, kind = null, nativeFacts = null;
  const failure = (code, signal) => Object.assign(new Error('ISOLATED_NATIVE_TRANSPORT_FAILED'), {
    nativeDiagnostic: safeDumpDiagnostic({kind:kind ?? dumpFailureKind(Buffer.concat(stderr).toString('utf8')),
      exit_code:code,signal:signal ?? 'NONE',elapsed_ms:Math.round(performance.now()-started),
      stdout_bytes:outputBytes,stderr_bytes:errorBytes,cancellation:cancellation.facts()}),
    ...(nativeFacts ? {nativeFacts:safeNativeFacts(nativeFacts)} : {})});
  const cancellation=nativeCancellation(child,deadlineMs,reason=>{kind ??= reason;});
  try {
    await new Promise((resolve,reject)=>{
      child.stdout.on('data',bytes=>{
        outputBytes += bytes.length;
        if(outputBytes>256)cancellation.abort('STDOUT_LIMIT');else stdout.push(bytes);
      });
      child.stderr.on('data',bytes=>{
        errorBytes += bytes.length;
        if(errorBytes>65536)cancellation.abort('STDERR_LIMIT');else stderr.push(bytes);
      });
      child.stdin.on('error',()=>cancellation.abort('STDIN'));
      child.once('error',()=>{kind ??= 'SPAWN';});
      child.once('close',(code,signal)=>{
        if(performance.now()-started>deadlineMs)kind ??= 'DEADLINE';
        nativeFacts=parseNativeFacts(Buffer.concat(stdout).toString('utf8'));
        if(code===0 && kind===null && nativeFacts && Object.values(nativeFacts).every(value=>value===true))resolve();
        else {if(code===0)kind ??= 'FACTS_REFUSED';reject(failure(code,signal));}
      });
      // Only this validated original snapshot and constant read-only facts go
      // to stdin. No snapshot, URL, credential or SQL text enters argv/logs.
      child.stdin.end(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT '${snapshot}';
SET LOCAL search_path=pg_catalog;
SELECT current_database()='postgres'
 , current_setting('transaction_read_only')='on'
 , current_setting('transaction_isolation')='repeatable read'
 , current_setting('statement_timeout')='5s'
 , current_setting('lock_timeout')='1s'
 , current_setting('application_name')='isolated-schema-readonly-native-transport';
ROLLBACK;
`);
    });
    return nativeTransportReceipt(Math.round(performance.now()-started));
  } finally {
    cancellation.clear();delete env.PGPASSWORD;stdout.length=0;stderr.length=0;
  }
}

export async function dumpSnapshot(config, snapshot, { spawnProcess = spawn, deadlineMs = 30000 } = {}) {
  requireCapture(/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/.test(snapshot));
  const env = databaseChildEnvironment(config, 'isolated-schema-readonly-dump');
  // Native pg_dump resets statement_timeout during startup. Its effective
  // bounds are this whole-export deadline and explicit table-lock wait below;
  // the Node catalogue connection retains its separate five-second queries.
  const child = spawnProcess('pg_dump', ['--no-password','--schema-only','--format=plain',
    '--quote-all-identifiers','--no-comments','--no-security-labels','--no-subscriptions',
    '--lock-wait-timeout=1000',`--snapshot=${snapshot}`], { env, stdio: ['ignore','pipe','pipe'] });
  let size = 0, stderrSize = 0, failed = false, failureKind = null;
  const chunks = [], stderrChunks = [];
  const started = performance.now();
  const failure = (code, signal) => Object.assign(new Error('ISOLATED_SCHEMA_DUMP_FAILED'), {
    dumpDiagnostic: safeDumpDiagnostic({kind: failureKind ?? dumpFailureKind(Buffer.concat(stderrChunks).toString('utf8')),
      exit_code: code, signal: signal ?? 'NONE', elapsed_ms: Math.round(performance.now() - started),
      stdout_bytes: size, stderr_bytes: stderrSize,cancellation:cancellation.facts()}) });
  const cancellation=nativeCancellation(child,deadlineMs,reason=>{failed=true;failureKind ??= reason;});
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (bytes) => {
        size += bytes.length;
        if (size > MAX_SCHEMA_BYTES) cancellation.abort('STDOUT_LIMIT');
        else chunks.push(bytes);
      });
      child.stderr.on('data', (bytes) => {
        stderrSize += bytes.length;
        if (stderrSize > 65536) cancellation.abort('STDERR_LIMIT');
        else stderrChunks.push(bytes);
      });
      child.once('error', () => { failed = true; failureKind ??= 'SPAWN'; });
      child.once('close', (code, signal) => {
        if(performance.now()-started>deadlineMs){failed=true;failureKind ??= 'DEADLINE';}
        code === 0 && !failed ? resolve() : reject(failure(code, signal));
      });
    });
    const sql = Buffer.concat(chunks).toString('utf8');
    assertSchemaOnly(sql);
    return sql;
  } finally { cancellation.clear(); delete env.PGPASSWORD; chunks.length = 0; stderrChunks.length = 0; }
}

export async function captureSchema({ output, env = process.env, Client, dump = dumpSnapshot,
  nativeCheck = verifyNativeSnapshotTransport }) {
  const context = captureContext(env);
  const runner = await realpath(env.RUNNER_TEMP);
  requireCapture(path.isAbsolute(output) && path.dirname(output) === runner &&
    /^isolated-schema-[a-z0-9-]{1,80}$/.test(path.basename(output)));
  let absent = false;
  try { await lstat(output); } catch (error) { if (error.code === 'ENOENT') absent = true; else throw error; }
  requireCapture(absent);
  const config = databaseConfiguration(env.DATABASE_URL);
  if (!Client) Client = (await import('pg')).default.Client;
  const db = new Client(config);
  // pg emits idle transport errors; own them without logging driver text.
  let transportFailed = false;
  db.on('error', () => { transportFailed = true; });
  let began = false, complete = false, created = false;
  let stage = 'connection';
  let nativeTransport = null;
  const deadlineAt = Date.now() + DEADLINE_MS;
  const timer = setTimeout(() => { transportFailed = true; void db.end().catch(() => {}); }, DEADLINE_MS);
  try {
    await db.connect();
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); began = true;
    await db.query("SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s'");
    stage = 'metadata-preflight';
    const facts = (await db.query(safetySQL)).rows[0];
    requireCapture(facts.database === 'postgres' && facts.server_version_num === 170006 &&
      facts.read_only === 'on' && ['foreign_servers','user_mappings','subscriptions','security_labels','other_database_settings']
        .every((key) => facts[key] === 0));
    const snapshot = (await db.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    stage = 'catalogue';
    const catalogue = await schemaCataloguePayload(db);
    const catalogueDigest = catalogue.catalogue_digest;
    const roleCatalogue = await captureRoleCatalogue(db);
    stage = 'native-snapshot-transport';
    const nativeResult = await nativeCheck(config,snapshot,{deadlineMs:Math.min(5000,remainingDumpBudget(deadlineAt,Date.now()))});
    requireCapture(nativeResult?.status==='passed' && nativeResult.client_major===17 &&
      ['database_postgres','read_only','repeatable_read','snapshot_imported','application_name_matches'].every(key=>nativeResult[key]===true) &&
      nativeResult.statement_timeout_ms===5000 && nativeResult.lock_timeout_ms===1000);
    nativeTransport = nativeTransportReceipt(nativeResult.elapsed_ms);
    stage = 'schema-only-dump';
    const remaining = remainingDumpBudget(deadlineAt, Date.now());
    const sql = await dump(config, snapshot, { deadlineMs: remaining });
    requireCapture(!transportFailed);
    // Keep every output private until the complete capture is closed. The
    // only allowed public output is a separate sanitized qualification receipt.
    const fixture = { version: 1, scope: 'isolated-club-arena-fixture', seed_version: 1,
      actor_count: 2, spectator_count: 1, auth_user_source: 'local-gotrue-admin-api',
      supabase_host: 'kuklfnapbkmacvwxktbh.supabase.co',
      source_contract: { version: 1, source_sha: context.source_sha,
        current_database_contract_ready: false, exclusions: ['native-preflight-pending'] } };
    const contents = {
      'schema.sql': sql,
      'candidate-fixture.json': JSON.stringify(fixture) + '\n',
      'production-catalogue.json': JSON.stringify({ ...catalogue, capture_scope: 'original-production-schema-catalogue',
        server_version_num: facts.server_version_num,
        extensions: facts.extensions, exported_snapshot_sha256: schemaHash(snapshot) }) + '\n',
      'role-catalogue.json': JSON.stringify(roleCatalogue) + '\n',
      'composition-manifest.json': JSON.stringify({ version: 1, scope: 'uncomposed-schema-candidate',
        original_sha256: schemaHash(sql), current_database_contract_ready: false,
        reason: 'genuine-native-service-preimage-and-full-restore-parity-required' }) + '\n',
    };
    for (const [name, bytes] of Object.entries(contents))
      requireCapture(Buffer.byteLength(bytes) <= (name === 'schema.sql' ? MAX_SCHEMA_BYTES : MAX_METADATA_BYTES));
    await db.query('ROLLBACK'); began = false;
    await db.end();
    requireCapture(!transportFailed);
    stage = 'private-output';
    await mkdir(output, { mode: 0o700 });
    created = true;
    for (const [name, bytes] of Object.entries(contents)) await writeFile(path.join(output,name),bytes,{mode:0o600,flag:'wx'});
    const manifest = { version: 1, ...context, transaction: 'REPEATABLE READ READ ONLY',
      original_catalogue_digest: catalogueDigest, original_schema_sha256: schemaHash(sql),
      files: Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name,
        { sha256: schemaHash(bytes), bytes: Buffer.byteLength(bytes) }])),
      private_same_job_only: true, public_artifact_permitted: false,
      native_transport: nativeTransport,
      current_database_contract_ready: false, production_writes: false };
    await writeFile(path.join(output,'schema-capture-manifest.json'),JSON.stringify(manifest)+'\n',{mode:0o600,flag:'wx'});
    requireCapture(!transportFailed && Date.now() < deadlineAt);
    complete = true;
    return { scope: context.scope, source_sha: context.source_sha,
      original_schema_sha256: manifest.original_schema_sha256, private_files: CAPTURE_FILES.length,
      native_transport: nativeTransport,
      current_database_contract_ready: false, public_artifact_permitted: false };
  } catch (error) {
    const safe = new Error(safeFailures.has(error?.message) ? error.message : 'ISOLATED_SCHEMA_CAPTURE_FAILED');
    safe.captureStage = stage;
    safe.connectionFailure = stage === 'connection' ? connectionFailureCode(error) : 'NOT_CONNECTION';
    safe.connectionRoute = config.host === 'db.kuklfnapbkmacvwxktbh.supabase.co' ? 'direct' : 'session-pooler';
    if (stage === 'schema-only-dump') safe.dumpDiagnostic = safeDumpDiagnostic(error?.dumpDiagnostic);
    if (nativeTransport) safe.nativeTransport = nativeTransport;
    if (stage === 'native-snapshot-transport') safe.nativeDiagnostic = safeDumpDiagnostic(error?.nativeDiagnostic);
    if (stage === 'native-snapshot-transport') safe.nativeFacts = safeNativeFacts(error?.nativeFacts);
    throw safe;
  } finally {
    clearTimeout(timer);
    if (began) await db.query('ROLLBACK').catch(() => {});
    await db.end().catch(() => {});
    config.password = '';
    if (created && !complete) await rm(output,{recursive:true,force:true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) { console.error('ISOLATED_SCHEMA_CAPTURE_REFUSED'); process.exitCode = 1; }
  else captureSchema({output:process.argv[2]}).then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error) => {
      const stages = new Set(['connection','metadata-preflight','catalogue','native-snapshot-transport','schema-only-dump','private-output']);
      console.error(JSON.stringify({scope:'same-job-private-schema-capture',status:'failed',
        stage:stages.has(error?.captureStage) ? error.captureStage : 'context',
        connection_failure: connectionFailures.has(error?.connectionFailure) ||
          ['MULTIPLE_KNOWN_FAILURES','UNKNOWN','NOT_CONNECTION'].includes(error?.connectionFailure)
          ? error.connectionFailure : 'UNKNOWN',
        connection_route: ['direct','session-pooler'].includes(error?.connectionRoute) ? error.connectionRoute : 'UNKNOWN',
        ...(error?.captureStage === 'schema-only-dump' ? {dump_diagnostic: safeDumpDiagnostic(error?.dumpDiagnostic)} : {}),
        ...(error?.nativeTransport ? {native_transport: nativeTransportReceipt(error.nativeTransport.elapsed_ms)} : {}),
        ...(error?.captureStage === 'native-snapshot-transport' ? {native_transport_failure: safeDumpDiagnostic(error?.nativeDiagnostic)} : {}),
        ...(safeNativeFacts(error?.nativeFacts) ? {native_transport_facts:safeNativeFacts(error.nativeFacts)} : {}),
        code:safeFailures.has(error?.message) ? error.message : 'ISOLATED_SCHEMA_CAPTURE_FAILED'}));
      process.exitCode = 1;
    });
}
