#!/usr/bin/env python3
"""Expected-row proof over pinned real owner composition; no synthetic money owners."""
import os,sys,json,hashlib,subprocess
from pathlib import Path
from decimal import Decimal
outer=Path(os.environ['CASCADE_HERE']);inspector=Path(os.environ['INSPECTOR_HERE'])
pinned_runner=(outer/'run-local.sh').read_text()
for declaration in ['readonly PAYER_COMMIT=7adbfb02544b68ccc1754c51f11d2f61fa406180',
 'readonly SOURCE_COMMIT=d5300be77e19d08b887b3b851946c5c244b77ad9',
 'readonly COMPLETION_COMMIT=c12f993244b1f6b01dd950a8e8fee2b0de07ffef']:
 assert declaration in pinned_runner,'Composed owner pin mismatch: '+declaration
original=(outer/'outer-native-probe.py').read_text()
boundary="load(here/'03-cron-diagnostics.sql')\n"
assert original.count(boundary)==1
end=original.index(boundary)+len(boundary)
owner_setup=original[:end]
(inspector/'owner-setup.py').write_text(owner_setup)
# This exact archived prefix only installs the reviewed composition. Its existing
# helper/outer suites below the delimiter are deliberately not rerun.
exec(compile(owner_setup,str(outer/'outer-native-probe.py'), 'exec'),globals())
here=inspector;checks=[];snapshots={}
load(here/'01-known-source-inspector.sql')
sql("""INSERT INTO unions(id,name,owner_id,slug) VALUES(test_id(901),'Known Source Inspection',test_id(100),'known-source-inspection'),(test_id(902),'Different Original Union',test_id(100),'known-source-other');
INSERT INTO union_clubs(union_id,club_id,rate_cash) VALUES(test_id(901),test_id(900),.90);
UPDATE tables SET union_id=test_id(901) WHERE id=test_id(950);
UPDATE agents SET commission_rate=.25,player_rakeback_rate=.15 WHERE id=test_id(103);
UPDATE club_members SET player_rakeback_pct=.15 WHERE club_id=test_id(900) AND user_id IN(test_id(201),test_id(202));
CREATE FUNCTION test_inspection_manifest(p_omit uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE AS $f$
 SELECT coalesce(jsonb_agg(jsonb_build_object('source',to_jsonb(s),'facts',
 (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.player_id),'[]') FROM ca_cash_commission_facts f WHERE f.hand_id=s.hand_id)) ORDER BY s.hand_id),'[]')
 FROM ca_cash_commission_sources s WHERE s.funding_union_id=test_id(901) AND (p_omit IS NULL OR s.hand_id<>p_omit);
$f$;""")
def query(manifest='test_inspection_manifest()',sha=None,union=901,locks=True,read_only=False):
 digest=sha or "encode(extensions.digest(convert_to(m::text,'UTF8'),'sha256'),'hex')"
 body=(f"SELECT fn_lock_rakeback_payer_clubs(fn_ca_union_captured_scope_clubs(test_id({union})));" if locks else '')
 body+=f"WITH source_manifest AS (SELECT {manifest} m) SELECT ca_accounting_readiness_private.inspect_known_sources(test_id({union}),'2026-08-31T07:00Z','2026-09-07T07:00Z','2026-09-07',m,{digest},fn_ca_union_captured_scope_clubs(test_id({union}))) FROM source_manifest;"
 return ('BEGIN READ ONLY;' if read_only else 'BEGIN;')+body+'COMMIT;'
def inspect(label=None,**kwargs):
 before=state();r=value(query(**kwargs));assert before==state(),'Inspector changed public rows'
 if label:snapshots[label]=r
 return r
def kinds(r):return {g['kind'] for g in r['gaps']}
def batch(n):
 r=value(f"SELECT fn_credit_agent_commissions_batch(jsonb_agg(jsonb_build_object('user_id',player_id,'club_id',booked_club_id,'rake_credit',rake_credit,'source_type','rake_settlement','source_id',hand_id))) FROM ca_cash_commission_facts WHERE hand_id=test_id({n});")
 assert r.get('failed')==0,r
