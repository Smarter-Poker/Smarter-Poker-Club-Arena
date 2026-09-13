import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pbkdf2Sync, createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expectedFutureAcl, expectedFuturePrivilege, expectedSchemaUsage, reachableRoles, futureObjectCases, verifySyntheticScram } from '../../operations/release/fixture/role-native-access.mjs';
import { roleFaultCases, splitRoleFaultSource } from '../../operations/release/fixture/role-native-faults.mjs';
import { roleNativeInputs, RoleNativeOwner, lastCommand, identifier } from '../../operations/release/fixture/role-native-protocol.mjs';
import { withHeldFixtureRoleAlignmentClient, renderFixtureRoleAlignmentSql } from '../../operations/release/fixture/role-alignment-render.mjs';
const inputs = await roleNativeInputs(), catalog = inputs['role-alignment-aligned.json'];
const password = 'a'.repeat(64);
const entry = (creator,schema,type) => catalog.default_acl.find((r) => r.creator===creator && r.schema===schema && r.type===type);

test('all27 source-pinned creator/schema/type cases are unique and cover9triples', () => {
  const cases = futureObjectCases(catalog);
  assert.equal(cases.length,27);
  assert.equal(new Set(cases.map((c) => [c.creator,c.schema,c.type].join(':'))).size,27);
  assert.equal(new Set(cases.map((c) => c.name)).size,27);
  assert.deepEqual(Object.fromEntries(['r','S','f'].map((t) => [t,cases.filter((c) => c.type===t).length])),{r:9,S:9,f:9});
  assert.throws(() => futureObjectCases({...catalog,default_acl:catalog.default_acl.slice(1)}));
});
test('function PUBLIC execution remains in defaults even without explicit per-schema PUBLIC', () => {
  const acl = expectedFutureAcl(entry('supabase_admin','cron','f'));
  assert.deepEqual(acl,[
    {grantor:'supabase_admin',grantee:'postgres',privilege:'EXECUTE',grantable:true},
    {grantor:'supabase_admin',grantee:'PUBLIC',privilege:'EXECUTE',grantable:false},
    {grantor:'supabase_admin',grantee:'supabase_admin',privilege:'EXECUTE',grantable:false},
  ].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  assert.equal(expectedFuturePrivilege(catalog,entry('supabase_admin','cron','f'),'anon','EXECUTE'),true);
  assert.equal(expectedSchemaUsage(catalog,'cron','anon'),false,'schema permission remains independent');
});
test('owner defaults merge grants without deleting PostgreSQL TRUNCATE or MAINTAIN', () => {
  const acl = expectedFutureAcl(entry('postgres','public','r'));
  const mine = acl.filter((g)=>g.grantee==='postgres');
  assert.equal(mine.length,8);
  assert.ok(mine.some((g)=>g.privilege==='TRUNCATE'));
  assert.ok(mine.some((g)=>g.privilege==='MAINTAIN'));
  assert.equal(acl.some((g)=>g.grantee==='anon'&&g.privilege==='TRUNCATE'),false);
});
test('SET and INHERIT paths remain different across backup and authenticator edges', () => {
  assert.equal(reachableRoles(catalog,'postgres','set').has('supabase_backup_admin'),false);
  assert.equal(reachableRoles(catalog,'postgres','inherit').has('supabase_backup_admin'),false);
  assert.equal(reachableRoles(catalog,'authenticator','set').has('anon'),true);
  assert.equal(reachableRoles(catalog,'authenticator','inherit').has('anon'),false);
  assert.equal(reachableRoles(catalog,'supabase_storage_admin','set').has('anon'),true);
  assert.equal(reachableRoles(catalog,'supabase_storage_admin','inherit').has('anon'),false);
});
test('read-all-data grants effective reads and schema usage without granting onward', () => {
  const e=entry('supabase_auth_admin','auth','r');
  assert.equal(expectedFuturePrivilege(catalog,e,'supabase_read_only_user','SELECT'),true);
  assert.equal(expectedFuturePrivilege(catalog,e,'supabase_read_only_user','SELECT',true),false);
  assert.equal(expectedFuturePrivilege(catalog,e,'supabase_read_only_user','UPDATE'),false);
  assert.equal(expectedSchemaUsage(catalog,'auth','supabase_read_only_user'),true);
});
test('schema-only catalog defaults do not invent a CREATE grant for postgres/storage', () => {
  const schema=catalog.schemas.find((s)=>s.name==='storage');
  assert.equal(schema.acl.includes('postgres=U*/supabase_admin'),true);
  assert.equal(schema.acl.some((a)=>a.startsWith('postgres=')&&a.split('=')[1].split('/')[0].includes('C')),false);
});
test('SCRAM proof rejects wrong passwords, iteration abuse and malformed verifier', () => {
  const salt=Buffer.alloc(16,1),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
  const stored=createHash('sha256').update(createHmac('sha256',salted).update('Client Key').digest()).digest('base64');
  const server=createHmac('sha256',salted).update('Server Key').digest('base64');
  const verifier=`SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
  verifySyntheticScram(password,verifier);
  assert.throws(()=>verifySyntheticScram('b'.repeat(64),verifier));
  assert.throws(()=>verifySyntheticScram(password,verifier.replace('4096','999999999')));
  assert.throws(()=>verifySyntheticScram(password,'not-a-scram-secret'));
});
test('fault matrix covers both guards, middle/late and every held-client category exactly once', () => {
  assert.equal(roleFaultCases.length,36);
  assert.equal(new Set(roleFaultCases.map((s)=>s.name)).size,36);
  for(const stage of ['entry','final']) for(const fault of ['extra-role','flags','settings','membership','schema-owner','schema-acl','default-acl','extension-version','extension-owner','absent','replacement','extra-client','idle-transaction','active','other-database','prepared','cron-job'])
    assert.ok(roleFaultCases.some((s)=>s.name===stage+'-'+fault));
});
test('all fault slices preserve exact source bytes and unique complete-statement boundaries', async () => {
  class Held extends EventEmitter {processID=99;async query(){return{rows:[{pid:99,database:'club_arena_qualification',session_role:'postgres',current_role:'postgres',superuser:false,backend_start_micros:'1700000000000000'}]};}}
  const client=new Held();
  await withHeldFixtureRoleAlignmentClient(client, async(binding)=>{
    const rendered=renderFixtureRoleAlignmentSql(inputs['role-alignment-installer.sql'],{password,clientBinding:binding});
    for(const stage of ['middle','late','final']){
      const [prefix,suffix]=splitRoleFaultSource(rendered,stage);
      assert.equal(prefix+suffix,rendered);
      assert.equal(prefix.trimEnd().endsWith(';'),true);
      assert.equal(suffix.trimEnd().endsWith('COMMIT;'),true);
    }
    assert.throws(()=>splitRoleFaultSource(rendered+'\n-- exact-postimage-and-commit\n','final'));
    assert.throws(()=>splitRoleFaultSource(rendered,'invented'));
  });
});
test('an absent client fault can render while alive and still submit SQL after intentional end', async () => {
  class Held extends EventEmitter {processID=99;async query(){return{rows:[{pid:99,database:'club_arena_qualification',session_role:'postgres',current_role:'postgres',superuser:false,backend_start_micros:'1700000000000000'}]};}}
  const client=new Held();let submitted=false;
  await assert.rejects(withHeldFixtureRoleAlignmentClient(client,async(binding)=>{
    const rendered=renderFixtureRoleAlignmentSql(inputs['role-alignment-installer.sql'],{password,clientBinding:binding});
    client.emit('end');
    assert.ok(rendered.includes('pid=99'));
    submitted=true; // Portable binding ordering only; SQL refusal is native-only.
  }),/FIXTURE_APPLICATION_DISCONNECTED/);
  assert.equal(submitted,true);
});
function clients(mode='ok') {
  const records=[];
  class Client extends EventEmitter {
    constructor(config){super();this.config=config;this.processID=101+records.length;records.push(this);}
    async connect(){}
    async query(){if(mode==='hung-query')return new Promise(()=>{});return{rows:[{pid:this.processID,session_role:this.config.user,current_role:this.config.user,database:this.config.database,superuser:this.config.user==='supabase_admin',tcp:this.config.host==='127.0.0.1',read_only:this.config.options?.includes('read_only=on')?'on':'off'}]};}
    async end(){this.ended=true;if(mode!=='missing-end')this.emit('end');}
  }
  return {Client,records};
}
test('ordinary sessions preserve role defaults; password auth uses only fixed loopback',async()=>{
  const f=clients(),o=new RoleNativeOwner(f.Client,{password,deadlineMs:1000});
  const ordinary=await o.connect('authenticator',{tcp:true});
  assert.equal(ordinary.client.config.host,'127.0.0.1');
  assert.equal(ordinary.client.config.password,password);
  assert.equal(ordinary.client.config.statement_timeout,undefined);
  assert.equal(ordinary.client.config.options,undefined);
  await o.closeAll();assert.ok(f.records.every((r)=>r.ended));
});
test('one overall deadline rejects a stuck query while reserved cleanup still ends client',async()=>{
  const f=clients('hung-query'),o=new RoleNativeOwner(f.Client,{password,deadlineMs:500});
  await assert.rejects(o.connect('supabase_admin'),/FIXTURE_ROLE_NATIVE_DEADLINE/);
  await o.closeAll();assert.equal(f.records[0].ended,true);
});
test('end acknowledgement is required and background client errors refuse further queries',async()=>{
  const f=clients('missing-end'),o=new RoleNativeOwner(f.Client,{password,deadlineMs:1000});
  const r=await o.connect('supabase_admin');r.client.emit('error',new Error('controlled'));
  await assert.rejects(o.query(r,'SELECT 1'),/FIXTURE_ROLE_NATIVE_CLIENT_ERROR/);
  await assert.rejects(o.closeAll(),/FIXTURE_ROLE_NATIVE_CLIENT_CLEANUP/);
});
test('transaction terminal response cannot treat a missing COMMIT or ROLLBACK as success',()=>{
  lastCommand([{command:'BEGIN'},{command:'COMMIT'}],'COMMIT');
  assert.throws(()=>lastCommand([{command:'BEGIN'},{command:'DO'}],'COMMIT'));
  assert.throws(()=>lastCommand({command:'COMMIT'},'ROLLBACK'));
});
test('identifier and database boundaries reject external or injected destinations',()=>{
  for(const name of ['public;DROP','a.b','a"b',''])assert.throws(()=>identifier(name));
  const f=clients(),o=new RoleNativeOwner(f.Client,{password,deadlineMs:1000});
  assert.throws(()=>o.make('supabase_admin',{database:'production'}));
});


test('a client disposal rejection stays failed while cleanup budget remains', async () => {
  const f = clients(), owner = new RoleNativeOwner(f.Client, { password, deadlineMs: 1000 });
  const record = await owner.connect('supabase_admin');
  let closes = 0;
  record.client.end = async () => { closes++; throw new Error('controlled disposal rejection'); };
  await assert.rejects(owner.close(record), /controlled disposal rejection/);
  await assert.rejects(owner.closeAll(), /FIXTURE_ROLE_NATIVE_CLIENT_CLEANUP/);
  assert.equal(closes, 1);
  assert.equal(record.ended, false);
});

test('late client disposal rejection remains owned after total cleanup deadline', async () => {
  const f = clients(), owner = new RoleNativeOwner(f.Client, { password, deadlineMs: 1000 });
  const record = await owner.connect('supabase_admin');
  const unhandled = [];
  const observe = (error) => unhandled.push(error.message);
  let closes = 0;
  record.client.end = async () => {
    closes++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw new Error('controlled late disposal rejection');
  };
  process.on('unhandledRejection', observe);
  try {
    owner.deadline = -1;
    await assert.rejects(owner.close(record), /FIXTURE_ROLE_NATIVE_DEADLINE/);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await assert.rejects(owner.closeAll(), /FIXTURE_ROLE_NATIVE_CLIENT_CLEANUP/);
    assert.equal(closes, 1);
    assert.equal(record.ended, false);
    assert.deepEqual(unhandled, []);
  } finally { process.removeListener('unhandledRejection', observe); }
});


test('a final client error cannot become successful cleanup merely because end arrives', async () => {
  const f = clients(), owner = new RoleNativeOwner(f.Client, { password, deadlineMs: 1000 });
  const record = await owner.connect('supabase_admin');
  record.client.end = async () => {
    record.client.emit('error', new Error('controlled final connection error'));
    record.client.emit('end');
  };
  await assert.rejects(owner.closeAll(), /FIXTURE_ROLE_NATIVE_CLIENT_CLEANUP/);
  assert.equal(record.ended, true);
  assert.equal(record.error, true);
});
