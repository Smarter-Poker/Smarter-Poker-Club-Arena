import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureContext, databaseConfiguration, captureSchema, dumpSnapshot, CAPTURE_FILES, connectionFailureCode, dumpFailureKind, safeDumpDiagnostic, remainingDumpBudget } from '../schema-snapshot.mjs';
import { assertSchemaOnly, composeSchema, dumpObjects, schemaHash } from '../schema-compose.mjs';
import { schemaCatalogue, schemaCataloguePayload } from '../../native/component-semantic-observations.mjs';
import { APPLICATION_TRIGGER_WITNESSES } from '../schema-application-hooks.mjs';

const context = { GITHUB_REPOSITORY_ID: '1132369872',
  GITHUB_REPOSITORY: 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena/.github/workflows/schema-manifest-refresh.yml@refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
const fixtureURL = 'postgres://postgres:synthetic-only@db.kuklfnapbkmacvwxktbh.supabase.co:5432/postgres?sslmode=require';
const object = (name, schema, body, type = 'FUNCTION', owner = 'postgres') =>
  `-- Name: ${name}; Type: ${type}; Schema: ${schema}; Owner: ${owner}\n--\n\n${body}\n\n`;
const managed = [...['email()', 'jwt()', 'role()', 'uid()'].map((name) =>
  object(name, 'auth', `CREATE FUNCTION auth.${name} RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;`)),
  ...['schedule(text)', 'unschedule(bigint)', 'alter_job(bigint)'].map((name) =>
    object(name, 'cron', `CREATE FUNCTION cron.${name} RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;`))].join('');
const ordinary = object('application()', 'public', `CREATE FUNCTION public.application() RETURNS text LANGUAGE sql AS $body$\n-- Name: impostor(); Type: FUNCTION; Schema: auth; Owner: postgres\nSELECT 'kept';\n$body$;`);
const prefix = '-- PostgreSQL database dump\n\\restrict safeToken\nSET standard_conforming_strings = on;\n';
const footer = '-- PostgreSQL database dump complete\n\\unrestrict safeToken\n';

test('connection diagnostics retain only fixed codes across causes and aggregate failures', () => {
  const privateError = Object.assign(Error('postgres://private:secret@private.invalid'), {code:'ENETUNREACH'});
  assert.equal(connectionFailureCode(new AggregateError([privateError])), 'ENETUNREACH');
  assert.equal(connectionFailureCode(Error('outer', {cause:privateError})), 'ENETUNREACH');
  assert.equal(connectionFailureCode({code:'secret-provider-code', message:'secret'}), 'UNKNOWN');
  assert.equal(connectionFailureCode(new AggregateError([privateError, {code:'ECONNREFUSED'}])), 'MULTIPLE_KNOWN_FAILURES');
  const cycle = {}; cycle.cause = cycle;
  assert.equal(connectionFailureCode(cycle), 'UNKNOWN');
  let deep = privateError; for (let i=0;i<20;i++) deep = {cause:deep};
  assert.equal(connectionFailureCode(deep), 'UNKNOWN');
});

test('dump diagnostics classify only fixed categories and bounded scalar facts', () => {
  assert.equal(dumpFailureKind('pg_dump: query failed: permission denied for private-source'), 'PERMISSION_DENIED');
  assert.equal(dumpFailureKind('certificate verify failed at private-host'), 'TLS_VERIFICATION');
  assert.equal(dumpFailureKind('canceling statement due to statement timeout'), 'STATEMENT_TIMEOUT');
  assert.equal(dumpFailureKind('private-provider-secret'), 'UNKNOWN');
  const result=safeDumpDiagnostic({kind:'private-secret',exit_code:999,signal:'private-host',elapsed_ms:-1,
    stdout_bytes:Infinity,stderr_bytes:NaN,message:'private-provider-secret'});
  assert.deepEqual(result,{kind:'UNKNOWN',exit_code:null,signal:'UNKNOWN',elapsed_ms:null,stdout_bytes:null,stderr_bytes:null});
});

test('capture export uses only the original total deadline minus metadata time and finalization reserve', () => {
  assert.equal(remainingDumpBudget(45000,3000),37000);
  assert.equal(remainingDumpBudget(45000,0),40000);
  assert.equal(remainingDumpBudget(45000,39999),1);
  for(const now of [40000,45000,50000,NaN,Infinity,0.5])
    assert.throws(()=>remainingDumpBudget(45000,now),/CAPTURE_REFUSED/);
  assert.throws(()=>remainingDumpBudget(45001,0),/CAPTURE_REFUSED/);
});

test('only the exact canonical manual main caller can capture', () => {
  assert.equal(captureContext(context).source_sha, context.GITHUB_SHA);
  for (const [key, value] of [['GITHUB_REPOSITORY_ID','1'],['GITHUB_REPOSITORY','other/repo'],
    ['GITHUB_EVENT_NAME','pull_request'],['GITHUB_REF','refs/heads/topic'],
    ['GITHUB_WORKFLOW_REF',context.GITHUB_WORKFLOW_REF.replace('schema-manifest-refresh','ci')],
    ['GITHUB_SHA','short'],['GITHUB_RUN_ID','0'],['GITHUB_RUN_ATTEMPT','0']])
    assert.throws(() => captureContext({...context,[key]:value}), /CAPTURE_REFUSED/);
});

test('database configuration cannot select another project, transaction pool or insecure TLS', () => {
  const config = databaseConfiguration(fixtureURL);
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(schemaHash(config.ssl.ca), '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7');
  assert.ok(!config.ssl.ca.includes('PRIVATE KEY'));
  assert.match(config.options, /default_transaction_read_only=on/);
  for (const value of [fixtureURL.replace('kuklfnapbkmacvwxktbh','aaaaaaaaaaaaaaaaaaaa'),
    fixtureURL.replace(':5432',':6543'),fixtureURL.replace('/postgres?','/other?'),
    fixtureURL.replace('sslmode=require','sslmode=disable'),fixtureURL+'&options=-c+default_transaction_read_only=off'])
    assert.throws(() => databaseConfiguration(value), /CAPTURE_REFUSED/);
});

test('SQL object boundaries ignore fake headers in dollar bodies, escaped strings and comments', () => {
  const sql = prefix + ordinary + footer;
  const parsed = dumpObjects(sql);
  assert.equal(parsed.objects.length, 1);
  assert.equal(parsed.objects[0].schema, 'public');
  assert.equal(parsed.footer, footer);
  const strings = object('literal()', 'public', String.raw`SELECT E'escaped\'
-- Name: string-impostor(); Type: FUNCTION; Schema: auth; Owner: postgres
still a string';
/* nested /* block */
-- Name: comment-impostor(); Type: FUNCTION; Schema: auth; Owner: postgres
*/`);
  assert.equal(dumpObjects(strings).objects.length, 1);
  const defaults = ['postgres', 'service_role'].map((owner) =>
    object('DEFAULT PRIVILEGES FOR FUNCTIONS', 'public', 'ALTER DEFAULT PRIVILEGES;', 'DEFAULT ACL', owner)).join('');
  assert.equal(dumpObjects(defaults).objects.length, 2);
  assert.throws(() => dumpObjects(object('x()', 'public', 'SELECT $unclosed$')), /PREIMAGE_REQUIRED/);
});

test('composition preserves application bytes and footer, removes only exact genuine service preimages', () => {
  const capture = prefix + managed + ordinary + footer;
  const result = composeSchema(capture, prefix + managed + footer);
  assert.equal(result.sql, prefix + ordinary + footer);
  assert.equal(result.manifest.retained.length, 1);
  assert.equal(result.manifest.removed.length, 7);
  assert.equal(result.manifest.current_database_contract_ready, false);
  assert.equal(result.manifest.original_sha256, schemaHash(capture));
  assert.throws(() => composeSchema(capture, prefix + managed.replace('SELECT NULL::text','SELECT 1::text') + footer), /PREIMAGE_REQUIRED/);
  assert.throws(() => composeSchema(capture, prefix + ordinary + footer), /PREIMAGE_REQUIRED/);
  assert.throws(() => composeSchema(capture, prefix + managed.replace('Owner: postgres','Owner: other') + footer), /PREIMAGE_REQUIRED/);
  assert.throws(() => composeSchema(capture, prefix + managed + object('extra()', 'auth', 'SELECT 1;') + footer), /PREIMAGE_REQUIRED/);
});

test('schema-only refusal excludes data, external connections and literal credential material', () => {
  for (const type of ['TABLE DATA','SEQUENCE SET','FOREIGN SERVER','USER MAPPING','SUBSCRIPTION'])
    assert.throws(() => assertSchemaOnly(object('x','public','unsafe;',type)), /PREIMAGE_REQUIRED/);
  assert.throws(() => assertSchemaOnly(object('x()','public',"SELECT 'postgres://user:password@example.invalid/db';")), /PREIMAGE_REQUIRED/);
  assert.throws(() => assertSchemaOnly(object('x()','public',"SELECT '-----BEGIN PRIVATE KEY-----';")), /PREIMAGE_REQUIRED/);
});

test('exact source-bound application hooks survive genuine service composition; unknown or changed hooks refuse', async () => {
  assert.equal(APPLICATION_TRIGGER_WITNESSES.length, 6);
  assert.deepEqual(APPLICATION_TRIGGER_WITNESSES.map((item) => item.function_name).sort(),
    ['handle_new_user','initialize_user_diamonds','handle_new_user_v2_create_wallet',
      'tr_auth_user_confirmed_settles_referral','tr_auth_user_confirmed_settles_referral','fn_ca_cash_failed_run_intake'].sort());
  const hooks = APPLICATION_TRIGGER_WITNESSES.map((item) => object(
    item.relation_name+' '+item.trigger_name,item.schema_name,
    item.definition.replaceAll('auth.users','"auth"."users"').replaceAll('public.','"public".')+';','TRIGGER','-')).join('');
  const result = composeSchema(prefix+managed+hooks+ordinary+footer,prefix+managed+footer);
  assert.equal(result.sql,prefix+hooks+ordinary+footer);
  assert.equal(result.manifest.application_hooks.length,6);
  assert.equal(result.manifest.current_database_contract_ready,false);
  assert.throws(() => composeSchema(prefix+managed+hooks.replace('AFTER INSERT ON','BEFORE INSERT ON')+ordinary+footer,prefix+managed+footer),/APPLICATION_TRIGGER_REFUSED/);
  assert.throws(() => composeSchema(prefix+managed+hooks.replace('public".handle_new_user()', 'public".different_handler()')+ordinary+footer,prefix+managed+footer),/APPLICATION_TRIGGER_REFUSED/);
  assert.throws(() => composeSchema(prefix+managed+hooks.replace('new.jobid = 259','new.jobid = 260')+ordinary+footer,prefix+managed+footer),/APPLICATION_TRIGGER_REFUSED/);
  assert.throws(() => composeSchema(prefix+managed+hooks.replace('public".handle_new_user();','public".handle_new_user(); ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created;')+ordinary+footer,prefix+managed+footer),/APPLICATION_TRIGGER_REFUSED/);
  assert.throws(() => composeSchema(prefix+managed+object('users unexpected_hook','auth','CREATE TRIGGER unexpected_hook AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();','TRIGGER','-')+ordinary+footer,prefix+managed+footer),/PREIMAGE_REQUIRED/);
  assert.throws(() => composeSchema(prefix+managed+hooks+ordinary+footer,prefix+managed+hooks+footer),/PREIMAGE_REQUIRED/);
  for(const witness of APPLICATION_TRIGGER_WITNESSES) {
    const source = await readFile(new URL('../../../../'+witness.source.path,import.meta.url));
    assert.equal(schemaHash(source),witness.source.sha256);
    assert.ok(source.toString().includes(witness.trigger_name));
    assert.ok(source.toString().includes(witness.function_name));
    assert.equal(schemaHash(witness.definition),witness.definition_sha256);
  }
  assert.equal(APPLICATION_TRIGGER_WITNESSES.find((item)=>item.trigger_name==='on_auth_user_created_diamonds').source.kind,
    'protected-function-repair-and-live-trigger-metadata');
});

function fakeClient(safety = {}) {
  const calls = [];
  class Client extends EventEmitter {
    async connect() { calls.push('CONNECT'); }
    async end() { calls.push('END'); }
    async query(sql) {
      calls.push(sql);
      if (sql.includes('foreign_servers')) return {rows:[{database:'postgres',server_version_num:170006,
        read_only:'on',foreign_servers:0,user_mappings:0,subscriptions:0,security_labels:0,other_database_settings:0,extensions:[],...safety}]};
      if (sql.includes('pg_export_snapshot')) return {rows:[{snapshot:'00000003-0000001B-1'}]};
      if (sql.includes('WITH user_schemas')) return {rows:[{catalogue:'{"actual":"catalogue"}'}]};
      if (sql.includes('password-free-role-catalogue')) return {rows:[{catalogue:{roles:[],memberships:[]}}]};
      return {rows:[]};
    }
  }
  return {Client,calls};
}

async function workspace(run) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/SmarterWork/') || process.env.RUNNER_TEMP);
  const root = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? process.env.TMPDIR,'schema-source-test-'));
  try { await run(root); } finally { await rm(root,{recursive:true,force:true}); }
}

