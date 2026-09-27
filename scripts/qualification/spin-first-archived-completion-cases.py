"""Completion-specific isolated scenarios through existing owned Sessions only."""
import copy,hashlib,re,time
KINDS=('original','bank_intervals')
FAULTS=('own_parent','own_child','own_noop','own_offset','deferred_commit')
def require(x,m):
 if not x:raise ValueError(m)
def fault_source(source,kind,P,B):
 require(kind in FAULTS,'unknown completion fault')
 if kind=='deferred_commit':
  # Explicitly synthetic temporary constraint; no production owner weakened.
  ddl="""CREATE TEMP TABLE completion_commit_fault (n integer) ON COMMIT DROP;
CREATE FUNCTION pg_temp.completion_commit_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN RAISE EXCEPTION 'ISOLATED_COMPLETION_DEFERRED_FAULT' USING ERRCODE='PZ005'; END $fault$;
CREATE CONSTRAINT TRIGGER completion_commit_fault AFTER INSERT ON completion_commit_fault
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.completion_commit_fault();
"""
  source=source.replace("SET LOCAL statement_timeout='20s';", "SET LOCAL statement_timeout='20s';\n"+ddl,1)
  # The financial owners/constraint checks finish first; COMMIT must fail AFTER
  # the genuine will-commit SELECT was emitted. Never count that row as commit.
  return source.replace("SELECT current_setting('ca.first_archived_completion_evidence')", "SET CONSTRAINTS completion_commit_fault DEFERRED;\nINSERT INTO completion_commit_fault VALUES(1);\nSELECT current_setting('ca.first_archived_completion_evidence')",1)
 if kind=='own_offset':
  injection="  IF phase=0 THEN UPDATE public.union_wallets SET rake_wallet=rake_wallet+1 WHERE id='"+B.ROW+"'; UPDATE public.union_wallets SET rake_wallet=rake_wallet-1 WHERE id='"+B.ROW+"'; END IF;\n"
  require(source.count(P.BANK_FAULT_ANCHOR)==1,'completion offset anchor differs')
  return source.replace(P.BANK_FAULT_ANCHOR,"  EXECUTE format('SET LOCAL ROLE %I',original_role);\n"+injection+' END LOOP;',1)
 return B.derived_source(source,kind,P)
def wait_operation(worker,observer,key,deadline):
 while time.monotonic()<deadline:
  w=observer.json("SELECT jsonb_build_object('worker',"+str(worker.pid)+",'holder',pg_backend_pid(),'blockers',to_jsonb(pg_blocking_pids("+str(worker.pid)+")),'waiting',EXISTS(SELECT 1 FROM pg_locks WHERE pid="+str(worker.pid)+" AND locktype='advisory' AND objsubid=1 AND classid::bigint=((("+key+")>>32)&4294967295) AND objid::bigint=(("+key+")&4294967295) AND NOT granted),'held',EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND objsubid=1 AND classid::bigint=((("+key+")>>32)&4294967295) AND objid::bigint=(("+key+")&4294967295) AND granted));".replace('SELECT1','SELECT 1'))
  if w['waiting'] and w['held'] and w['blockers']==[observer.pid]:return w
  require(worker.poll() is None,'completion returned before barrier');time.sleep(.01)
 raise TimeoutError('completion actual advisory ownership not observed')
