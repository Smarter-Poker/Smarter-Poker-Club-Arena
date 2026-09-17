"""Inert, root-owned continuation AFTER a proved original100 opening in a fresh clone.
No seed or opening is executed here. No process, connector, installer or main entrypoint.
The sole financial statement is the genuine main->backup25 function invocation.
"""
from pathlib import Path
from decimal import Decimal
from datetime import datetime
from uuid import UUID
import hashlib,json,re,types
HERE=Path(__file__).resolve().parent
CASE='SEQ08_BBJ_BACKUP_POSITIVE_MAIN_TRANSFER_25'
ACTOR='7beef002-0002-4000-8000-000000000001'
CLUB='7beef002-0002-4000-8000-000000000002'
ABSENT='7beef002-0002-4000-8000-000000000099'
DETECTORS={'public.ca_account_snapshots','public.ca_currency_meter'}
MOVE={'public.bbj_pools','public.chip_ledger','public.ca_bbj_bucket_moves'}
GUARDS=('app.freeze_bypass','app.ledger_autoskip_clubs','app.ledger_autoskip_bbj_pools','app.ledger_autoskip_club_members','app.ledger_maintenance','app.club_retirement_maintenance','app.bypass_wallet_guard','app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_hand_id','app.ledger_table_id','app.ledger_tournament_id','app.ledger_tournament','app.ledger_correlation','app.ledger_settlement','app.ledger_idempotency_key')
def require(v,m):
 if not v:raise AssertionError(m)
def read(n):return json.loads((HERE/n).read_text())
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def literal(v):return "'"+str(v).replace("'","''")+"'"
def dec(v):
 require(type(v) in (int,str,Decimal),'Exact numeric type required');d=Decimal(str(v));require(d.is_finite(),'Finite money required');return d

def canon_uuid(v):require(type(v)is str and str(UUID(v))==v,'Canonical actual UUID required')
def stamp(v):
 require(type(v)is str,'Actual timestamp required');t=datetime.fromisoformat(v.replace('Z','+00:00'));require(t.tzinfo is not None,'Timestamp zone required');return t

def rows(s,n):return s['raw']['public.'+n]
def only(s,n):
 a=rows(s,n);require(len(a)==1,'Exactly one '+n+' required');return a[0]
def physical(row):require(type(row.get('_xmin'))is str and re.fullmatch('[1-9][0-9]*',row['_xmin']) is not None,'Actual physical xmin required')
def additions(a,b,n,key='id'):
 old={};new={}
 for src,dst in [(rows(a,n),old),(rows(b,n),new)]:
  for v in src:
   physical(v);require(v.get(key) is not None and v[key] not in dst,'Missing/duplicate '+n+' identity');dst[v[key]]=v
 require(all(new.get(k)==v for k,v in old.items()),'Old '+n+' row/body/xmin changed')
 return [v for k,v in new.items() if k not in old]
def raw_equal(a,b,except_names=()):
 names=set(read('FINGERPRINT-CONTRACT.json')['financial_and_control_relations'])|DETECTORS|{'public.audit_trail','public.game_management_events'}
 require(set(a['raw'])==set(b['raw'])==names and len(names)==57,'Full57 raw scope required')
 for n in names-set(except_names):require(a['raw'][n]==b['raw'][n],'Unexpected raw body/xmin mutation: '+n)
 for s in (a,b):require(set(s['financial'])==set(read('FINGERPRINT-CONTRACT.json')['financial_and_control_relations']),'Complete53 fingerprints required')
 for n in set(a['financial'])-set(except_names):require(a['financial'][n]==b['financial'][n],'Unexpected fingerprint mutation: '+n)

