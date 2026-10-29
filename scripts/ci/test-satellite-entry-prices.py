#!/usr/bin/env python3
"""Native PG qualification of value-ticket selection and atomic escrow use.
The unchanged gameplay/admission and journal-writer closures are explicit fixture
boundaries; provider financial qualification and live readback remain required.
"""
import os,json,re,subprocess,tempfile,shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
root=Path(__file__).resolve().parents[2]
binpath=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
if not (binpath/'initdb').exists():
 candidate=shutil.which('initdb')
 if not candidate: raise RuntimeError('PostgreSQL initdb is required')
 binpath=Path(candidate).parent
base=Path(tempfile.mkdtemp(prefix='satellite-price-',dir=os.environ['TMPDIR']))
data=base/'data';sock=base/'socket';sock.mkdir();log=base/'postgres.log'
port='56478'
def command(name,*args,**kw):
 result=subprocess.run([str(binpath/name),*args],text=True,capture_output=True,**kw)
 if result.returncode:raise RuntimeError(result.stderr+'\n'+result.stdout+(log.read_text() if name=='pg_ctl' and log.exists() else ''))
 return result
def sql(text):return command('psql','-X','-qAt','-h',str(sock),'-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1',input="SET test.actor='80000000-0000-4000-8000-000000000003';\n"+text).stdout.strip()
def check(statement):
 result=sql(statement)
 if result!='t':raise AssertionError(result)
try:
 command('initdb','-D',str(data),'-A','trust','--no-locale','-U','postgres')
 command('pg_ctl','-D',str(data),'-l',str(log),'-o',f'-k {sock} -p {port} -h 127.0.0.1','-w','start')
 sql("""
 CREATE TABLE clubs(id uuid PRIMARY KEY,asset text,is_platform boolean);
 CREATE TABLE tournament_schedules(id uuid PRIMARY KEY,club_id uuid,union_id uuid,name text,active boolean,config jsonb);
 CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,schedule_id uuid,name text,status text,format_contract text,started_at timestamptz,start_time timestamptz,buy_in_amount numeric,buy_in_fee numeric,satellite_target_id uuid,satellite_target uuid,min_players int,is_rebuy boolean,is_reentry boolean,add_on_available boolean,rebuy_cost numeric,addon_cost numeric,short_description text,entry_contract_locked boolean DEFAULT false);
 CREATE TABLE chip_ledger(tournament_id uuid,from_type text,to_type text,to_entity_id uuid,category text);
 CREATE TABLE tournament_players(tournament_id uuid);
 CREATE TABLE tournament_satellite_economic_snapshots(tournament_id uuid);
 INSERT INTO clubs VALUES('90000000-0000-4000-8000-000000000001','chips',true);
 INSERT INTO tournament_schedules VALUES
 ('90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001',NULL,'Nightly',true,'{"type":"mtt","buyIn":35}'),
 ('90000000-0000-4000-8000-000000000003','90000000-0000-4000-8000-000000000001',NULL,'Nightly Satellite 15',true,'{"type":"satellite","buyIn":15,"satelliteTargetName":"Nightly","isRebuy":true,"rebuyCost":15}');
 INSERT INTO tournaments(id,club_id,name,status,format_contract,start_time,buy_in_amount,buy_in_fee) VALUES('90000000-0000-4000-8000-000000000004','90000000-0000-4000-8000-000000000001','Nightly','REGISTERING','mtt-v2',now()+interval '3 hours',31.5,3.5);
 INSERT INTO tournaments(id,club_id,schedule_id,name,status,format_contract,start_time,buy_in_amount,buy_in_fee,satellite_target_id,is_rebuy,min_players) SELECT id,'90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000003','Nightly Satellite 15',status,'mtt-v2',now(),13.5,1.5,'90000000-0000-4000-8000-000000000004',true,4 FROM (VALUES
 ('90000000-0000-4000-8000-000000000005'::uuid,'REGISTERING'),
 ('90000000-0000-4000-8000-000000000006'::uuid,'REGISTERING'),
 ('90000000-0000-4000-8000-000000000007'::uuid,'RUNNING'),
 ('90000000-0000-4000-8000-000000000008'::uuid,'REGISTERING'))v(id,status);
 INSERT INTO tournament_players VALUES('90000000-0000-4000-8000-000000000006');
 INSERT INTO tournament_satellite_economic_snapshots VALUES('90000000-0000-4000-8000-000000000008');
 """)
 migration=next((root/'supabase/migrations').glob('*_satellite_schedules_fund_economical_target_tickets.sql'))
 sql(migration.read_text())
 check("SELECT config->>'buyIn'='5' AND name='Nightly Satellite 5' AND config->>'rebuyCost'='5' FROM tournament_schedules WHERE config->>'type'='satellite';")
 check("SELECT buy_in_amount=4.5 AND buy_in_fee=.5 AND min_players=8 AND rebuy_cost=5 AND name='Nightly Satellite 5' FROM tournaments WHERE id='90000000-0000-4000-8000-000000000005';")
 check("SELECT count(*)=3 FROM tournaments WHERE id IN ('90000000-0000-4000-8000-000000000006','90000000-0000-4000-8000-000000000007','90000000-0000-4000-8000-000000000008') AND buy_in_amount=13.5 AND buy_in_fee=1.5;")
 sql('DROP FUNCTION IF EXISTS pg_temp.satellite_entry_value(numeric,numeric);'+migration.read_text())
 check("SELECT count(*)=1 FROM tournaments WHERE name='Nightly Satellite 5' AND buy_in_amount=4.5;")
 print('PASS: schedule and empty feeder 15-to-35 becomes 5-to-35, funded minimum eight, rebuy price, purchased/running/frozen preservation and idempotence')
finally:
 if (data/'postmaster.pid').exists():command('pg_ctl','-D',str(data),'-m','immediate','-w','stop')
 shutil.rmtree(base)
