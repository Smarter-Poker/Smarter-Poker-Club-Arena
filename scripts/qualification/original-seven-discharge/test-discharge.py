#!/usr/bin/env python3
"""Qualify the maintained finite request against real captured money primitives.

Existing isolated PG17 fixture only; never production. The full installer in
README reconstructs exact catalog bodies, schemas and raw original sources.
"""
import argparse,json,pathlib,subprocess,time
parser=argparse.ArgumentParser();parser.add_argument('--socket',required=True);parser.add_argument('--port',required=True);parser.add_argument('--database',required=True);parser.add_argument('--output',type=pathlib.Path,required=True)
args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
import os,shutil
pg=pathlib.Path(os.environ.get('PG_BIN',str(pathlib.Path(shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql').parent)));cmd=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h',args.socket,'-p',args.port,'-U','postgres','-d',args.database]
if not args.database.startswith('discharge_') or args.socket.startswith('/tmp'):raise RuntimeError('owned isolated database required')
cases=[]
hashes={42309154:'dcc2248b35d55e8c3239044f5e5e2869',42346932:'4a806deeace376da57411d584cc90491',42399949:'2d6149ab417c6ade798d2aae7a7f7af1',42407664:'6463819644005aba4cc1817b20f9f21d',42586570:'ca1904c2f019f5ec7864b113c2119db6',42607253:'d4e0d142973bc8f8226ece46950e13c0',42626673:'503edc03d357862da655c3867b51240c'}
def call(e=42309154,h=None):return "SELECT smarter_private.original_erased_cash_base_discharge("+str(e)+",'"+(h or hashes[e])+"');"
def run(name,sql,error=None):
 source=args.output/(name+'.sql');source.write_text(sql)
 r=subprocess.run(cmd+['-f',str(source)],text=True,capture_output=True,timeout=20);(args.output/(name+'.log')).write_text(r.stdout+r.stderr)
 ok=(r.returncode!=0 and error in r.stderr) if error else r.returncode==0;cases.append({'case':name,'passed':ok,'expected_error':error})
 if not ok:raise RuntimeError(name+': '+r.stderr[-2000:])
 return r.stdout
run('actual-101-original-source-refs-qualified',"DO $b$DECLARE c record;r jsonb;BEGIN FOR c IN SELECT * FROM smarter_private.original_inventory_restoration_cases LOOP r:=smarter_private.original_erased_cash_base_request(c.event_id,smarter_private.original_erased_cash_base_expected_hash(c.event_id));IF r->>'status' IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION 'actual_request_refused';END IF;END LOOP;END$b$;")
pending_source=pathlib.Path(__file__).resolve().parent.parent/'original-retirement-boundary'/'actual-b9-pending-seven-report-native.sql'
run('actual-b9-pending-seven-retains-owed-basis',"BEGIN;"+pending_source.read_text()+"ROLLBACK;")
run('all-seven-actual-request-current-money-rollback',"BEGIN;CREATE TEMP TABLE before_legs AS SELECT id,md5(to_jsonb(l)::text) digest FROM chip_ledger l;"+''.join(call(e) for e in hashes)+"SET CONSTRAINTS ALL IMMEDIATE;DO $b$BEGIN IF (SELECT count(*) FROM smarter_private.original_erased_cash_base_discharges)<>7 OR (SELECT sum(base_cents) FROM smarter_private.original_erased_cash_base_discharges)<>184587 OR (SELECT sum(chip_treasury) FROM clubs)<>3845.87 OR (SELECT count(*) FROM ca_mint_ledger)<>7 OR (SELECT sum(amount) FROM ca_mint_ledger)<>1845.87 OR (SELECT count(*) FROM chip_ledger)<>36 OR (SELECT count(*) FROM chip_transactions)<>14 OR EXISTS(SELECT 1 FROM before_legs b LEFT JOIN chip_ledger l USING(id) WHERE b.digest IS DISTINCT FROM md5(to_jsonb(l)::text)) OR EXISTS(SELECT 1 FROM club_members WHERE chip_balance<>0) THEN RAISE EXCEPTION 'seven_original_conservation_refused';END IF;END$b$;ROLLBACK;")
report_source=pathlib.Path(__file__).resolve().parent.parent/'original-retirement-boundary'/'actual-b9-current-seven-report-native.sql'
run('actual-b9-current-seven-report-cash-conservation',"BEGIN;"+''.join(call(e) for e in hashes)+report_source.read_text()+"ROLLBACK;")
run('all-seven-durable-replay-unchanged-report',"BEGIN;"+''.join(call(e) for e in hashes)+report_source.read_text()+"CREATE TEMP TABLE native_before_replay AS SELECT md5(to_jsonb(t)::text) hash FROM smarter_private.original_erased_cash_base_discharges t;"+''.join(call(e) for e in hashes)+"DO $b$BEGIN IF (SELECT count(*) FROM smarter_private.original_erased_cash_base_discharges)<>7 OR EXISTS(SELECT md5(to_jsonb(t)::text) FROM smarter_private.original_erased_cash_base_discharges t EXCEPT SELECT hash FROM native_before_replay) OR (SELECT count(*) FROM smarter_private.original_erased_cash_discharge_returns('fade0000-0000-0000-0000-000000000001','2026-10-12 07:00Z',(SELECT period_end FROM native_original_report_period)))<>7 OR (smarter_private.original_erased_cash_receivables('fade0000-0000-0000-0000-000000000001','2026-10-12 07:00Z')->>'held_total')::numeric IS DISTINCT FROM 1845.87 THEN RAISE EXCEPTION 'replay_or_historical_boundary_changed';END IF;END$b$;ROLLBACK;")
run('all-seven-rollback-no-custody-or-certificate',"DO $b$BEGIN IF EXISTS(SELECT 1 FROM smarter_private.original_erased_cash_base_discharges) OR EXISTS(SELECT 1 FROM ca_mint_ledger) OR EXISTS(SELECT 1 FROM wallet_credit_idempotency WHERE key LIKE 'retired_completed_cash_base:%') OR (SELECT sum(chip_treasury) FROM clubs)<>2000 THEN RAISE EXCEPTION 'rollback_failed';END IF;END$b$;")
run('unknown-eighth-event-refuses',call(999,hashes[42309154]),error='unknown_request')
run('wrong-witness-hash-refuses',call(h='0'*32),error='unknown_request')
run('browser-caller-refuses',"SET ROLE authenticated;"+call(),error='permission denied')
run('service-caller-refuses',"SET ROLE service_role;"+call(),error='permission denied')
run('jwt-claims-caller-refuses',"SET request.jwt.claims='{\"role\":\"service_role\"}';"+call(),error='caller_refused')
run('current-source-pin-refuses',"BEGIN;CREATE OR REPLACE FUNCTION public.fn_ensure_club_wallet(p_user_id uuid,p_club_id uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';"+call(),error='money_source_changed')
run('missing-original-source-refuses',"BEGIN;DELETE FROM cash_participant_funding_receipts WHERE id='6cfdaf5c-f9cc-4ce4-9b72-377fe89b72a0';"+call(),error='source_refused')
run('profile-deletion-drift-refuses',"BEGIN;UPDATE profiles SET status='active' WHERE id='00000000-0000-0000-0000-000000000051';"+call(),error='deleted_status_changed')
run('wallet-held-drift-refuses',"BEGIN;UPDATE club_members SET held_chips=1 WHERE user_id='00000000-0000-0000-0000-000000000051' AND club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';"+call(),error='wallet_changed')
run('real-freeze-refuses',"BEGIN;INSERT INTO engine_maintenance_break(id,phase,ownership_token,announced_at,break_started_at,break_ends_at,enforce_freeze)VALUES(true,'counting_down',gen_random_uuid(),clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '3 minutes',true);"+call(),error='discharge_frozen')
run('real-positive-issuance-stop-refuses',"BEGIN;UPDATE ca_emergency_stops SET stopped=true WHERE path='positive_issuance';"+call(),error='emergency_path_stopped')
run('last-seventh-leg-cap-rolls-back-entire-prefix',"BEGIN;UPDATE ca_mint_policy SET per_operation_cap_chips=1200 WHERE id=1;"+''.join(call(e) for e in hashes),error='per-operation ceiling')
k='retired_completed_cash_base:cd822e0f-41eb-4017-b073-d43d911d2a67'
# The unchanged shared writer is the actual before counterexample: its swallowed
# unique violation returns nominal success while a wrong op_id row survives.
run('before-raw-mint-collision-cannot-certify-original-beneficiary',"BEGIN;INSERT INTO ca_mint_ledger(op_id,action,asset,holder_type,holder_id,amount,balance_before,balance_after,supply_after,reason)VALUES('"+k+"','mint','chips','player','00000000-0000-0000-0000-000000000005',1,0,1,1,'Native prior unrelated mint collision');SELECT fn_ca_restore_erased_seat_credit('"+k+"','00000000-0000-0000-0000-000000000051','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',297.5,'0a0cc937-c155-457a-b68b-56865a09281d','Native raw prior collision counterexample');SET CONSTRAINTS ALL IMMEDIATE;DO $b$BEGIN IF (SELECT count(*) FROM ca_mint_ledger)<>2 OR NOT EXISTS(SELECT 1 FROM ca_mint_ledger WHERE op_id='"+k+"' AND holder_id='00000000-0000-0000-0000-000000000005' AND amount=1) OR NOT EXISTS(SELECT 1 FROM ca_mint_ledger WHERE op_id LIKE 'ledger:%' AND amount=297.5) THEN RAISE EXCEPTION 'actual_raw_before_counterexample_changed';END IF;END$b$;ROLLBACK;")
run('orphan-mint-op-collision-refuses-before-wallet',"BEGIN;INSERT INTO ca_mint_ledger(op_id,action,asset,holder_type,holder_id,amount,balance_before,balance_after,supply_after,reason)VALUES('"+k+"','mint','chips','player','00000000-0000-0000-0000-000000000005',1,0,1,1,'Native prior unrelated mint collision');"+call(),error='orphan_or_partial_key')
run('orphan-wallet-key-refuses-before-wallet',"BEGIN;INSERT INTO wallet_credit_idempotency(key,user_id,amount)VALUES('"+k+"','00000000-0000-0000-0000-000000000005',1);"+call(),error='orphan_or_partial_key')
stale="INSERT INTO chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,notes,metadata,balance_after)VALUES('ffffffff-ffff-ffff-ffff-ffffffffffff','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','00000000-0000-0000-0000-000000000051','47965354-0e56-43ef-931c-ddaab82af765',297.5,'club_bank_claim','Native prior equal amount receipt','{\"op_id\":\"ffffffff-ffff-ffff-ffff-ffffffffffff\",\"reason\":\"deleted_account\",\"source\":\"player_wallet\"}',1000);"
run('prior-equal-amount-receipt-cannot-be-consumed',"BEGIN;"+stale+call()+"DO $b$BEGIN IF EXISTS(SELECT 1 FROM smarter_private.original_erased_cash_base_discharges WHERE evidence->>'bank_claim_transaction_id'='ffffffff-ffff-ffff-ffff-ffffffffffff') THEN RAISE EXCEPTION 'prior_receipt_selected';END IF;END$b$;ROLLBACK;")
run('forged-insert-without-money-refuses',"INSERT INTO smarter_private.original_erased_cash_base_discharges(event_id,witness_md5,occupancy_id,user_id,funding_club_id,base_cents,restoration_key,discharged_at,evidence,evidence_md5)VALUES(42309154,'"+hashes[42309154]+"','cd822e0f-41eb-4017-b073-d43d911d2a67','00000000-0000-0000-0000-000000000051','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',29750,'"+k+"',clock_timestamp(),'{\"amount\":297.5}',md5('{\"amount\": 297.5}'));",error='insert_evidence_refused')
# Retained guard controls mutate only a disposable subtransaction copy of evidence.
run('actual-evidence-crossbindings-refuse-all-forgeries',"BEGIN;"+call()+"DO $b$DECLARE s jsonb;mut jsonb;key text;BEGIN SELECT evidence INTO s FROM smarter_private.original_erased_cash_base_discharges WHERE event_id=42309154;FOREACH key IN ARRAY ARRAY['amount','bank_increment','user_id','funding_club_id','issuance_leg_id','mint_id','bank_claim_leg_id','bank_claim_transaction_id','base_credit_transaction_id','occupancy_id','restoration_key','preserved_played_delta'] LOOP mut:=s||jsonb_build_object(key,CASE WHEN key IN('amount','bank_increment','preserved_played_delta') THEN to_jsonb(1) ELSE to_jsonb('00000000-0000-0000-0000-000000000005'::text) END);IF smarter_private.original_erased_cash_base_discharge_evidence_valid(42309154,'"+hashes[42309154]+"',mut) IS DISTINCT FROM false THEN RAISE EXCEPTION 'forged_association_accepted:%',key;END IF;END LOOP;END$b$;ROLLBACK;")
# Maintained admission mutex fails closed promptly while its original owner holds the transaction.
first=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
first.stdin.write("SET application_name='seven-discharge-first';BEGIN;"+call()+"SELECT 'EXACT_OWNER_HELD';\n");first.stdin.flush();first_lines=[]
while True:
 line=first.stdout.readline();first_lines.append(line)
 if 'EXACT_OWNER_HELD' in line:break
 if not line:raise RuntimeError('first actual maintained owner failed')
try:run('concurrent-maintained-request-refuses-busy-owner',call(),error='writer_busy')
finally:first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
(args.output/'maintained-first-committed.log').write_text(''.join(first_lines)+first.stdout.read()+first.stderr.read())
run('durable-repeat-reproves-exact-custody-no-money',"DO $b$DECLARE r jsonb;BEGIN r:=smarter_private.original_erased_cash_base_discharge(42309154,'"+hashes[42309154]+"');IF r->'replayed' IS DISTINCT FROM 'true'::jsonb OR r->'financial_payment' IS DISTINCT FROM 'false'::jsonb OR (SELECT count(*) FROM ca_mint_ledger)<>1 OR (SELECT count(*) FROM chip_transactions)<>2 OR (SELECT sum(chip_treasury) FROM clubs)<>2297.5 THEN RAISE EXCEPTION 'durable_repeat_moved_money';END IF;END$b$;")
run('certificate-update-refuses',"UPDATE smarter_private.original_erased_cash_base_discharges SET base_cents=1 WHERE event_id=42309154;",error='is_immutable')
run('certificate-delete-refuses',"DELETE FROM smarter_private.original_erased_cash_base_discharges WHERE event_id=42309154;",error='is_immutable')
run('durable-financial-row-drift-refuses-replay',"BEGIN;SET LOCAL session_replication_role=replica;UPDATE ca_mint_ledger SET amount=1 WHERE op_id='"+k+"';SET LOCAL session_replication_role=origin;"+call(),error='durable_receipt_refused')
run('final-rails-and-original-history-unchanged',"DO $b$BEGIN IF (SELECT count(*) FROM smarter_private.original_erased_cash_base_discharges)<>1 OR (SELECT count(*) FROM ca_mint_ledger)<>1 OR (SELECT sum(chip_treasury) FROM clubs)<>2297.5 OR (SELECT count(*) FROM chip_ledger)<>24 OR EXISTS(SELECT 1 FROM club_members WHERE chip_balance<>0) THEN RAISE EXCEPTION 'native_final_bad';END IF;END$b$;")
(args.output/'results.json').write_text(json.dumps(cases,indent=2));print(json.dumps(cases,indent=2))