test('failed actual connection closes once and exposes no raw cause, message or endpoint', async () => workspace(async (root) => {
  const {Client,calls} = fakeClient();
  Client.prototype.connect = async () => { throw Object.assign(Error('private-provider-secret'), {code:'28P01'}); };
  await assert.rejects(captureSchema({output:path.join(root,'isolated-schema-fail'),
    env:{...context,RUNNER_TEMP:root,DATABASE_URL:fixtureURL},Client}), (error) => {
      assert.equal(error.message,'ISOLATED_SCHEMA_CAPTURE_FAILED');
      assert.equal(error.captureStage,'connection');
      assert.equal(error.connectionFailure,'28P01');
      assert.equal(error.connectionRoute,'direct');
      assert.equal(error.cause,undefined);
      assert.ok(!JSON.stringify(error).includes('private-provider-secret'));
      assert.ok(!JSON.stringify(error).includes('kuklfnapbkmacvwxktbh'));
      return true;
    });
  assert.deepEqual(calls,['END']);
  assert.deepEqual(await readdir(root),[]);
}));

test('one read-only snapshot owns dump/catalogue, closes before publishing exactly six private files', async () => workspace(async (root) => {
  const {Client,calls} = fakeClient();
  const output = path.join(root,'isolated-schema-test');
  const receipt = await captureSchema({output,env:{...context,RUNNER_TEMP:root,DATABASE_URL:fixtureURL},Client,
    dump:async (_,snapshot) => {assert.equal(snapshot,'00000003-0000001B-1');assert.ok(calls.includes('SELECT pg_export_snapshot() AS snapshot'));return prefix+managed+ordinary+footer;}});
  assert.equal(receipt.current_database_contract_ready,false);
  assert.equal(receipt.public_artifact_permitted,false);
  assert.deepEqual((await readdir(output)).sort(),[...CAPTURE_FILES].sort());
  assert.ok(calls.indexOf('ROLLBACK') < calls.indexOf('END'));
  assert.equal(calls.filter((value) => value==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length,1);
  for (const name of CAPTURE_FILES) assert.equal((await stat(path.join(output,name))).mode&0o777,0o600);
  const manifest = JSON.parse(await readFile(path.join(output,'schema-capture-manifest.json'),'utf8'));
  assert.equal(manifest.files['schema.sql'].sha256,schemaHash(await readFile(path.join(output,'schema.sql'))));
  assert.ok(!JSON.stringify(manifest).includes('synthetic-only'));
}));

test('unsafe metadata/dump failures close the original transaction and never remove a preexisting output', async () => workspace(async (root) => {
  for (const safety of [{foreign_servers:1},{user_mappings:1},{subscriptions:1},{other_database_settings:1},{read_only:'off'},{server_version_num:170007}]) {
    const {Client,calls} = fakeClient(safety);
    await assert.rejects(captureSchema({output:path.join(root,'isolated-schema-fail'),env:{...context,RUNNER_TEMP:root,DATABASE_URL:fixtureURL},Client,
      dump:()=>{throw Error('must not reach dump');}}),/CAPTURE_REFUSED/);
    assert.ok(calls.includes('ROLLBACK'));assert.ok(calls.includes('END'));
  }
  const {Client,calls} = fakeClient();
  await assert.rejects(captureSchema({output:path.join(root,'isolated-schema-fail'),env:{...context,RUNNER_TEMP:root,DATABASE_URL:fixtureURL},Client,
    dump:()=>{throw Error('private provider text');}}));
  assert.ok(calls.includes('ROLLBACK'));assert.deepEqual(await readdir(root),[]);
  const occupied=path.join(root,'isolated-schema-owned-elsewhere');await writeFile(occupied,'preserved');
  await assert.rejects(captureSchema({output:occupied,env:{...context,RUNNER_TEMP:root,DATABASE_URL:fixtureURL},Client}),/CAPTURE_REFUSED/);
  assert.equal(await readFile(occupied,'utf8'),'preserved');
}));

test('pg_dump uses fixed no-data imported snapshot and no credential argv or inherited environment', async () => {
  const config=databaseConfiguration(fixtureURL);let observed;
  const spawnProcess=(command,args,options)=>{
    observed={command,args,options};const child=new EventEmitter();
    child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    queueMicrotask(()=>{child.stdout.end(prefix+ordinary+footer);child.stderr.end('private provider warning');child.emit('close',0);});
    return child;
  };
  await dumpSnapshot(config,'00000003-0000001B-1',{spawnProcess});
  assert.equal(observed.command,'pg_dump');assert.ok(observed.args.includes('--schema-only'));
  assert.ok(observed.args.includes('--snapshot=00000003-0000001B-1'));
  assert.ok(observed.args.includes('--lock-wait-timeout=1000'));
  assert.ok(!JSON.stringify(observed.args).includes('synthetic-only'));
  assert.ok(!('DATABASE_URL' in observed.options.env));assert.equal(observed.options.env.PGSSLMODE,'verify-full');
  assert.equal(observed.options.env.PGSSLROOTCERT, path.resolve('scripts/ci/certificates/supabase-prod-ca-2021.crt'));
  assert.equal(schemaHash(await readFile(observed.options.env.PGSSLROOTCERT)), schemaHash(config.ssl.ca));
});

test('dump failure preserves no private stderr, schema bytes or nested error', async () => {
  const spawnProcess=()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    queueMicrotask(()=>{child.stdout.end('private-schema');child.stderr.end('pg_dump: query failed: permission denied for private-relation');child.emit('close',1,null);});
    return child;
  };
  await assert.rejects(dumpSnapshot(databaseConfiguration(fixtureURL),'00000003-0000001B-1',{spawnProcess}),error=>{
    assert.equal(error.message,'ISOLATED_SCHEMA_DUMP_FAILED');
    assert.equal(error.dumpDiagnostic.kind,'PERMISSION_DENIED');
    assert.equal(error.dumpDiagnostic.exit_code,1);assert.equal(error.dumpDiagnostic.signal,'NONE');
    assert.ok(error.dumpDiagnostic.stdout_bytes>0);assert.ok(error.dumpDiagnostic.stderr_bytes>0);
    assert.ok(!JSON.stringify(error).includes('private-'));assert.equal(error.cause,undefined);return true;
  });
});

