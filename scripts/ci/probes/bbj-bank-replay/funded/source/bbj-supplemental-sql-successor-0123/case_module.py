"""Dormant BBJ case; root invokes only after independent case/adapter acceptance."""
from decimal import Decimal
from uuid import UUID
import json,re
from packet_contract import HERE,CASE,ACTOR,CLUB,read,require,verify_authorization
from pair_support import parse_command
from supplemental import supplemental_preflight
from noninterference import unchanged,validate_idempotency,validate_events,preserve_detectors,additions,preserve_producer_scope
SELECTED=(CASE,)
MAX_ROWS=512;MAX_BYTES=4194304;MAX_TOTAL_ROWS=4096;MAX_TOTAL_BYTES=16777216
AMOUNT=Decimal('100')
GUARD_SETTINGS=('app.ledger_autoskip_clubs','app.ledger_autoskip_bbj_pools','app.ledger_autoskip_club_members','app.ledger_maintenance','app.club_retirement_maintenance','app.bypass_wallet_guard','app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_hand_id','app.ledger_table_id','app.ledger_tournament_id','app.ledger_tournament','app.ledger_correlation','app.ledger_settlement','app.ledger_idempotency_key')
def literal(v):return 'NULL' if v is None else "'"+str(v).replace("'","''")+"'"
def dec(v):
 d=Decimal(str(v));require(d.is_finite(),'Nonfinite monetary observation');return d

def capture(c):
 """All47 fingerprints and raw rows, plus separate config and detector outputs.
 No blanket id assumption: deterministic whole-row ordering handles composites.
 Bounds are admitted before extraction in one real read-only snapshot.
 """
 contract=read('FINGERPRINT-CONTRACT.json');financial=contract['financial_and_control_relations']
 require(len(financial)==len(set(financial))==47,'Exact47 relation contract required')
 relations=financial+contract['separate_real_configuration_outputs']+['public.ca_account_snapshots','public.ca_currency_meter']
 c.sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='10s'")
 result={'raw':{},'financial':{},'sizes':{}};total_rows=total_bytes=0;kinds={}
 try:
  for name in relations:
   require(re.fullmatch(r'[a-z_]+\.[a-z_]+',name) is not None,'Invalid fixed relation')
   kind=c.one('SELECT to_jsonb(relkind) FROM pg_class WHERE oid=to_regclass('+literal(name)+')');kinds[name]=kind
   extra="||jsonb_build_object('_xmin',t.xmin::text)" if kind in ('r','p','m') else ''
   size=c.one("SELECT jsonb_build_object('count',count(*),'bytes',COALESCE(sum(octet_length((to_jsonb(t)"+extra+")::text)),0)) FROM "+name+' t')
   require(type(size['count']) is int and type(size['bytes']) is int and 0<=size['count']<=MAX_ROWS and 0<=size['bytes']<=MAX_BYTES,'Relation read bound exceeded: '+name)
   total_rows+=size['count'];total_bytes+=size['bytes'];require(total_rows<=MAX_TOTAL_ROWS and total_bytes<=MAX_TOTAL_BYTES,'Aggregate snapshot bound exceeded')
   result['sizes'][name]=size
  for name in relations:
   kind=kinds[name]
   extra="||jsonb_build_object('_xmin',t.xmin::text)" if kind in ('r','p','m') else ''
   row=c.one("SELECT jsonb_build_object('rows',COALESCE(jsonb_agg(to_jsonb(t)"+extra+" ORDER BY to_jsonb(t)::text),'[]'::jsonb),'count',count(*),'md5',md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]'))) FROM "+name+' t')
   require(row['count']==result['sizes'][name]['count'],'Snapshot bound/extraction mismatch')
   result['raw'][name]=row['rows']
   if name in financial:result['financial'][name]={'count':row['count'],'md5':row['md5']}
  result['sequences']=c.one("SELECT COALESCE(jsonb_agg(jsonb_build_object('schema',schemaname,'name',sequencename,'last_value',last_value::text,'increment',increment_by::text,'cache',cache_size::text) ORDER BY schemaname,sequencename),'[]'::jsonb) FROM pg_sequences WHERE schemaname IN ('public','smarter_private')")
  result['cut']=c.one("SELECT jsonb_build_object('snapshot',pg_current_snapshot()::text,'isolation',current_setting('transaction_isolation'),'backend',pg_backend_pid())")
  c.sql('COMMIT');return result
 except Exception as primary:
  try:c.sql('ROLLBACK')
  except Exception as cleanup:primary.capture_cleanup_errors=[{'action':'capture rollback','error':str(cleanup)}]
  raise