def capture(c,in_writer=False):
 contract=read('FINGERPRINT-CONTRACT.json');financial=contract['financial_and_control_relations'];names=financial+contract['separate_real_configuration_outputs']+sorted(DETECTORS);limits=contract['limits']
 require(len(names)==len(set(names))==57,'Full bounded inventory required')
 if not in_writer:c.sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='10s'")
 result={'raw':{},'financial':{},'sizes':{}};count=size=0;kinds={}
 try:
  # Admit every relation before any raw extraction. The writer retains its own transaction.
  for n in names:
   require(re.fullmatch('[a-z_]+\\.[a-z_]+',n) is not None,'Fixed relation only')
   kind=c.one('SELECT to_jsonb(relkind) FROM pg_class WHERE oid=to_regclass('+literal(n)+')');require(kind in ('r','p','m','v'),'Missing/unexpected relation '+n);kinds[n]=kind
   x="||jsonb_build_object('_xmin',t.xmin::text)" if kind in ('r','p','m') else ''
   z=c.one("SELECT jsonb_build_object('count',count(*),'bytes',COALESCE(sum(octet_length((to_jsonb(t)"+x+")::text)),0)) FROM "+n+' t')
   require(type(z['count'])is int and type(z['bytes'])is int and 0<=z['count']<=limits['rows_per_relation'] and 0<=z['bytes']<=limits['bytes_per_relation'],'Per-relation bound exceeded')
   count+=z['count'];size+=z['bytes'];require(count<=limits['rows_total'] and size<=limits['bytes_total'],'Aggregate bound exceeded');result['sizes'][n]=z
  for n in names:
   x="||jsonb_build_object('_xmin',t.xmin::text)" if kinds[n] in ('r','p','m') else ''
   v=c.one("SELECT jsonb_build_object('rows',COALESCE(jsonb_agg(to_jsonb(t)"+x+" ORDER BY to_jsonb(t)::text),'[]'::jsonb),'count',count(*),'md5',md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]'))) FROM "+n+' t')
   require(type(v['rows'])is list and len(v['rows'])==v['count']==result['sizes'][n]['count'],'Bound/extraction mismatch');result['raw'][n]=v['rows']
   if n in financial:result['financial'][n]={'count':v['count'],'md5':v['md5']}
  result['sequences']=c.one("SELECT COALESCE(jsonb_agg(jsonb_build_object('schema',schemaname,'name',sequencename,'last_value',last_value::text,'increment',increment_by::text,'cache',cache_size::text) ORDER BY schemaname,sequencename),'[]'::jsonb) FROM pg_sequences WHERE schemaname IN ('public','smarter_private')")
  result['cut']=c.one("SELECT jsonb_build_object('snapshot',pg_current_snapshot()::text,'isolation',current_setting('transaction_isolation'),'backend',pg_backend_pid())")
  if not in_writer:c.sql('COMMIT')
  return result
 except Exception as primary:
  if not in_writer:
   try:c.sql('ROLLBACK')
   except Exception as cleanup:primary.capture_cleanup_errors=[str(cleanup)]
  raise

def verify_authorization(a,driver,seed,opening):
 require(type(a)is dict and a.get('authorized')is True and a.get('case')==CASE and a.get('case_review_accepted')is True and a.get('root_adapter_review_accepted')is True and a.get('supplemental_source_review_accepted')is True,'Independent case, supplemental and root adapter acceptance required')
 require(a.get('packet_sha256')==sha(HERE/'INTEGRITY.json'),'Exact sealed packet authorization required')
 for n,h in read('INTEGRITY.json')['files'].items():
  p=(HERE/n).resolve();require(p.is_relative_to(HERE) and sha(p)==h,'Packet changed')
 pins=read('SOURCE-PINS.json')
 for p in pins:require(sha(p['path'])==p['sha256'],'Pinned source changed: '+p['path'])
 d=next(p for p in pins if p['role']=='original base driver');s=next(p for p in pins if p['role']=='original seed0007')
 require(type(driver)is types.ModuleType and str(Path(driver.__file__).resolve())==d['path'] and driver.ACTOR==ACTOR and driver.CLUB==CLUB,'Exact original driver required')
 require(callable(seed) and a.get('seed_sha256')==s['sha256'],'Root must bind original seed0007; it is not invoked here')
 require(type(opening)is types.ModuleType and str(Path(opening.__file__).resolve())==a.get('opening_module_path'),'Original opening module object required')
 op=next(p for p in pins if p['path'].endswith('/bbj-supplemental-sql-successor-0123/case_module.py'))
 require(str(Path(opening.__file__).resolve())==op['path'] and sha(opening.__file__)==op['sha256'],'Accepted original0123 source required')
 for n in ['validate_producer','original_seed','notes','parse_command']:
  require(callable(getattr(opening,n,None)),'Original opening support missing '+n)
 require(type(a.get('database_oid'))is str and a['database_oid'].isdigit() and type(a.get('database'))is str and a.get('fresh_fixture')is True,'Fresh private fixture boundary required')
 operation=a.get('move_operation');reason=a.get('move_reason')
 require(type(operation)is str and 0<len(operation.strip())<=200 and '\x00' not in operation,'Bounded root-owned move operation required')
 require(type(reason)is str and 10<=len(reason.strip(' '))<=500 and '\x00' not in reason,'Bounded genuine reason required')
 require(operation!=a.get('opening_operation_id'),'Separate opening and move identity required')

