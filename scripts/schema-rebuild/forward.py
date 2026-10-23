"""Four exact schema transitions, after independent baseline equality."""
import copy,hashlib,json
from pathlib import Path
PATH='supabase/migrations/20261022162545_the_hourly_sweep_reads_each_ledger_leg_once.sql'
SOURCE_SHA='79dd6ab3923df1c5a85825c4153385a0a79b66235efdacdf61264784fe3da3d3'
DELTA_SHA='1073170e13e3966564d60ad63d861fa87793ddeca588daa7d39af531f8fafacb'
PREIMAGES={'fn_chip_drift_since_baseline':'6e7f006fb462ab5e008f94a6d6df63e8','fn_bbj_conservation_check':'ffbdd5f2fab8e7a8f8dbd32a667a0b5a','fn_chip_integrity_report':'f87b9efb48d0bb8930358fabb7ebd870','fn_ca_payout_rows_without_money':'7d1f46dce13044b7cb90823ed08e1be4','fn_tournament_prize_disbursement_audit':'d62ceae6005e91ab678155a826bc50e5','fn_ca_conservation_sweep':'81995d0a3590cab15132df5b1ef609e8','fn_ledger_liveness':'222ef060dbfe6e7c4a4c2a37cb0cfda5','fn_unaccounted_seat_exits':'9b4bd9fcada25292668ed80c5ccf7a0c'}
TABLES={'ca_ledger_audit_marks','ca_ledger_audit_member_net','ca_ledger_audit_bbj_pool'}
INDEX_TABLES={'idx_wallet_tx_credit_user_created_amount':'wallet_transactions','idx_tournament_escrow_overlay_in':'tournament_escrow','idx_ca_bbj_pool_snapshots_baseline':'ca_bbj_pool_snapshots'}
OPENING_PATH='supabase/migrations/20261022201306_restore_welcome_reserve_reuse_for_quick_club_opening.sql'
OPENING_SHA='c3be2d8375c2aa0c2c20718e4a9a01361b09635c63546b73ef20bfd9a2832a67'
OPENING_DELTA_SHA='5fe7191aa269effeb7916c9343f39c905225ae748e768dbe5340dda58eff88d4'
JOURNAL_PATH='supabase/migrations/20261022223439_adaptive_journal_metadata_cover.sql'
JOURNAL_SHA='1922ecbde6a5cfa600e21d0e48aae8941036bcc08db12af5b263710dee3c6696'
JOURNAL_DELTA_SHA='eae9ee3e9dcc55b84fbb36dadc6175edfc9ab6e2b184da948ce906773b99275f'
PICK_PATH='supabase/migrations/20261022223610_mystery_bounty_pick_refuses_after_the_reveal.sql'
PICK_SHA='93e0b63ef3e7196ac09e41456bc2ce2cd851cd6648d52ec9d318d14425b5238d'
PICK_DELTA_SHA='54b4585fcf3443abb6d1b3d76f36170d8ee9a4720fb8a4c5815edb5b05a44bac'
def entries():
 return [dict(path=PATH,sha256=SOURCE_SHA,state='pending-at-capture'),dict(path=OPENING_PATH,sha256=OPENING_SHA,state='installed-after-capture'),dict(path=JOURNAL_PATH,sha256=JOURNAL_SHA,state='pending-after-capture'),dict(path=PICK_PATH,sha256=PICK_SHA,state='installed-after-capture')]
def validate(root,provided):
 if provided!=entries():raise ValueError('Only the exact ordered hourly-sweep, opening, journal-index and bounty-pick transitions are admitted')
 for entry in provided:
  if hashlib.sha256((Path(root)/entry['path']).read_bytes()).hexdigest()!=entry['sha256']:raise ValueError('Schema transition source bytes differ')
 return provided

def opening_expected(reference,base):
 source=(Path(base)/'post-capture-opening-catalog.json').read_bytes()
 if hashlib.sha256(source).hexdigest()!=OPENING_DELTA_SHA:raise ValueError('Independent opening catalog contract differs')
 delta=json.loads(source);before=delta['before'];names={r['name'] for r in delta['routines']}
 if names!={'fn_complete_club_opening_setup','fn_club_opening_defaults_ready'} or len(delta['routines'])!=2:raise ValueError('Opening catalog delta shape differs')
 matches=[r for r in reference['routines'] if r['schema']=='public' and r['name']==before['name']]
 if matches!=[before]:raise ValueError('Opening routine full preimage differs')
 if any(r['schema']=='public' and r['name']=='fn_club_opening_defaults_ready' for r in reference['routines']):raise ValueError('Opening readiness routine already exists')
 after=next(r for r in delta['routines'] if r['name']==before['name'])
 if {k:v for k,v in before.items() if k!='definition_md5'}!={k:v for k,v in after.items() if k!='definition_md5'}:raise ValueError('Opening patch unexpectedly changes security metadata')
 result=copy.deepcopy(reference)
 result['routines']=[r for r in result['routines'] if not(r['schema']=='public' and r['name'] in names)]+copy.deepcopy(delta['routines'])
 result['routines'].sort(key=lambda r:(r['schema'],r['name'],r['args']))
 return result

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

def journal_expected(reference,base):
 source=(Path(base)/'pending-journal-index-catalog.json').read_bytes()
 if hashlib.sha256(source).hexdigest()!=JOURNAL_DELTA_SHA:raise ValueError('Independent journal index contract differs')
 delta=json.loads(source);before=delta['before'];index=delta['index']
 if delta['sourceSHA256']!=JOURNAL_SHA or index['name']!='horse_adaptive_journal_metadata_cover':raise ValueError('Journal index scope differs')
 matches=[r for r in reference['relations'] if r['schema']=='public' and r['name']=='horse_adaptive_observation_journal']
 if matches!=[before]:raise ValueError('Journal full table preimage differs')
 if any(i['name']==index['name'] for r in reference['relations'] for i in r.get('indexes') or []):raise ValueError('Journal index already exists')
 result=copy.deepcopy(reference);relation=next(r for r in result['relations'] if r['schema']=='public' and r['name']==before['name'])
 relation['indexes'].append(copy.deepcopy(index));relation['indexes'].sort(key=lambda i:i['name'])
 return result

def pick_expected(reference,base):
 source=(Path(base)/'post-capture-pick-catalog.json').read_bytes()
 if hashlib.sha256(source).hexdigest()!=PICK_DELTA_SHA:raise ValueError('Independent pick routine contract differs')
 delta=json.loads(source);before=delta['before'];after=delta['routine']
 if before['schema']!='public' or before['name']!='fn_mystery_bounty_pick' or after['name']!=before['name'] or delta['source']['sha256']!=PICK_SHA:raise ValueError('Pick routine delta scope differs')
 matches=[r for r in reference['routines'] if r['schema']=='public' and r['name']==before['name']]
 if matches!=[before]:raise ValueError('Pick full routine preimage differs')
 if {k:v for k,v in before.items() if k!='definition_md5'}!={k:v for k,v in after.items() if k!='definition_md5'}:raise ValueError('Pick routine security metadata differs')
 result=copy.deepcopy(reference);position=result['routines'].index(before);result['routines'][position]=copy.deepcopy(after)
 return result