test('dump deadline and stderr overflow remain distinct terminal refusals', async () => {
  for (const mode of ['DEADLINE','STDERR_LIMIT','SPAWN']) {
    const spawnProcess=()=>{
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.kill=()=>child.emit('close',null,'SIGKILL');
      queueMicrotask(()=>{
        if(mode==='STDERR_LIMIT')child.stderr.end(Buffer.alloc(65537,65));
        if(mode==='SPAWN')child.emit('error',Error('private-host-secret'));
      });return child;
    };
    await assert.rejects(dumpSnapshot(databaseConfiguration(fixtureURL),'00000003-0000001B-1',
      {spawnProcess,deadlineMs:mode==='DEADLINE'?1:1000}),error=>{
        assert.equal(error.dumpDiagnostic.kind,mode);assert.equal(error.dumpDiagnostic.exit_code,null);
        assert.ok(!JSON.stringify(error).includes('private'));return true;
      });
  }
});

test('the original catalogue digest and private complete payload use the exact same canonical encoding', async () => {
  const {Client,calls}=fakeClient();const db=new Client();
  const original=await schemaCatalogue(db),payload=await schemaCataloguePayload(db);
  assert.equal(original,schemaHash('{"actual":"catalogue"}'));
  assert.equal(payload.catalogue_digest,original);
  assert.equal(payload.catalogue_text,'{"actual":"catalogue"}');
  assert.equal(payload.encoding,'postgres-jsonb-text-sha256/v1');
  const queries=calls.filter((sql)=>sql.includes('WITH user_schemas'));
  assert.equal(queries.length,2);assert.ok(queries[1].includes(`FROM (${queries[0]}) bounded_catalogue`));
});