def boundary(c,a):
 value=c.one("SELECT jsonb_build_object('database',current_database(),'database_oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'role',current_user,'session_role',session_user,'socket',inet_server_addr() IS NULL,'replication',current_setting('session_replication_role'),'pid',pg_backend_pid(),'backend_start',(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()),'application_name',current_setting('application_name'))")
 wanted=dict(database=a['database'],database_oid=a['database_oid'],role='postgres',session_role='postgres',socket=True,replication='origin')
 require(all(value.get(k)==v for k,v in wanted.items()) and type(value.get('pid'))is int and value['pid']>0 and value.get('backend_start') and value.get('application_name'),'Actual owned backend boundary required')
 return value

def exact(actual,expected):
 if type(expected)is bool:return type(actual)is bool and actual is expected
 if type(expected)is dict:return type(actual)is dict and set(actual)==set(expected) and all(exact(actual[k],v) for k,v in expected.items())
 if type(expected)is list:return type(actual)is list and len(actual)==len(expected) and all(exact(a,b) for a,b in zip(actual,expected))
 return actual==expected

def canonical_relation(v):
 require(type(v)is dict and set(v)=={'relation','metadata'} and type(v['metadata'])is dict,'Exact relation wrapper required')
 m=dict(v['metadata'])
 # Captured query did not ORDER BY index/policy aggregates. Preserve complete
 # records, sort only unordered named attachments, and reject duplicate identities.
 for key in ['indexes','policies','constraints','triggers']:
  require(type(m.get(key))is list and all(type(x)is dict and type(x.get('name'))is str for x in m[key]),'Complete named relation attachment required')
  require(len({x['name'] for x in m[key]})==len(m[key]),'Duplicate relation attachment')
  m[key]=sorted(m[key],key=lambda x:x['name'])
 return {'relation':v['relation'],'metadata':m}

def metadata(c,check):
 r=check(c);require(type(r)is dict and r.get('passed')is True and r.get('original_identity_count')==327 and r.get('original_edge_count')==2957 and r.get('registry_checks')==16 and r.get('prerequisites_passed')is True,'Full original327/2957/prerequisites/16 registry required')
 require(r.get('opening_supplemental_12_functions_6_relations_passed')is True,'Accepted opening supplemental scope required')
 b=r.get('backup',{});require(b.get('source_model_sha256')==sha(HERE/'DEPENDENCY-CONTRACT.json') and b.get('passed')is True and b.get('raw_catalog_observations_retained')is True and b.get('historical_support_scope_matched')is True,'Root must qualify exact supplemental/historical support and preserve raw catalogs')
 # These are independent expected models from sealed source, not expectations made from live rows.
 require(exact(b.get('functions'),[{k:v for k,v in x.items() if k!='raw_pg_proc'} for x in [z['metadata']|{'signature':z['signature']} for z in read('CURRENT-FUNCTIONS.json')]]),'Exact two helper models differ')
 require(type(b.get('relations'))is list and exact([canonical_relation(v) for v in b['relations']],[canonical_relation({'relation':x['relation'],'metadata':x['metadata']}) for x in read('CURRENT-RELATIONS.json')]),'Exact three complete relation models differ')
 require(exact(b.get('trigger_functions'),read('SUPPLEMENTAL-TRIGGER-MODELS.json')) and b.get('all_internal_RI_trigger_modes_and_constraints_passed')is True,'Exact trigger helpers and source-bound RI attachments required')
 require(b.get('sequence_max_text')=='9223372036854775807' and b.get('sequence_config_ownership_acl_passed')is True,'Exact text-preserving sequence proof required')
 return r

