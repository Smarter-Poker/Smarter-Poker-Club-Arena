import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../../..');
const parent=process.argv[2];if(!parent)throw Error('Pass task-owned SSD scratch directory');
mkdirSync(parent,{recursive:true});const dir=mkdtempSync(path.join(parent,'of-'));
const socket=path.join(dir,'s');mkdirSync(socket);
const bin=process.env.PG_BIN||execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const args=['-X','-At','-v','ON_ERROR_STOP=1','-h',socket,'-p','55477','-U','postgres','-d','postgres'];
const run=(tool,argv)=>execFileSync(path.join(bin,tool),argv,{encoding:'utf8',maxBuffer:12000000});
const sql=q=>execFileSync(path.join(bin,'psql'),args,{input:q,encoding:'utf8',maxBuffer:12000000}).trim();
const json=name=>JSON.parse(readFileSync(path.join(here,name),'utf8'));
const id=n=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
const owner=id(1),club=id(2),player=id(3),event=id(4);
const migration=readFileSync(path.join(root,'supabase/migrations/20261019180622_owner_fee_capture_resumes_in_its_original_close.sql'),'utf8');
let running=false;
const fixture=(n,override='',charged='2026-10-19T16:00:00Z')=>{
 const payer=id(600+n);
 const fee=id(100+n),registration=id(200+n),entitlement=id(300+n),ledger=id(400+n);
 return `INSERT INTO accounting_agreement_history(id,entity_type,entity_key,observed_at,after_terms,club_id,subject_user_id) VALUES(${10}+${n},'club_members','${club}:${payer}','2026-10-19T15:43:10Z',jsonb_build_object('club_id','${club}','user_id','${payer}','agent_id','${owner}','role','player','status','active','is_active',true,'player_rakeback_pct',.1),'${club}','${payer}');
 INSERT INTO tournament_players(id,tournament_id,user_id,club_id,registered_at) VALUES('${registration}','${event}','${payer}','${club}','${charged}');
 INSERT INTO chip_ledger(id,club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,category,tournament_id,status) VALUES('${ledger}','${club}','player_wallet','${payer}','prize_liability','${event}',1.10,'${charged}','tournament_buyin','${event}','posted');
 INSERT INTO tournament_refund_entitlements(id,tournament_id,user_id,refund_wallet_club_id,source_ledger_id,created_at,refund_fee,gross,entitlement_kind,charge_category,registration_id) VALUES('${entitlement}','${event}','${payer}','${club}','${ledger}','${charged}',.10,1.10,'wallet_charge','tournament_buyin','${registration}');
 INSERT INTO rake_records(id,club_id,tournament_id,is_tournament,rake_amount,created_at,source,metadata) VALUES('${fee}','${club}','${event}',true,.10,'${charged}','fn_register_for_tournament',jsonb_build_object('kind','tournament_entry_fee','user_id','${payer}','registration_id','${registration}'));
 INSERT INTO accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,source_version,status,source_manifest,captured_at)
 SELECT r.id,r.tournament_id,fn_accounting_tournament_fee_fingerprint(r),r.rake_amount,2,'legacy_unverified',jsonb_build_object('union_id',NULL,'game_type','sng','spin_reserve_id',NULL,'capture_reason','accounting_terms_not_observed','contributors',jsonb_build_array(jsonb_build_object('player_id','${payer}','club_id','${club}','registration_id','${registration}','charge_ledger_id','${ledger}','entitlement_id','${entitlement}','charged_at','${charged}','weight',.10))),'${charged}' FROM rake_records r WHERE id='${fee}';${override}`;
};
const refuse=(q,message)=>{let error;try{sql(q);}catch(e){error=String(e.stderr);}assert.ok(error?.includes(message),`${message}: ${error}`);};
try{
 run('initdb',['-D',path.join(dir,'db'),'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
 run('pg_ctl',['-D',path.join(dir,'db'),'-l',path.join(dir,'pg.log'),'-o',`-k ${socket} -p 55477 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=15 -c timezone=UTC`,'-w','start']);running=true;
 let setup='CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;SET check_function_bodies=off;';
 for(const t of json('tables.json')){
  const columns=t.columns.split(',\n').map(c=>c.split(' DEFAULT ')[0]);
  setup+=`CREATE TABLE public.${t.table_name}(${columns.join(',')});`;
 }
 setup+=`ALTER TABLE accounting_tournament_fee_sources ALTER COLUMN id SET DEFAULT gen_random_uuid();
 ALTER TABLE accounting_tournament_fee_batches ADD PRIMARY KEY(rake_record_id);
 ALTER TABLE accounting_tournament_fee_sources ADD PRIMARY KEY(id),ADD UNIQUE(rake_record_id,player_id),ADD UNIQUE(source_entitlement_id),ADD CHECK(rake_credit>=0 AND rake_credit=round(rake_credit,2));
 CREATE TABLE ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);
 CREATE TABLE accounting_mixed_cutover_spin_fee_proofs(rake_record_id uuid,tournament_id uuid,original_batch jsonb,cutover_at timestamptz,canonical_sources jsonb);
 CREATE FUNCTION fn_poker_diamond_tournament(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';`;
 setup+=json('helpers.json').map(r=>r.definition+';').join('\n');
 setup+=json('mixed-preimages.json').find(r=>r.signature==='fn_accounting_mixed_cutover_spin_proof_valid(uuid)').definition+';';
 setup+=json('producer-preimages.json').map(r=>r.definition+';').join('\n');
 setup+=json('preimages.json').filter(r=>['fn_accounting_tournament_fee_net_plan(uuid)','fn_accounting_tournament_week_quality(uuid,timestamp with time zone,timestamp with time zone)','fn_settle_tournament_rake(uuid,text)'].includes(r.signature)).map(r=>r.definition+';').join('\n');
 setup+=`CREATE TRIGGER original_batch_immutable BEFORE UPDATE OR DELETE ON accounting_tournament_fee_batches FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
 INSERT INTO clubs(id,owner_id) VALUES('${club}','${owner}');
 INSERT INTO tournaments(id,club_id,is_private,tournament_type,status) VALUES('${event}','${club}',true,'SNG','COMPLETING');
 INSERT INTO accounting_tournament_fee_cutover(singleton,starts_at) VALUES(true,'2026-09-17T18:24:02.831517Z');
 INSERT INTO accounting_agreement_history(id,entity_type,entity_key,observed_at,after_terms,club_id,subject_user_id) VALUES(1,'club_members','${club}:${player}','2026-10-19T15:43:10Z',jsonb_build_object('club_id','${club}','user_id','${player}','agent_id','${owner}','role','player','status','active','is_active',true,'player_rakeback_pct',.1),'${club}','${player}');`;
 sql(setup);sql(fixture(1));
 refuse(`SELECT fn_accounting_tournament_fee_net_plan('${event}');`,'tournament_fee_sources_require_reconciliation');
 refuse(`SELECT fn_accounting_earning_contract('${club}','${player}',.1,NULL,'2026-10-19T16:00:00Z');`,'accounting_terms_not_observed');
 // Use the exact guarded dependency patch, without installing its unrelated cash functions.
 sql(readFileSync(path.join(here,'producer-dependency-patch.sql'),'utf8'));
 assert.equal(sql("SELECT md5(pg_get_functiondef('fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamptz)'::regprocedure))"),'440c0bc501e1c2094b8d4c947533c08d');
 refuse(`SELECT fn_accounting_tournament_fee_net_plan('${event}');`,'tournament_fee_sources_require_reconciliation');
 sql(migration);
 const before=sql(`SELECT to_jsonb(b) FROM accounting_tournament_fee_batches b WHERE rake_record_id='${id(101)}'`);
 sql(`SELECT fn_accounting_qualify_owner_direct_fee('${id(101)}');`);
 assert.equal(sql(`SELECT to_jsonb(b) FROM accounting_tournament_fee_batches b WHERE rake_record_id='${id(101)}'`),before);
 const plan=JSON.parse(sql(`SELECT fn_accounting_tournament_fee_net_plan('${event}');`));assert.equal(plan.net_fee,.1);assert.equal(plan.status,'proven');
 assert.equal(sql(`SELECT contract#>>'{membership,terms,player_rakeback_pct}' FROM accounting_tournament_fee_sources WHERE rake_record_id='${id(101)}'`),'0.1','original charge-time player deal is retained');
 const close=sql("SELECT pg_get_functiondef('fn_settle_tournament_rake(uuid,text)'::regprocedure)");
 assert.ok(close.indexOf('PERFORM public.fn_accounting_qualify_owner_direct_fee(v_raw.id)')<close.indexOf('v_plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id)'),'original close captures before its authoritative net plan');
 const first=sql('SELECT count(*) FROM accounting_tournament_fee_sources');
 assert.equal(JSON.parse(sql(`SELECT fn_accounting_qualify_owner_direct_fee('${id(101)}')`)).replayed,true);
 assert.equal(sql('SELECT count(*) FROM accounting_tournament_fee_sources'),first);
 refuse(`SET ROLE authenticated;SELECT fn_accounting_qualify_owner_direct_fee('${id(101)}');`,'permission denied');
 refuse("UPDATE accounting_owner_direct_fee_proofs SET source_manifest='{}';",'accounting_tournament_fee_receipt_is_immutable');
 refuse("DELETE FROM accounting_tournament_fee_batches;",'accounting_tournament_fee_receipt_is_immutable');
 refuse('TRUNCATE accounting_owner_direct_fee_proofs;','accounting_tournament_fee_receipt_is_immutable');
 sql(fixture(2,`UPDATE chip_ledger SET amount=9 WHERE id='${id(402)}';`));
 refuse(`SELECT fn_accounting_qualify_owner_direct_fee('${id(102)}');`,'tournament_fee_charge_evidence_mismatch');
 assert.equal(sql(`SELECT count(*) FROM accounting_tournament_fee_sources WHERE rake_record_id='${id(102)}'`),'0');
 sql(fixture(3));
 refuse(`BEGIN;SELECT fn_accounting_qualify_owner_direct_fee('${id(103)}');DO $x$BEGIN RAISE EXCEPTION 'terminal_refusal';END$x$;COMMIT;`,'terminal_refusal');
 assert.equal(sql(`SELECT count(*) FROM accounting_owner_direct_fee_proofs WHERE rake_record_id='${id(103)}'`),'0');
 sql(`SELECT fn_accounting_qualify_owner_direct_fee('${id(103)}');`);
 sql(fixture(4));
 const concurrent=q=>new Promise((resolve,reject)=>{const p=spawn(path.join(bin,'psql'),args);let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('exit',c=>c===0?resolve(out):reject(Error(err)));p.stdin.end(q);});
 await Promise.all([concurrent(`BEGIN;SELECT fn_accounting_qualify_owner_direct_fee('${id(104)}');SELECT pg_sleep(.15);COMMIT;`),concurrent(`SELECT fn_accounting_qualify_owner_direct_fee('${id(104)}');`)]);
 assert.equal(sql(`SELECT count(*) FROM accounting_tournament_fee_sources WHERE rake_record_id='${id(104)}'`),'1');
 assert.equal(sql(`SELECT count(*) FROM accounting_owner_direct_fee_proofs WHERE rake_record_id='${id(104)}'`),'1');
 sql(fixture(5,'','2026-10-19T15:42:00Z'));
 refuse(`SELECT fn_accounting_qualify_owner_direct_fee('${id(105)}');`,'owner_fee_original_batch_unproven');
 sql(fixture(6));
 sql(`UPDATE tournaments SET status='RUNNING' WHERE id='${event}';`);
 refuse(`SELECT fn_accounting_qualify_owner_direct_fee('${id(106)}');`,'chip_tournament_fee_required');
 sql(`UPDATE tournaments SET status='COMPLETING' WHERE id='${event}';`);
 sql(fixture(7,`UPDATE clubs SET owner_id='${id(99)}' WHERE id='${club}';`));
 refuse(`SELECT fn_accounting_qualify_owner_direct_fee('${id(107)}');`,'accounting_terms_not_observed');
 assert.equal(sql(`SELECT count(*) FROM accounting_tournament_fee_sources WHERE rake_record_id='${id(107)}'`),'0');
 sql(`UPDATE clubs SET owner_id='${owner}' WHERE id='${club}';`);
 refuse(migration,'OWNER_FEE_MIGRATION_ALREADY_INSTALLED');
  // Current original-close lineage preimages, including satellite source-ledger identity.
  const detectorPreimages = json('detector-preimages.json');
  sql(
    'CREATE SCHEMA smarter_private;' + detectorPreimages.map((x) => x.definition + ';').join('\n')
  );
  sql(`CREATE TABLE table_seats(left_at timestamptz,horse_id uuid,table_id uuid);
 CREATE TABLE tables(id uuid,tournament_id uuid);ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS updated_at timestamptz;
 ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS status text;
 INSERT INTO tournaments(id,club_id,is_private,tournament_type,status) VALUES('${id(800)}','${club}',true,'SNG','RUNNING');`);
  sql(fixture(20).replaceAll(event, id(800)));
  const metric = () =>
    Number(sql('SELECT unbatched_fee_running FROM fn_ca_horse_fleet_metrics(10)'));
  assert.equal(metric(), 1, 'before: lawful deferred fee is incorrectly counted');
  const detectorMigration = readFileSync(
    path.join(root, 'supabase/migrations/20261020201951_fee_detector_uses_original_close_plan.sql'),
    'utf8'
  );
  sql(detectorMigration);
  const snapshot = () =>
    sql(`SELECT jsonb_build_object('b',(SELECT jsonb_agg(to_jsonb(x)) FROM accounting_tournament_fee_batches x),
 's',(SELECT jsonb_agg(to_jsonb(x)) FROM accounting_tournament_fee_sources x),'p',(SELECT jsonb_agg(to_jsonb(x)) FROM accounting_owner_direct_fee_proofs x),
 'l',(SELECT jsonb_agg(to_jsonb(x)) FROM chip_ledger x))`);
  const noWrites = snapshot();
  assert.equal(metric(), 0, 'after: exact validated original-close plan is not blocked');
  assert.equal(snapshot(), noWrites, 'observer writes no accounting, proof, or ledger rows');
  assert.equal(
    JSON.parse(sql(`SELECT smarter_private.owner_direct_fee_capture_plan('${id(120)}')`))
      .rake_credit,
    0.1
  );
  assert.equal(
    sql(
      `SELECT provolatile FROM pg_proc WHERE oid='smarter_private.owner_direct_fee_capture_plan(uuid)'::regprocedure`
    ),
    's'
  );
  refuse(
    `SET ROLE service_role;SELECT smarter_private.owner_direct_fee_capture_plan('${id(120)}');`,
    'permission denied'
  );
  refuse(
    `SELECT fn_accounting_qualify_owner_direct_fee('${id(120)}');`,
    'chip_tournament_fee_required'
  );
  sql(`UPDATE chip_ledger SET amount=9 WHERE id='${id(420)}'`);
  assert.equal(metric(), 1, 'invalid original charge still blocks');
  sql(`UPDATE chip_ledger SET amount=1.10 WHERE id='${id(420)}'`);
  sql(`UPDATE clubs SET owner_id='${id(999)}' WHERE id='${club}'`);
  assert.equal(metric(), 1, 'missing original earning agreement still blocks');
  sql(`UPDATE clubs SET owner_id='${owner}' WHERE id='${club}'`);
  assert.equal(metric(), 0);
  // Unexpected implementation failures must surface, rather than turn into clean metrics.
  sql('ALTER TABLE accounting_owner_direct_fee_incident RENAME TO hidden_incident');
  refuse('SELECT * FROM fn_ca_horse_fleet_metrics(10)', 'accounting_owner_direct_fee_incident');
  sql('ALTER TABLE hidden_incident RENAME TO accounting_owner_direct_fee_incident');
  const planned = JSON.parse(
    sql(`SELECT smarter_private.owner_direct_fee_capture_plan('${id(120)}')`)
  );
  sql(`UPDATE tournaments SET status='COMPLETING' WHERE id='${id(800)}'`);
  sql(`SELECT fn_accounting_qualify_owner_direct_fee('${id(120)}')`);
  const stored = JSON.parse(
    sql(
      `SELECT to_jsonb(x)-ARRAY['id','recorded_at'] FROM accounting_tournament_fee_sources x WHERE rake_record_id='${id(120)}'`
    )
  );
  assert.deepEqual(stored, planned.sources[0], 'original writer commits exact shared-plan values');
  assert.equal(
    JSON.parse(sql(`SELECT fn_accounting_qualify_owner_direct_fee('${id(120)}')`)).replayed,
    true
  );
  sql(fixture(21).replaceAll(event,id(800)));
  await Promise.all([concurrent(`BEGIN;SELECT fn_accounting_qualify_owner_direct_fee('${id(121)}');SELECT pg_sleep(.05);COMMIT;`),concurrent(`SELECT fn_accounting_qualify_owner_direct_fee('${id(121)}');`)]);
  assert.equal(sql(`SELECT count(*) FROM accounting_tournament_fee_sources WHERE rake_record_id='${id(121)}'`),'1');
  assert.equal(sql(`SELECT count(*) FROM accounting_owner_direct_fee_proofs WHERE rake_record_id='${id(121)}'`),'1');
  sql(fixture(22,'','2026-10-19T15:42:00Z').replaceAll(event,id(800)));
  assert.equal(sql(`SELECT smarter_private.owner_direct_fee_close_ready('${id(122)}')`),'f','incident label cannot admit a fee outside its exact time boundary');
  refuse(detectorMigration, 'fee_detector_source_preimage_changed');
  console.log(
    'PASS: fee detector real before/after, no writes, exact original shared plan, invalid evidence and contract, private ACL, unexpected errors visible, completion-only writer and replay refusal.'
  );
 const signatures=['smarter_private.owner_direct_fee_capture_plan(uuid)','smarter_private.owner_direct_fee_close_ready(uuid)','fn_ca_horse_fleet_metrics(integer)','fn_accounting_qualify_owner_direct_fee(uuid)','fn_accounting_owner_direct_fee_proof_valid(uuid)','fn_settle_tournament_rake(uuid,text)','fn_accounting_tournament_fee_net_plan(uuid)','fn_accounting_tournament_week_quality(uuid,timestamp with time zone,timestamp with time zone)'];
 console.log('POSTIMAGES '+JSON.stringify(JSON.parse(sql(`SELECT jsonb_object_agg(sig,md5(pg_get_functiondef(sig::regprocedure))) FROM unnest(ARRAY[${signatures.map(x=>"'"+x+"'").join(',')}]) sig`))));
 console.log('PASS: real PG17 baseline failure, original producer dependency, exact charge validation, immutable batches/proofs, canonical net plan, duplicate/concurrent requests, authorization, rollback of terminal refusal, replay refusal.');
}finally{if(running)run('pg_ctl',['-D',path.join(dir,'db'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