def rows(s,n):return s['raw']['public.'+n]
def one(s,n):
 v=rows(s,n);require(len(v)==1,'Exactly one actual '+n+' row required');return v[0]
def original_seed(s):
 c=one(s,'clubs');m=one(s,'club_members');p=one(s,'profiles')
 require(c['id']==CLUB and c['owner_id']==ACTOR and c['union_id'] is None and c['is_union'] is False and c['asset']=='chips' and c['lifecycle_status']!='retired','Original standalone club differs')
 require(dec(c['chip_treasury'])==100000 and dec(c['promo_balance'])==dec(c['insurance_balance'])==0,'Original bank balances differ')
 require((m['club_id'],m['user_id'],m['role'],m['status'])==(CLUB,ACTOR,'owner','active') and dec(m['chip_balance'])==0,'Original composite-key owner membership differs')
 require(p['id']==ACTOR and dec(p['diamonds'])==500 and not p.get('is_horse',False) and len(s['raw']['auth.users'])==1,'Original signup500 differs')
 for n in ['bbj_pools','bbj_mini_tiers','club_opening_setups','club_opening_setup_funding','club_leaderboard_settings','leaderboard_reward_program_versions','spin_bonus_pools','unions','union_clubs','union_wallets','agents','table_seats','tables','tournaments']:
  require(rows(s,n)==[],'Unexpected existing '+n)
 grant=one(s,'chip_ledger');policy=one(s,'ca_mint_policy');mints={x['op_id']:x for x in rows(s,'ca_mint_ledger')};key='club-opening-grant:'+CLUB
 require(grant['idempotency_key']==key and dec(grant['amount'])==100000 and grant['from_type']=='issuance_reserve' and grant['from_entity_id'] is None and grant['to_type']=='club_treasury' and grant['to_entity_id']==CLUB,'Original journal grant differs')
 require(policy['id']==1 and policy['per_operation_cap_chips']==policy['rolling_24h_cap_chips']==100000 and policy['per_operation_cap_diamonds']==policy['rolling_24h_cap_diamonds']==500,'Mint policy/caps changed')
 require(set(mints)=={key,'signup:'+ACTOR} and dec(mints[key]['amount'])==100000 and mints[key]['asset']=='chips' and mints[key]['chip_ledger_id']==grant['id'] and dec(mints['signup:'+ACTOR]['amount'])==500 and mints['signup:'+ACTOR]['asset']=='diamonds' and mints['signup:'+ACTOR]['diamond_tx_id'] is not None,'Original mint linkage differs')

 validate_idempotency({'raw':{'public.chip_ledger_idem':[]}},s,[grant])

def producer_sql(operation):
 values=[]
 for name,typ,v in read('CASE-RECIPE.json')['parameters_in_exact_order']:
  if name=='p_operation_id':v=operation
  value=('true' if v else 'false') if type(v) is bool else literal(v)
  values.append(value+'::'+typ)
 return 'SELECT public.fn_complete_club_opening_setup('+','.join(values)+')'

def validate_club_transition(before,after):
 old=one(before,'clubs');new=one(after,'clubs')
 expected={'chip_treasury':99900,'tagline':'Original owner BBJ readiness','default_rake_percent':-1,'rake_cap':-1,'bbj_enabled':True,'bbj_rake_enabled':True,'spins_enabled':False,'spins_preseed_amount':0,'spins_wallet_funding':'CHIP_TREASURY'}
 require(set(old)==set(new),'Club column inventory changed')
 require(all(new[k]==v and (type(new[k]) is bool if type(v) is bool else True) for k,v in expected.items()),'Exact original producer club configuration differs')
 require(dec(old['chip_treasury'])==100000 and dec(old['promo_balance'])==dec(new['promo_balance'])==dec(old['insurance_balance'])==dec(new['insurance_balance'])==0,'Unrelated club balances changed')
 allowed=set(expected)|{'updated_at','_xmin'}
 require(all(new[k]==v for k,v in old.items() if k not in allowed),'Unrelated club field changed')
 require(new.get('updated_at') is not None and re.fullmatch(r'\d+',new.get('_xmin','')) is not None,'Club timestamp/xmin missing')