# Deliberately include zero-credit contributors in the actual batch contract.
def admit(n):return value(f'SELECT fn_ca_admit_source_funding(test_id({n}),test_id(900));')
def release_all():
 return value("SELECT fn_release_captured_club_funding(id,'2026-09-07T07:00Z',gen_random_uuid(),test_id(100)) FROM ca_source_funding_pools WHERE funding_union_id=test_id(901) ORDER BY id;")
def agents():
 sql("SELECT fn_pay_captured_agent_funding(pool_id,recipient_id,'2026-09-07') FROM (SELECT DISTINCT pool_id,recipient_id FROM ca_source_recipient_accruals ORDER BY pool_id,recipient_id) x;")
def players():
 sql("SELECT fn_pay_captured_player_funding(x.pool_id,x.player_id,x.payer_id,'2026-09-07') FROM (SELECT DISTINCT a.pool_id,a.contributor_id player_id,a.recipient_id payer_id FROM ca_source_recipient_funding_admissions a JOIN ca_source_recipient_accruals r USING(hand_id,contributor_id,agent_id) WHERE r.is_direct_payer ORDER BY a.pool_id,a.recipient_id,a.contributor_id) x;")
source(3100001,'2','2026-08-31T12:00:00Z','2026-09-01T12:00:00Z')
r=inspect('banked_only')
check('Actual accepted and bank owners cannot appear complete when no funding lots exist','missing_funding_lot' in kinds(r) and r['known_rows_complete'] is False)
check('Expected captured hierarchy reveals missing accruals before any recipient row exists','missing_recipient_accrual' in kinds(r) and r['known_attribution']['agent']['exact']==Decimal('1.4'))
check('Missing contributor and all three funding admission stages are explicit',{'missing_contributor_receipt','missing_club_funding_admission','missing_agent_funding_admission','missing_player_funding_admission'}<=kinds(r))
batch(3100001);r=inspect('contributor_only');check('Actual contributor receipts clear only their own missing-row gap','missing_contributor_receipt' not in kinds(r) and 'missing_funding_lot' in kinds(r))
admit(3100001);r=inspect('rights_admitted');check('Actual source owner creates all expected lots and hierarchy accruals',not {'missing_funding_lot','missing_recipient_accrual'}&kinds(r) and 'missing_club_funding_admission' in kinds(r))
release_all();r=inspect('club_released');check('Actual club release clears club admission while agent/player gaps remain','missing_club_funding_admission' not in kinds(r) and {'missing_agent_funding_admission','missing_player_funding_admission'}<=kinds(r))
agents();r=inspect('agents_paid');check('Actual agent owner clears agent admission without inventing player admission','missing_agent_funding_admission' not in kinds(r) and 'missing_player_funding_admission' in kinds(r))
players();r=inspect('players_paid');check('Actual player owner completes expected known rows and all exact attribution',r['known_rows_complete'] and all(v['remaining_exact']==0 for v in r['known_attribution'].values()))
check('Complete observed rows never become common period finality',r['common_finality'] is False and r['period_closed'] is False and r['scope']=='known_captured_sources_only')
# Test database-enforced read-only execution as well as before/after row equality.
ro=query(read_only=True).replace('BEGIN READ ONLY;',"BEGIN READ ONLY;SELECT set_config('request.jwt.claim.sub',test_id(100)::text,false);")
p=subprocess.run([os.environ['COMMISSION_PSQL'],'-X','-qAt','-v','ON_ERROR_STOP=1','-c',ro],capture_output=True,text=True)
check('Inspector and existing assertions execute in a read-only database transaction',p.returncode==0)
refused('A mismatched manifest hash refuses without mutation',query(sha="repeat('0',64)"),'manifest hash or shape mismatch')
refused('A valid hash cannot authorize a different original Union',query(union=902),'original source or Union scope mismatch')
refused('Missing original club lock refuses before inspection',query(locks=False),'club_lock_not_owned')
refused('A rehashed altered facts manifest still conflicts with accepted authority',query(manifest="jsonb_set(test_inspection_manifest(),'{0,facts}','[]')"),'captured facts or accepted authority mismatch')
refused('Duplicate source identity cannot be counted twice',query(manifest='test_inspection_manifest()||test_inspection_manifest()'),'identity missing or duplicated')
# Deliberate corruption fault, only inside the disposable private fixture. The
# refusal rolls back both the temporary guard suspension and the altered receipt.
corruption="ALTER TABLE ca_commission_contributor_receipts DISABLE TRIGGER USER;UPDATE ca_commission_contributor_receipts SET allocations=allocations||jsonb_build_array(jsonb_build_object('agent_id',test_id(999999))) WHERE source_id=test_id(3100001) AND contributing_user_id=test_id(201);ALTER TABLE ca_commission_contributor_receipts ENABLE TRIGGER USER;"
refused('Extra contributor allocation refuses and rolls back the private corruption fault',query().replace('BEGIN;','BEGIN;'+corruption,1),'do not exactly cover captured hierarchy')
for role in ['anon','authenticated','service_role']:
 refused('Private inspector refuses '+role+' execution','SET ROLE '+role+";SELECT ca_accounting_readiness_private.inspect_known_sources('00000000-0000-0000-0000-000000000901','2026-08-31T07:00Z','2026-09-07T07:00Z','2026-09-07','[]',repeat('0',64),'{}');",'permission denied for schema ca_accounting_readiness_private')
