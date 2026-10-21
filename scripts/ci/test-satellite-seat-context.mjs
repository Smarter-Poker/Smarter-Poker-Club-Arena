import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const parent=process.argv[2];if(!parent)throw Error('Pass owned SSD scratch');mkdirSync(parent,{recursive:true});
const dir=mkdtempSync(path.join(parent,'c-'));const socket=path.join(dir,'s');mkdirSync(socket);
const bin=process.env.PG_BIN||execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const run=(tool,args)=>execFileSync(path.join(bin,tool),args,{encoding:'utf8',maxBuffer:12000000});
const sql=q=>run('psql',['-X','-At','-v','ON_ERROR_STOP=1','-h',socket,'-p','55478','-U','postgres','-d','postgres','-c',q]).trim();
const pre=JSON.parse(readFileSync(path.join(root,'scripts/ci/fixtures/satellite-seat-context-preimages.json'),'utf8'));
const seat='fn_seat_late_registrant_before_maintenance_gate';
const id=n=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
let running=false;
try{
 run('initdb',['-D',path.join(dir,'db'),'-U','fixture_super','-A','trust','--no-locale','--encoding=UTF8']);
 run('pg_ctl',['-D',path.join(dir,'db'),'-l',path.join(dir,'log'),'-o',`-k ${socket} -p 55478 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10`,'-w','start']);running=true;
 run('psql',['-X','-v','ON_ERROR_STOP=1','-h',socket,'-p','55478','-U','fixture_super','-d','postgres','-c','CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE;GRANT ALL ON SCHEMA public TO postgres;']);
 sql(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE TABLE tournaments(id uuid PRIMARY KEY,status text,starting_chips int,club_id uuid);
 CREATE TABLE tournament_players(tournament_id uuid,user_id uuid,chips int,table_id uuid,seat_number int,status text);
 CREATE TABLE tables(id uuid PRIMARY KEY,tournament_id uuid,max_players int,status text,is_deleted boolean,created_at timestamptz,current_players int);
 CREATE TABLE table_seats(table_id uuid,user_id uuid,seat_number int,stack int,club_id uuid,left_at timestamptz,joined_at timestamptz,is_sitting_out boolean,is_away boolean);
 CREATE UNIQUE INDEX chairs ON table_seats(table_id,seat_number);
 CREATE TABLE ca_money_path_enforcement(only_row boolean,mode text);INSERT INTO ca_money_path_enforcement VALUES(true,'refuse');
 CREATE TABLE tournament_refund_authorizations(token uuid,tournament_id uuid,user_id uuid,amount_paid_now numeric);
 CREATE TABLE wallet_transactions(user_id uuid,amount numeric,category text,description text,related_entity_id uuid);
 CREATE FUNCTION fn_ensure_late_registration_capacity(uuid,integer) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"ok":false}'::jsonb$$;
 ${pre.map(x=>x.definition+';').join('\n')}
 REVOKE ALL ON FUNCTION ${seat}(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
 CREATE TRIGGER real_r3 BEFORE INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION fn_ca_money_path_log();
 CREATE FUNCTION assert_seat_context() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('app.money_path',true) IS DISTINCT FROM 'fn_seat_late_registrant' THEN RAISE EXCEPTION 'seat authority missing';END IF;
 IF current_setting('test.refuse_seat',true)='unique' THEN RAISE unique_violation;END IF;
 IF current_setting('test.refuse_seat',true)='true' THEN RAISE EXCEPTION 'seat fixture refusal';END IF;RETURN NEW;END$$;
 CREATE TRIGGER seat_context BEFORE INSERT OR UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION assert_seat_context();
 INSERT INTO tournaments VALUES('${id(1)}','RUNNING',1000,'${id(3)}');
 INSERT INTO tables VALUES('${id(2)}','${id(1)}',9,'running',false,now(),0);
 INSERT INTO tournament_players VALUES('${id(1)}','${id(4)}',0,NULL,NULL,'registered');`);
 assert.equal(sql('SELECT rolsuper FROM pg_roles WHERE rolname=current_user'),'f','managed installer is not a superuser');
 assert.equal(sql("SELECT current_setting('app.money_path',true) IS NULL"),'t','fresh installer connection has no custom GUC registered');
 let freshRefusal;try{sql(`ALTER FUNCTION ${seat}(uuid,uuid) SET app.money_path TO 'fn_seat_late_registrant'`);}catch(e){freshRefusal=String(e.stderr);}
 assert.ok(freshRefusal?.includes('permission denied to set parameter'), 'original bare ALTER refuses in a fresh non-superuser connection');
 const call=`SELECT ${seat}('${id(1)}','${id(4)}')`;
 const parentCall=`BEGIN;SET LOCAL app.money_path='fn_settle_satellite_tournament';${call};INSERT INTO wallet_transactions VALUES('${id(4)}',6,'prize','satellite remainder','${id(1)}');ROLLBACK;`;
 let before;try{sql(parentCall);}catch(e){before=String(e.stderr);}assert.ok(before?.includes('R3: a prize credit of 6')&&before.includes('money_path=fn_seat_late_registrant'),'actual leaked seat context refuses real satellite remainder before fix');
 assert.equal(sql('SELECT count(*) FROM table_seats'),'0','refused transaction leaves no chair');
 const migration=readFileSync(path.join(root,'supabase/migrations/20261021173509_late_seat_preserves_callers_money_path.sql'),'utf8');sql(migration);
 sql(parentCall);
 const absent=sql(`BEGIN;${call};SELECT NULLIF(current_setting('app.money_path',true),'') IS NULL;ROLLBACK;`);assert.ok(absent.split('\n').includes('t'),'absent caller remains semantically absent, never seat authority');
 assert.equal(sql('SELECT count(*) FROM table_seats'),'0');assert.equal(sql('SELECT count(*) FROM wallet_transactions'),'0');
 for(const caller of ['fn_settle_satellite_tournament','fn_settle_tournament_obligation','other_authority','']){
  const q=sql(`BEGIN;SELECT set_config('app.money_path','${caller}',true);${call};SELECT quote_nullable(current_setting('app.money_path',true));ROLLBACK;`);assert.ok(q.split('\n').includes("'"+caller+"'"),`success restores ${caller}`);
 }
 const early=sql(`BEGIN;SET LOCAL app.money_path='sentinel';SELECT ${seat}('${id(9)}','${id(4)}');SELECT current_setting('app.money_path');ROLLBACK;`);assert.ok(early.includes('not_running')&&early.includes('sentinel'));
 const full=sql(`BEGIN;SET LOCAL app.money_path='sentinel';DELETE FROM tables;${call};SELECT current_setting('app.money_path');ROLLBACK;`);assert.ok(full.includes('no_open_seat')&&full.includes('sentinel'));
 const race=sql(`BEGIN;SET LOCAL app.money_path='sentinel';SET LOCAL test.refuse_seat='unique';${call};SELECT current_setting('app.money_path');ROLLBACK;`);assert.ok(race.includes('seat_race')&&race.includes('sentinel'));
 const reused=sql(`BEGIN;SET LOCAL app.money_path='fn_seat_late_registrant';INSERT INTO table_seats(table_id,seat_number,left_at) VALUES('${id(2)}',1,now());SET LOCAL app.money_path='sentinel';${call};SELECT current_setting('app.money_path');ROLLBACK;`);assert.ok(reused.includes('"ok": true')&&reused.includes('sentinel'));
 const unavailable=sql(`BEGIN;SET LOCAL app.money_path='sentinel';SELECT ${seat}('${id(1)}','${id(9)}');SELECT current_setting('app.money_path');ROLLBACK;`);assert.ok(unavailable.includes('already_seated_or_missing')&&unavailable.includes('sentinel'));
 sql(`BEGIN;SET LOCAL app.money_path='sentinel';SET LOCAL test.refuse_seat='true';DO $x$ BEGIN BEGIN PERFORM ${seat}('${id(1)}','${id(4)}');EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'seat fixture refusal' THEN RAISE;END IF;END;IF current_setting('app.money_path')<>'sentinel' THEN RAISE EXCEPTION 'exception leaked context';END IF;END$x$;ROLLBACK;`);
 let blocked;try{sql(`INSERT INTO wallet_transactions VALUES('${id(4)}',6,'prize','unauthorized','${id(1)}')`);}catch(e){blocked=String(e.stderr);}assert.ok(blocked?.includes('R3:'),'unrelated unauthorized credits remain refused');
 assert.equal(sql("SELECT mode FROM ca_money_path_enforcement"),'refuse');
 console.log('PASS: actual seat function plus actual R3 trigger fail-before/pass-after; success, early returns, nested exception restore caller; refusal rolls all rows back; unrelated unauthorized prize remains refused.');
 assert.equal(sql(`SELECT proacl::text FROM pg_proc WHERE oid='${seat}(uuid,uuid)'::regprocedure`),'{postgres=X/postgres}');
 let replay;try{sql(migration);}catch(e){replay=String(e.stderr);}assert.ok(replay?.includes('late_seat_context_source_changed'));
 console.log('POSTIMAGE '+sql(`SELECT md5(pg_get_functiondef('${seat}(uuid,uuid)'::regprocedure))`));
}catch(e){console.error(readFileSync(path.join(dir,'log'),'utf8'));throw e;}finally{if(running)run('pg_ctl',['-D',path.join(dir,'db'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