def validate_producer(before,after,reply,operation):
 validate_club_transition(before,after)
 wanted=dict(success=True,already_completed=False,club_id=CLUB,club_bank_after=99900,allocated=100,bbj_seeded=100,spin_seeded=0,promo_budget=0,promotion_id=None,leaderboard_rewards_enabled=False,leaderboard_prize_budget=0,operation_id=operation)
 require(all(reply.get(k)==v for k,v in wanted.items()),'Actual opening receipt differs')
 pool=one(after,'bbj_pools');require(str(UUID(pool['id']))==pool['id'] and pool['id']!=CLUB and pool['club_id']==CLUB and pool['union_id'] is None,'Actual pool identity differs')
 require(pool['main_balance']==100 and pool['backup_balance']==pool['promo_balance']==pool['pool_amount']==0 and pool['mini_reserve_floor']==5000 and pool['status']=='active','Actual pool amounts/config differ')
 require(one(after,'clubs')['chip_treasury']==99900 and dec(one(after,'clubs')['chip_treasury'])+dec(pool['main_balance'])==100000,'Actual bank debit/counted selected supply differs')
 funding=one(after,'club_opening_setup_funding');setup=one(after,'club_opening_setups');settings=one(after,'club_leaderboard_settings');version=one(after,'leaderboard_reward_program_versions')
 require(all(funding[k]==v for k,v in dict(club_id=CLUB,operation_id=operation,destination='bbj_main',amount=100,balance_after=100,created_by=ACTOR).items()),'Actual original funding differs')
 require(setup['club_id']==CLUB and setup['owner_id']==ACTOR and setup['last_operation_id']==operation and setup['bbj_seeded_amount']==100 and setup['spin_seeded_amount']==setup['promo_budget']==setup['leaderboard_prize_budget']==setup['leaderboard_seed_remaining']==0,'Setup budget/key differs')
 require(settings['club_id']==CLUB and settings['rewards_enabled'] is False and settings['weekly_prizes']==settings['monthly_prizes']==[],'Display-only settings differ')
 require(version['club_id']==CLUB and version['operation_id']==operation and version['version']==1 and version['rewards_enabled'] is False and version['weekly_prizes']==version['monthly_prizes']==[],'Actual program version differs')
 old={x['id']:x for x in rows(before,'chip_ledger')};now={x['id']:x for x in rows(after,'chip_ledger')}
 require(all(now.get(k)==v for k,v in old.items()),'Original opening grant/xmin changed')
 legs=[v for k,v in now.items() if k not in old];require(len(legs)==2,'Two genuine new journal legs required')
 for e in read('CASE-RECIPE.json')['expected_journal']:
  e={k:pool['id'] if v=='<actual_pool_id>' else v for k,v in e.items()}
  found=[]
  for leg in legs:
   if all((dec(leg[k])==dec(v) if k in ['amount','pre_from_balance','post_from_balance','pre_to_balance','post_to_balance'] and v is not None else leg[k]==v) for k,v in e.items()):found.append(leg)
  require(len(found)==1,'Original routing leg labels/balances differ')
 require(legs[0]['created_at']==legs[1]['created_at'] and all(re.fullmatch(r'\d+',x['_xmin']) for x in legs),'Actual journal timestamp/xmin missing')
 validate_idempotency(before,after,legs);validate_events(before,after);preserve_detectors(before,after)
 # Xmins need not equal one another or the allocated top-level transaction id.
 return pool,legs

def ordinary_and_aliases(c,pool,legs):
 t=c.one('SELECT to_jsonb(created_at::text) FROM public.chip_ledger WHERE id='+literal(legs[0]['id']))
 require(c.one('SELECT count(*) FROM public.chip_ledger WHERE created_at='+literal(t)+'::timestamptz')==2,'Unrelated timestamp cohort')
 actual=c.one("SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY account_key NULLS LAST),'[]'::jsonb) FROM public.fn_ca_leg_accounts("+literal(t)+"::timestamptz-interval '1 microsecond',"+literal(t)+'::timestamptz) a')
 expected=read('CASE-RECIPE.json')['expected_accounts'];require(len(actual)==3,'Full ordinary account cohort must include unkeyable')
 for e in expected:
  e={k:v.replace('<actual_pool_id>',pool['id']) if isinstance(v,str) else v for k,v in e.items()};matches=[a for a in actual if a['account_key']==e['account_key']]
  require(len(matches)==1,'Original account key differs');a=matches[0]
  require(all(dec(a[k])==dec(v) if k=='net' else a[k]==v for k,v in e.items()),'Original net/legs/unkeyable differs')
 aliases=[]
 absent='7beef002-0002-4000-8000-000000000099'
 for identity,want in [(pool['id'],100),(CLUB,None),(absent,None)]:
  value=c.one("SELECT COALESCE(to_jsonb(public.fn_ca_account_balance('bbj_pool',"+literal(identity)+"::uuid,NULL,'bbj_pools.main_balance')),'null'::jsonb)")
  aliases.append({'identity':identity,'balance':value});require(value==want,'Actual BBJ pool/negative alias differs')
 for col in ['backup_balance','promo_balance']:
  require(c.one("SELECT to_jsonb(public.fn_ca_account_balance('bbj_pool',"+literal(pool['id'])+"::uuid,NULL,'bbj_pools."+col+"'))")==0,'Inactive BBJ balance differs')
 return {'timestamp':t,'accounts':actual,'aliases':aliases,'routing_residual':'SEQ06-GAP-SIDE-FILTERS','economic_loss_claim':False}

