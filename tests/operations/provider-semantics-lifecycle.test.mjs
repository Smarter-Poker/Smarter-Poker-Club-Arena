import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const source = process.env.PROVIDER_REVIEW_SUBJECT ?? new URL('../../operations/release/fixture/', import.meta.url).pathname;
const { qualifyFixtureProviders } = await import(pathToFileURL(source + '/provider-semantics.mjs'));
const { providerSql: sql, providerVersions } = await import(pathToFileURL(source + '/provider-semantic-sql.mjs'));
const { createProviderProbePeer } = await import(pathToFileURL(source + '/provider-probe-peer.mjs'));
const roleProof = { scope:'native-full-role-installer',status:'passed',catalog_outcome:'committed',graph_assertion:true,membership_assertion:true,all_driver_clients_closed:true };
const names=['http','commit','rollback','sentinel'];
const symbols=[['http','http','$libdir/http'],['pg_net','wake','pg_net'],['supabase_vault','_crypto_aead_det_encrypt','$libdir/supabase_vault'],['supabase_vault','_crypto_aead_det_decrypt','$libdir/supabase_vault'],['plpgsql_check','plpgsql_check_function_tb','$libdir/plpgsql_check-2.7'],['postgis','st_makepoint','$libdir/postgis-3']];
const rows = (rows, command='SELECT') => ({rows, command});
const deferred = () => { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; };
function fixture({ endHook, peerCloseHook }={}) {
  const clients=[]; const hits=Object.fromEntries(names.map(n=>[n,0])); let transaction=false,pending=[],sequence=0;
  const peer={ body:'{"fixture":"synthetic"}',closeCalls:0,
    url(name){ assert.ok(names.includes(name)); return 'http://127.0.0.1:1/review/'+name; },
    assertHits(expected){ assert.deepEqual(hits,expected); },
    async close(){ this.closeCalls++; await peerCloseHook?.(); },
  };
  class Client extends EventEmitter {
    constructor(config){super();this.config=config;this.processID=1000+clients.length;this.index=clients.length+1;this.closed=false;clients.push(this);}
    async connect(){}
    async end(){await endHook?.(this);this.closed=true;this.emit('end');}
    async query({text,values}){
      if(text===sql.identity)return rows([{pid:this.processID,database:'club_arena_qualification',role:'supabase_admin',session_role:'supabase_admin',local:true,superuser:true,read_only:this.config.options.includes('read_only=on')?'on':'off',...(sql.identity.includes('server_version_num') ? {version_num:'170011'} : {version:'17.11'})}]);
      if(text===sql.empty)return rows([{empty:true}]);
      if(text===sql.install)return rows([], 'COMMIT');
      if(text===sql.inventory)return rows(Object.entries(providerVersions).map(([name,version])=>({name,version,schema:name==='supabase_vault'?'vault':'extensions',owner:'supabase_admin'})));
      if(text===sql.catalog){
        const catalog=symbols.map(([extension,name,library])=>({extension,name,library,language:'c',owner:'supabase_admin'}));
        for(const name of ['create_secret','update_secret'])catalog.push({extension:'supabase_vault',name,owner:'supabase_admin',security_definer:true,settings:['search_path=""']});
        while(catalog.length<101)catalog.push({owner:'supabase_admin',name:'controlled'});
        return rows(catalog);
      }
      if(text===sql.acl)return rows([Object.fromEntries(['vault_schema_denied','vault_create_denied','vault_table_denied','net_schema_public','net_get_public','net_queue_public','http_public','extensions_usage','extensions_create_denied'].map(k=>[k,true]))]);
      if(text===sql.vaultDenied)throw Object.assign(new Error('controlled permission denial'),{code:'42501'});
      if(text==='BEGIN'){transaction=true;return rows([],'BEGIN');}
      if(text==='COMMIT'){for(const name of pending)hits[name]++;pending=[];transaction=false;return rows([],'COMMIT');}
      if(text==='ROLLBACK'){pending=[];transaction=false;return rows([],'ROLLBACK');}
      if(text==='SET LOCAL ROLE anon')return rows([],'SET');
      if(text===sql.postgis)return [rows([{'QUERY PLAN':[{Plan:{'Index Name':'provider_points_gist'}}]}],'EXPLAIN'),rows([],'ROLLBACK')];
      if(text===sql.plpgsql)return rows([],'ROLLBACK');
      if(text===sql.vaultCreate)return rows([{id:'11111111-1111-4111-8111-111111111111'}]);
      if(text===sql.vaultRead)return rows([{encrypted:true,decrypted:true,authenticated_ciphertext:true}]);
      if(text===sql.vaultUpdate)return rows([{}]);
      if(text===sql.httpOptions)return rows([{timeout:true,connect_timeout:true,redirects:true}]);
      if(text===sql.http){hits.http++;return rows([{status:200,content_type:'application/json',content:peer.body}]);}
      if(text===sql.preload)return rows([{libraries:'pg_stat_statements,pg_cron,pg_net,supabase_vault',database:'club_arena_qualification',username:'supabase_admin',key_script:'/run/club-arena-qualification/private/provider-getkey'}]);
      if(text==='SELECT net.wait_until_running()')return rows([{}]);
      if(text===sql.worker)return rows([{workers:1}]);
      if(text===sql.enqueue){const name=values[0].split('/').at(-1);if(transaction)pending.push(name);else hits[name]++;return rows([{id:String(++sequence)}]);}
      if(text===sql.queueInvisible)return rows([{absent:true}]);
      if(text===sql.response)return rows([{status_code:200,content:peer.body,timed_out:false,error_msg:null}]);
      if(text.startsWith('DELETE FROM '))return rows([],'DELETE');
      if(text.startsWith('DROP SCHEMA '))return rows([],'DROP');
      if(text===sql.cleaned)return rows([{cleaned:true}]);
      throw new Error('unrecognized controlled SQL');
    }
  }
  const run=(extra={})=>qualifyFixtureProviders({Client,roleProof,buildSha256:'a'.repeat(64),peerFactory:async()=>peer,deadlineMs:4000,...extra});
  return {Client,clients,peer,run};
}

