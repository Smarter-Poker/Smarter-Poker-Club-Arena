#!/usr/bin/env python3
import json,hashlib,os
from pathlib import Path
from fixture_helpers import sql,setup,source,admit,pool,release,state
checks=[]
def check(n,p):
 assert p,n
 checks.append(n);print('PASS: '+n,flush=True)
def refused(n,s,expected=None):
 before=state();err=sql(s,False)
 if expected: assert expected in err,err
 check(n,before==state())
setup()
source(1200001,'2')
admit(1200001);direct=pool(1200001)
cutoff=sql('SELECT fn_union_week_start(clock_timestamp());')
r=release(direct,cutoff,1200101)
check('Unchanged current accepted/bank emission cannot enter a closed bank window',r['new_release']==0 and sql('SELECT count(*) FROM ca_source_club_funding_admissions;')=='0')
sql("""INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(901),'Funding Union',test_id(100),'funding-union');
INSERT INTO union_clubs(union_id,club_id,rate_cash) VALUES(test_id(901),test_id(900),.90);
UPDATE tables SET union_id=test_id(901) WHERE id=test_id(950);
UPDATE club_members SET agent_id=test_id(301),player_rakeback_pct=.60 WHERE user_id IN(test_id(201),test_id(202)) AND club_id=test_id(900);""")
source(1200002,'.01','2026-08-24T12:00:00Z','2026-08-31T06:59:59Z')
admit(1200002);p=pool(1200002)
r=release(p,'2026-08-31T07:00:00Z',1200102)
check('First closed .009 exact club right is admitted with zero cash',r['new_release']==0 and str(r['exact_club_entitlement'])=='0.009')
source(1200003,'.01','2026-08-24T12:00:01Z','2026-08-31T07:00:00Z')
admit(1200003)
before=json.loads(sql("SELECT jsonb_build_object('club',chip_treasury,'union',(SELECT rake_wallet FROM union_wallets WHERE union_id=test_id(901))) FROM clubs WHERE id=test_id(900);"))
r=release(p,'2026-09-07T07:00:00Z',1200103)
after=json.loads(sql("SELECT jsonb_build_object('club',chip_treasury,'union',(SELECT rake_wallet FROM union_wallets WHERE union_id=test_id(901))) FROM clubs WHERE id=test_id(900);"))
check('Two Pacific windows release one cumulative cent through actual Union and treasury owners',r['new_release']==.01 and round(after['club']-before['club'],2)==.01 and round(before['union']-after['union'],2)==.01)
check('Release slices retain both original bank windows and each source exact cap',sql("SELECT count(DISTINCT l.bank_period_start) FROM ca_source_club_release_slices s JOIN ca_source_funding_lots l USING(hand_id,contributor_id);")=='2')
before=state();again=release(p,'2026-09-07T07:00:00Z',1200103)
check('Same UUID replays the original receipt with no public row change',again==r and state()==before)
old=release(p,'2026-08-31T07:00:00Z',1200104)
check('Older requested cutoff preserves admitted highwater and cannot repay carry',old['new_release']==0 and str(old['exact_club_entitlement'])=='0.018')
source(1200004,'.02','2026-08-25T12:00:00Z','2026-09-01T12:00:00Z');admit(1200004)
sql("""CREATE FUNCTION test_fail_release_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected final release request failure';END$$;
CREATE TRIGGER zzz_test_fail_release BEFORE INSERT ON ca_source_club_release_requests FOR EACH ROW EXECUTE FUNCTION test_fail_release_receipt();""")
refused('Final request receipt failure rolls back all public money/admission/slice/support rows',f"SELECT fn_release_captured_club_funding('{p}','2026-09-07T07:00:00Z',test_id(1200105),test_id(100));",'injected final release')
sql('DROP TRIGGER zzz_test_fail_release ON ca_source_club_release_requests;')
r=release(p,'2026-09-07T07:00:00Z',1200105)
check('Failed request retries actual remaining cash once',r['new_release']==.02)
refused('Linked Union debit cannot change under maintenance',"SET app.maintenance_mode='on';UPDATE union_wallet_transactions SET notes='changed' WHERE id=(SELECT union_debit_transaction_id FROM ca_source_club_cash_releases LIMIT 1);",'immutable')
refused('Linked release ledger cannot be truncated under maintenance',"SET app.maintenance_mode='on';TRUNCATE chip_ledger CASCADE;",'immutable')
sql("UPDATE tables SET is_private=true WHERE id=test_id(950);")
source(1200005,'2','2026-08-26T12:00:00Z','2026-09-02T12:00:00Z');admit(1200005)
before=sql("SELECT chip_treasury FROM clubs WHERE id=test_id(900);")
r=release(pool(1200005),'2026-09-07T07:00:00Z',1200106)
check('Closed standalone bank capacity references the actual bank receipt without a second treasury credit',r['new_release']==2 and before==sql("SELECT chip_treasury FROM clubs WHERE id=test_id(900);"))
here=Path(os.environ['ROUND1_HERE'])
receipt={'status':'partial_native_round1_checkpoint','checks':checks,'temporal_scope':'Current actual owner emission proves open refusal; closed cases use fixture-only timestamp triggers with unchanged actual owners. Full Union legacy exclusion, Round2/player composition, authorization/races and common finality remain pending.','runtime':sql('SELECT version();'),'inputs':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in [here/'01-release-writer.sql',here/'fixture-clock.sql',here/'fixture_helpers.py',here/'native-probe.py',here/'activate-fixture.py',here/'run-local.sh',here/'vendor-input-hashes.json']}}
(here/'native-proof.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'passed':len(checks)}),flush=True)
