#!/usr/bin/env python3
"""Actual old bank-owner overlap. Source-only setup is a deliberately separated
fixture boundary; release requires coordinated source/bank/legacy cutover."""
from pathlib import Path
root=Path(__file__).resolve().parent
# Reuse proven psql/process wait helpers; execute no source activation tests.
exec((root.parent/'owner-composition/overlap.py').read_text().split('activation=',1)[0])
p=root
checks=[];observed={}
auth="DO $auth$ BEGIN PERFORM set_config('request.jwt.claim.sub',test_id(100)::text,false); END $auth$;"
def bank(n,hand=None):
 h=f'test_id({n})' if hand is None else hand
 return auth+f"SELECT row_to_json(b) FROM atomic_distribute_rake(test_id(950),test_id(900),{h},{n},2,0,200,2,jsonb_build_object(test_id(201)::text,100,test_id(202)::text,100),NULL,'{{}}','WEIGHTED_CONTRIBUTED') b;"
def mark(name,expr=True):
 assert expr,name
 checks.append(name);print('PASS: '+name,flush=True)
def state():return query('SELECT test_bank_state()').stdout.strip()
query((p/'native-probe.py').read_text().split('sql("""',1)[1].split('""")',1)[0])
source='BEGIN;'+''.join((p.parent/f).read_text() for f in ['03-receipt-source-boundary.sql','04-cash-admission.sql','05-immutable-receipts.sql'])+'COMMIT;'
query(source)
# A real old owner can bank a table/number before history resolves its real UUID.
query(bank(1000033,'NULL'))
query("INSERT INTO rake_records(hand_id,table_id,club_id,rake_amount,bbj_contribution,pot_size,num_players,player_contributions,rake_method,returned_uncalled,metadata) VALUES(test_id(1000032),test_id(950),test_id(900),2,0,200,2,jsonb_build_object(test_id(201)::text,100,test_id(202)::text,100),'WEIGHTED_CONTRIBUTED','{}',jsonb_build_object('hand_number',1000032));")
for n in [1000030,1000031,1000032]:query(f'SELECT test_owner({n});')
bank_activation='BEGIN; SET LOCAL lock_timeout=\'400ms\'; SET LOCAL statement_timeout=\'10s\';'+(p/'01-bank-receipts.sql').read_text()+(p/'02-bank-owner.sql').read_text()+'COMMIT;'
query("""CREATE FUNCTION test_pause_bank_leg() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN IF NEW.leg_key=test_id(1000030) AND NEW.leg='chip_treasury' THEN
 PERFORM pg_advisory_xact_lock(8847,1); END IF; RETURN NEW; END $f$;
CREATE TRIGGER test_pause_bank_leg AFTER INSERT ON rake_distribution_legs
 FOR EACH ROW EXECUTE FUNCTION test_pause_bank_leg();""")
gate=holder('SELECT pg_advisory_xact_lock(8847,1)','bank-after-leg-gate')
before=state()
old=start('BEGIN;'+bank(1000030)+'ROLLBACK;','bank-old-after-leg')
observed['old_after_leg']=wait_for('bank-old-after-leg','advisory')
ddl=start(bank_activation,'bank-activation-drain')
observed['ddl_drain']=wait_for('bank-activation-drain','relation')
out,err,rc=finish(ddl,False)
assert rc and 'lock timeout' in err,err
mark('Activation fails atomically while actual old bank has inserted spendable leg',
 query("SELECT to_regclass('public.ca_cash_bank_receipts') IS NULL;").stdout.strip()=='t')
release(gate);finish(old)
mark('Drained old transaction rollback leaves every public row unchanged',state()==before)
query('DROP TRIGGER test_pause_bank_leg ON rake_distribution_legs;')
# Both old compiled bodies block before acquiring rake-record relation locks.
before=state()
club_gate=holder('LOCK TABLE clubs IN ACCESS EXCLUSIVE MODE','bank-before-record-gate')
pending=start(bank(1000031),'bank-old-new-record')
recovery=start(bank(1000032),'bank-old-existing-record')
observed['old_new_record']=wait_for('bank-old-new-record','relation')
observed['old_existing_record']=wait_for('bank-old-existing-record','relation')
query(bank_activation)
release(club_gate)
for proc,name in [(pending,'new-record'),(recovery,'existing-record recovery')]:
 out,err,rc=finish(proc,False)
 assert rc and 'cash bank receipt' in err.lower(),(name,err)
def normalized(s):
 d=json.loads(s);d.pop('ca_cash_bank_receipts',None)
 for name in ['rake_records','rake_distribution_legs']:
  for row in d.get(name,[]):row.pop('cash_bank_version',None)
 return d
mark('Old new-record and existing-record recovery owners cannot commit unacknowledged credit',normalized(state())==normalized(before))
query(bank(1000031))
mark('Retry through replacement owner credits once with complete receipt',
 query('SELECT count(*) FROM ca_cash_bank_receipts WHERE hand_id=test_id(1000031);').stdout.strip()=='1')
before=state();r=query(bank(1000032),False)
mark('Legacy rake-record recovery cannot be promoted to prospective funding',
 r.returncode!=0 and 'preexisting' in r.stderr and state()==before)
query('SELECT test_owner(1000033);')
before=state();r=query(bank(1000033),False)
mark('Real legacy derived-key bank cannot credit again under accepted UUID',
 r.returncode!=0 and 'preexisting' in r.stderr and state()==before)
before=state();r=query(bank(1000031,'test_id(999)'),False)
mark('Wrong non-NULL hand alias refuses before financial writes',r.returncode!=0 and state()==before)
before=state();query(bank(1000031,'NULL'))
mark('NULL hand resolves actual accepted history and replays without new money',state()==before)
# Two fresh calls wait on observed locks, then share exactly one receipt.
query('SELECT test_owner(1000034);')
gate=holder("SELECT pg_advisory_xact_lock(hashtextextended('club-arena:cash-bank:'||test_id(950)::text||':1000034',0))",'bank-duplicate-gate')
one=start(bank(1000034),'bank-duplicate-one')
observed['duplicate_one']=wait_for('bank-duplicate-one','advisory')
two=start(bank(1000034),'bank-duplicate-two')
observed['duplicate_two']=wait_for('bank-duplicate-two','advisory')
release(gate)
a=json.loads(finish(one)[0]);b=json.loads(finish(two)[0])
mark('Concurrent exact requests produce one actual credit and one replay',
 sum([a['applied'],b['applied']])==1 and query('SELECT count(*) FROM ca_cash_bank_receipts WHERE hand_id=test_id(1000034);').stdout.strip()=='1')
(p/'overlap-proof.json').write_text(json.dumps({'checks':checks,'observed_waits':observed},indent=2)+'\n')
print(json.dumps({'overlap_checks':len(checks)}),flush=True)
