#!/usr/bin/env python3
"""Native PG17 actual accepted owner -> actual bank owner. No money stubs."""
import json,os,subprocess
from pathlib import Path
p=Path(__file__).resolve().parent
psql=os.environ['COMMISSION_PSQL']
checks=[]
def sql(s,ok=True):
 r=subprocess.run([psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',
  "DO $auth$ BEGIN PERFORM set_config('request.jwt.claim.sub',test_id(100)::text,false); END $auth$;"+s],text=True,capture_output=True)
 if ok and r.returncode: raise RuntimeError(r.stderr+'\nSQL:'+s[:500])
 if not ok and not r.returncode: raise AssertionError('Expected failure: '+s[:300])
 return r.stdout.strip() if ok else r.stderr
def check(name,predicate):
 assert predicate,name
 checks.append(name);print('PASS: '+name,flush=True)
def bank(n,args=''):
 return f"SELECT row_to_json(b) FROM public.atomic_distribute_rake(test_id(950),test_id(900),test_id({n}),{n},2,0,200,2,jsonb_build_object(test_id(201)::text,100,test_id(202)::text,100),NULL,'{{}}','WEIGHTED_CONTRIBUTED') b;"
def state():
 return sql("SELECT public.test_bank_state();")
def refused(name,s,expected=None):
 before=state();err=sql(s,False)
 if expected: assert expected in err,err
 check(name,before==state())
sql("""
CREATE FUNCTION public.test_bank_state() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE t record; j jsonb; result jsonb:='{}';
BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(j ORDER BY j::text),''[]'') FROM (SELECT to_jsonb(x) j FROM public.%I x) z',t.tablename) INTO j;
  result:=result||jsonb_build_object(t.tablename,j);
 END LOOP;
 RETURN result;
END $f$;
""")
activation='BEGIN; SET LOCAL lock_timeout=\'500ms\'; SET LOCAL statement_timeout=\'10s\';\n'
for f in [p/'01-bank-receipts.sql',p/'02-bank-owner.sql',p.parent/'03-receipt-source-boundary.sql',
          p.parent/'04-cash-admission.sql',p.parent/'05-immutable-receipts.sql']:
 activation+=f.read_text()+'\n'
activation+='COMMIT;'
sql(activation)
sql('SELECT test_owner(1000010);')
first=json.loads(sql(bank(1000010)))
check('Actual accepted source credits actual standalone treasury and immutable receipt',first['applied'] and
 sql('SELECT count(*) FROM ca_cash_bank_receipts WHERE hand_id=test_id(1000010) AND credited_amount=2 AND chip_ledger_id IS NOT NULL;')=='1')
before=state();replay=json.loads(sql(bank(1000010)))
check('Exact replay produces no public-row change',before==state() and replay['already_processed'])
for label,old,new in [('rake',',2,0,200,2,',',3,0,200,2,'),
 ('BBJ',',2,0,200,2,',',2,1,200,2,'),('pot',',0,200,2,',',0,201,2,'),
 ('player count',',200,2,',',200,3,'),('method',"'WEIGHTED_CONTRIBUTED'","'DEALT_EQUAL'")]:
 query=bank(1000010).replace(old,new)
 assert query!=bank(1000010),label
 refused('Changed '+label+' bank payload refuses without side effects',query,'conflict')
refused('Receipt refuses service writes',"SET ROLE service_role; DELETE FROM ca_cash_bank_receipts;")
refused('Receipt refuses maintenance truncate',"SET app.maintenance_mode='on'; TRUNCATE ca_cash_bank_receipts CASCADE;",'immutable')
refused('Referenced ledger identity cannot change',"SET app.maintenance_mode='on'; UPDATE chip_ledger SET hand_id=test_id(999) WHERE id=(SELECT chip_ledger_id FROM ca_cash_bank_receipts LIMIT 1);",'immutable')
refused('Captured rake record cannot change identity',"UPDATE rake_records SET hand_id=test_id(999) WHERE hand_id=test_id(1000010);",'immutable')
sql("INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(901),'Native source Union',test_id(100),'native-source-union'),(test_id(902),'Native replacement Union',test_id(100),'native-replacement-union'); INSERT INTO union_clubs(union_id,club_id,rate_cash) VALUES(test_id(901),test_id(900),0.88); UPDATE tables SET union_id=test_id(901) WHERE id=test_id(950);")
sql('SELECT test_owner(1000011);')
sql("UPDATE tables SET union_id=test_id(902),is_private=true WHERE id=test_id(950); UPDATE union_clubs SET rate_cash=0.77 WHERE union_id=test_id(901);")
second=json.loads(sql(bank(1000011)))
check('Bank follows captured Union after current private/Union/rate changes',second['union_id_out']==sql('SELECT test_id(901);') and
 sql("SELECT count(*) FROM ca_cash_commission_facts WHERE hand_id=test_id(1000011) AND funding_club_rate=0.88;")=='2')
check('Union receipt pins actual credited transaction time and gross amount',sql("SELECT count(*) FROM ca_cash_bank_receipts b JOIN union_wallet_transactions u ON u.id=b.union_wallet_transaction_id WHERE b.hand_id=test_id(1000011) AND b.bank_credit_at=u.created_at AND b.credited_amount=u.amount AND b.credited_amount=2;")=='1')
before=state();sql(bank(1000011))
check('Route-changed Union replay cannot create treasury leg',state()==before)
refused('Referenced Union credit cannot change destination',"SET app.maintenance_mode='on'; UPDATE union_wallet_transactions SET union_id=test_id(902) WHERE id=(SELECT union_wallet_transaction_id FROM ca_cash_bank_receipts WHERE hand_id=test_id(1000011));",'immutable')
sql('SELECT test_owner(1000012);')
sql("CREATE FUNCTION public.test_bank_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected final bank receipt failure'; END$$; CREATE TRIGGER zzz_test_bank_fail_receipt BEFORE INSERT ON ca_cash_bank_receipts FOR EACH ROW EXECUTE FUNCTION test_bank_fail_receipt();")
refused('Final receipt failure rolls back every public row including bank, legs and allocations',bank(1000012),'injected final')
sql('DROP TRIGGER zzz_test_bank_fail_receipt ON ca_cash_bank_receipts;')
sql(bank(1000012))
check('Failed final receipt can retry the full bank once',sql('SELECT count(*) FROM ca_cash_bank_receipts WHERE hand_id=test_id(1000012);')=='1')
exec((p/'additional-probe.py').read_text())
(p/'local-proof.json').write_text(json.dumps({'status':'partial_native_bank_proof_overlap_pending','checks':checks},indent=2)+'\n')
print(json.dumps({'passed':len(checks),'remaining':'actual overlap, legacy alias/races, full funding cascade'}),flush=True)