def validate_fault(c,M,P,A,B):
 require(c['derived_source']==fault_source((M.ROOT/M.SQL).read_text(),c['kind'],P,B) and c['derived_sha256']==hashlib.sha256(c['derived_source'].encode()).hexdigest(),'completion fault source differs')
 require(c['rollback_output']=='true' and c['before']['rows']==c['after']['rows'],'completion fault did not restore whole rows')
 if c['kind']=='deferred_commit':
  raw=c['original_output'];require(not re.search(r'(?:WARNING|FATAL|PANIC):',raw),'unexpected deferred fault diagnostic');require(re.findall(r'ERROR:  ([A-Z0-9]{5}): ([^\n]+)',raw)==[('PZ005','ISOLATED_COMPLETION_DEFERRED_FAULT')],'actual deferred COMMIT failure absent')
  A.validate_fee_notice('\n'.join(l for l in raw.splitlines() if 'NOTICE:' in l))
  lines=[l for l in raw.splitlines() if l.startswith('{')];require(len(lines)==1,'will-commit envelope not actually emitted before deferred failure')
  d=M.modules()[2].decode_json(lines[0]);require(d['kind']=='first_archived_completion_before_commit_v1' and d['commit_observed'] is False,'deferred result misrepresented');xid=d['transaction_id']
 else:
  d=B.parse_fault(c['original_output'],P,A);xid=d['transaction_id']
  expected=copy.deepcopy(d['before'][0]);expected['rake_wallet']+=0 if c['kind'] in ('own_noop','own_offset') else 1
  require(d['inside']==[expected],'completion own fault amount differs')
 require(c['transaction_status']=={'transaction_id':xid,'status':'aborted'},'completion fault xid not aborted')
 return xid


def recovery_query(P):
 return "SELECT jsonb_build_object('admission',(SELECT to_jsonb(a) FROM smarter_private.spin_archived_first_admission a WHERE tournament_id='"+P.C.EVENT+"'),'status',(SELECT pg_xact_status(admitted_xid::text::xid8) FROM smarter_private.spin_archived_first_admission WHERE tournament_id='"+P.C.EVENT+"'),'receipt',public.fn_ca_tournament_terminal_receipt('"+P.C.EVENT+"','"+P.C.WINNER+"'));"
def replay_query(P):
 return "BEGIN; SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true); SELECT set_config('request.headers','{\"x-smarter-data-actor\":\"service\",\"x-smarter-data-protocol\":\"1\"}',true); SELECT set_config('request.method','POST',true); SELECT set_config('request.path','/rpc/fn_complete_first_archived_spin',true); SET LOCAL ROLE service_role; SELECT smarter_private.fn_smarter_data_api_pre_request(); SELECT public.fn_complete_first_archived_spin('"+P.OPERATION+"','"+P.C.SOURCE+"'); COMMIT;"