def validate_funding(f,s,opening,a):
 require(type(f)is dict and f.get('case')=='SEQ08_BBJ_MAIN_POSITIVE_OPENING_SETUP' and f.get('status')=='PASS_IMPLEMENTED_SUBSET' and f.get('commit_status')=='COMMITTED' and f.get('effects_committed')is True and f.get('failures')==[] and f.get('cleanup_errors')==[],'Real successful funding result required; old actual cannot be replayed')
 obs=f['observations'];base=next(x['original'] for x in obs if 'original'in x);pre=next(x['after'] for x in obs if x.get('phase')=='BEFORE');durable=next(x['durable'] for x in obs if 'durable'in x);final=next(x['final'] for x in obs if 'final'in x);reply=next(x['producer_reply'] for x in obs if 'producer_reply'in x)
 b=next(x['boundary'] for x in obs if 'boundary'in x);require(b['database']==a['database'] and b['database_oid']==a['database_oid'],'Funding belongs to another database')
 opening.original_seed(base);pool,legs=opening.validate_producer(pre,durable,reply,a['opening_operation_id'])
 require(set(final['raw'])==set(s['raw'])-{'public.'+x for x in read('FINGERPRINT-CONTRACT.json')['new_supporting_relations']},'Original51 funding scope required')
 for n,v in final['raw'].items():require(s['raw'][n]==v,'Funding cut mismatch/body/xmin: '+n)
 for n,v in final['financial'].items():require(s['financial'][n]==v,'Original funding fingerprint mismatch')
 for n in read('FINGERPRINT-CONTRACT.json')['new_supporting_relations']:require(rows(s,n)==[],'Original supporting relation must be empty: '+n)
 require({x.get('phase') for x in obs if 'phase'in x}=={'BEFORE','FIRST-POSITIVE','STABLE'},'All original funding detector phases required')
 bank='club_treasury:'+CLUB+':clubs.chip_treasury';main='bbj_pool:'+pool['id']+':bbj_pools.main_balance'
 latest=next(x for x in obs if x.get('phase')=='STABLE');require(latest['replay']['baselines']==0 and latest['replay']['checked']==2 and latest['replay']['unkeyable_legs']==2,'Funding stable detector prerequisite differs')
 require(len(rows(s,'ca_account_snapshots'))==5 and len(rows(s,'ca_currency_meter'))==9,'Full original detector history must be retained')
 require(pool['id'] not in (CLUB,ABSENT) and only(s,'bbj_pools')==pool,'Actual unique pool key required')
 return pool,bank,main

def transfer_sql(pool,operation,reason):
 canon_uuid(pool)
 return 'SELECT public.fn_bbj_move_between_banks('+literal(pool)+"::uuid,'main'::text,'backup'::text,25.00::numeric,"+literal(reason)+'::text,'+literal(operation)+'::text)'

