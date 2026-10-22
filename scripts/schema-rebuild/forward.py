"""One exact pending schema transition, after independent baseline equality."""
import copy,hashlib,json
from pathlib import Path
PATH='supabase/migrations/20261022162545_the_hourly_sweep_reads_each_ledger_leg_once.sql'
SOURCE_SHA='79dd6ab3923df1c5a85825c4153385a0a79b66235efdacdf61264784fe3da3d3'
DELTA_SHA='1073170e13e3966564d60ad63d861fa87793ddeca588daa7d39af531f8fafacb'
PREIMAGES={'fn_chip_drift_since_baseline':'6e7f006fb462ab5e008f94a6d6df63e8','fn_bbj_conservation_check':'ffbdd5f2fab8e7a8f8dbd32a667a0b5a','fn_chip_integrity_report':'f87b9efb48d0bb8930358fabb7ebd870','fn_ca_payout_rows_without_money':'7d1f46dce13044b7cb90823ed08e1be4','fn_tournament_prize_disbursement_audit':'d62ceae6005e91ab678155a826bc50e5','fn_ca_conservation_sweep':'81995d0a3590cab15132df5b1ef609e8','fn_ledger_liveness':'222ef060dbfe6e7c4a4c2a37cb0cfda5','fn_unaccounted_seat_exits':'9b4bd9fcada25292668ed80c5ccf7a0c'}
TABLES={'ca_ledger_audit_marks','ca_ledger_audit_member_net','ca_ledger_audit_bbj_pool'}
INDEX_TABLES={'idx_wallet_tx_credit_user_created_amount':'wallet_transactions','idx_tournament_escrow_overlay_in':'tournament_escrow','idx_ca_bbj_pool_snapshots_baseline':'ca_bbj_pool_snapshots'}
def validate(root,entries):
 if len(entries)!=1 or entries[0]!=dict(path=PATH,sha256=SOURCE_SHA,state='pending-at-capture'):raise ValueError('Only the exact reviewed hourly-sweep schema transition is admitted')
 if hashlib.sha256((Path(root)/PATH).read_bytes()).hexdigest()!=SOURCE_SHA:raise ValueError('Pending schema source bytes differ')
 return entries

def load_delta(base):
 source=(Path(base)/'pending-hourly-sweep-catalog.json').read_bytes()
 if hashlib.sha256(source).hexdigest()!=DELTA_SHA:raise ValueError('Independent pending catalog contract differs')
 return json.loads(source)

def expected_catalog(reference,delta):
 result=copy.deepcopy(reference)
 for name,before in PREIMAGES.items():
  matches=[r for r in reference['routines'] if r['schema']=='public' and r['name']==name]
  if len(matches)!=1 or matches[0]['definition_md5']!=before:raise ValueError('Pending routine preimage differs: '+name)
 if {r['name'] for r in delta['relations']}!=TABLES or len(delta['routines'])!=7 or len(delta['indexes'])!=3 or len(delta['comments'])!=3:raise ValueError('Pending catalog delta shape differs')
 if any(r['schema']=='public' and r['name'] in TABLES for r in reference['relations']):raise ValueError('Pending table already exists')
 if any(r['schema']=='public' and r['name']=='fn_ca_ledger_audit_checkpoint_advance' for r in reference['routines']):raise ValueError('Pending routine already exists')
 result['relations']+=copy.deepcopy(delta['relations'])
 for index in delta['indexes']:
  table=INDEX_TABLES[index['name']];relation=next(r for r in result['relations'] if r['schema']=='public' and r['name']==table)
  if any(i['name']==index['name'] for i in relation['indexes'] or []):raise ValueError('Pending index already exists')
  relation['indexes']=(relation['indexes'] or [])+[copy.deepcopy(index)];relation['indexes'].sort(key=lambda i:i['name'])
 names={r['name'] for r in delta['routines']}
 if names!={'fn_ca_ledger_audit_checkpoint_advance'}|set(PREIMAGES)-{'fn_ledger_liveness','fn_unaccounted_seat_exits'}:raise ValueError('Pending routine set differs')
 result['routines']=[r for r in result['routines'] if not(r['schema']=='public' and r['name'] in names)]+copy.deepcopy(delta['routines'])
 result['comments']+=copy.deepcopy(delta['comments'])
 result['relations'].sort(key=lambda r:(r['schema'],r['name']));result['routines'].sort(key=lambda r:(r['schema'],r['name'],r['args']));result['comments'].sort(key=lambda r:r['object'])
 return result
