"""Original weekly hand reducers advance finite native parts; no payment simulation."""
import argparse,hashlib,json,os,re,subprocess,tempfile
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/native-weekly-hand-parts'
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',default='/opt/homebrew/opt/postgresql@17/bin');ap.add_argument('--scratch',type=Path,required=True);ap.add_argument('--derive',action='store_true');a=ap.parse_args();pg=Path(a.pg_bin)
def lit(s):return "'"+s.replace("'","''")+"'"
pre=json.loads((F/'actual-preimages.json').read_text());connected=pre['connected'];cases=[]
with tempfile.TemporaryDirectory(prefix='gh-',dir=a.scratch)as tmp:
 root=Path(tmp);sock=root/'s';sock.mkdir();data=root/'d';env={**os.environ,'PGHOST':str(sock),'PGUSER':'postgres','PGDATABASE':'postgres','PGSSLMODE':'disable'}
 def run(cmd,s=None,error=None):
  r=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,env=env,timeout=45)
  if error:assert r.returncode and error in r.stderr,(error,r.stdout,r.stderr)
  else:assert r.returncode==0,(r.stdout,r.stderr)
  return r.stdout.strip()
 ps=[pg/'psql','-XAtq','-v','ON_ERROR_STOP=1']
 def q(s,error=None):return run(ps,s,error)
 def h(sig):return q('SELECT md5(pg_get_functiondef('+lit(sig)+'::regprocedure));')
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 with(data/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\ntimezone='UTC'\nunix_socket_directories='"+str(sock)+"'\n")
 run([pg/'pg_ctl','-D',data,'-l',root/'log','-w','start'])
 try:
  q((F/'setup.sql').read_text())
  for x in connected['functions']:q(x['definition']+';')
  q(pre['linked']+';')
  seen=set()
  for t in pre['immutable']:
   if t['fn'] not in seen:q(t['fn_definition']+';');seen.add(t['fn'])
   schema='smarter_private.' if t['table']=='smarter_private.posthand_escrow_certificates' else 'public.'
   # Captured catalog spells schema separately for escrow, already qualified.
   q(t['definition']+';')
  q("CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_cash_outcomes FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable();")
  # Derivation compiles original full report/advance without executing unrelated
  # report collaborators. Their captured production old failure is retained.
  q("SET check_function_bodies=off;"+pre['flow']+';');q(pre['report']+';');q(pre['advance']+';')
  if a.derive:
   helpers=(F/'new-helpers.sql').read_text();q(helpers)
   hashes={n:h('smarter_private.weekly_hand_parts_'+n+'(uuid,timestamptz,timestamptz,'+('text,boolean)'if n=='read'else'boolean)'))for n in ['witness','reduce','read']}
   for name in ['new-report.sql','new-advance.sql']:
    s=(F/name).read_text()
    for n,v in hashes.items():s=s.replace('__'+n.upper()+'_MD5__',v)
    q(s);hashes['report'if name=='new-report.sql'else'advance']=h('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'if name=='new-report.sql'else'public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)')
   print(json.dumps(hashes));raise SystemExit(0)
  # Production's240s old fullweek failure is retained separately. Locally the
  # exact old advance has no resumable hand stage despite ready earned/flow.
  q("INSERT INTO union_pnl_projection_build(projection,completed_at)VALUES('cash_outcome_touches',now());")
  u="fade0000-0000-0000-0000-000000000001";start='2026-10-12 07:00Z';end='2026-10-19 07:00Z'
  q("""INSERT INTO union_pnl_cash_outcomes SELECT '10000000-0000-0000-0000-000000000001',n,gen_random_uuid(),'2026-10-12 07:00Z'::timestamptz+(n-1)*interval '2 hours',jsonb_build_object('game_union_id','fade0000-0000-0000-0000-000000000001'),jsonb_build_object('accepted_rake',CASE WHEN n%2=0 THEN '0' ELSE '1.25' END,'participants',jsonb_build_array(jsonb_build_object('earning_club_id','20000000-0000-0000-0000-000000000001','user_id','30000000-0000-0000-0000-000000000001','observed_stack_delta','-2.25'),jsonb_build_object('earning_club_id','20000000-0000-0000-0000-000000000002','user_id','30000000-0000-0000-0000-000000000002','observed_stack_delta','1.00'))),'payload' FROM generate_series(1,84)n;
INSERT INTO union_pnl_cash_outcome_touches SELECT table_id,hand_number,recognized_at,game_scope->>'game_union_id',false,evidence->>'accepted_rake',evidence->'participants'FROM union_pnl_cash_outcomes;
INSERT INTO union_pnl_cash_outcomes VALUES('10000000-0000-0000-0000-000000000002',1,gen_random_uuid(),'2026-10-12 09:00Z','{}',jsonb_build_object('accepted_rake','2.50','participants',jsonb_build_array(jsonb_build_object('earning_club_id','20000000-0000-0000-0000-000000000001','user_id','30000000-0000-0000-0000-000000000001','observed_stack_delta','-2.50'))),'linked-payload');
INSERT INTO union_pnl_cash_outcome_link_resolutions SELECT table_id,hand_number,hand_id,payload_hash,md5(evidence::text),jsonb_build_object('game_union_id','fade0000-0000-0000-0000-000000000001'),evidence,md5('{}'::jsonb::text),'{}' FROM union_pnl_cash_outcomes WHERE table_id='10000000-0000-0000-0000-000000000002';""")
  prefix="SET app.weekly_accounting_chunked='on';SET app.accounting_close_memo='on';SET app.weekly_accounting_scope_budget='8 minutes';SET app.weekly_accounting_scope_deadline='2099-01-01';"
  call="SELECT fn_accounting_union_earned_plan_advance('"+u+"','"+start+"','"+end+"');"
  assert q(prefix+call)=='t';assert q("SELECT count(*)FROM accounting_close_partials WHERE kind='pnl_hands_window'")=='0';cases.append('old_owner_has_no_hand_progress_after_ready_flows')
  q((F/'new-helpers.sql').read_text());q((F/'new-report.sql').read_text());q((F/'new-advance.sql').read_text())
  q("REVOKE ALL ON FUNCTION smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean),smarter_private.weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean),smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean) FROM PUBLIC,anon,authenticated;")
  # Force the original stop_at before now: first window commits, next waits.
  first=prefix+"SET app.weekly_accounting_scope_deadline='2000-01-01';"+call
  assert q(first)=='f';assert q("SELECT count(*)FROM accounting_close_partials WHERE kind='pnl_hands_window'")=='1';cases.append('one_original_window_progress_respects_original_budget')
  assert q(prefix+call)=='f';assert q("SELECT count(*)FROM accounting_close_partials WHERE kind='pnl_hands_window'")=='84';assert q(prefix+call)=='t';cases.append('resume_remaining83_last_window_warms_next_attempt_consumes')
  get="SELECT smarter_private.weekly_hand_parts_read('"+u+"','"+start+"','"+end+"','fixture-generation',true);"
  actual=json.loads(q(prefix+get),parse_float=str);full=json.loads(q("SELECT smarter_private.weekly_hand_parts_reduce('"+u+"','"+start+"','"+end+"',true);"),parse_float=str);assert actual==full,(actual,full)
  zero=next(x for x in actual if x['kind']==0);assert zero['hands']==85 and str(zero['rake'])=='55.00',zero
  assert len(actual)==3;cases.append('exact_original_fullweek_reducer_equals84parts_linked_zero_rake_all_players')
  # Read refuses every altered input without silently filling omitted zero fields.
  # Expire against the actual owner lifetime, independent of the fixed book end.
  faults=[('missing_window',"DELETE FROM accounting_close_partials WHERE window_start='2026-10-12 07:00Z';"),('wrong_window_end',"UPDATE accounting_close_partials SET window_end=window_end+interval '1 second' WHERE window_start='2026-10-12 07:00Z';"),('expired_window',"UPDATE accounting_close_partials SET computed_at=clock_timestamp()-public.fn_accounting_close_proof_lifetime()-interval '1 second';"),('wrong_generation',"UPDATE accounting_close_partials SET value=jsonb_set(value,'{generation}','\"wrong\"');"),('wrong_projection',"UPDATE accounting_close_partials SET value=jsonb_set(value,'{projected}','false');"),('wrong_owner_contract',"UPDATE accounting_close_partials SET value=jsonb_set(value,'{contract}','\"wrong\"');"),('corrupt_groups',"UPDATE accounting_close_partials SET value=jsonb_set(value,'{groups}','[]');"),('null_groups',"UPDATE accounting_close_partials SET value=value-'groups';"),('future_computed_at',"UPDATE accounting_close_partials SET computed_at=now()+interval '1 day';"),('late_touch_insert',"INSERT INTO union_pnl_cash_outcome_touches SELECT table_id,999,recognized_at,game_union_id,false,accepted_rake,participants FROM union_pnl_cash_outcome_touches LIMIT 1;"),('late_escrow_certificate',"INSERT INTO smarter_private.posthand_escrow_certificates(table_id,hand_number,hand_id,original,original_sha256) SELECT table_id,hand_number,hand_id,smarter_private.posthand_escrow_original_snapshot(table_id,hand_number),encode(extensions.digest(convert_to(smarter_private.posthand_escrow_original_snapshot(table_id,hand_number)::text,'UTF8'),'sha256'),'hex') FROM union_pnl_cash_outcomes LIMIT 1;"),('late_link_insert',"INSERT INTO union_pnl_cash_outcome_link_resolutions SELECT table_id,999,hand_id,outcome_payload_hash,outcome_evidence_md5,game_scope,evidence,proof_md5,proof FROM union_pnl_cash_outcome_link_resolutions LIMIT 1;")]
  for name,change in faults:
   assert q('BEGIN;'+prefix+change+get)=='',name;cases.append(name+'_refuses_cached_parts')
  # Same exact ordinary+linked semantics without the projected reader.
  q("UPDATE union_pnl_projection_build SET completed_at=NULL;")
  rawget=get.replace(',true);',',false);')
  assert q(prefix+rawget)=='';assert q(prefix+call)=='f';assert q(prefix+call)=='t'
  assert json.loads(q(prefix+rawget),parse_float=str)==json.loads(q("SELECT smarter_private.weekly_hand_parts_reduce('"+u+"','"+start+"','"+end+"',false);"),parse_float=str);cases.append('nonprojected_original_raw_and_linked_exact_equivalence')
  assert q('BEGIN;'+prefix+"INSERT INTO union_pnl_cash_outcomes SELECT table_id,9999,gen_random_uuid(),recognized_at,game_scope,evidence,payload_hash FROM union_pnl_cash_outcomes LIMIT 1;"+rawget)=='';cases.append('nonprojected_late_original_hand_invalidates')
  q("UPDATE union_pnl_projection_build SET completed_at=now();");assert q(prefix+call)=='f';assert q(prefix+call)=='t'
  q('BEGIN;'+prefix+"INSERT INTO accounting_close_partials SELECT kind,union_id,period_start,period_end,window_start-interval '1 second',window_end,value,cash_ids,cash_md5,fee_ids,fee_md5,computed_at FROM accounting_close_partials LIMIT 1;"+call,'weekly_hand_parts_noncanonical_window');cases.append('extra_noncanonical_window_refused')
  q('BEGIN;'+prefix+"DELETE FROM accounting_close_partials WHERE window_start IN('2026-10-12 07:00Z','2026-10-12 09:00Z');INSERT INTO union_pnl_cash_outcome_touches SELECT table_id,99999,'2026-10-12 09:00Z',game_union_id,false,'bad',participants FROM union_pnl_cash_outcome_touches LIMIT 1;"+call,'invalid input syntax for type numeric');assert q("SELECT count(*)FROM accounting_close_partials WHERE kind='pnl_hands_window'")=='84';cases.append('failed_window_rolls_back_no_phantom_progress')
  q('BEGIN;'+prefix+'ALTER TABLE union_pnl_cash_outcome_touches DISABLE TRIGGER original_pnl_immutable;'+get,'weekly_hand_parts_append_only_contract_changed');cases.append('disabled_immutable_trigger_refused')
  q('BEGIN;'+prefix+"SET session_replication_role='replica';"+get,'weekly_hand_parts_original_sources_unqualified');cases.append('replica_mode_refused')
  q('BEGIN;'+prefix+"ALTER FUNCTION fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean) SECURITY INVOKER;"+get,'weekly_hand_parts_original_owners_changed');cases.append('original_hand_owner_hash_refused')
  # Only affected current book club aggregates are invalidated during recompute.
  q("INSERT INTO accounting_close_certificates VALUES('pnl_clubs','"+u+"','"+start+"','"+end+"','{}',now()),('pnl_boundary','"+u+"','"+start+"','"+start+"','{}',now());DELETE FROM accounting_close_partials WHERE window_start='2026-10-12 07:00Z';")
  assert q(first)=='f';assert q("SELECT string_agg(kind,',')FROM accounting_close_certificates")=='pnl_boundary';assert q(prefix+call)=='t';cases.append('missing_window_restart_invalidates_only_current_club_cache')
  q("SET ROLE anon;SELECT smarter_private.weekly_hand_parts_reduce(NULL,NULL,NULL,false);",'permission denied');cases.append('anon_denied_original_owner_helpers')
  # Full original report algebra after hand_players/BBJ and all later checks is
  # byte-identical; the new reader never includes BBJ awards itself.
  new=(F/'new-report.sql').read_text();assert pre['report'].split(' ), hand_players AS',1)[1]==new[:-2].replace("  IF v_hand_parts IS NOT NULL AND smarter_private.weekly_hand_parts_read(p_union_id,p_start,p_end,v_generation,v_cash) IS DISTINCT FROM v_hand_parts THEN\n   RAISE EXCEPTION 'weekly_hand_parts_sources_changed_during_report';END IF;\n",'').split(' ), hand_players AS',1)[1];cases.append('BBJ_and_all_downstream_report_math_exact_original_bytes')
  # The exact guarded installer uses all40 real bound owners, the maintained
  # C installer, and its actual table/type catalog in a separate empty database.
  q('CREATE DATABASE installer;');env['PGDATABASE']='installer'
  ticket=json.loads((R/'scripts/ci/fixtures/ticket-refund-pnl-preimages.json').read_text())
  setup='CREATE SCHEMA smarter_private;SET check_function_bodies=off;'
  for t in ticket['schemas']:setup+='CREATE TABLE public.'+t['relname']+'('+t['columns']+');'
  for f in ticket['source40']+ticket['connected']:setup+=f['definition']+';'
  setup+=';'.join('REVOKE ALL ON FUNCTION '+f['signature']+' FROM PUBLIC,anon,authenticated,service_role'for f in ticket['source40']+ticket['connected'])+';'
  setup+='GRANT EXECUTE ON FUNCTION public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)TO service_role;'
  oldguard=next(f['definition']for f in ticket['definitions']if f['proname']=='original_inventory_proof_sources_match')
  setup+=oldguard+';REVOKE ALL ON FUNCTION smarter_private.original_inventory_proof_sources_match()FROM PUBLIC,anon,authenticated,service_role;'
  q(setup)
  q("SET check_function_bodies=off;"+(R/'supabase/migrations/20261020155211_ticket_refund_pnl_requires_its_original_admission_and_award.sql').read_text())
  # Actual minimal new dependencies used only by the new hand helpers.
  q("CREATE TABLE public.union_pnl_cash_outcome_touches(table_id uuid,hand_number bigint,recognized_at timestamptz,game_union_id text,shaped boolean,accepted_rake text,participants jsonb);CREATE TABLE public.union_pnl_cash_outcome_link_resolutions(table_id uuid,hand_number bigint,hand_id uuid,outcome_payload_hash text,outcome_evidence_md5 text,game_scope jsonb,evidence jsonb,proof_md5 text,proof jsonb);CREATE TABLE smarter_private.posthand_escrow_certificates(table_id uuid,hand_number bigint);CREATE TABLE public.accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea,computed_at timestamptz,PRIMARY KEY(kind,union_id,period_start,period_end,window_start),CONSTRAINT accounting_close_partials_kind_check CHECK(kind=ANY(ARRAY['earned_plan_window'::text,'round2_union_window'::text,'round2_club_window'::text,'round3_union_window'::text,'round3_club_window'::text,'round3_union_plan'::text,'round3_club_plan'::text,'pnl_flows_window'::text])));")
  for x in connected['functions']:
   if 'posthand_escrow_'not in x['sig']:q('SET check_function_bodies=off;'+x['definition']+';')
  q('SET check_function_bodies=off;'+pre['linked']+';')
  migration="SET check_function_bodies=off;"+(R/'supabase/migrations/20261020182843_native_weekly_hand_outcomes_use_original_bounded_parts.sql').read_text()
  assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t'
  q('GRANT EXECUTE ON FUNCTION fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)TO anon;');q(migration,'weekly_hand_parts_original_authority_changed');q('REVOKE EXECUTE ON FUNCTION fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)FROM anon;');cases.append('installer_original_ACL_fault_refused')
  q(migration.replace('COMMIT;','ROLLBACK;'));assert h('fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)')=='7b465b7055e80234bd8c40ed5899f4dd';cases.append('installer_rollback_preserves_original_owners')
  q(migration.replace("'cab1019f5055b42be8f25d1b2fad1736' THEN RAISE EXCEPTION 'weekly_hand_parts_native_postimage_changed'","'00000000000000000000000000000000' THEN RAISE EXCEPTION 'weekly_hand_parts_native_postimage_changed'"),'weekly_hand_parts_native_postimage_changed');assert h('fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)')=='7b465b7055e80234bd8c40ed5899f4dd';cases.append('installer_postimage_fault_atomic_rollback')
  q(migration);assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t';q(migration,'weekly_hand_parts_original_preimage_changed');cases.append('all40_original_source_owners_exact_guard_update_and_replay_refusal')
  assert q("SELECT bool_and(proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}')FROM pg_proc WHERE oid IN('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)'::regprocedure,'smarter_private.weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean)'::regprocedure,'smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)'::regprocedure,'fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure,'smarter_private.original_inventory_proof_sources_match()'::regprocedure)")=='t';cases.append('installer_owner_only_ACLs_and_original_source40_preserved')
  print(json.dumps({'qualification':'passed','cases':cases,'postimages':{n:h('smarter_private.weekly_hand_parts_'+n+'(uuid,timestamptz,timestamptz,'+('text,boolean)'if n=='read'else'boolean)'))for n in ['witness','reduce','read']},'report':h('fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'),'advance':h('fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'),'original_fullweek_and_partial_outcomes':actual,'limits':'Actual original hand-lines/linked/immutable owners and exact original reducer/report downstream bytes. Installer independently loads all40 captured owners and actual C migration; unrelated SQL dependencies are declared with check_function_bodies off and never treated as executed full report proof. Escrow proof collaborators, source40/generation, earned/flow readiness and clock inputs controlled in isolated PG17; full original report runtime/production84windows/newgeneration boundaries and all financial behavior remain separate live proof.'}))
 finally:run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