def notes(s):
 m=re.fullmatch(r'moved ([^,]+), journal ([^,]+), unexplained ([^ ]+) this interval \(cumulative ([^,]+), judged ([^)]+)\) since (.+)',s['note']);require(m is not None,'Original replay note differs');return tuple(dec(v) for v in m.groups()[:5])
def run_pair(c,driver,combined,observations,phase,bank,keys,unkeyable,expected=None):
 before=capture(c)
 require(expected is not None,'Fixed prior observation required');unchanged(expected,before);preserve_detectors(expected,before)
 out=combined();event={'phase':phase,'combined_command':out,'before':before,'committed_command':False};observations.append(event)
 require(type(out) is dict and out.get('single_request') is True and type(out.get('stdout')) is str and type(out.get('stderr')) is str and len(out['stdout'].encode())<=MAX_BYTES and len(out['stderr'].encode())<=MAX_BYTES,'Bounded original combined command required')
 replay,meter=parse_command(out,driver);event['committed_command']=True;after=capture(c);event.update(replay=replay,meter=meter,after=after)
 new=rows(after,'ca_account_snapshots');newrows=additions(before,after,'ca_account_snapshots')
 meters=additions(before,after,'ca_currency_meter')
 state={'snapshots':new,'currencies':meters,'treasury':one(after,'clubs')['chip_treasury'],'wallet':one(after,'club_members')['chip_balance'],'incidents':len(rows(after,'ca_drift_incidents')),'file_failures':len(rows(after,'ca_incident_file_failures')),'journal_failures':c.one('SELECT count(*) FROM public.ca_ledger_write_failures'),'freezes':len(rows(after,'ca_payout_freeze'))}
 driver.balanced({'replay':replay,'meter':meter,'state':state},bank,'0',False)
 require(len(newrows)==len(keys) and {x['account_key'] for x in newrows}==set(keys),'Complete original snapshot account selection differs')
 require(len(meters)==3 and {x['currency'] for x in meters}=={'vip_points','agent_commissions','rakeback'} and all(x['at']==meter['at'] for x in meters),'Complete meter timestamp/currencies differ')
 require(replay['unkeyable_legs']==unkeyable and replay['basis_version']=='one-snapshot-v4' and replay['rebaselined']==0,'Original replay residual/basis differs')
 unchanged(before,after);return replay,{x['account_key']:x for x in newrows}

def full_metadata(c,callback):
 result=callback(c)
 require(type(result) is dict and result.get('passed') is True and result.get('original_identity_count')==327 and result.get('original_edge_count')==2957 and result.get('registry_checks')==16 and result.get('prerequisites_passed') is True,'Complete original327/2957/prerequisite/16-registry evidence required')
 return {'original':result,'supplemental':supplemental_preflight(c)}

