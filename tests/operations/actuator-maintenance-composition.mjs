// Invoked only by tests/maintenance/native.py --integration-script. This runner
// requires its disposable socket-only PG17 cluster; it accepts no production DSN.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
const exec=promisify(execFile);
const source=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const [clusterFile,evidence]=process.argv.slice(2);
const state=JSON.parse(await readFile(clusterFile,'utf8'));
assert.ok(state.socket.startsWith('/tmp/ca-e2-owned-') && state.socket.endsWith('/socket'));
assert.equal(state.port,55496);
const fixtureRoot=process.cwd();
const inputs=['integration.mjs','runtime-fixture.mjs'];
const inputHashes={};
for(const name of inputs)inputHashes[name]=createHash('sha256').update(await readFile(path.join(fixtureRoot,'tests/maintenance',name))).digest('hex');
const providerFiles=['operations/release/actuator-journal.mjs','operations/release/maintenance-journal.mjs',
 'operations/release/native/engine-operation-v2.py','operations/release/native/engine-native-v2.py',
 'operations/release/native/engine-boundary.py','operations/release/operationPolicy.json',
 'tests/operations/native-operation-v2.test.py'];
const providerHashes={};
for(const name of providerFiles)providerHashes[name]=createHash('sha256').update(await readFile(path.join(source,name))).digest('hex');
await mkdir(path.join(evidence,'authority'),{recursive:true});
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')&&!key.startsWith('PG')&&key!=='DATABASE_URL'));
await exec(process.execPath,[path.join(fixtureRoot,'tests/maintenance/integration.mjs'),clusterFile,path.join(evidence,'authority')],{env,timeout:180000,maxBuffer:100000});
const F=await import(pathToFileURL(path.join(fixtureRoot,'tests/maintenance/runtime-fixture.mjs')));
const admin=await F.connect(state,'postgres');const clients=[admin];const cases=[];
const settingsFile=path.join(evidence,'socket-settings.json');
const bridge=path.join(evidence,'authority-bridge.mjs');
await writeFile(bridge,`import {createRequire} from 'node:module';import {readFile} from 'node:fs/promises';
import {actuatorAuthority} from ${JSON.stringify(pathToFileURL(path.join(source,'operations/release/actuator-journal.mjs')).href)};
const require=createRequire(${JSON.stringify(pathToFileURL(path.join(source,'operations/release/package.json')).href)});const {Client}=require('pg');
const c=new Client(JSON.parse(await readFile(process.argv[2],'utf8')));await c.connect();
try{let s='';for await(const chunk of process.stdin)s+=chunk;console.log(JSON.stringify(await actuatorAuthority(c,JSON.parse(s),process.argv[3])));}finally{await c.end();}
`);
const python=path.join(evidence,'native-actuator.py');
await writeFile(python,`import importlib.util,json,subprocess,sys,tempfile
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('fixture',${JSON.stringify(path.join(source,'tests/operations/native-operation-v2.test.py'))})
F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F);V=F.V2
input=json.loads(Path(sys.argv[1]).read_text());envelope=input['envelope'];health=input['health']
class Host(F.FakeHost):
 def __init__(self):super().__init__(envelope,None,health);self.lost=False
 def authority(self,action,context=None):
  payload={'action':action,'provider_operation_id':envelope['operation_id']}
  if action=='consume':
   self.claims+=1
   payload.update(owner=context['provider_operation']['owner_id'],epoch=envelope['epoch'],operation_id=context['interval']['operation_id'],step_id=context['step']['id'])
  r=subprocess.run([input['node'],input['bridge'],input['settings'],input['bundle']],input=json.dumps(payload),capture_output=True,text=True,timeout=20)
  if r.returncode:raise ValueError('native fixture database boundary refused: '+r.stderr[:2000])
  value=json.loads(r.stdout)
  if action=='consume' and input['mode']=='lost_response' and not self.lost:self.lost=True;raise TimeoutError('discarded fixture response after actual COMMIT')
  return value
host=Host();error=None
with tempfile.TemporaryDirectory(prefix='actuator-composition-') as directory,patch.object(V,'secure',side_effect=lambda p,file=True:Path(p)),patch.object(V.NATIVE,'secure',side_effect=lambda p,file=True:Path(p)):
 folder=Path(directory)
 try:result=V.transaction(envelope,host,folder)
 except Exception as e:
  error=type(e).__name__+': '+str(e);result={'terminal':False}
  if input['mode']=='lost_response':result=V.transaction(envelope,host,folder,True)
 again=V.transaction(envelope,host,folder,True) if result.get('terminal') else None
 print(json.dumps({'result':result,'replay':again,'error':error,'claims':host.claims,'trials':host.trials,'restores':host.restores}))
`);
try {
 for(const mode of ['success','lost_response','owner_disconnected','stale_epoch','wrong_bundle','expired_step']) {
  const started=Date.now();const database='actuator_'+mode;
  await admin.query(`CREATE DATABASE ${database} TEMPLATE maintenance_template`);
  const c=await F.connect(state,database);clients.push(c);const b=await F.readBase(c);
  const {o,n,s}=await F.fixtureHold(c);
  const step=await F.as(c,'release_journal_controller',()=>F.call(c,'release_ops.authorize_maintenance_step',
   [o.owner_id,o.epoch,s.operation_id,'publish:'+b.plan,150000,150000,10000,'engine_cutover',n,F.actor]));
  assert.equal(step.authorized,true);
  const operation=randomUUID(),event=await F.call(c,'release_ops.event',[b.release,'NATIVE_ACTUATOR_COMPOSITION',F.actor,{}]);
  await c.query(`INSERT INTO release_ops.external_operations(id,release_id,operation_key,owner_id,epoch,kind,intent,intent_event,resume_state,status)
   VALUES($1,$2,'native-host-send',$3,$4,'PUBLISH',$5,$6,'APPLYING','UNKNOWN')`,[operation,b.release,o.owner_id,o.epoch,
   {target:'club-arena-engine',manifest_digest:b.manifest_digest,provider_request:b.request,plan_id:b.plan,installation_id:b.installation},event]);
  await c.query('INSERT INTO release_ops.provider_submissions VALUES($1,$2,$3,$4,$5)',[operation,b.installation,o.owner_id,o.epoch,event]);
  if(mode==='owner_disconnected')await c.query('SELECT pg_advisory_unlock_all()');
  if(mode==='expired_step') {
   // Fixture-only time boundary; no controller API can extend/alter a step.
   await c.query('ALTER TABLE release_ops.maintenance_steps DISABLE TRIGGER USER');
   await c.query("UPDATE release_ops.maintenance_steps SET not_after_at=clock_timestamp()-interval '1second'");
   await c.query('ALTER TABLE release_ops.maintenance_steps ENABLE TRIGGER USER');
  }
  await writeFile(settingsFile,JSON.stringify({host:state.socket,port:state.port,database,user:'maintenance_native_actuator'}));
  const envelope={operation_id:operation,epoch:mode==='stale_epoch'?randomUUID():o.epoch,request:b.request};
  const health={running:true,liveness:'ok',releaseSha:b.request.expected_current.source_sha,maintenance:{policyVersion:2,policyDigest:F.digest,
   activationReceipt:b.compatibility,readyForRestart:true,operation:{operationId:s.operation_id,releaseId:b.release,phase:'applying'}}};
  const input=path.join(evidence,mode+'.input.json');
  await writeFile(input,JSON.stringify({envelope,health,mode,node:process.execPath,bridge,settings:settingsFile,bundle:(mode==='wrong_bundle'?'c':'b').repeat(64)}));
  const output=JSON.parse((await exec('python3',['-B',python,input],{env,timeout:45000,maxBuffer:100000})).stdout);
  const consumed=(await c.query('SELECT count(*)::int n FROM release_ops.maintenance_step_consumptions')).rows[0].n;
  await writeFile(path.join(evidence,mode+'.json'),JSON.stringify({output,consumed},null,2));
  if(mode==='success') {assert.equal(output.result.outcome,'SUCCEEDED');assert.equal(output.trials,1);assert.equal(consumed,1);assert.deepEqual(output.result,output.replay);}
  else if(mode==='lost_response') {assert.equal(output.result.outcome,'FAILED');assert.equal(output.trials,0);assert.equal(output.restores,1);assert.equal(consumed,1);assert.deepEqual(output.result,output.replay);}
  else {assert.equal(output.result.terminal,false);assert.equal(output.trials,0);assert.equal(consumed,0);}
  await writeFile(path.join(evidence,mode+'.json'),JSON.stringify({output,consumed},null,2));
  cases.push({name:'native_actuator_with_real_journal_'+mode,status:'passed',milliseconds:Date.now()-started});
  await writeFile(path.join(evidence,'cases.json'),JSON.stringify(cases,null,2));
 }
 for(const name of inputs)assert.equal(createHash('sha256').update(await readFile(path.join(fixtureRoot,'tests/maintenance',name))).digest('hex'),inputHashes[name]);
 for(const name of providerFiles)assert.equal(createHash('sha256').update(await readFile(path.join(source,name))).digest('hex'),providerHashes[name]);
 await writeFile(path.join(evidence,'composition-inputs.json'),JSON.stringify({fixture_files:inputHashes,provider_files:providerHashes,fixture_root:fixtureRoot,provider_root:source},null,2));
 console.log(JSON.stringify(cases));
} finally {await Promise.all(clients.map(c=>c.end().catch(()=>{})));}
