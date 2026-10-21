// Real PG17 historical installation guard; isolated original witnesses, no production writes.
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'../../..');
const parent=process.argv[2];if(!parent)throw Error('Pass owned scratch directory');
mkdirSync(parent,{recursive:true});const dir=mkdtempSync(path.join(parent,'storm-'));const socket=path.join(dir,'s');mkdirSync(socket);
const bin=process.env.PG_BIN||execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const run=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',maxBuffer:8e6});
const args=['-X','-At','-v','ON_ERROR_STOP=1','-h',socket,'-p','55479','-U','postgres','-d','postgres'];
const sql=q=>execFileSync(path.join(bin,'psql'),args,{input:q,encoding:'utf8',maxBuffer:8e6}).trim();
const migration=readFileSync(path.join(root,'supabase/migrations/20261020145408_resolved_financial_alert_storms_close_with_their_exact_membe.sql'),'utf8');
const block=migration.match(/DO \$historical\$([\s\S]*?)END \$historical\$;/)[0];
const historicalFunction=block.replace('DO $historical$', 'CREATE FUNCTION public.fixture_close_historical() RETURNS void LANGUAGE plpgsql AS $historical$');
let running=false;
try{
 run('initdb',['-D',path.join(dir,'db'),'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
 run('pg_ctl',['-D',path.join(dir,'db'),'-l',path.join(dir,'log'),'-o',`-k ${socket} -p 55479 -c listen_addresses=''`,'-w','start']);running=true;
 const schema=readFileSync(path.join(root,'scripts/ci/probes/production-alert-core/notification/inputs/schema.sql'),'utf8');
 for(const name of ['ca_drift_incidents','ca_incident_events','financial_alerts']){
  sql(schema.match(new RegExp('CREATE TABLE "public"\\."'+name+'"\\([\\s\\S]*?\\);'))[0]);
  sql(schema.split('\n').filter(x=>x.startsWith('ALTER TABLE "public"."'+name+'" ALTER COLUMN')&&x.includes(' SET DEFAULT ')).join('\n'));
 }
 sql(`ALTER TABLE ca_drift_incidents ADD COLUMN closure_basis text;
 CREATE TABLE tournaments(id uuid,status text);
 CREATE TABLE tournament_terminal_settlements(tournament_id uuid,completed_at timestamptz);
 CREATE TABLE tournament_escrow(tournament_id uuid,prize_balance numeric,bounty_balance numeric,fee_balance numeric,terminal_closed_at timestamptz);`);
 const ids=JSON.parse(readFileSync(path.join(root,'scripts/qualification/fixtures/tournament-finish-storm/historical-ids.json'),'utf8'));
 sql(`INSERT INTO ca_drift_incidents(id,source,dedupe_key,occurrences,last_seen_at) VALUES('d205bf24-b6ef-4969-9ec7-5e3c03b8b1ec','financial_alerts:Tournament.atomic_finish_refused','storm:financial_alerts:Tournament.atomic_finish_refused',966,'2026-10-19T21:03:59.928348Z');`);
 sql(ids.map(id=>`INSERT INTO ca_incident_events(incident_id,kind,detail) VALUES('d205bf24-b6ef-4969-9ec7-5e3c03b8b1ec','recurred',jsonb_build_object('capped_dedupe_key','fa:Tournament.atomic_finish_refused:${id}:00000000000000000000000000000000'));INSERT INTO tournaments VALUES('${id}','COMPLETED');INSERT INTO tournament_terminal_settlements VALUES('${id}',now());INSERT INTO tournament_escrow VALUES('${id}',0,0,0,now());`).join('\n'));
 sql(historicalFunction);
 sql('SELECT public.fixture_close_historical()');
 assert.equal(sql("SELECT status FROM ca_drift_incidents"),'resolved');
 // Independently captured production closure, never derived from the guard under test.
 const known=JSON.parse(readFileSync(path.join(root,'scripts/qualification/fixtures/tournament-finish-storm/known-closure.json'),'utf8'));
 const assignments=Object.entries(known).map(([key,value])=>key+"='"+value.replaceAll("'","''")+"'");
 sql("UPDATE ca_drift_incidents SET "+assignments.join(','));
 const preimage=readFileSync(path.join(root,'scripts/qualification/fixtures/tournament-finish-storm/historical-preimage.sql'),'utf8');
 assert.throws(()=>sql(preimage),/HISTORICAL_STORM_STATE_CHANGED/,'original guard refuses this same known closure');
 const before=sql('SELECT row_to_json(i)::text FROM ca_drift_incidents i');
 sql('SELECT public.fixture_close_historical()');
 assert.equal(sql('SELECT row_to_json(i)::text FROM ca_drift_incidents i'),before,'entire existing resolved row preserved');
 sql("UPDATE ca_drift_incidents SET resolution='unknown closure'");
 assert.throws(()=>sql('SELECT public.fixture_close_historical()'),/HISTORICAL_STORM_STATE_CHANGED/);
 sql("UPDATE ca_drift_incidents SET "+assignments.join(','));
 sql("UPDATE tournament_escrow SET fee_balance=1 WHERE tournament_id='"+ids[0]+"'");
 assert.throws(()=>sql('SELECT public.fixture_close_historical()'),/HISTORICAL_STORM_TERMINAL_PROOF_CHANGED/);
 // Execute the complete migration with the actual captured declaration helper.
 // The helper records the definition present when called, not a future DDL body.
 sql("UPDATE tournament_escrow SET fee_balance=0");
 sql(`CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
 CREATE TABLE ca_guard_defs(proname text PRIMARY KEY,def_hash text,declared_ref text,declared_at timestamptz,updated_at timestamptz);
 CREATE TABLE ca_guard_def_history(proname text,def_hash text,def_text text,UNIQUE(proname,def_hash));
 CREATE FUNCTION fn_ca_guard_watchlist() RETURNS text[] LANGUAGE sql AS $$SELECT ARRAY['fn_ca_raise_drift_incident']::text[]$$;`);
 sql(readFileSync(path.join(root,'scripts/qualification/fixtures/tournament-finish-storm/declare-guard.sql'),'utf8'));
 sql(readFileSync(path.join(root,'scripts/qualification/fixtures/tournament-finish-storm/preimages.sql'),'utf8'));
 const signature='fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)';
 sql(`REVOKE ALL ON FUNCTION fn_ca_alert_resolution_reaches_the_incident(),${signature} FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION fn_ca_alert_resolution_reaches_the_incident(),${signature} TO postgres,service_role;`);
 const declaration="SELECT public.fn_ca_declare_guard_redefinition('fn_ca_raise_drift_incident','migration 20261020145408_resolved_financial_alert_storms_close_with_their_exact_membe');";
 const lastDeclaration=migration.lastIndexOf(declaration);
 assert.ok(lastDeclaration>migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_raise_drift_incident'),'final declaration follows the installed definition');
 const refused=migration.slice(0,lastDeclaration)+migration.slice(lastDeclaration+declaration.length);
 assert.throws(()=>sql(refused),/STORM_GUARD_DECLARATION_CHANGED/,'pre-DDL declaration alone must refuse and roll back');
 assert.equal(sql("SELECT md5(pg_get_functiondef('"+signature+"'::regprocedure))"),'b5025fd1a0f856767f3a91166722ed7f','refused transaction preserves original source');
 const originalRow=sql('SELECT row_to_json(i)::text FROM ca_drift_incidents i');
 sql(migration);
 assert.equal(sql("SELECT def_hash FROM ca_guard_defs WHERE proname='fn_ca_raise_drift_incident'"),'0d59dc950cdc32ce9df9ac12b02b2c89');
 assert.equal(sql('SELECT row_to_json(i)::text FROM ca_drift_incidents i'),originalRow,'full installation preserves known closure');
 console.log('PASS complete exact migration with actual guard declaration: pre-DDL-only fails and rolls back; post-DDL baseline, private authority, source hashes and existing closure all pass');
 console.log('PASS actual PG17 exact historical block: original open closure, exact verified closure preserves entire row, unknown closure refused, unpaid original witness refused; immutable 966 IDs/hash unchanged');
}finally{
 if(running)run('pg_ctl',['-D',path.join(dir,'db'),'-m','immediate','-w','stop']);
 rmSync(dir,{recursive:true,force:true});
}
