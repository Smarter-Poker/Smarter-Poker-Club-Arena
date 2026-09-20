"""Exact selected producer effects; immutable old raw rows include physical xmins."""
import re
from datetime import datetime
from uuid import UUID
from packet_contract import ACTOR,CLUB,read,require
CONFIG=('public.audit_trail','public.game_management_events')
WATCHED=('name','description','is_public','requires_approval','default_rake_percent','rake_cap','allow_straddle','allow_run_it_twice','allow_rabbit_hunt','min_buyin_bb','max_buyin_bb','logo_url','bbj_rake_enabled','spins_enabled','spins_preseed_amount','spins_wallet_funding','settings','tagline','lobby_message')
PRODUCER_ALLOWED={'public.clubs','public.bbj_pools','public.club_opening_setup_funding','public.club_opening_setups','public.club_leaderboard_settings','public.leaderboard_reward_program_versions','public.chip_ledger','public.chip_ledger_idem'}
def rows(s,n):return s['raw']['public.'+n]
def physical(row):
 value=row.get('_xmin');require(type(value)is str and re.fullmatch(r'[1-9][0-9]*',value) is not None,'Physical xmin required')
def indexed(s,n,key):
 values=rows(s,n);result={}
 for row in values:
  physical(row);require(key in row and row[key] is not None and row[key] not in result,'Missing/duplicate '+n+' identity')
  result[row[key]]=row
 return result

def additions(before,after,n,key='id'):
 old=indexed(before,n,key);new=indexed(after,n,key)
 require(all(new.get(k)==v for k,v in old.items()),'Original '+n+' row/body/xmin changed')
 return [v for k,v in new.items() if k not in old]

def preserve_configuration(a,b):
 for n in CONFIG:require(a['raw'][n]==b['raw'][n],'Configuration/event raw rows or xmins changed: '+n)

def validate_idempotency(before,after,legs):
 added=additions(before,after,'chip_ledger_idem','idempotency_key')
 old=indexed(before,'chip_ledger_idem','idempotency_key');expected={}
 for leg in legs:
  require('idempotency_key' in leg,'Natural journal key column missing')
  key=leg['idempotency_key']
  if key is None:continue
  require(type(key)is str and key not in old and key not in expected,'Original unique-key trigger would refuse')
  require(leg.get('created_at') is not None,'Selected journal timestamp missing')
  expected[key]={'idempotency_key':key,'leg_id':leg['id'],'created_at':leg['created_at']}
 require(len(added)==len(expected),'Missing/unrelated idempotency additions')
 for row in added:
  wanted=expected.get(row['idempotency_key'])
  require(wanted is not None and set(row)==set(wanted)|{'_xmin'} and all(row[k]==v for k,v in wanted.items()),'Exact trigger-derived keyed leg mapping differs')
 # Xmins may be subtransaction IDs. New mappings are retained, then compared
 # byte-for-byte at durability/detector cuts; never require top-level xid equality.

def timestamp(value):
 require(type(value)is str,'Timestamp missing')
 stamp=datetime.fromisoformat(value.replace('Z','+00:00'));require(stamp.tzinfo is not None,'Timestamp timezone missing');return stamp

def uuid(value):
 require(type(value)is str and str(UUID(value))==value,'Canonical natural UUID missing')

def validate_events(before,after):
 old=rows(before,'clubs');new=rows(after,'clubs');require(len(old)==len(new)==1,'Exact producer club required');old,new=old[0],new[0]
 require(old['owner_id']==new['owner_id']==ACTOR and old['union_id'] is None and new['union_id'] is None,'Standalone owner event scope required')
 # The complete initial seed verifies no union_clubs; full unchanged financial
 # comparison independently preserves it. Uncommitted after contains only effects.
 require(rows(before,'union_clubs')==[],'Unexpected union membership scope')
 events=additions(before,after,'game_management_events','sequence');audits=additions(before,after,'audit_trail')
 for snap in [before,after]:
  ids=[x['event_id'] for x in rows(snap,'game_management_events')];require(len(ids)==len(set(ids)),'Duplicate management event UUID')
 require(len(events)==1 and len(audits)==2,'Exact one management event and two audit additions required')
 event=events[0]
 wanted=dict(event_type='club_identity_changed',scope_kind='club',scope_id=CLUB,club_id=CLUB,union_id=None,recipient_id=None,entity_type='clubs',entity_id=CLUB,command_id=None,actor_id=ACTOR,payload={'operation':'update'})
 require(set(event)==set(wanted)|{'sequence','event_id','created_at','_xmin'} and all(event[k]==v for k,v in wanted.items()),'Actual producer management event differs')
 require(type(event['sequence'])is int and event['sequence']>0,'Natural positive event sequence required');uuid(event['event_id'])
 names=('tagline','lobby_message','description');require(all(k in old and k in new for k in names),'Complete club content fields required')
 changed=[k for k in WATCHED if old.get(k)!=new.get(k)]
 require(changed and any(old[k]!=new[k] for k in names),'Selected producer must emit real content/settings changes')
 expected={
  'club_identity_changed':dict(target_type='clubs',before_state={k:old[k] for k in names},after_state={k:new[k] for k in names}),
  'update_club_settings':dict(target_type='club',before_state={k:old.get(k) for k in changed},after_state={k:new.get(k) for k in changed})}
 require({x['action'] for x in audits}==set(expected),'Actual producer audit actions differ')
 for row in audits:
  wanted=dict(actor_id=ACTOR,actor_role='owner',action=row['action'],target_id=CLUB,club_id=CLUB,agent_id=None,amount=None,currency='CHIPS',reason=None,ip_address=None,user_agent=None,request_id=None,**expected[row['action']])
  require(set(row)==set(wanted)|{'id','created_at','_xmin'} and all(row[k]==v for k,v in wanted.items()),'Exact producer audit body/defaults differ')
  uuid(row['id'])
 # Original defaults use now(), as does the producer's updated_at. Compare
 # timestamps semantically; new row IDs/xmins are natural, not invented expected IDs.
 stamp=timestamp(new['updated_at'])
 require(all(timestamp(x['created_at'])==stamp for x in events+audits),'Producer audit/event timestamp differs')

def unchanged(a,b,allowed=()):
 require(set(a['financial'])==set(b['financial']),'Fingerprint set changed')
 require(all(b['financial'][n]==v for n,v in a['financial'].items() if n not in allowed),'Unexpected financial/control mutation')
 require(all(a['raw'][n]==b['raw'][n] for n in a['financial'] if n not in allowed),'Financial/control raw row or xmin changed')
 if allowed:
  require(set(allowed)==PRODUCER_ALLOWED,'Only exact producer allowance permitted')
  validate_idempotency(a,b,additions(a,b,'chip_ledger'));validate_events(a,b)
 else:preserve_configuration(a,b)

DETECTORS=('ca_account_snapshots','ca_currency_meter')
def preserve_detectors(before,after):
 for name in DETECTORS:
  indexed(before,name,'id');indexed(after,name,'id')
  require(rows(before,name)==rows(after,name),'Detector history row/body/xmin changed outside combined phase: '+name)

def preserve_producer_scope(before,after):
 require(set(before['raw'])==set(after['raw']),'Complete raw producer relation inventory required')
 allowed=PRODUCER_ALLOWED|set(CONFIG)
 for name in before['raw']:
  if name not in allowed:require(before['raw'][name]==after['raw'][name],'Unrelated raw producer row/body/xmin changed: '+name)
 preserve_detectors(before,after)
