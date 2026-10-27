#!/usr/bin/env python3
import argparse,hashlib,json,os,shutil,socket,subprocess,tempfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--reader-composition',type=Path);ap.add_argument('--output',type=Path,required=True);reader_args=ap.parse_args()
P=Path(__file__).resolve().parent;D=P/'deferred-originals';O=reader_args.output.resolve();O.mkdir(parents=True,exist_ok=True);PG=Path(os.environ.get('PG_BIN',str(Path(shutil.which('psql')or'/opt/homebrew/opt/postgresql@17/bin/psql').parent)));base=Path(tempfile.mkdtemp(prefix='g-',dir=O));started=False;data=base/'d'
with socket.socket() as l:l.bind(('127.0.0.1',0));port=str(l.getsockname()[1])
env={k:v for k,v in os.environ.items()if not k.startswith('PG')};env['TMPDIR']=str(base)
def run(args,s=None,error=None):
 r=subprocess.run(list(map(str,args)),input=s,text=True,capture_output=True,env=env,timeout=90)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(s,error=None):return run([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],s,error)
def lit(s):return "'"+s.replace("'","''")+"'"
def load(table,rows):
 if rows:q('INSERT INTO public.'+table+' SELECT * FROM jsonb_populate_recordset(NULL::public.'+table+','+lit(json.dumps(rows))+'::jsonb)')