test('controlled successful protocol remains explicitly portable, with no production claims',async()=>{
  const f=fixture();const proof=await f.run();assert.equal(proof.status,'passed');assert.equal(proof.funded_or_production_complete,false);assert.equal(proof.production_binary_parity,false);assert.equal(f.clients.length,4);assert.ok(f.clients.every(c=>c.closed));assert.equal(f.peer.closeCalls,1);
});
test('cancellation during final peer cleanup cannot become a passing qualification',async()=>{
  const abort=new AbortController();const f=fixture({peerCloseHook:()=>abort.abort()});
  await assert.rejects(f.run({signal:abort.signal}), /FIXTURE_PROVIDER_/);
});
test('a transport error during final client close cannot become a passing qualification',async()=>{
  const f=fixture({endHook:client=>{if(client.index===4)client.emit('error',new Error('controlled final transport loss'));}});
  await assert.rejects(f.run(),/FIXTURE_PROVIDER_/);
});
test('a private peer acquired after cancellation is physically closed by its owner',async()=>{
  const abort=new AbortController();const entered=deferred(),gate=deferred();const f=fixture();let acquired,closed=0;
  const operation=f.run({signal:abort.signal,peerFactory:()=>{entered.resolve();return gate.promise;}});
  const rejected=assert.rejects(operation,/FIXTURE_PROVIDER_/);
  await entered.promise;abort.abort();
  // The acquisition is deliberately still in flight when cancellation wins.
  await sleep(20);
  acquired=await createProviderProbePeer();const originalClose=acquired.close;
  acquired.close=async()=>{closed++;return originalClose();};
  gate.resolve(acquired);
  try {await rejected;await sleep(30);assert.equal(closed,1,'late actual loopback peer escaped owner cleanup');}
  finally {if(!closed)await acquired.close();}
});
test('owned peer is loopback-only and rejects unexpected requests',async()=>{
  const peer=await createProviderProbePeer();
  try {
    const url=new URL(peer.url('http'));assert.equal(url.hostname,'127.0.0.1');
    const response=await fetch(url);assert.equal(response.status,200);assert.equal(await response.text(),peer.body);
    peer.assertHits({http:1,commit:0,rollback:0,sentinel:0});
    assert.throws(()=>peer.url('external'));
    const invalid=await fetch(new URL('/wrong-path',url));assert.equal(invalid.status,400);
    assert.throws(()=>peer.assertHits({http:1,commit:0,rollback:0,sentinel:0}));
  }finally{await peer.close();}
});

test('provider build version accepts only the pinned ABI and exact Debian suffix',async()=>{
  const mod=await import(pathToFileURL(source+'/provider-semantics.mjs'));
  mod.assertProviderPostgresVersion('PostgreSQL 17.11');
  mod.assertProviderPostgresVersion('PostgreSQL 17.11 (Debian 17.11-0+deb13u1)');
  for(const value of ['PostgreSQL 17.12','PostgreSQL 17.110','PostgreSQL 18.11','PostgreSQL 17.11 untrusted','PostgreSQL 17.11 (Debian 17.11-0+deb13u2)',null])assert.throws(()=>mod.assertProviderPostgresVersion(value));
  assert.match(sql.identity,/current_setting\('server_version_num'\) AS version_num/);
});