def validate_transfer(before,after,reply,operation,reason,application_name):
 raw_equal(before,after,MOVE)
 old=only(before,'bbj_pools');new=only(after,'bbj_pools');physical(new);canon_uuid(new['id'])
 require(set(old)==set(new) and all(new[k]==v for k,v in old.items() if k not in {'main_balance','backup_balance','updated_at','_xmin'}),'Unrelated pool field changed')
 require(old['id']==new['id'] and new['id'] not in (CLUB,ABSENT) and new['club_id']==CLUB and new['union_id']is None,'Original pool identity changed')
 require(dec(old['main_balance'])==100 and dec(old['backup_balance'])==0 and dec(new['main_balance'])==75 and dec(new['backup_balance'])==25 and dec(new['promo_balance'])==dec(new['pool_amount'])==0,'Exact100->75/25 balances required')
 require(dec(only(after,'clubs')['chip_treasury'])==99900 and sum(dec(new[k]) for k in ['main_balance','backup_balance','promo_balance'])+99900==100000,'Selected original supply not conserved')
 for n in ['bbj_payouts','bbj_unclaimed_shares']:require(rows(before,n)==rows(after,n)==[],'Parked reserve must be genuinely empty')
 receipts=additions(before,after,'ca_bbj_bucket_moves');require(len(receipts)==1,'Exactly one actual bank-move receipt required');receipt=receipts[0]
 want={'pool_id':new['id'],'from_bank':'main','to_bank':'backup','amount':25,'reason':reason.strip(' '),'op_id':operation,'performed_by':ACTOR,'db_role':'postgres'}
 require(set(receipt)==set(want)|{'id','created_at','_xmin'} and all(receipt.get(k)==v for k,v in want.items()),'Exact natural bank-move receipt fields differ')
 require(type(receipt['id'])is int and 0<receipt['id']<=9223372036854775807,'Natural bigint move identity required')
 require(type(reply)is dict and reply.get('ok')is True and reply.get('replayed')is False and reply=={'ok':True,'replayed':False,'move_id':receipt['id'],'amount':25,'from_bank':'main','to_bank':'backup'},'Actual move reply mismatch/replay/refusal')
 legs=additions(before,after,'chip_ledger');require(len(legs)==2,'Exactly two genuine new legs required')
 cols={x['name'] for x in next(t for t in read('ORIGINAL-POOL-JOURNAL-MODELS.json') if t['name']=='chip_ledger')['columns']}|{'_xmin'}
 epochs=[x for x in rows(before,'ca_financial_epochs') if x['is_current']];require(len(epochs)==1,'Exact current original epoch required')
 for col,start,end in [('main_balance',100,75),('backup_balance',0,25)]:
  matches=[x for x in legs if x['from_label']=='bbj_pools.'+col or x['to_label']=='bbj_pools.'+col];require(len(matches)==1,'Exact labeled source/destination leg required');leg=matches[0]
  wanted={k:None for k in cols-{'id','created_at','_xmin','chain_seq','prev_hash','row_hash'}}
  wanted.update(performed_by=ACTOR,from_type='bbj_pool',from_entity_id=new['id'],to_type='bbj_pool',to_entity_id=new['id'],amount=25,category='adjustment',description='auto-ledgered bbj_pools.'+col+' delta '+('-25.00' if col=='main_balance' else '25.00'),club_id=CLUB,union_id=None,epoch_id=epochs[0]['id'],actor_service=application_name,db_role='postgres',status='posted')
  if col=='main_balance':wanted.update(from_label='bbj_pools.main_balance',to_label=None,pre_from_balance=start,post_from_balance=end)
  else:wanted.update(from_label=None,to_label='bbj_pools.backup_balance',pre_to_balance=start,post_to_balance=end)
  require(set(leg)==cols and all(leg[k]==v for k,v in wanted.items()),'Complete original journal defaults/enrichment/labels differ')
  canon_uuid(leg['id']);physical(leg);require(type(leg['chain_seq'])is int and leg['chain_seq']>0 and re.fullmatch('[0-9a-f]{64}',leg['row_hash'] or '') is not None,'Actual chain metadata required')
  require(stamp(leg['created_at'])==stamp(new['updated_at'])==stamp(receipt['created_at']),'Transaction timestamps differ')
 require(len({x['id'] for x in legs})==len({x['chain_seq'] for x in legs})==2,'Distinct natural legs required')
 # NULL keys leave chip_ledger_idem byte-for-byte unchanged via raw_equal; no fabrication.
 # Do not equate any xmin to a top-level xid or to another subtransaction xmin.
 return new,legs,receipt