def run(e,worker,observer,external,snapshot,M,P,A,R,kind,deadline):
 B=P.C.load('completion_bank_existing',P.ROOT/'scripts/qualification/spin-first-archived-bank-races.py');Q=M.modules()[2]
 require(kind in KINDS,'unknown completion schedule')
 source=(M.ROOT/M.SQL).read_text();c={'kind':kind,'source':source,'source_sha256':M.SQL_SHA,'original_before':observer.json(snapshot),'production_sql_executed':False,'isolated_commit':True,'synthetic_overlay':kind!='original','historical_fixture_claimed':False,'faults':[],'writers':[],'readbacks':[],'pids':{'worker':worker.pid,'observer':observer.pid}};e['completion']=c
 require(c['original_before']['rows']==e['fee_protocol'][-1]['after']['rows'],'completion original baseline differs')
 if kind!='original':
  c['pids']['external']=external.pid;c['seed_before']=c['original_before']['rows'][B.REL];require(c['seed_before']==[],'completion original bank must be empty')
  observer.no_errors(observer.command("INSERT INTO public.union_wallets(id,union_id,chip_balance,rake_wallet,bbj_wallet,promo_wallet,insurance_wallet,spin_reserve_wallet) VALUES('"+B.ROW+"','"+B.UNION+"',0,0,0,0,0,0);"))
  c['seeded']=observer.json(snapshot);expected=copy.deepcopy(c['original_before']['rows']);expected[B.REL]=c['seeded']['rows'][B.REL];require(expected==c['seeded']['rows'],'synthetic seed unrelated writes')
  seed=expected[B.REL];require(len(seed)==1 and seed[0]['id']==B.ROW and all(seed[0][k]==0 for k in P.BANK.FINANCIAL),'synthetic zero bank differs')
  setup=(P.ROOT/P.C.PROBE).read_text();setup=setup[setup.index('CREATE FUNCTION pg_temp.archive_financial_snapshot()'):setup.index('CREATE TEMP TABLE archive_before')]
  external.no_errors(external.command("SET timezone='UTC';\n"+setup+'\n'+P.C.SEQUENCE_SQL))
  for fk in FAULTS:
   f={'kind':fk,'before':observer.json(snapshot),'derived_source':fault_source(source,fk,P,B)};c['faults'].append(f);f['derived_sha256']=hashlib.sha256(f['derived_source'].encode()).hexdigest();f['original_output']=worker.command(f['derived_source'])
   if fk=='deferred_commit':
    lines=[l for l in f['original_output'].splitlines() if l.startswith('{')];require(len(lines)==1,'deferred financial envelope missing');xid=Q.decode_json(lines[0])['transaction_id']
   else:xid=B.parse_fault(f['original_output'],P,A)['transaction_id']
   f['rollback_output']=worker.command(('' if fk=='deferred_commit' else 'ROLLBACK; ')+'SELECT to_jsonb(pg_current_xact_id_if_assigned() IS NULL);');f['after']=observer.json(snapshot);f['transaction_status']=observer.json("SELECT jsonb_build_object('transaction_id','"+xid+"','status',pg_xact_status('"+xid+"'::xid8));");validate_fault(f,M,P,A,B)
 c['before']=observer.json(snapshot)
 derived=B.derived_source(source,'external_replay_blocked',P) if kind=='bank_intervals' else source;c['derived_source']=derived;c['derived_sha256']=hashlib.sha256(derived.encode()).hexdigest()
 def start_writer(label):
  external.no_errors(external.command('BEGIN;'));w={'label':label,'transaction_id':external.json('SELECT to_jsonb(pg_current_xact_id()::text);'),'application':external.json("SELECT to_jsonb(current_setting('application_name'));"),'before':external.json("SELECT to_jsonb(rake_wallet) FROM public.union_wallets WHERE id='"+B.ROW+"';")};c['writers'].append(w);return w
 update="UPDATE public.union_wallets SET rake_wallet=rake_wallet+1 WHERE id='"+B.ROW+"';"
 def finish_writer(w):
  w['outside_before']=observer.json(snapshot)['rows'];w['inside_rows']=external.json(snapshot)['rows'];w['after']=external.json("SELECT to_jsonb(rake_wallet) FROM public.union_wallets WHERE id='"+B.ROW+"';")
  external.no_errors(external.command('COMMIT;'));w['status']=observer.json("SELECT to_jsonb(pg_xact_status('"+w['transaction_id']+"'::xid8));");w['outside_after']=observer.json(snapshot)['rows'];w['journal_additions']=B.external_delta(w['outside_before'],w['outside_after'],w,w['application']);require(w['inside_rows']==w['outside_after'],'external commit state changed')
 if kind=='bank_intervals':
  # Acquire both synthetic observation barriers; actual canonical lease and bank
  # owners remain untouched. Cleanup releases these through the existing owner.
  observer.no_errors(observer.command('SELECT pg_advisory_lock('+B.OPKEY+'); SELECT pg_advisory_lock('+B.REPLAY_KEY+');'));e['completion_barriers']=[B.OPKEY,B.REPLAY_KEY]
  worker.start(derived);c['operation_wait']=wait_operation(worker,observer,B.OPKEY,deadline)
  wa=start_writer('A');external.no_errors(external.command(update));finish_writer(wa)
  c['operation_release']=observer.json('SELECT to_jsonb(pg_advisory_unlock('+B.OPKEY+'));');e['completion_barriers'].remove(B.OPKEY)
  c['replay_wait']=wait_operation(worker,observer,B.REPLAY_KEY,deadline)
  wb=start_writer('B');external.start(update)
  while time.monotonic()<deadline:
   wait=observer.json("SELECT jsonb_build_object('pid',pid,'blockers',to_jsonb(pg_blocking_pids(pid)),'wait_event',wait_event,'worker_blockers',to_jsonb(pg_blocking_pids("+str(worker.pid)+")),'waiting_xids',(SELECT coalesce(jsonb_agg(transactionid::text),'[]'::jsonb) FROM pg_locks WHERE pid="+str(external.pid)+" AND locktype='transactionid' AND NOT granted)) FROM pg_stat_activity WHERE pid="+str(external.pid)+";")
   if wait['blockers']==[worker.pid] and wait['waiting_xids'] and wait['worker_blockers']==[observer.pid]:break
   require(external.poll() is None,'external writer not blocked');time.sleep(.01)
  else:raise TimeoutError('canonical completion row blocker absent')
  c['external_wait']=wait;c['replay_release']=observer.json('SELECT to_jsonb(pg_advisory_unlock('+B.REPLAY_KEY+'));');e['completion_barriers'].remove(B.REPLAY_KEY);c['original_output']=worker.wait();external.no_errors(external.wait())
 else:c['original_output']=worker.command(derived)
 d=M.parse_original(c['original_output'],native=True);c['envelope']=d
 def readback(label):
  query=M.bind(d);raw=observer.command(query);observer.no_errors(raw);lines=[l for l in raw.splitlines() if l.startswith('{')];require(len(lines)==1,'completion readback absent');result=Q.decode_json(lines[0]);v=M.validate(d,result);c['readbacks'].append({'label':label,'query':query,'query_sha256':hashlib.sha256(query.encode()).hexdigest(),'original_output':raw,'evidence':result,'validation':v})
 readback('committed_before_B' if kind=='bank_intervals' else 'committed')
 if kind=='bank_intervals':
  # B has updated but is UNCOMMITTED: first independent read still sees A.
  c['B_in_progress_at_first_readback']=observer.json("SELECT to_jsonb(pg_xact_status('"+wb['transaction_id']+"'::xid8));")
  finish_writer(wb);readback('after_B')
  wc=start_writer('C');external.no_errors(external.command(update));finish_writer(wc);readback('after_C')
 c['after']=observer.json(snapshot)
 recovery=recovery_query(P)
 c['unknown_ack_recovery_query']=recovery;c['unknown_ack_recovery']=observer.json(recovery)
 # This represents an explicit subsequent duplicate call, not a blind attempt
 # to resolve an unknown first acknowledgment. Recovery above performs no write.
 request=replay_query(P)
 c['replay_query']=request;c['replay_output']=worker.command(request);worker.no_errors(c['replay_output']);c['after_replay']=observer.json(snapshot);require(c['after']==c['after_replay'],'committed replay changed full rows or sequences');validate(c,M,P,A,R)

