#!/usr/bin/env python3
"""Old compiled LEGACY bank body across activation, each route direction."""
from pathlib import Path
root=Path(__file__).resolve().parent
exec((root.parent/'owner-composition/overlap.py').read_text().split('activation=',1)[0])
p=root
route=os.environ['BANK_LEGACY_ROUTE'];checks=[]
auth="DO $auth$ BEGIN PERFORM set_config('request.jwt.claim.sub',test_id(100)::text,false); END $auth$;"
def bank():
 return auth+"SELECT row_to_json(b) FROM atomic_distribute_rake(test_id(950),test_id(900),test_id(1000001),1000001,2,0,200,2,jsonb_build_object(test_id(201)::text,100,test_id(202)::text,100),NULL,'{}','WEIGHTED_CONTRIBUTED') b;"
def mark(name,expr):
 assert expr,name
 checks.append(name);print('PASS: '+name,flush=True)
query((p/'native-probe.py').read_text().split('sql("""',1)[1].split('""")',1)[0])
query("INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(901),'Legacy native Union',test_id(100),'legacy-native-union');")
private='false' if route=='union_to_club' else 'true'
query('UPDATE tables SET union_id=test_id(901),is_private='+private+' WHERE id=test_id(950);')
query(bank())
private='true' if route=='union_to_club' else 'false'
query('UPDATE tables SET is_private='+private+' WHERE id=test_id(950);')
before=query('SELECT test_bank_state();').stdout.strip()
gate=holder('LOCK TABLE clubs IN ACCESS EXCLUSIVE MODE','legacy-route-gate')
old=start(bank(),'legacy-route-old-'+route)
observed=wait_for('legacy-route-old-'+route,'relation')
activation='BEGIN; SET LOCAL lock_timeout=\'500ms\'; SET LOCAL statement_timeout=\'10s\';'
for f in [p/'01-bank-receipts.sql',p/'02-bank-owner.sql',p.parent/'03-receipt-source-boundary.sql',p.parent/'04-cash-admission.sql',p.parent/'05-immutable-receipts.sql']:
 activation+=f.read_text()
query(activation+'COMMIT;')
release(gate)
out,err,rc=finish(old,False)
assert rc and 'original route or identity' in err,err
def normalized(s):
 d=json.loads(s)
 for name in ['ca_cash_bank_receipts','ca_cash_commission_authority']:d.pop(name,None)
 for name in ['rake_records','rake_distribution_legs']:
  for row in d.get(name,[]):row.pop('cash_bank_version',None)
 for row in d.get('hand_atomic_commits',[]):row.pop('commission_capture_version',None)
 return d
mark('Actual old legacy '+route+' call cannot create a second spendable route',
 normalized(before)==normalized(query('SELECT test_bank_state();').stdout.strip()))
mark('Legacy '+route+' history remains outside prospective funding',
 query('SELECT count(*) FROM ca_cash_bank_receipts;').stdout.strip()=='0')
(p/('legacy-'+route+'-proof.json')).write_text(json.dumps({'checks':checks,'observed_waits':observed},indent=2)+'\n')