def ordinary_and_aliases(c,pool,legs):
 t=c.one('SELECT to_jsonb(created_at::text) FROM public.chip_ledger WHERE id='+literal(legs[0]['id'])+'::uuid')
 require(c.one('SELECT count(*) FROM public.chip_ledger WHERE created_at='+literal(t)+'::timestamptz')==2,'Move must have its own exact two-leg timestamp cohort')
 actual=c.one("SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY account_key NULLS LAST),'[]'::jsonb) FROM public.fn_ca_leg_accounts("+literal(t)+"::timestamptz-interval '1 microsecond',"+literal(t)+'::timestamptz) a')
 expected=[]
 for col,net in [('main_balance',-25),('backup_balance',25)]:expected.append(dict(account_key='bbj_pool:'+pool['id']+':bbj_pools.'+col,account_type='bbj_pool',entity_id=pool['id'],club_id=None,column_name='bbj_pools.'+col,net=net,legs=1,unkeyable=0))
 expected.append(dict(account_key=None,account_type='unkeyable',entity_id=None,club_id=None,column_name=None,net=0,legs=2,unkeyable=2))
 require(sorted(actual,key=lambda x:str(x['account_key']))==sorted(expected,key=lambda x:str(x['account_key'])),'Full ordinary net25/-25 and net0/count2 required')
 aliases=[]
 for col,want in [('main_balance',75),('backup_balance',25),('promo_balance',0)]:
  for identity,value in [(pool['id'],want),(CLUB,None),(ABSENT,None)]:
   v=c.one("SELECT COALESCE(to_jsonb(public.fn_ca_account_balance('bbj_pool',"+literal(identity)+"::uuid,NULL,'bbj_pools."+col+"')),'null'::jsonb)");require(v==value,'Pool key/negative club or absent alias differs');aliases.append(dict(column=col,identity=identity,balance=v))
 # The exact original checksum expression is evaluated on real stored fields, preserving PG numeric/time text.
 hashes=c.one("SELECT jsonb_agg(jsonb_build_object('id',l.id,'valid',l.row_hash=encode(extensions.digest('v1'||'|'||l.chain_seq::text||'|'||COALESCE(l.epoch_id::text,'')||'|'||l.amount::text||'|'||l.from_type||':'||COALESCE(l.from_entity_id::text,'')||'|'||l.to_type||':'||COALESCE(l.to_entity_id::text,'')||'|'||l.category||'|'||COALESCE(l.idempotency_key,'')||'|'||COALESCE(l.correlation_id::text,'')||'|'||l.created_at::text,'sha256'),'hex'),'prev_valid',l.prev_hash IS NOT DISTINCT FROM (SELECT p.row_hash FROM public.chip_ledger p WHERE p.chain_seq=l.chain_seq-1))) FROM public.chip_ledger l WHERE l.id IN ("+','.join(literal(x['id'])+'::uuid' for x in legs)+')')
 require(type(hashes)is list and {x['id'] for x in hashes}=={x['id'] for x in legs} and all(x['valid']is True and x['prev_valid']is True for x in hashes),'Original generated row checksum/previous hash differs')
 return dict(timestamp=t,accounts=actual,aliases=aliases,hashes=hashes,residual='SEQ06-GAP-SIDE-FILTERS',economic_loss_claim=False)