def execute_prepared_case(case,connect,seed,base_driver,authorization,combined=None,metadata_check=None):
 verify_authorization(authorization,base_driver,seed)
 require(case==CASE and callable(combined) and callable(metadata_check),'Original combined pair and full metadata callbacks required')
 operation=str(UUID(authorization['operation_id']));events=[];observations=[];connections=[]
 result={'case':CASE,'status':'RUNNING','events':events,'observations':observations,'commit_status':'NOT_ATTEMPTED','effects_committed':False,'whole_original_case_qualified':False,'native_financial_foundation_qualified':False,'failures':[]}
 writer=None;initial=None;post_before=None
 def connection(label):
  c=connect(label,events);connections.append(c);return c
 try:
  observer=connection('bbj_observer');writer=connection('bbj_writer')
  boundary=observer.one("SELECT jsonb_build_object('database',current_database(),'database_oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'role',current_user,'socket',inet_server_addr() IS NULL,'replication',current_setting('session_replication_role'))")
  require(boundary==dict(database=authorization['database'],database_oid=authorization['database_oid'],role='postgres',socket=True,replication='origin'),'Root-owned database/OID boundary differs')
  observations.append({'boundary':boundary,'preflight':full_metadata(observer,metadata_check)})
  seed();initial=capture(observer);observations.append({'original':initial});original_seed(initial)
  require(rows(initial,'ca_account_snapshots')==rows(initial,'ca_currency_meter')==[],'Transplanted detector outputs')
  bank='club_treasury:'+CLUB+':clubs.chip_treasury'
  replay,baseline=run_pair(observer,base_driver,combined,observations,'BEFORE','100000',{bank},0,initial)
  require(replay['baselines']==1 and replay['checked']==0 and baseline[bank]['is_baseline'] is True and baseline[bank]['balance']==100000,'Original bank baseline differs')
  post_before=observations[-1]['after']
  cut=base_driver.begin_writer(writer);writer.sql('SET CONSTRAINTS ALL IMMEDIATE')
  actor=writer.one("SELECT jsonb_build_object('current_user',current_user,'session_user',session_user,'uid',auth.uid(),'role',auth.role())")
  require(actor==dict(current_user='postgres',session_user='postgres',uid=ACTOR,role='service_role'),'Original synthetic owner claim differs')
  context=writer.one("SELECT jsonb_object_agg(n,COALESCE(current_setting(n,true),'')) FROM unnest(ARRAY["+','.join(literal(x) for x in GUARD_SETTINGS)+']) n')
  require(set(context)==set(GUARD_SETTINGS) and all(v=='' for v in context.values()),'Inherited producer-changing context')
  observations.append({'producer_top_xid':cut,'actor':actor,'context':context})
  reply=writer.one(producer_sql(operation));observations.append({'producer_reply':reply})
  # Existing writer transaction: capture raw produced relations without BEGIN/COMMIT.
  produced={};produced_rows=produced_bytes=0
  contract=read('FINGERPRINT-CONTRACT.json')
  all_relations=contract['financial_and_control_relations']+contract['separate_real_configuration_outputs']+['public.ca_account_snapshots','public.ca_currency_meter']
  require(len(all_relations)==len(set(all_relations))==51,'Exact full raw producer inventory required')
  for name in all_relations:
   require(re.fullmatch(r'[a-z_]+\.[a-z_]+',name) is not None,'Invalid fixed producer relation')
   kind=writer.one('SELECT to_jsonb(relkind) FROM pg_class WHERE oid=to_regclass('+literal(name)+')')
   extra="||jsonb_build_object('_xmin',t.xmin::text)" if kind in ('r','p','m') else ''
   sz=writer.one("SELECT jsonb_build_object('n',count(*),'b',COALESCE(sum(octet_length((to_jsonb(t)"+extra+")::text)),0)) FROM "+name+' t')
   require(type(sz['n'])is int and type(sz['b'])is int and 0<=sz['n']<=MAX_ROWS and 0<=sz['b']<=MAX_BYTES,'Produced raw bound exceeded')
   produced_rows+=sz['n'];produced_bytes+=sz['b'];require(produced_rows<=MAX_TOTAL_ROWS and produced_bytes<=MAX_TOTAL_BYTES,'Produced aggregate bound exceeded')
   produced[name]=writer.one("SELECT COALESCE(jsonb_agg(to_jsonb(t)"+extra+" ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM "+name+' t')
   require(type(produced[name])is list and len(produced[name])==sz['n'],'Produced raw bound/extraction mismatch')
  after={'raw':produced};observations.append({'uncommitted_raw':after});pool,legs=validate_producer(post_before,after,reply,operation);preserve_producer_scope(post_before,after)
  invisible=capture(observer);observations.append({'independent_uncommitted':invisible});unchanged(post_before,invisible);preserve_detectors(post_before,invisible)
  result.update(commit_status='ATTEMPTED',effects_committed=None);writer.sql('COMMIT');result.update(commit_status='COMMITTED',effects_committed=True)
  fresh=connection('bbj_durable');committed=capture(fresh);observations.append({'durable':committed})
  require(all(committed['raw'][n]==v for n,v in produced.items()),'Fresh committed rows/xmins differ')
  preserve_detectors(post_before,committed)
  unchanged(post_before,committed,{'public.clubs','public.bbj_pools','public.club_opening_setup_funding','public.club_opening_setups','public.club_leaderboard_settings','public.leaderboard_reward_program_versions','public.chip_ledger','public.chip_ledger_idem'})
  observations.append({'ordinary_and_aliases':ordinary_and_aliases(fresh,pool,legs)})
  poolkey='bbj_pool:'+pool['id']+':bbj_pools.main_balance'
  detector_cut=committed
  for phase in ['FIRST-POSITIVE','STABLE']:
   try:
    rr,ss=run_pair(fresh,base_driver,combined,observations,phase,'99900',{bank,poolkey},2,detector_cut)
    if phase=='FIRST-POSITIVE':require(rr['baselines']==1 and rr['checked']==1 and ss[poolkey]['is_baseline'] is True and ss[poolkey]['balance']==100 and ss[bank]['is_baseline'] is False and ss[bank]['balance']-baseline[bank]['balance']==-100 and notes(ss[bank])==(-AMOUNT,-AMOUNT,Decimal(0),Decimal(0),Decimal(0)),'First positive100/original treasury visibility differs; preserve SEQ05 failure')
    else:require(rr['baselines']==0 and rr['checked']==2 and all(not x['is_baseline'] and notes(x)==(Decimal(0),)*5 for x in ss.values()) and ss[poolkey]['balance']==100 and ss[bank]['balance']==99900,'Stable original baseline/delta differs')
    detector_cut=observations[-1]['after']
   except Exception as exc:
    result['failures'].append({'phase':phase,'type':type(exc).__name__,'error':str(exc),'sqlstate':getattr(exc,'sqlstate',None),'capture_cleanup_errors':getattr(exc,'capture_cleanup_errors',[])})
    event=next((x for x in reversed(observations) if x.get('phase')==phase),{})
    if event.get('committed_command') is not True:raise # uncertain pair outcome is not a retry invitation
  final=capture(fresh);unchanged(committed,final);preserve_detectors(detector_cut,final);observations.append({'final':final,'postflight':full_metadata(fresh,metadata_check)})
  result['status']='FAIL' if result['failures'] else 'PASS_IMPLEMENTED_SUBSET'
  result['residual']='SEQ06-GAP-SIDE-FILTERS';result['money_loss_claim']=False
 except Exception as exc:
  result['status']='FAIL';result['failures'].append({'type':type(exc).__name__,'error':str(exc),'sqlstate':getattr(exc,'sqlstate',None),'capture_cleanup_errors':getattr(exc,'capture_cleanup_errors',[])})
 finally:
  cleanup=[]
  if writer is not None:
   try:writer.sql('ROLLBACK')
   except Exception as exc:cleanup.append({'action':'writer rollback','error':str(exc)})
  if initial is not None and result['commit_status']=='NOT_ATTEMPTED':
   try:
    proof=connection('bbj_failure_fresh');snap=capture(proof);observations.append({'rollback_fresh':snap});unchanged(initial,snap)
    preserve_detectors(post_before if post_before is not None else initial,snap)
    require(all(initial['raw'][n]==snap['raw'][n] for n in read('FINGERPRINT-CONTRACT.json')['separate_real_configuration_outputs']),'Failed producer configuration effects did not roll back')
   except Exception as exc:cleanup.append({'action':'fresh rollback proof','error':str(exc)})
  elif result['commit_status']=='ATTEMPTED':
   result['status']='FAIL';result['commit_status']='UNCERTAIN';result['effects_committed']=None
   try:observations.append({'uncertain_commit_fresh':capture(connection('bbj_uncertain_fresh'))})
   except Exception as exc:cleanup.append({'action':'uncertain commit readback','error':str(exc)})
  for c in connections:
   for action,fn in [('rollback',lambda c=c:c.sql('ROLLBACK')),('reset/unlock',lambda c=c:c.sql('RESET ALL; SELECT pg_advisory_unlock_all()')),('close',lambda c=c:c.close())]:
    try:fn()
    except Exception as exc:cleanup.append({'connection':c.label,'action':action,'error':str(exc)})
  result['connection_stderr']={c.label:c.errors for c in connections};result['cleanup_errors']=cleanup
  if cleanup:result['status']='FAIL'
 return result