source(3100002,'2','2026-08-31T13:00:00Z','2026-09-01T13:00:00Z')
r=inspect('omitted_banked_source',manifest='test_inspection_manifest(test_id(3100002))')
check('Reverse bank coverage detects an omitted accepted source','bank_source_omitted_from_manifest' in kinds(r) and r['known_rows_complete'] is False)
batch(3100002);admit(3100002);release_all();agents();players()
source(3100003,'.06','2026-08-31T14:00:00Z','2026-09-01T14:00:00Z');batch(3100003);admit(3100003);release_all();agents();players();r=inspect('fractional_attribution')
check('Exact fractional rights remain visible after actual cumulative cents payments',r['known_rows_complete'] and r['known_attribution']['club']['remaining_exact']==Decimal('.004') and r['known_attribution']['agent']['remaining_exact']==Decimal('.012') and r['known_attribution']['player']['remaining_exact']==Decimal('.009'))
check('Attribution is explicitly separate from spendable cash and finality',r['amounts_are_attribution_not_new_spendable_cash'] and not r['common_finality'])
source(3100004,'2','2026-09-06T12:00:00Z','2026-09-07T07:00:00Z');r=inspect('bank_boundary')
check('A bank receipt exactly at the period end belongs outside the half-open interval',r['sources_outside_bank_window']==1 and r['known_rows_complete'])
source(3100005,'2','2026-09-07T01:00:00Z','2026-09-07T06:00:00Z');batch(3100005);admit(3100005);release_all();agents();players();r=inspect('future_earning_week')
check('Closed bank funding does not invent admissions for a still-open earning week',r['future_earning_contributors']==2 and r['known_rows_complete'] and r['known_attribution']['agent']['exact']==Decimal('2.842'))
before=r['known_attribution'];sql("UPDATE tables SET union_id=test_id(902) WHERE id=test_id(950);UPDATE agents SET player_rakeback_rate=.10 WHERE id=test_id(103);");r=inspect('current_terms_changed')
check('Current table Union and agent terms cannot rewrite original inspected rights',r['known_attribution']==before and r['known_rows_complete'])
# A one-cent two-contributor allocation leaves one captured contributor at zero.
# Lower club funding terms make the positive contributor overpromised, while the
# actual owner still classifies the zero exact entitlement as eligible.
sql("UPDATE tables SET union_id=test_id(901) WHERE id=test_id(950);UPDATE agents SET player_rakeback_rate=.15 WHERE id=test_id(103);UPDATE union_clubs SET rate_cash=.10 WHERE union_id=test_id(901) AND club_id=test_id(900);")
source(3100006,'.01','2026-08-31T15:00:00Z','2026-09-01T15:00:00Z');batch(3100006)
zero_player=sql('SELECT player_id FROM ca_cash_commission_facts WHERE hand_id=test_id(3100006) AND rake_credit=0;')
assert zero_player and '\n' not in zero_player
r=inspect('zero_credit_missing_rows')
zero_gaps={g['kind'] for g in r['gaps'] if g.get('hand_id')==sql('SELECT test_id(3100006);') and g.get('player_id')==zero_player}
check('Allocator zero-credit contributor still requires a lot and captured hierarchy accruals',{'missing_funding_lot','missing_recipient_accrual'}<=zero_gaps and 'unresolved_or_overpromised_original_rights' not in zero_gaps)
admit(3100006);r=inspect('zero_credit_actual_admission')
zero_gaps={g['kind'] for g in r['gaps'] if g.get('hand_id')==sql('SELECT test_id(3100006);') and g.get('player_id')==zero_player}
check('Actual source owner admits the same zero-credit expected rows despite higher captured hierarchy rate',not {'missing_funding_lot','missing_recipient_accrual','unresolved_or_overpromised_original_rights'}&zero_gaps and sql("SELECT contract_state FROM ca_source_funding_lots WHERE hand_id=test_id(3100006) AND rake_credit=0;")=='eligible')
check('Positive overpromised original rights remain explicitly unresolved','unresolved_or_overpromised_original_rights' in kinds(r) and not r['known_rows_complete'])
# Actual acceptance without the subsequent bank owner must remain incomplete.
sql("SELECT set_config('test.funding_accepted_at','2026-08-31T16:00:00Z',false);SELECT test_owner_amount(3100007,2);")
r=inspect('accepted_without_bank')
check('Accepted source without a matching bank receipt cannot appear complete','missing_bank_receipt' in kinds(r) and not r['known_rows_complete'])
check('Inspector creates no settlement period completion rows',sql('SELECT count(*) FROM settlement_periods;')=='0')
proof={'schema_version':1,'production_applied':False,'common_finality':False,'passing':len(checks),'checks':checks,'source_sha256':hashlib.sha256((here/'01-known-source-inspector.sql').read_bytes()).hexdigest(),'probe_sha256':hashlib.sha256((here/'native-probe.py').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256((here/'run-local.sh').read_bytes()).hexdigest(),'owner_setup_sha256':hashlib.sha256(owner_setup.encode()).hexdigest(),'outer_commit':os.environ['INSPECTOR_OUTER_COMMIT'],'source_commit':'d5300be77e19d08b887b3b851946c5c244b77ad9','payer_commit':'c12f993244b1f6b01dd950a8e8fee2b0de07ffef','original_payer_commit':'7adbfb02544b68ccc1754c51f11d2f61fa406180','composed_inputs':{kind:{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file() and p.suffix!='.log'} for kind,root in {'source':source_input,'payer':payer,'outer':outer}.items()},'fixture_inputs':{str(p.relative_to(Path(os.environ['ROUND1_INPUT']))):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(os.environ['ROUND1_INPUT']).rglob('*') if p.is_file()},'limits':['Known-source row completeness only; producer and global bank period completeness are not claimed.','Synthetic identities, terms and historical calendar stamps; real accepted/bank/release/agent/player owners.','Known-source slice attribution is not another spendable cash balance.','Raw fractions and future earning rights remain in their existing compatible pools.','No period, invoice, actor or capability activation.']}
(here/'snapshots.json').write_text(json.dumps(snapshots,indent=2,default=str)+'\n');(here/'native-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'passing':len(checks),'common_finality':False}),flush=True)