def pair(c,driver,opening,combined,observations,phase,prior,bank,main,backup):
 before=capture(c);raw_equal(prior,before);out=combined();event={'phase':phase,'before':before,'combined_command':out,'committed_command':False};observations.append(event)
 require(type(out)is dict and out.get('single_request')is True and type(out.get('stdout'))is str and type(out.get('stderr'))is str and len(out['stdout'].encode())<=4194304 and len(out['stderr'].encode())<=4194304,'Bounded original pair output required')
 replay,meter=opening.parse_command(out,driver);event['committed_command']=True;after=capture(c);event.update(after=after,replay=replay,meter=meter);raw_equal(before,after,DETECTORS)
 snaps=additions(before,after,'ca_account_snapshots');meters=additions(before,after,'ca_currency_meter');bykey={x['account_key']:x for x in snaps}
 require(len(snaps)==3 and set(bykey)=={bank,main,backup},'Exact three original snapshot accounts required')
 require(len(meters)==3 and {x['currency'] for x in meters}=={'vip_points','agent_commissions','rakeback'} and all(x['at']==meter['at'] for x in meters),'Original complete meter output required')
 state={'snapshots':rows(after,'ca_account_snapshots'),'currencies':meters,'treasury':only(after,'clubs')['chip_treasury'],'wallet':only(after,'club_members')['chip_balance'],'incidents':len(rows(after,'ca_drift_incidents')),'file_failures':len(rows(after,'ca_incident_file_failures')),'journal_failures':c.one('SELECT count(*) FROM public.ca_ledger_write_failures'),'freezes':len(rows(after,'ca_payout_freeze'))}
 driver.balanced({'replay':replay,'meter':meter,'state':state},'99900','0',False)
 require(replay['unkeyable_legs']==4 and replay['basis_version']=='one-snapshot-v4' and replay['rebaselined']==0,'Full opening+move routing residual count4 required')
 for key,balance in [(bank,99900),(main,75),(backup,25)]:require(bykey[key]['balance']==balance,'Detector account balance differs')
 if phase=='FIRST-BACKUP-POSITIVE':
  require(replay['baselines']==1 and replay['checked']==2 and bykey[backup]['is_baseline']is True and bykey[backup]['note']=='baseline: first reading of this account, not judged','Backup must be its first real25 baseline')
  require(bykey[main]['is_baseline']is False and opening.notes(bykey[main])==(Decimal(-25),Decimal(-25),Decimal(0),Decimal(0),Decimal(0)),'Original main snapshot must recognize real -25; preserve any subxid failure')
  require(bykey[bank]['is_baseline']is False and opening.notes(bykey[bank])==(Decimal(0),)*5,'Treasury must remain stable')
 else:require(phase=='STABLE-BACKUP' and replay['baselines']==0 and replay['checked']==3 and all(x['is_baseline']is False and opening.notes(x)==(Decimal(0),)*5 for x in snaps),'Stable three-account replay required')
 return after