test('unsettled peer acquisition cannot hold qualification beyond its cleanup deadline',async()=>{
  const f=fixture();const started=performance.now();
  await assert.rejects(f.run({deadlineMs:120,peerFactory:()=>new Promise(()=>{})}),/FIXTURE_PROVIDER_/);
  assert.ok(performance.now()-started<500);assert.ok(f.clients.every(c=>c.closed));
});
test('unsettled private peer close fails within the remaining cleanup budget',async()=>{
  const f=fixture({peerCloseHook:()=>new Promise(()=>{})});const started=performance.now();
  await assert.rejects(f.run({deadlineMs:1000}),/FIXTURE_PROVIDER_/);
  assert.ok(performance.now()-started<1500);assert.ok(f.clients.every(c=>c.closed));assert.equal(f.peer.closeCalls,1);
});


test('late disposal rejections remain owned after the cleanup deadline fails', async () => {
  const unhandled = [];
  const observe = (error) => unhandled.push(error.message);
  process.on('unhandledRejection', observe);
  try {
    let acquired = 0;
    let disposed = 0;
    const gate = deferred();
    const f = fixture();
    await assert.rejects(f.run({ deadlineMs: 80, peerFactory: () => { acquired++; return gate.promise; } }), /FIXTURE_PROVIDER_/);
    assert.equal(acquired, 1, 'probe must reach peer acquisition');
    gate.resolve({ ...f.peer, async close() { disposed++; throw new Error('controlled late peer close'); } });
    await sleep(30);
    assert.equal(disposed, 1, 'late peer disposal must start despite expired budget');
    const g = fixture({ endHook: async (client) => {
      if (client.index === 1) return new Promise(() => {});
      throw new Error('controlled late client close');
    } });
    await assert.rejects(g.run({ deadlineMs: 80, peerFactory: () => new Promise(() => {}) }), /FIXTURE_PROVIDER_/);
    assert.equal(g.clients.length, 2, 'both native-client owners must be acquired before the fault');
    await sleep(30);
    assert.deepEqual(unhandled, [], 'cleanup rejection must remain owned after its deadline');
  } finally {
    process.removeListener('unhandledRejection', observe);
  }
});


test('an acquisition rejection before deadline still fails qualification', async () => {
  const f = fixture();
  let acquisitions = 0, failure;
  try {
    await f.run({ peerFactory: async () => {
      acquisitions++;
      throw new Error('controlled acquisition failed');
    } });
  } catch (error) { failure = error; }
  assert.equal(acquisitions, 1);
  assert.match(failure?.message ?? '', /FIXTURE_PROVIDER_/);
  assert.equal(failure?.proof.status, 'failed');
  assert.equal(failure?.proof.stage, 'private-http');
  assert.equal(failure?.proof.private_http_closed, false);
  assert.equal(failure?.proof.all_probe_clients_closed, true);
  assert.ok(f.clients.every((client) => client.closed));
});

test('an acquisition rejection after an event-loop stall remains owned beyond the total deadline', { timeout: 1500 }, async () => {
  const f = fixture();
  const query = f.Client.prototype.query;
  let reads = 0, acquisitions = 0, failure;
  const unhandled = [];
  const observe = (error) => unhandled.push(error.message);
  process.on('unhandledRejection', observe);
  f.Client.prototype.query = function (input) {
    const result = query.call(this, input);
    if (input.text === sql.vaultRead && ++reads === 3) {
      // Exercise actual event-loop starvation at an already-resolving query.
      // Its microtask wins before the delayed deadline timer can run.
      const until = performance.now() + 120;
      while (performance.now() < until) {}
    }
    return result;
  };
  try {
    try {
      await f.run({ deadlineMs: 80, peerFactory: async () => {
        acquisitions++;
        throw new Error('controlled acquisition after deadline');
      } });
    } catch (error) { failure = error; }
    await sleep(40);
    assert.equal(reads, 3, 'must reach the intended last Vault read');
    assert.equal(acquisitions, 1, 'must reach acquisition after the event-loop stall');
    assert.match(failure?.message ?? '', /FIXTURE_PROVIDER_/);
    assert.equal(failure?.proof.stage, 'private-http');
    assert.equal(failure?.proof.status, 'failed');
    assert.equal(failure?.proof.private_http_closed, false);
    assert.equal(f.clients.length, 2);
    assert.ok(f.clients.every((client) => client.closed));
    assert.deepEqual(unhandled, [], 'late acquisition rejection must remain owned');
  } finally {
    f.Client.prototype.query = query;
    process.removeListener('unhandledRejection', observe);
  }
});