try:
 run([PG/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
 with(data/'postgresql.conf').open('a')as f:f.write("\nunix_socket_directories=''\n")
 run([PG/'pg_ctl','-D',data,'-l',base/'server.log','-o',f'-h 127.0.0.1 -p {port}','-w','start']);started=True
 q('CREATE SCHEMA smarter_private;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;')
 schema=json.loads((P/'original-witness-table-columns.json').read_text())
 for name,cols in schema.items():q('CREATE TABLE public.'+name+'('+','.join('"'+c['name']+'" '+c['type'] for c in cols)+')')
 raw=json.loads((P/'seven-original-flow-witnesses.json').read_text());other=json.loads((D/'seven-original-occupancies.json').read_text());entries=json.loads((D/'seven-treasury-original-receipts.json').read_text())
 for table,rows in [('union_pnl_original_flows',raw['original_flows']),('union_pnl_inventory_events',raw['original_events']),('union_pnl_transaction_frames',raw['frames']),('chip_ledger',other['cashout_ledgers']),('chip_transactions',other['journals']),('entry_purchase_idempotency_receipts',entries['entry_receipts'])]:load(table,rows)
 extra=json.loads((P/'addon-authorities.json').read_text());assert extra['moves'] is None
 for name,cols in extra['columns'].items():q('CREATE TABLE public.'+name+'('+','.join(chr(34)+c['name']+chr(34)+' '+c['type'] for c in cols)+')')
 load('wallet_transactions',raw['wallet_credits']);load('cash_participant_funding_receipts',entries['funding_receipts']);load('chip_ledger',extra['addon_ledgers'])
 q((P/'treasury-lineage-original.sql').read_text())
 q((P/'original-treasury-witnesses.sql').read_text())
 # Unchanged245 authority is isolated behind controlled source-family inputs;
 # the actual generation/cache owner bodies and actual treasury admissions run.
 q("""CREATE TABLE smarter_private.original_inventory_restoration_cases(event_id bigint,source_refs jsonb,family text,original_witness jsonb);
 CREATE TABLE smarter_private.original_inventory_restoration_certificates(event_id bigint,boundary timestamptz,witness_md5 text,proof_md5 text);
 INSERT INTO smarter_private.original_inventory_restoration_cases SELECT i,'[]','native_unchanged_family','{}' FROM generate_series(1,245)i;
 INSERT INTO smarter_private.original_inventory_restoration_certificates SELECT i,'2026-10-12 07:00:00Z','unchanged_witness','unchanged_proof' FROM generate_series(1,245)i;
 CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql AS 'SELECT true';
 CREATE FUNCTION public.fn_union_pnl_boundary(uuid,timestamptz)RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object()';
 CREATE FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_array()';
 CREATE FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object()';
 CREATE TABLE public.native_blocked_basis_cache(proof jsonb);
 CREATE FUNCTION public.fn_accounting_close_problem(text,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS 'SELECT proof FROM public.native_blocked_basis_cache';
 CREATE FUNCTION public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';""")
 q((P/'original_inventory_basis_generation.sql').read_text())
 cacheowner=next(r['body']for r in json.loads((P/'current-generation-cache-owners.json').read_text())if '.inventory_basis_cache_read('in r['signature']);q(cacheowner)
 g0=q('SELECT smarter_private.original_inventory_basis_generation()');assert g0.startswith('original-inventory-245-v1:')
 q('INSERT INTO native_blocked_basis_cache VALUES(jsonb_build_object(\'status\',\'blocked\',\'_original_inventory_generation\','+lit(g0)+'))')
 cachecall="SELECT smarter_private.inventory_basis_cache_read(%s,true,'pnl_flows','fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')"
 assert json.loads(q(cachecall%lit(g0)))['status']=='blocked'
 gifts=[r for r in other['cashout_ledgers']if r['category']=='horse_funding'];g=gifts[0];gid=lit(g['id'])+'::uuid';event=next(e for e in raw['original_events']if str(e['transaction_id'])==next(f['transaction_id']for f in raw['original_flows']if f['ledger_id']==g['id']))
 call='SELECT smarter_private.admit_original_treasury_gift('+gid+');';cases=[]
 def refused(name,change,error='original_treasury_gift'):
  q('BEGIN;'+change+';'+call,error);cases.append(name)
 refused('missing_seat_insert','DELETE FROM union_pnl_inventory_events WHERE event_id='+str(event['event_id']))
 refused('duplicate_seat_insert',"INSERT INTO union_pnl_inventory_events SELECT event_id+1000000000,source_name,row_id,observed_at,transaction_id,operation,before_row,after_row FROM union_pnl_inventory_events WHERE event_id="+str(event['event_id']))
 refused('wrong_ledger_amount','UPDATE chip_ledger SET amount=amount+.01 WHERE id='+gid)
 refused('wrong_asset',"UPDATE union_pnl_original_flows SET game_scope=jsonb_set(game_scope,'{asset}',to_jsonb('diamonds'::text)) WHERE ledger_id="+gid)
 refused('missing_entry',"DELETE FROM entry_purchase_idempotency_receipts WHERE idempotency_key="+lit(g['metadata']['op_id']),'query returned no rows')
 refused('uncompleted_entry',"UPDATE entry_purchase_idempotency_receipts SET completed_at=NULL WHERE idempotency_key="+lit(g['metadata']['op_id']))
 refused('wrong_request_user',"UPDATE entry_purchase_idempotency_receipts SET request=jsonb_set(request,'{user_id}',to_jsonb('00000000-0000-0000-0000-000000000001'::text)) WHERE idempotency_key="+lit(g['metadata']['op_id']))
 refused('missing_request_seat',"UPDATE entry_purchase_idempotency_receipts SET request=request-'seat_number' WHERE idempotency_key="+lit(g['metadata']['op_id']))
 refused('missing_journal',"DELETE FROM chip_transactions WHERE to_user_id="+lit(g['metadata']['user_id'])+'::uuid')
 refused('duplicate_journal',"INSERT INTO chip_transactions SELECT (jsonb_populate_record(NULL::chip_transactions,to_jsonb(j)||jsonb_build_object('id',gen_random_uuid()))).* FROM chip_transactions j WHERE to_user_id="+lit(g['metadata']['user_id'])+'::uuid')
 q('SET ROLE service_role;'+call,'permission denied');cases.append('untrusted_role_refused')
 before=q("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM chip_ledger t")
 from concurrent.futures import ThreadPoolExecutor
 with ThreadPoolExecutor(max_workers=4) as pool:
  concurrent=list(pool.map(lambda _:q(call),range(4)))
 assert len(set(concurrent))==1 and q("SELECT count(*) FROM smarter_private.original_treasury_funding_witnesses")=='1';cases.append('concurrent_duplicate_gift_one_witness')
 proofs=[]
 for g in gifts:
  x=json.loads(q('SELECT smarter_private.admit_original_treasury_gift('+lit(g['id'])+'::uuid)'));assert x['status']=='proven';assert x['sponsor_bank_club']==g['from_entity_id'];proofs.append(x)
 assert len(proofs)==4 and sum(x['amount']for x in proofs)==947
 g1=q('SELECT smarter_private.original_inventory_basis_generation()');assert g1!=g0 and q(cachecall%lit(g1))=='';cases.append('genuine_historical_gift_admission_changes_generation_and_actual_cache_owner_rejects_blocked_prior_cache')
 r0=next(r for r in other['cashout_ledgers']if r['category']=='table_cashout');rid=lit(r0['id'])+'::uuid';retcall='SELECT smarter_private.admit_original_treasury_return('+rid+');';re=next(e for e in raw['original_events']if e['after_row'] and e['after_row'].get('left_at')==r0['created_at'])
 def return_refused(name,change,error='original_treasury_return'):
  q('BEGIN;'+change+';'+retcall,error);cases.append(name)
 return_refused('return_missing_exit','DELETE FROM union_pnl_inventory_events WHERE event_id='+str(re['event_id']))
 return_refused('return_wrong_amount','UPDATE chip_ledger SET amount=amount+.01 WHERE id='+rid)
 return_refused('return_wrong_occupancy',"UPDATE union_pnl_inventory_events SET before_row=jsonb_set(before_row,'{occupancy_id}',to_jsonb(gen_random_uuid()::text)) WHERE event_id="+str(re['event_id']))
 return_refused('return_missing_wallet_credit','DELETE FROM wallet_transactions WHERE user_id='+lit(r0['to_entity_id'])+'::uuid')
 return_refused('return_duplicate_wallet_credit',"INSERT INTO wallet_transactions SELECT (jsonb_populate_record(NULL::wallet_transactions,to_jsonb(j)||jsonb_build_object('id',gen_random_uuid()))).* FROM wallet_transactions j WHERE user_id="+lit(r0['to_entity_id'])+'::uuid')
 return_refused('return_extra_funding_issue',"UPDATE cash_participant_funding_receipts SET funding_club_id=gen_random_uuid() WHERE user_id="+lit('1c1c117c-bf60-4282-810c-0658f2528e11')+'::uuid','original_treasury_return') if r0['to_entity_id']=='1c1c117c-bf60-4282-810c-0658f2528e11' else None
 addonret=next(r for r in other['cashout_ledgers']if r['to_entity_id']=='1c1c117c-bf60-4282-810c-0658f2528e11' and r['category']=='table_cashout')
 q("BEGIN;UPDATE cash_participant_funding_receipts SET funding_club_id=gen_random_uuid() WHERE user_id='1c1c117c-bf60-4282-810c-0658f2528e11';SELECT smarter_private.admit_original_treasury_return("+lit(addonret['id'])+"::uuid);",'original_treasury_return');cases.append('return_extra_funding_issue_refused')
 with ThreadPoolExecutor(max_workers=4) as pool:
  concurrent=list(pool.map(lambda _:q(retcall),range(4)))
 assert len(set(concurrent))==1;cases.append('concurrent_duplicate_return_one_witness')
 returns=[]
 for r in other['cashout_ledgers']:
  if r['category']=='table_cashout':returns.append(json.loads(q('SELECT smarter_private.admit_original_treasury_return('+lit(r['id'])+'::uuid)')))
 assert len(returns)==3 and all(r['status']=='proven'for r in returns)
 assert round(sum(r['amount']for r in returns),2)==2661.33
 assert before==q("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM chip_ledger t")
 assert q('SELECT count(*) FROM smarter_private.original_treasury_funding_witnesses')=='7'
 for g in gifts:assert json.loads(q('SELECT smarter_private.admit_original_treasury_gift('+lit(g['id'])+'::uuid)'))['status']=='proven'
 assert q('SELECT count(*) FROM smarter_private.original_treasury_funding_witnesses')=='7';cases.append('replay_zero_new_admissions')
 q('UPDATE smarter_private.original_treasury_funding_witnesses SET admitted_at=clock_timestamp()','original_treasury_witness_is_immutable');q('DELETE FROM smarter_private.original_treasury_funding_witnesses','original_treasury_witness_is_immutable');q('TRUNCATE smarter_private.original_treasury_funding_witnesses','original_treasury_witness_is_immutable');cases.append('immutable_update_delete_truncate')
 got=json.loads(q("BEGIN;DELETE FROM union_pnl_inventory_events;DELETE FROM union_pnl_original_flows;DELETE FROM union_pnl_transaction_frames;SELECT jsonb_agg(CASE kind WHEN 'gift' THEN smarter_private.original_treasury_gift_evidence(ledger_id) ELSE smarter_private.original_treasury_return_evidence(ledger_id) END)FROM smarter_private.original_treasury_funding_witnesses;ROLLBACK;"));assert len(got)==7 and all(x and x['status']=='proven'for x in got);cases.append('original_volatile_inventory_retirement_keeps_accepted_witness')
 hands=json.loads((P/'78-financial-only.json').read_text())
 for name,cols in hands['columns'].items():q('CREATE TABLE public.'+name+'('+','.join('"'+c['name']+'" '+c['type'] for c in cols)+')')
 moves={m['move_id']:m for p in hands['provenance']for u in p['participants']for m in u.get('funding_lineage',{}).get('moves',[])};load('cash_seat_move_receipts',list(moves.values()))
 load('cash_hand_provenance_receipts',hands['provenance']);load('cash_hand_participant_manifests',hands['manifests']);load('cash_funding_application_receipts',hands['funding_applications'])
 existing={r['id']for r in entries['funding_receipts']};load('cash_participant_funding_receipts',[r for r in hands['funding_receipts']if r['id']not in existing]);existing={r['id']for r in other['cashout_ledgers']+extra['addon_ledgers']};load('chip_ledger',[r for r in hands['funding_ledgers']if r['id']not in existing])
 q((P/'fn_pnl_evidence_cents.sql').read_text())
 q('CREATE TABLE public.native_trusted_financial_requests AS SELECT table_id,hand_number,payload_hash,accepted_request FROM cash_hand_provenance_receipts;')
 q("""CREATE FUNCTION smarter_private.posthand_escrow_certified_evidence(uuid,bigint)RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
 CREATE FUNCTION smarter_private.horse_cash_retained_request_matches(t uuid,n bigint,h text,r jsonb)RETURNS boolean LANGUAGE sql AS 'SELECT EXISTS(SELECT FROM public.native_trusted_financial_requests p WHERE p.table_id=t AND p.hand_number=n AND p.payload_hash=h AND p.accepted_request=r)';
 CREATE FUNCTION smarter_private.horse_cash_retained_atomic_matches(uuid,bigint,jsonb,jsonb,jsonb)RETURNS boolean LANGUAGE sql AS 'SELECT $3=$4';
 CREATE FUNCTION smarter_private.horse_settlement_original_result(uuid,uuid,jsonb)RETURNS jsonb LANGUAGE sql AS 'SELECT $3';""")
 q((P/'treasury-hand-original.sql').read_text().replace('FUNCTION public.fn_pnl_cash_hand_evidence(', 'FUNCTION public.native_before_hand_evidence('))
 q((P/'fn_pnl_cash_hand_evidence.sql').read_text())
 before=q("SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY hand_number)::text) FROM cash_hand_provenance_receipts p")
 old=json.loads(q("SELECT jsonb_agg(public.native_before_hand_evidence(table_id,hand_number)ORDER BY hand_number) FROM cash_hand_provenance_receipts"))
 new=json.loads(q("SELECT jsonb_agg(public.fn_pnl_cash_hand_evidence(table_id,hand_number)ORDER BY hand_number) FROM cash_hand_provenance_receipts"))
 (O/'native-78-verdicts.json').write_text(json.dumps({'before':old,'after':new},indent=2)+'\n')
 assert len(old)==len(new)==78
 assert all(r['status']=='blocked'for r in old)
 assert all(r['status']=='ready' and r['basis_certified'] and r['all_players_included']for r in new),[(r.get('hand_number'),r.get('issues'),r.get('reason'))for r in new if r['status']!='ready']
 assert before==q("SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY hand_number)::text) FROM cash_hand_provenance_receipts p")
 cases.append('78_actual_financial_projection_original_blocks_new_ready_preserving_provenance')
 first=hands['provenance'][0];hg=next(g for g in gifts if g['metadata']['user_id']==first['participants'][0]['user_id']);tn=first['hand_number'];table=first['table_id'];where="table_id="+lit(table)+"::uuid AND hand_number="+str(tn)
 def hand_refused(name,change):
  r=json.loads(q('BEGIN;'+change+';SELECT fn_pnl_cash_hand_evidence('+lit(table)+'::uuid,'+str(tn)+');ROLLBACK;'));assert r['status']=='blocked',(name,r);cases.append(name)
 hand_refused('hand_extra_issue_remains_blocked',"UPDATE cash_hand_provenance_receipts SET issues=issues||jsonb_build_array('unrelated_defect')WHERE "+where+";UPDATE cash_hand_participant_manifests SET issues=issues||jsonb_build_array('unrelated_defect')WHERE table_id="+lit(table)+"::uuid AND hand_number="+str(tn))
 hand_refused('hand_missing_gift_entry_refused',"DELETE FROM entry_purchase_idempotency_receipts WHERE idempotency_key="+lit(hg['metadata']['op_id']))
 hand_refused('hand_wrong_participant_occupancy_refused',"UPDATE cash_hand_provenance_receipts SET participants=jsonb_set(participants,'{0,occupancy_id}',to_jsonb(gen_random_uuid()::text))WHERE "+where)
 hand_refused('hand_corrupted_accepted_hash_refused',"UPDATE cash_hand_provenance_receipts SET payload_hash='not-original'WHERE "+where)
 hand_refused('hand_wrong_bank_original_refused',"UPDATE chip_ledger SET from_entity_id=gen_random_uuid()WHERE id="+lit(hg['id'])+'::uuid')
 giftusers={g['metadata']['user_id']for g in gifts};ordinary=[u for u in first['participants']if u['user_id']not in giftusers];assert len(ordinary)>=2
 ordinary=ordinary[:2]
 for u in ordinary:u['stack_after']=u['stack_before'];u['poker_delta']=0
 stacks=[dict(r,stack=r['stack_before'])for r in first['accepted_request']['stacks']if r['user_id']in{u['user_id']for u in ordinary}]
 req=dict(first['accepted_request'],stacks=stacks,rake=0,bbj=0,inflow=0);at=dict(first['atomic_receipt']);sr=dict(at['stack_result'],request=req);at['stack_result']=sr;claim=dict(first['stack_claim'],result=sr)
 updates={'participants':ordinary,'accepted_request':req,'atomic_receipt':at,'stack_claim':claim,'issues':[]}
 change='UPDATE cash_hand_provenance_receipts SET '+','.join(k+'='+lit(json.dumps(v))+'::jsonb'for k,v in updates.items())+",status='captured',funding_provenance_complete=true,rake=0,bbj=0,signed_external_net=0 WHERE "+where
 manifest=[{k:v for k,v in u.items()if k not in('stack_after','poker_delta')}for u in ordinary]
 change+=';UPDATE cash_hand_participant_manifests SET participants='+lit(json.dumps(manifest))+"::jsonb,issues='[]',funding_provenance_complete=true WHERE id="+lit(first['manifest_id'])+'::uuid'
 change+=';UPDATE native_trusted_financial_requests SET accepted_request='+lit(json.dumps(req))+'::jsonb WHERE '+where
 normal=json.loads(q('BEGIN;'+change+';SELECT jsonb_build_array(native_before_hand_evidence('+lit(table)+'::uuid,'+str(tn)+'),fn_pnl_cash_hand_evidence('+lit(table)+'::uuid,'+str(tn)+'));ROLLBACK;'))
 assert normal[0]['status']=='ready' and normal[0]==normal[1],normal;cases.append('whole_original_ordinary_buyin_reader_byte_equal')
 q("ALTER TABLE cash_participant_funding_receipts ALTER COLUMN id SET DEFAULT gen_random_uuid(),ALTER COLUMN recorded_at SET DEFAULT current_setting('native.original_time')::timestamptz,ALTER COLUMN unit_scale SET DEFAULT 2,ALTER COLUMN transaction_id SET DEFAULT pg_current_xact_id();")
 load('table_seats',[e['after_row']for e in raw['original_events']if e['operation']=='INSERT'])
 clubs={g['earning_club']for g in proofs}|{g['sponsor_bank_club']for g in proofs};load('clubs',[{'id':c,'asset':'chips','union_id':'fade0000-0000-0000-0000-000000000001'}for c in clubs])
 q((D/'current-cash-record-original-funding.sql').read_text().replace('FUNCTION public.fn_cash_record_original_funding(', 'FUNCTION public.native_before_record_funding('))
 q((P/'fn_cash_record_original_funding.sql').read_text())
 q((P/'fn_cash_original_funding_lineage.sql').read_text())
 for gift in proofs:
  args="'horse_funding',"+lit(gift['operation_key'])+','+lit(gift['user_id'])+'::uuid,'+lit(gift['table_id'])+'::uuid,'+lit(gift['ledger_id'])+'::uuid,NULL,'+lit(gift['earning_club'])+'::uuid,'+str(gift['amount'])+','+str(gift['bank_balance_after'])+',NULL'
  q('SELECT native_before_record_funding('+args+')','Original cash funding debit identity mismatch')
  prefix='BEGIN;SET LOCAL native.original_time='+lit(gift['seat_joined_at'])+';'
  qualified=json.loads(q(prefix+'SELECT jsonb_build_object(\'initial\',smarter_private.cash_initial_funding_receipt(fn_cash_record_original_funding('+args+')));ROLLBACK;'));assert qualified['initial']is True
  wrong=args.replace(lit(gift['earning_club'])+'::uuid',lit(gift['sponsor_bank_club'])+'::uuid')
  q(prefix+'SELECT fn_cash_record_original_funding('+wrong+');ROLLBACK;','Original treasury seat gift proof required')
 cases.append('actual_original_recorder_four_sponsor_recipient_separated_old_refuses_new_accepts')
 assert q("SELECT bool_and(NOT smarter_private.cash_initial_funding_receipt(id)) FROM cash_participant_funding_receipts WHERE operation_kind='addon'")=='t'
 cases.append('ordinary_addons_remain_noninitial')
 # The actual unchanged financial core and actual entry claim/record owners run;
 # authorization, rejoin-floor/session and original event-capture environment
 # are controlled native boundaries, not production qualification of triggers.
 q("""CREATE SCHEMA auth;CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
 CREATE FUNCTION fn_actor_can_manage_club_treasury(uuid)RETURNS boolean LANGUAGE sql AS 'SELECT true';
 CREATE FUNCTION fn_cash_rejoin_floor(uuid,uuid)RETURNS numeric LANGUAGE sql AS 'SELECT NULL::numeric';
 CREATE FUNCTION fn_cash_session_open(uuid,uuid,numeric)RETURNS void LANGUAGE plpgsql AS 'BEGIN RETURN;END';
 CREATE FUNCTION fn_entry_purchases_frozen()RETURNS boolean LANGUAGE sql AS 'SELECT false';
 CREATE FUNCTION fn_assert_cash_chip_purchase_table(uuid)RETURNS void LANGUAGE plpgsql AS 'BEGIN RETURN;END';
 ALTER TABLE table_seats ALTER COLUMN id SET DEFAULT gen_random_uuid(),ALTER COLUMN occupancy_id SET DEFAULT gen_random_uuid(),ALTER COLUMN joined_at SET DEFAULT now();
 CREATE UNIQUE INDEX native_active_seat_once ON table_seats(table_id,seat_number)WHERE left_at IS NULL;
 ALTER TABLE chip_ledger ALTER COLUMN id SET DEFAULT gen_random_uuid(),ALTER COLUMN status SET DEFAULT 'posted',ALTER COLUMN created_at SET DEFAULT now();
 CREATE UNIQUE INDEX native_ledger_key_once ON chip_ledger(idempotency_key);
 ALTER TABLE entry_purchase_idempotency_receipts ALTER COLUMN claimed_at SET DEFAULT now();
 CREATE UNIQUE INDEX native_entry_key_once ON entry_purchase_idempotency_receipts(key_domain,idempotency_key);
 ALTER TABLE cash_participant_funding_receipts ALTER COLUMN recorded_at SET DEFAULT now();
 CREATE TABLE native_beneficiaries(user_id uuid PRIMARY KEY,club_id uuid);
 CREATE SEQUENCE native_event_id START 9000000000;
 CREATE FUNCTION native_seat_witness_capture()RETURNS trigger LANGUAGE plpgsql SET timezone='UTC' AS $$
 BEGIN
  SELECT club_id INTO STRICT NEW.club_id FROM native_beneficiaries WHERE user_id=NEW.user_id;
  INSERT INTO union_pnl_inventory_events(event_id,source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)
  VALUES(nextval('native_event_id'),'table_seats',NEW.id,clock_timestamp(),pg_current_xact_id(),'INSERT',NULL,
   jsonb_build_object('id',NEW.id,'occupancy_id',NEW.occupancy_id,'joined_at',NEW.joined_at,'left_at',NEW.left_at,'user_id',NEW.user_id,'table_id',NEW.table_id,'club_id',NEW.club_id,'stack',NEW.stack));
  RETURN NEW;
 END $$;
 CREATE TRIGGER native_seat_witness BEFORE INSERT ON table_seats FOR EACH ROW EXECUTE FUNCTION native_seat_witness_capture();
 CREATE UNIQUE INDEX native_frame_once ON union_pnl_transaction_frames(transaction_id);
 CREATE FUNCTION native_original_ledger_capture()RETURNS trigger LANGUAGE plpgsql SET timezone='UTC' AS $$
 DECLARE stamp timestamptz;
 BEGIN
  INSERT INTO union_pnl_transaction_frames(transaction_id,observed_at,book_start)VALUES(pg_current_xact_id(),clock_timestamp(),transaction_timestamp())ON CONFLICT(transaction_id)DO NOTHING;
  SELECT observed_at INTO STRICT stamp FROM union_pnl_transaction_frames WHERE transaction_id=pg_current_xact_id();
  INSERT INTO union_pnl_original_flows(ledger_id,transaction_id,recognized_at,game_scope,ledger_snapshot)
  VALUES(NEW.id,pg_current_xact_id(),stamp,jsonb_build_object('asset',COALESCE(NULLIF(current_setting('native.asset',true),''),'chips'),'unit_scale',2,'tournament_id',NULL,'host_club_id',NEW.club_id,'game_union_id',NEW.club_id,'is_private',false),to_jsonb(NEW));
  RETURN NEW;
 END $$;
 CREATE TRIGGER native_original_ledger AFTER INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION native_original_ledger_capture();""")
 for owner in json.loads((P/'entry-receipt-owners.json').read_text()):q(owner['definition'])
 q((P/'fn_release_entry_purchase_claim.sql').read_text())
 q((P/'original-horse-seat-money-core.sql').read_text())
 q((P/'fn_horse_seat_from_treasury.sql').read_text())
 tid='11111111-0000-0000-0000-000000000001';uid='22222222-0000-0000-0000-000000000001';op='33333333-0000-0000-0000-000000000001';bank='fade0000-0000-0000-0000-000000000001';benefit='a0000000-0000-0000-0000-000000000001'
 load('tables',[{'id':tid,'club_id':bank,'min_buy_in':100,'max_buy_in':1000}]);load('native_beneficiaries',[{'user_id':uid,'club_id':benefit}]);q('UPDATE clubs SET chip_treasury=10000 WHERE id='+lit(bank)+'::uuid')
 generation_before_live=q('SELECT smarter_private.original_inventory_basis_generation()')
 initialmoney=q('SELECT chip_treasury FROM clubs WHERE id='+lit(bank)+'::uuid')
 producer='SELECT fn_horse_seat_from_treasury('+lit(tid)+'::uuid,'+lit(uid)+'::uuid,1,200,'+lit(op)+'::uuid)'
 with ThreadPoolExecutor(max_workers=4)as pool:responses=list(pool.map(lambda _:json.loads(q(producer)),range(4)))
 assert all(r==responses[0]for r in responses)
 first=responses[0];second=json.loads(q(producer));assert first==second and first['success'] and first['treasury_after']==9800
 assert float(q('SELECT chip_treasury FROM clubs WHERE id='+lit(bank)+'::uuid'))==9800
 final=json.loads(q("SELECT jsonb_build_object('debits',(SELECT count(*)FROM chip_ledger WHERE table_id="+lit(tid)+"::uuid),'gifts',(SELECT count(*)FROM smarter_private.original_treasury_funding_witnesses WHERE source#>>'{ledger,table_id}'="+lit(tid)+"),'funding',(SELECT count(*)FROM cash_participant_funding_receipts WHERE table_id="+lit(tid)+"::uuid),'initial',(SELECT bool_and(smarter_private.cash_initial_funding_receipt(id))FROM cash_participant_funding_receipts WHERE table_id="+lit(tid)+"::uuid),'beneficiary',(SELECT bool_and(funding_club_id="+lit(benefit)+"::uuid AND account_entity_id="+lit(bank)+"::uuid)FROM cash_participant_funding_receipts WHERE table_id="+lit(tid)+"::uuid))"));assert final=={'debits':1,'gifts':1,'funding':1,'initial':True,'beneficiary':True},final
 cases.append('actual_producer_and_money_core_concurrent_replay_one_debit_one_initial_recipient_receipt')
 uid2='22222222-0000-0000-0000-000000000002';op2='33333333-0000-0000-0000-000000000002';load('native_beneficiaries',[{'user_id':uid2,'club_id':benefit}])
 producer2=producer.replace(lit(uid),lit(uid2)).replace(lit(op),lit(op2)).replace('::uuid,1,200,','::uuid,2,200,')
 q("BEGIN;SET LOCAL native.asset='diamonds';"+producer2+';ROLLBACK;','original_treasury_gift_proof_refused')
 assert float(q('SELECT chip_treasury FROM clubs WHERE id='+lit(bank)+'::uuid'))==9800
 assert q('SELECT count(*) FROM table_seats WHERE user_id='+lit(uid2)+'::uuid')=='0'
 assert q('SELECT count(*) FROM entry_purchase_idempotency_receipts WHERE idempotency_key='+lit(op2))=='0'
 assert json.loads(q(producer2))['treasury_after']==9600
 cases.append('failed_original_witness_rolls_back_bank_seat_ledger_entry_then_samekey_retry_once')
 uid3='22222222-0000-0000-0000-000000000003';load('native_beneficiaries',[{'user_id':uid3,'club_id':benefit}]);unkeyed=producer.replace(lit(uid),lit(uid3)).replace(lit(op)+'::uuid','NULL::uuid').replace('::uuid,1,200,','::uuid,3,200,');assert json.loads(q(unkeyed))['treasury_after']==9400;cases.append('unkeyed_original_admission_gets_internal_atomic_original_key')
 assert q('SELECT smarter_private.original_inventory_basis_generation()')==generation_before_live
 assert q("SELECT count(*) FROM smarter_private.original_treasury_historical_admissions")=='7'
 assert q("SELECT count(*) FROM smarter_private.original_treasury_funding_witnesses WHERE NOT historical_late")=='3';cases.append('future_atomic_live_gifts_do_not_invalidate_closed_book_generation')
 for t in ['original_treasury_funding_cutover','original_treasury_historical_admissions']:
  q('DELETE FROM smarter_private.'+t,'original_treasury_witness_is_immutable');q('TRUNCATE smarter_private.'+t,'original_treasury_witness_is_immutable')
 cases.append('current_cutover_and_finite_historical_admission_journal_immutable')
 q('BEGIN;CREATE FUNCTION pg_temp.native_readonly_probe()RETURNS boolean LANGUAGE sql AS '+lit('SELECT true')+';SET LOCAL transaction_read_only=on;SELECT pg_temp.native_readonly_probe();ROLLBACK;');cases.append('temp_function_before_readonly_mode_same_rollback_transaction_route')
 for name,cols in json.loads((P/'future-consumer-columns.json').read_text()).items():q('CREATE TABLE '+name+'('+','.join('"'+c['name']+'" '+c['type']for c in cols)+')')
 q("CREATE FUNCTION fn_caller_is_engine()RETURNS boolean LANGUAGE sql AS 'SELECT true';CREATE FUNCTION fn_engine_lease_stale_seconds()RETURNS integer LANGUAGE sql AS 'SELECT 60';")
 oldearning=json.loads((P/'treasury-source-metadata.json').read_text())['earning'][0]['definition'];q(oldearning.replace('FUNCTION public.fn_cash_earning_club(', 'FUNCTION public.native_before_earning_club('));q((P/'fn_cash_earning_club.sql').read_text())
 q((P/'fn_ca_cash_seat_club.sql').read_text().replace('FUNCTION public.fn_ca_cash_seat_club(', 'FUNCTION public.native_before_seat_club('));q((P/'fn_ca_cash_seat_club-candidate.sql').read_text())
 hh='44444444-0000-0000-0000-000000000001';cluster='55555555-0000-0000-0000-000000000001';cash='66666666-0000-0000-0000-000000000001';pool='77777777-0000-0000-0000-000000000001';slot='88888888-0000-0000-0000-000000000001';lh='99999999-0000-0000-0000-000000000001'
 seat=json.loads(q('SELECT to_jsonb(s)FROM table_seats s WHERE user_id='+lit(uid)+'::uuid'))
 start=q('SELECT clock_timestamp()');load('hand_history',[{'id':hh,'table_id':tid,'started_at':start}]);earg=','.join(lit(i)+'::uuid'for i in(hh,tid,uid,bank,bank))
 assert q('SELECT native_before_earning_club('+earg+')')==q('SELECT fn_cash_earning_club('+earg+')')==benefit;cases.append('whole_classic_earning_original_recipient_unchanged')
 load('lightning_hand',[{'hand_id':lh,'cluster_id':cluster,'cluster_epoch':1,'formed_at':start,'host_table_id':tid,'hand_history_id':hh}]);load('cash_player_session',[{'id':cash,'player_id':uid,'club_id':bank,'table_id':tid,'opened_at':seat['joined_at'],'cluster_id':cluster}]);load('lightning_pool_session',[{'id':pool,'cluster_id':cluster,'cluster_epoch':1,'player_id':uid,'cash_player_session_id':cash,'entered_at':seat['joined_at'],'anchor_seat_id':seat['id']}]);load('lightning_pool_slot',[{'id':slot,'pool_session_id':pool,'cluster_id':cluster,'cluster_epoch':1,'player_id':uid,'opened_at':seat['joined_at']}]);load('lightning_hand_player',[{'hand_id':lh,'player_id':uid,'pool_slot_id':slot,'cluster_id':cluster,'cluster_epoch':1}])
 detached=json.loads(q('BEGIN;DELETE FROM table_seats WHERE id='+lit(seat['id'])+'::uuid;SELECT jsonb_build_object(\'old\',native_before_earning_club('+earg+'),\'new\',fn_cash_earning_club('+earg+'),\'old_seat\',native_before_seat_club('+lit(tid)+'::uuid,'+lit(uid)+'::uuid),\'new_seat\',fn_ca_cash_seat_club('+lit(tid)+'::uuid,'+lit(uid)+'::uuid));ROLLBACK;'));assert detached=={'old':bank,'new':benefit,'old_seat':None,'new_seat':benefit},detached;cases.append('actual_lightning_gone_anchor_original_gift_recipient_never_sponsor')
 q((P/'fn_cash_capture_hand_manifest.sql').read_text().replace('FUNCTION public.fn_cash_capture_hand_manifest(', 'FUNCTION public.native_before_capture_manifest('));q((P/'fn_cash_capture_hand_manifest-candidate.sql').read_text());q("ALTER TABLE cash_hand_participant_manifests ALTER COLUMN id SET DEFAULT gen_random_uuid(),ALTER COLUMN captured_at SET DEFAULT clock_timestamp();UPDATE tables SET union_id="+lit(bank)+"::uuid,is_private=false WHERE id="+lit(tid)+'::uuid')
 lease='aaaaaaaa-0000-0000-0000-000000000001';load('engine_table_leases',[{'table_id':tid,'instance_id':'native-engine','lease_generation':lease,'protocol_version':2,'heartbeat_at':q('SELECT clock_timestamp()')}])
 roster=json.loads(q("SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'occupancy_id',occupancy_id,'seat_joined_at',joined_at,'is_horse',true,'stack_before',stack))FROM table_seats WHERE table_id="+lit(tid)+'::uuid AND user_id IN('+lit(uid)+'::uuid,'+lit(uid2)+'::uuid)'))
 margs=lit(tid)+'::uuid,90000001,'+lit(json.dumps(roster))+"::jsonb,'native-engine',"+lit(lease)+'::uuid'
 oldm=json.loads(q('BEGIN;SELECT native_before_capture_manifest('+margs+');ROLLBACK;'));newm=json.loads(q('SELECT fn_cash_capture_hand_manifest('+margs+')'));assert oldm['funding_provenance_complete']is False and newm['funding_provenance_complete']is True and newm['issues']==[],(oldm,newm)
 assert json.loads(q('SELECT fn_cash_capture_hand_manifest('+margs+')'))==newm;cases.append('actual_new_hand_manifest_original_gift_initial_complete_replay')
 q("""CREATE TABLE native_boundary_inventory(proof jsonb);
 CREATE FUNCTION public.fn_union_pnl_inventory_as_of_admitted(timestamptz)RETURNS jsonb LANGUAGE sql AS 'SELECT proof FROM native_boundary_inventory';
 CREATE FUNCTION public.fn_union_pnl_projection_ready(text)RETURNS boolean LANGUAGE sql AS 'SELECT true';
 CREATE FUNCTION smarter_private.original_erased_cash_receivables(uuid,timestamptz)RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object(''status'',''ready'',''holdings'',jsonb_build_array())';""")
 q("INSERT INTO native_boundary_inventory SELECT jsonb_build_object('status','observed','population',jsonb_build_object('table_seats',(SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(s)))FROM table_seats s WHERE table_id="+lit(tid)+"::uuid),'tables',(SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t)))FROM tables t WHERE id="+lit(tid)+"::uuid),'tournaments',jsonb_build_array(),'tournament_players',jsonb_build_array()))")
 oldboundary=next(r['definition']for r in json.loads((P/'treasury-all-consumer-definitions.json').read_text())if r['signature'].startswith('fn_union_pnl_boundary('));q(oldboundary.replace('FUNCTION public.fn_union_pnl_boundary(', 'FUNCTION public.native_before_boundary('));q((P/'fn_union_pnl_boundary.sql').read_text())
 boundary=json.loads(q('SELECT jsonb_build_array(native_before_boundary('+lit(bank)+'::uuid,clock_timestamp()),fn_union_pnl_boundary('+lit(bank)+'::uuid,clock_timestamp()))'));assert boundary[0]['status']=='blocked' and boundary[1]['status']=='ready' and len(boundary[1]['holdings'])==3 and all(h['club_id']==benefit for h in boundary[1]['holdings']),boundary;cases.append('whole_original_boundary_future_gift_holdings_recipient_not_bank')
 cols=json.loads((P/'outcome-columns.json').read_text());q('CREATE TABLE union_pnl_cash_outcomes('+','.join('"'+c['name']+'" '+c['type']for c in cols)+')');load('union_pnl_cash_outcomes',json.loads((P/'78-original-outcomes.json').read_text()))
 q((P/'original-treasury-cash-outcome.sql').read_text())
 outdigest=q('SELECT md5(jsonb_agg(to_jsonb(o)ORDER BY hand_number)::text)FROM union_pnl_cash_outcomes o')
 effective=json.loads(q('SELECT jsonb_agg(smarter_private.original_treasury_cash_outcome_evidence(to_jsonb(o))ORDER BY hand_number)FROM union_pnl_cash_outcomes o'))
 (O/'native-78-effective-outcomes.json').write_text(json.dumps(effective,indent=2)+'\n')
 assert len(effective)==78 and all(e and e['status']=='ready' and e['basis_certified']for e in effective),[(i,e)for i,e in enumerate(effective)if not e or e.get('status')!='ready']
 assert outdigest==q('SELECT md5(jsonb_agg(to_jsonb(o)ORDER BY hand_number)::text)FROM union_pnl_cash_outcomes o');cases.append('78_original_frozen_outcomes_pure_reproof_ready_no_history_mutation')
 for name,change in [('effective_outcome_extra_issue_refused',"UPDATE union_pnl_cash_outcomes SET evidence=jsonb_set(evidence,'{issues}',evidence->'issues'||jsonb_build_array('unrelated'))WHERE hand_number="+str(tn)),('effective_outcome_wrong_rake_refused',"UPDATE union_pnl_cash_outcomes SET evidence=jsonb_set(evidence,'{accepted_rake}',to_jsonb(.01+(evidence->>'accepted_rake')::numeric))WHERE hand_number="+str(tn)),('effective_outcome_foreign_payload_refused',"UPDATE union_pnl_cash_outcomes SET payload_hash='not-original'WHERE hand_number="+str(tn))]:
  r=q('BEGIN;'+change+';SELECT smarter_private.original_treasury_cash_outcome_evidence(to_jsonb(o))IS NULL FROM union_pnl_cash_outcomes o WHERE hand_number='+str(tn)+';ROLLBACK;');assert r=='t',(name,r);cases.append(name)
 if reader_args.reader_composition is not None:exec(compile(reader_args.reader_composition.read_text(),str(reader_args.reader_composition),'exec'),globals(),globals());cases.append('qualified_composed_actual_reader_owners')
 q("CREATE TABLE accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,computed_at timestamptz,value jsonb);CREATE FUNCTION smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object(\'\'native_unchanged_boundary\'\',true)';")
 for owner in json.loads((P/'current-close-window-owners.json').read_text()):q(owner['body'])
 q(json.loads((P/'current-weekly-hand-parts-owners.json').read_text())[0]['body'])
 q("INSERT INTO accounting_close_partials SELECT 'pnl_hands_window','fade0000-0000-0000-0000-000000000001','2026-10-26 07:00Z','2026-10-26 11:00Z',window_start,window_end,clock_timestamp(),jsonb_build_object('generation',"+lit(g0)+",'projected',true,'groups',jsonb_build_array(),'groups_md5',md5('[]'),'contract','d4665eb6e43425a93816c55ded55f644','witness',jsonb_build_object('native_unchanged_boundary',true))FROM fn_accounting_close_windows('2026-10-26 07:00Z','2026-10-26 11:00Z')")
 parts_digest=q('SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY window_start)::text)FROM accounting_close_partials p')
 readparts="SELECT smarter_private.weekly_hand_parts_read('fade0000-0000-0000-0000-000000000001','2026-10-26 07:00Z','2026-10-26 11:00Z',%s,true)"
 assert q("BEGIN;SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.accounting_close_memo='on';"+readparts%lit(g0)+';ROLLBACK;')=='[]'
 assert q("BEGIN;SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.accounting_close_memo='on';"+readparts%lit(g1)+';ROLLBACK;')==''
 assert parts_digest==q('SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY window_start)::text)FROM accounting_close_partials p');cases.append('actual_partial_reader_rejects_old_blocked_generation_after_genuine_admission_without_retagging_parts')
 q((P/'treasury-hand-original.sql').read_text());q((P/'treasury-lineage-original.sql').read_text())
 routed=json.loads(q((P/'production-78-read-only-probe.sql').read_text()));assert routed['cohort_count']==78 and routed['new_ready']==78 and routed['transaction_read_only']=='on';cases.append('exact_temp_routed_readonly_production_probe_locally_qualified')
 result={'reader_composition_qualified':reader_args.reader_composition is not None,'qualification':'passed','original_returns':len(returns),'original_return_amount':2661.33,'original_gifts':len(proofs),'original_amount':947,'cases':cases,'original_money_unchanged':True,'limits':'Actual original captured financial rows and actual new proof/admission functions. Original78wholefinancialreader passes with controlled omitted-private-request cryptographic boundaries; exact real production reproof is a separate retained receipt, not executed by this native run. Actual producer wrapper/core and entry owners run with controlled unchanged auth/session/capture boundaries; actual new proof+recorder verified atomic/replay/concurrency.'};(O/'native-original-gifts-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
finally:
 if started:run([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
 shutil.rmtree(base)