def validate(c,M,P,A,R):
 B=P.C.load('completion_bank_existing_validate',P.ROOT/'scripts/qualification/spin-first-archived-bank-races.py');Q=M.modules()[2];kind=c['kind'];require(kind in KINDS,'completion schedule differs')
 source=(M.ROOT/M.SQL).read_text();require(c['source']==source and c['source_sha256']==M.SQL_SHA,'completion original source differs')
 derived=B.derived_source(source,'external_replay_blocked',P) if kind=='bank_intervals' else source
 require(c['derived_source']==derived and c['derived_sha256']==hashlib.sha256(derived.encode()).hexdigest(),'completion scenario source differs')
 require(c['production_sql_executed'] is False and c['historical_fixture_claimed'] is False and c['isolated_commit'] is True and c['synthetic_overlay'] is (kind!='original'),'completion scope differs')
 d=M.parse_original(c['original_output'],native=True);require(Q.equal(d,c['envelope']),'completion original envelope differs');top=d['transaction_id']
 require(c['after']==c['after_replay'],'committed duplicate changed rows/sequences')
 require(c['unknown_ack_recovery_query']==recovery_query(P) and c['replay_query']==replay_query(P),'recovery/replay source differs')
 recovery=c['unknown_ack_recovery'];require(recovery['status']=='committed' and Q.equal(recovery['admission'],d['inside']['smarter_private.spin_archived_first_admission'][0]) and Q.equal(recovery['receipt'],d['response']),'unknown-ack immutable recovery differs')
 replies=[Q.decode_json(x) for x in c['replay_output'].splitlines() if x.startswith('{')];matches=[x for x in replies if isinstance(x,dict) and x.get('tournament_id')==P.C.EVENT];require(len(matches)==1 and Q.equal(matches[0],d['response']),'same-op canonical replay differs')
 labels=['committed_before_B','after_B','after_C'] if kind=='bank_intervals' else ['committed'];require([r['label'] for r in c['readbacks']]==labels,'completion observation intervals missing')
 for i,r in enumerate(c['readbacks']):
  require(r['query']==M.bind(d) and r['query_sha256']==hashlib.sha256(r['query'].encode()).hexdigest(),'committed observation query differs');require(not re.search(r'(?:NOTICE|ERROR|WARNING|FATAL|PANIC):',r['original_output']),'committed readback diagnostic differs')
  lines=[x for x in r['original_output'].splitlines() if x.startswith('{')];require(len(lines)==1,'committed observation row count');actual=Q.decode_json(lines[0]);require(Q.equal(actual,r['evidence']) and Q.equal(M.validate(d,actual),r['validation']),'committed observation replay differs')
  require(r['validation']['bank_transition']==('external committed version' if kind=='bank_intervals' and i>0 else 'unchanged' if kind=='bank_intervals' else 'unchanged empty scope'),'completion bank interval attribution differs')
 if kind=='original':require(c['faults']==c['writers']==[],'original completion contains synthetic cases');return True
 require([f['kind'] for f in c['faults']]==list(FAULTS),'completion faults missing')
 seed=c['seeded']['rows'];expected=copy.deepcopy(c['original_before']['rows']);expected[B.REL]=seed[B.REL];require(c['seed_before']==[] and expected==seed and len(seed[B.REL])==1,'synthetic initial scope differs')
 require(seed[B.REL][0]['id']==B.ROW and seed[B.REL][0]['union_id']==B.UNION and all(type(seed[B.REL][0][k]) in (int,__import__('decimal').Decimal) and seed[B.REL][0][k]==0 for k in P.BANK.FINANCIAL),'synthetic zero bank differs')
 previous=seed
 for f in c['faults']:require(f['before']['rows']==previous,'fault initial custody changed');validate_fault(f,M,P,A,B);previous=f['after']['rows']
 require(c['before']['rows']==previous,'completion starting custody differs')
 for key in ('operation_wait','replay_wait'):
  w=c[key];require(w['worker']==c['pids']['worker'] and w['holder']==c['pids']['observer'] and w['blockers']==[w['holder']] and w['waiting'] is True and w['held'] is True,'actual completion barrier missing')
 require(c['operation_release'] is True and c['replay_release'] is True,'completion barrier release missing');w=c['external_wait'];require(w['pid']==c['pids']['external'] and w['blockers']==[c['pids']['worker']] and w['worker_blockers']==[c['pids']['observer']] and w['wait_event']=='transactionid' and w['waiting_xids']==[top],'actual external bank owner missing')
 require(c['B_in_progress_at_first_readback']=='in progress','B already committed at first readback')
 require([w['label'] for w in c['writers']]==['A','B','C'] and len({w['transaction_id'] for w in c['writers']})==3,'external transaction identity inventory differs')
 for w in c['writers']:
  require(type(w['before']) in (int,__import__('decimal').Decimal) and type(w['after']) in (int,__import__('decimal').Decimal) and w['after']==w['before']+1,'external money metadata differs')
  require(w['status']=='committed' and int(w['transaction_id'])>int(top) and w['transaction_id']!=top,'external original transaction not committed')
  additions=B.external_delta(w['outside_before'],w['outside_after'],w,w['application']);require(additions==w['journal_additions'] and w['inside_rows']==w['outside_after'],'external journal/source custody differs')
 require(P.BANK.validate_history(d['bank_observations'],top)==['external committed version','unchanged'],'A not observed in canonical transaction')
 for i,w in enumerate(c['writers']):
  obs=c['readbacks'][i]['evidence']['committed_bank_witness']['bank_observation'];require(obs['rows'][0]['full_xid']==w['transaction_id'],'readback did not observe exact external writer')
 return True