def execute_prepared_case(case,connect,seed,base_driver,authorization,combined=None,metadata_check=None,opening_module=None,funding_result=None):
 verify_authorization(authorization,base_driver,seed,opening_module)
 require(case==CASE and callable(connect) and callable(combined) and callable(metadata_check),'Root-owned original interfaces required')
 observations=[];events=[];connections=[];identities=[];before=None;writer=None
 result=dict(case=CASE,status='RUNNING',commit_status='NOT_ATTEMPTED',effects_committed=False,observations=observations,events=events,failures=[],whole_seq06_qualified=False,whole_seq08_qualified=False,foundation_qualified=False,native_financial_qualification=False)
 def conn(label):
  c=connect(label,events);connections.append(c) # Immediate ownership, before all validation.
  require(type(c)is base_driver.Psql and c.one.__func__ is base_driver.Psql.one and c.sql.__func__ is base_driver.Psql.sql,'Original real Psql object/methods required')
  b=boundary(c,authorization);require(all(b['pid']!=x['pid'] for x in identities),'Distinct financial backend PIDs required');identities.append(b);observations.append({'connection_boundary':b});return c
 try:
  observer=conn('bbj_backup_observer');writer=conn('bbj_backup_writer');observations.append({'preflight':metadata(observer,metadata_check)})
  before=capture(observer);observations.append({'funded_before':before});pool,bank,main=validate_funding(funding_result,before,opening_module,authorization);backup='bbj_pool:'+pool['id']+':bbj_pools.backup_balance'
  top=base_driver.begin_writer(writer);writer.sql('SET CONSTRAINTS ALL IMMEDIATE')
  actor=writer.one("SELECT jsonb_build_object('current_user',current_user,'session_user',session_user,'uid',auth.uid(),'role',auth.role())")
  require(actor==dict(current_user='postgres',session_user='postgres',uid=ACTOR,role='service_role'),'Original actual owner claims required')
  context=writer.one("SELECT jsonb_object_agg(n,COALESCE(current_setting(n,true),'')) FROM unnest(ARRAY["+','.join(literal(x) for x in GUARDS)+']) n')
  require(set(context)==set(GUARDS) and all(x=='' for x in context.values()),'No inherited producer-changing context')
  observations.append({'top_xid':top,'actor':actor,'context':context})
  # Exactly one real financial helper call; no automatic retry or duplicate business replay.
  reply=writer.one(transfer_sql(pool['id'],authorization['move_operation'],authorization['move_reason']));observations.append({'move_reply':reply})
  produced=capture(writer,True);observations.append({'uncommitted':produced});pool,legs,receipt=validate_transfer(before,produced,reply,authorization['move_operation'],authorization['move_reason'],identities[1]['application_name'])
  invisible=capture(observer);observations.append({'independent_uncommitted':invisible});raw_equal(before,invisible)
  result.update(commit_status='ATTEMPTED',effects_committed=None);writer.sql('COMMIT');result.update(commit_status='COMMITTED',effects_committed=True)
  fresh=conn('bbj_backup_durable');durable=capture(fresh);observations.append({'durable':durable});raw_equal(produced,durable);validate_transfer(before,durable,reply,authorization['move_operation'],authorization['move_reason'],identities[1]['application_name'])
  observations.append({'ordinary_and_aliases':ordinary_and_aliases(fresh,pool,legs)})
  cut=pair(fresh,base_driver,opening_module,combined,observations,'FIRST-BACKUP-POSITIVE',durable,bank,main,backup)
  cut=pair(fresh,base_driver,opening_module,combined,observations,'STABLE-BACKUP',cut,bank,main,backup)
  final=capture(fresh);raw_equal(cut,final);observations.append({'final':final,'postflight':metadata(fresh,metadata_check)})
  result.update(status='PASS_IMPLEMENTED_SUBSET',selected_class='bbj_pools.backup_balance',residual='SEQ06-GAP-SIDE-FILTERS',money_loss_claim=False)
 except Exception as e:
  result['status']='FAIL';result['failures'].append({'type':type(e).__name__,'error':str(e),'sqlstate':getattr(e,'sqlstate',None),'capture_cleanup_errors':getattr(e,'capture_cleanup_errors',[])})
 finally:
  cleanup=[]
  if writer is not None:
   try:writer.sql('ROLLBACK')
   except Exception as e:cleanup.append({'action':'writer rollback','error':str(e)})
  if before is not None and result['commit_status']=='NOT_ATTEMPTED':
   try:
    proof=capture(conn('bbj_backup_failure_fresh'));observations.append({'rollback_fresh':proof});raw_equal(before,proof)
   except Exception as e:cleanup.append({'action':'fresh rollback proof','error':str(e)})
  elif result['commit_status']=='ATTEMPTED':
   result.update(status='FAIL',commit_status='UNCERTAIN',effects_committed=None)
   try:observations.append({'uncertain_commit_fresh':capture(conn('bbj_backup_uncertain_fresh'))})
   except Exception as e:cleanup.append({'action':'uncertain readback','error':str(e)})
  # Every cleanup attempt is independent. Root separately owns actual private DB/OID disposal.
  for c in connections:
   for action,fn in [('rollback',lambda c=c:c.sql('ROLLBACK')),('reset/unlock',lambda c=c:c.sql('RESET ALL; SELECT pg_advisory_unlock_all()')),('close',lambda c=c:c.close())]:
    try:fn()
    except Exception as e:cleanup.append({'connection':getattr(c,'label','unknown'),'action':action,'error':str(e)})
  result['connection_stderr']=[{'label':getattr(c,'label','unknown'),'stderr':getattr(c,'errors',[])} for c in connections];result['cleanup_errors']=cleanup
  if cleanup:result['status']='FAIL'
 return result
