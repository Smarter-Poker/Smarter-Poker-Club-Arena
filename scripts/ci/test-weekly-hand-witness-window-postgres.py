"""Original hand witness ignores unrelated appends; relevant late evidence invalidates."""
import argparse,hashlib,json,os,subprocess,tempfile
from pathlib import Path
R=Path(__file__).resolve().parents[2];F=R/'scripts/ci/fixtures/weekly-hand-witness-window';G=R/'scripts/ci/fixtures/native-weekly-hand-parts'
p=argparse.ArgumentParser();p.add_argument('--scratch',type=Path,required=True);p.add_argument('--pg-bin',default='/opt/homebrew/opt/postgresql@17/bin');p.add_argument('--derive',action='store_true');a=p.parse_args();pg=Path(a.pg_bin);pre=json.loads((F/'actual-preimages.json').read_text());g=json.loads((G/'actual-preimages.json').read_text());cases=[]
def lit(x):return "'"+x.replace("'","''")+"'"
with tempfile.TemporaryDirectory(prefix='ww-',dir=a.scratch)as t:
 t=Path(t);sock=t/'s';sock.mkdir();data=t/'d';env={**os.environ,'PGHOST':str(sock),'PGUSER':'postgres','PGDATABASE':'postgres','PGSSLMODE':'disable'}
 def run(cmd,s=None,error=None):
  r=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,env=env,timeout=45)
  if error:assert r.returncode and error in r.stderr,(error,r.stdout,r.stderr)
  else:assert r.returncode==0,(r.stdout,r.stderr)
  return r.stdout.strip()
 def q(s,error=None):return run([pg/'psql','-XAtq','-v','ON_ERROR_STOP=1'],s,error)
 def h(sig):return q('SELECT md5(pg_get_functiondef('+lit(sig)+'::regprocedure));')
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 with(data/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses=''\ntimezone='UTC'\nunix_socket_directories='"+str(sock)+"'\n")
 run([pg/'pg_ctl','-D',data,'-l',t/'log','-w','start'])
 try:
  q((G/'setup.sql').read_text())
  for x in g['connected']['functions']:q(x['definition']+';')
  q(g['linked']+';');seen=set()
  for x in g['immutable']:
   if x['fn']not in seen:q(x['fn_definition']+';');seen.add(x['fn'])
   q(x['definition']+';')
  q('CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON union_pnl_cash_outcomes FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable();')
  for x in pre:q('SET check_function_bodies=off;'+x['definition']+';')
  # Actual source40 collaborators are controlled only here; the production
  # installer separately guards the exact complete source40 definition.
  q('CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE SET search_path TO pg_catalog AS $$SELECT true$$;')
  q("INSERT INTO union_pnl_projection_build(projection,completed_at)VALUES('cash_outcome_touches',now());")
  u='fade0000-0000-0000-0000-000000000001';other='fade0000-0000-0000-0000-000000000002';start='2026-10-12 07:00Z';end='2026-10-12 09:00Z'
  def witness(projected=True):return "SELECT smarter_private.weekly_hand_parts_witness('"+u+"','"+start+"','"+end+"',"+str(projected).lower()+');'
  # Outcomes deliberately have unresolved scope: only the immutable resolution
  # owns the union for the linked branch. Original recognition owns the window.
  q("INSERT INTO union_pnl_cash_outcomes SELECT '10000000-0000-0000-0000-000000000001',n,gen_random_uuid(),CASE n WHEN 1 THEN '2026-10-12 07:00Z'::timestamptz WHEN 2 THEN '2026-10-12 09:00Z'::timestamptz ELSE '2026-10-12 08:00Z'::timestamptz END,'{}','{}','hash' FROM generate_series(1,3)n;")
  addlink="INSERT INTO union_pnl_cash_outcome_link_resolutions SELECT table_id,hand_number,hand_id,payload_hash,md5(evidence::text),jsonb_build_object('game_union_id','"+u+"'),evidence,md5('{}'::jsonb::text),'{}' FROM union_pnl_cash_outcomes WHERE hand_number="
  old=q(witness());q(addlink+'2;');assert q(witness())!=old;cases.append('actual_old_global_count_invalidates_unrelated_end_boundary_link')
  q((F/'new-witness.sql').read_text());wh=h('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)')
  if a.derive:
   hashes={'witness':wh};oldwh='64731b2855b4ea526d831ca8ab2bc589';oldcontract='53698ac6f78427917d13ae753cbf085c';contract=hashlib.md5(('original-window-scoped-hand-witness-v2:'+wh).encode()).hexdigest();hashes['contract']=contract
   for name in ['read','report','advance','source_guard']:
    x=next(x for x in pre if ('weekly_hand_parts_read('in x['signature']if name=='read'else 'fn_union_pnl_evidence_report('in x['signature']if name=='report'else 'fn_accounting_union_earned_plan_advance('in x['signature']if name=='advance'else 'original_inventory_proof_sources_match('in x['signature']))
    s=x['definition'].replace(oldwh,wh).replace(oldcontract,contract)
    for old,key in [('5e474b2f2faebba54d1d4676e80b82e6','read'),('cab1019f5055b42be8f25d1b2fad1736','report')]:
     if key in hashes:s=s.replace(old,hashes[key])
    (F/('new-'+name+'.sql')).write_text(s+';\n');q(s+';');hashes[name]=h(x['signature'])
   (F/'postimages.json').write_text(json.dumps(hashes,indent=2)+'\n');print(json.dumps(hashes));raise SystemExit
  before=q(witness());q(addlink.replace("'"+u+"'","'"+other+"'")+'3;');assert q(witness())==before;cases.append('unrelated_union_link_does_not_invalidate')
  q(addlink+'1;');assert q(witness())!=before;cases.append('late_link_start_inclusive_original_recognition_invalidates')
  before=q(witness());q("INSERT INTO union_pnl_cash_outcome_touches SELECT table_id,hand_number,recognized_at,'"+u+"',false,'0','[]' FROM union_pnl_cash_outcomes WHERE hand_number=1;");assert q(witness())!=before;cases.append('late_ordinary_touch_invalidates')
  before=q(witness());cert="INSERT INTO smarter_private.posthand_escrow_certificates(table_id,hand_number,hand_id,original,original_sha256) SELECT table_id,hand_number,hand_id,smarter_private.posthand_escrow_original_snapshot(table_id,hand_number),encode(extensions.digest(convert_to(smarter_private.posthand_escrow_original_snapshot(table_id,hand_number)::text,'UTF8'),'sha256'),'hex') FROM union_pnl_cash_outcomes WHERE hand_number="
  q(cert+'2;');assert q(witness())==before;cases.append('outside_window_escrow_certificate_ignored')
  q(cert+'1;');assert q(witness())!=before;cases.append('inside_projected_original_hand_escrow_certificate_invalidates')
  q("UPDATE union_pnl_projection_build SET completed_at=NULL;")
  raw=q(witness(False));assert json.loads(raw)['escrow_certificates']==0;cases.append('raw_escrow_scope_uses_original_outcome_union_not_link_resolution')
  q("INSERT INTO union_pnl_cash_outcomes VALUES('10000000-0000-0000-0000-000000000002',1,gen_random_uuid(),'2026-10-12 08:00Z',jsonb_build_object('game_union_id','"+u+"'),'{}','hash');")
  assert q(witness(False))!=raw;cases.append('raw_late_ordinary_hand_invalidates')
  raw_before_cert=q(witness(False))
  q(cert.replace('WHERE hand_number=',"WHERE table_id='10000000-0000-0000-0000-000000000002' AND hand_number=")+'1;');assert q(witness(False))!=raw_before_cert;cases.append('inside_raw_original_hand_escrow_certificate_invalidates')
  q('BEGIN;ALTER TABLE union_pnl_cash_outcome_touches DISABLE TRIGGER original_pnl_immutable;'+witness(False),'weekly_hand_parts_append_only_contract_changed');cases.append('disabled_append_trigger_refused')
  q('BEGIN;SET session_replication_role=replica;'+witness(False),'weekly_hand_parts_original_sources_unqualified');cases.append('replica_mode_refused')
  # Independent original-scoped contract, actual helper metadata and permissions.
  assert h('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)')==json.loads((F/'postimages.json').read_text())['witness']
  q('REVOKE ALL ON FUNCTION smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)FROM PUBLIC,anon,authenticated,service_role;')
  q('SET ROLE anon;'+witness(),'permission denied');cases.append('anon_denied')
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
  for x in g['connected']['functions']:
   if 'posthand_escrow_'not in x['sig']:q('SET check_function_bodies=off;'+x['definition']+';')
  q('SET check_function_bodies=off;'+g['linked']+';')
  migration="SET check_function_bodies=off;"+(R/'supabase/migrations/20261020182843_native_weekly_hand_outcomes_use_original_bounded_parts.sql').read_text()
  assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t'
  q(migration);assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t'
  scoped=(R/'supabase/migrations/20261021172837_weekly_hand_witnesses_follow_original_window_sources.sql').read_text()
  q('CREATE FUNCTION fn_ca_guard_watchlist()RETURNS text[]LANGUAGE sql AS $$SELECT ARRAY[]::text[]$$;')
  old_report_hash=h('fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)')
  q('GRANT EXECUTE ON FUNCTION fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)TO anon;');q(scoped,'weekly_hand_window_original_authority_changed');q('REVOKE EXECUTE ON FUNCTION fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)FROM anon;');cases.append('installer_acl_fault_refused')
  q(scoped.replace('COMMIT;','ROLLBACK;'));assert h('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)')=='64731b2855b4ea526d831ca8ab2bc589';cases.append('installer_rollback_preserves_original')
  q(scoped.replace("'c4a17522149bfd879342ccc68dec98f9' THEN RAISE EXCEPTION 'weekly_hand_window_postimage_changed'","'00000000000000000000000000000000' THEN RAISE EXCEPTION 'weekly_hand_window_postimage_changed'"),'weekly_hand_window_postimage_changed');cases.append('installer_postimage_fault_rolls_back')
  q(scoped);assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t';q(scoped,'weekly_hand_window_original_preimage_changed');cases.append('exact_installer_source40_and_replay_refusal')
  assert h('fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)')!=old_report_hash;cases.append('generation_bound_report_body_changes_no_proof_relabel')
  print(json.dumps({'qualification':'passed','cases':cases,'postimages':json.loads((F/'postimages.json').read_text()),'limits':'Actual original witness/link/append-trigger bodies; controlled source40/projection collaborators. No production mutation or full weekly report claim.'}))
 finally:run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
