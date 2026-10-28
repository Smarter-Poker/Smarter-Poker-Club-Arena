# Invoked only inside existing genuine seven-flow/78-outcome/84-part native fixture.
# Complete report, advance, reduce/read/witness bodies run. The unrelated finite
# inventory, tournament and ECO populations are explicit empty external boundaries.
C=Path(os.environ['ORB_REPORT_COMPOSITION_NATIVE']).parent
captured=json.loads((C/'actual-original-owner-catalog.json').read_text())
original_report=(C/'report-original.sql').read_text(); candidate_report=(C/'report-candidate.sql').read_text()
assert hashlib.md5(original_report.encode()).hexdigest()=='c4a17522149bfd879342ccc68dec98f9'
assert q("SELECT md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure))")=='c4a17522149bfd879342ccc68dec98f9'
# Load current real occupancy composition bodies, retaining prior fixture owners
# for the unrelated retained delivery postimage assertion after this extension.
restore_readers={sig:q('SELECT pg_get_functiondef('+lit(sig)+'::regprocedure)')+'\n'for sig in ['public.fn_union_pnl_boundary(uuid,timestamptz)','public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)','smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)','public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)']}
for f in ['occupancy-owner0.sql','occupancy-owner1.sql','advance-original.sql']:q((C/f).read_text())
for sig,expected in [('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)','b23655a15587192f137ae4ad57859742'),('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)','2627c8820e0147d5e91a2014415ec558')]:
 assert q('SELECT md5(pg_get_functiondef('+lit(sig)+'::regprocedure))')==expected
# The report also consumes the original qualified BBJ felt-share owner;
# load its exact maintained composer over the actual original fourth owner.
import re
wallet_dir=P.parent.parent/'wallet-jackpot'
bbj_migration=(wallet_dir/'qualified-bbj-03208.sql').read_text()
bbj_week=(wallet_dir/'original-owners.sql').read_text().split('$function$;')[3].lstrip()+'$function$\n'
for left,right in [('award_anchor','award_replacement')]:
 old=re.search(r'\$'+left+r'\$(.*?)\$'+left+r'\$',bbj_migration,re.S).group(1)
 new=re.search(r'\$'+right+r'\$(.*?)\$'+right+r'\$',bbj_migration,re.S).group(1)
 assert bbj_week.count(old)==1;bbj_week=bbj_week.replace(old,new)
old=re.search(r'\$felt_anchor\$(.*?)\$felt_anchor\$',bbj_migration,re.S).group(1)
new=old+re.search(r'\$felt_guard\$(.*?)\$felt_guard\$',bbj_migration,re.S).group(1)
assert bbj_week.count(old)==1;bbj_week=bbj_week.replace(old,new)
new=re.search(r'\$award_tail\$(.*?)\$award_tail\$',bbj_migration,re.S).group(1)
assert bbj_week.count('\n$function$')==1;bbj_week=bbj_week.replace('\n$function$',new)
q(bbj_week)
assert q("SELECT md5(pg_get_functiondef('public.fn_union_pnl_week_bbj_stack_awards(uuid,timestamptz,timestamptz)'::regprocedure))")=='faf875701e49db1cf99b481119e87404'
# Public report's real canonical metadata/ACL are retained in local OID space.
reportmeta=next(r['metadata']for r in captured['owners']if 'fn_union_pnl_evidence_report' in r['signature'])
q('REVOKE ALL ON FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;')
# External population boundaries only; actual report SQL and actual84 readers are untouched.
q("""CREATE TABLE public.union_pnl_weekly_capture(singleton boolean,captured_at timestamptz);
INSERT INTO public.union_pnl_weekly_capture VALUES(true,'2026-10-12 07:00Z');
CREATE OR REPLACE FUNCTION public.fn_accounting_close_warm_stop() RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(nullif(current_setting('native.report_warm_stop',true),''),'off')='on'$$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_boundary(p_union_id uuid,p_at timestamptz) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('status','ready','holdings',jsonb_build_array())$$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean) RETURNS SETOF public.union_pnl_cash_outcomes LANGUAGE sql AS $$SELECT o.* FROM public.union_pnl_cash_outcomes o WHERE o.game_scope->>'game_union_id'=$1::text AND o.recognized_at>=$2 AND o.recognized_at<$3$$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_cash_outcome_link(public.union_pnl_cash_outcomes) RETURNS SETOF jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb WHERE false$$;
CREATE TABLE IF NOT EXISTS public.cash_funding_application_receipts(applied_at timestamptz,transaction_id uuid);
CREATE OR REPLACE FUNCTION public.fn_union_pnl_touched_registrations(timestamptz,timestamptz,boolean) RETURNS TABLE(registration_id uuid,touched_tournament_id text) LANGUAGE sql AS $$SELECT NULL::uuid,NULL::text WHERE false$$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_tournament_in_union(text,uuid,boolean) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE TABLE IF NOT EXISTS public.union_pnl_inventory_touches(source_name text,row_id uuid,union_id text);
CREATE TABLE IF NOT EXISTS public.union_pnl_inventory_events(source_name text,row_id uuid,after_row jsonb,before_row jsonb);
CREATE TABLE IF NOT EXISTS public.tournament_participant_funding_receipts(registration_id uuid,asset text,amount numeric,funding_club_id uuid,ledger_id uuid,entitlement_id uuid,registration_snapshot jsonb,id uuid,user_id uuid);
CREATE OR REPLACE FUNCTION public.fn_union_pnl_tournament_entry_club_of(text,numeric,uuid,uuid,uuid,jsonb) RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_union_credits(uuid,timestamptz,timestamptz,boolean) RETURNS TABLE(credit_id uuid) LANGUAGE sql AS $$SELECT NULL::uuid WHERE false$$;
CREATE TABLE IF NOT EXISTS public.tournament_accounting_credit_receipts(id uuid,entry_receipt_ids uuid[],credited_club_id uuid,user_id uuid);
CREATE OR REPLACE FUNCTION public.fn_union_pnl_award_owner_resolved(public.tournament_accounting_credit_receipts,uuid,timestamptz,uuid[]) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_award_satellite_owner(public.tournament_accounting_credit_receipts) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE OR REPLACE FUNCTION public.fn_union_eco_terms_evidence(uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"status":"ready","segments":[{"terms":{"eco_enabled":false,"eco_base_mode":"club_cash_profit"}}]}'::jsonb$$;
CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
CREATE TABLE IF NOT EXISTS public.accounting_payable_earning_sources(club_id uuid,union_id uuid,earned_at timestamptz,rake_credit numeric,source_type text);
CREATE OR REPLACE FUNCTION public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz) RETURNS TABLE(club_id uuid,payout numeric) LANGUAGE sql AS $$SELECT NULL::uuid,NULL::numeric WHERE false$$;
""")
# Cache owner bodies are actual; certificate storage is the isolated external lane.
q('CREATE TABLE native_report_certificates(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,value jsonb,PRIMARY KEY(kind,union_id,period_start,period_end))')
q("""CREATE OR REPLACE FUNCTION public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS $$SELECT CASE WHEN $1='earned_plan' THEN '{}'::jsonb ELSE(SELECT value FROM native_report_certificates WHERE kind=$1 AND union_id=$2 AND period_start=$3 AND period_end=$4)END$$;
CREATE OR REPLACE FUNCTION public.fn_accounting_close_problem(text,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM native_report_certificates WHERE kind=$1||'_problem' AND union_id=$2 AND period_start=$3 AND period_end=$4$$;
CREATE OR REPLACE FUNCTION public.fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb)RETURNS void LANGUAGE sql AS $$INSERT INTO native_report_certificates VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,union_id,period_start,period_end)DO UPDATE SET value=excluded.value$$;
""")
cache_write=next(f['body']for f in json.loads((P/'current-generation-cache-owners.json').read_text())if '.inventory_basis_cache_write(' in f['signature']);q(cache_write)
q("SET app.weekly_accounting_chunked='on';SET app.accounting_close_memo='on';")
# Advance uses the actual local whole-flow postimage, with untouched real window logic.
report_call='SELECT public.fn_union_pnl_evidence_report'+call
advance_current=q("SELECT pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure)")+'\n'
meta_before=q("SELECT (to_jsonb(p)-'prosrc'-'prosqlbody')::text FROM pg_proc p WHERE oid='public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure")
def advance_complete():
 for n in range(5):
  r=q(settings+'SELECT fn_accounting_union_earned_plan_advance'+call)
  if r=='t':return
 raise AssertionError('real84 advance did not complete')
advance_complete()
q(settings+report_call,'weekly_hand_parts_owner_changed')
cases.append('actual_full_report_before_composition_refuses_current_real84_reader')
before_report_generation=q('SELECT smarter_private.original_inventory_basis_generation()')
before_report_hands=q("SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY window_start)::text)FROM accounting_close_partials p WHERE kind='pnl_hands_window'")
q(candidate_report)
assert meta_before==q("SELECT (to_jsonb(p)-'prosrc'-'prosqlbody')::text FROM pg_proc p WHERE oid='public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure")
assert q("SELECT md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure))")=='49b47361e2ccd195968d293b1bb7c3c0'
# Bind actual local advance's genuine report dependency, preserving all other bytes.
advance_new=advance_current.replace('c4a17522149bfd879342ccc68dec98f9','49b47361e2ccd195968d293b1bb7c3c0');assert advance_new!=advance_current;q(advance_new)
advance_complete()
new_report_generation=q('SELECT smarter_private.original_inventory_basis_generation()');assert new_report_generation!=before_report_generation
assert q("SELECT count(*)FROM accounting_close_partials WHERE kind='pnl_hands_window' AND value->>'generation'="+lit(new_report_generation))=='84'
assert q("SELECT count(*)FROM accounting_close_partials WHERE kind='pnl_flows_window' AND value->>'generation'="+lit(new_report_generation))=='84'
assert before_report_hands!=q("SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY window_start)::text)FROM accounting_close_partials p WHERE kind='pnl_hands_window'")
assert other_parts_digest==q("SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY kind,window_start)::text)FROM accounting_close_partials p WHERE kind IN('earned_plan_window','round2_union_window')")
cases.append('actual_report_source_change_naturally_invalidates_GEN_original84flow_and_hand_rebuild_no_retag_earned_R2_preserved')
q('TRUNCATE native_report_certificates;')
# Clear report memo every call, so cache-hit is actual durable cache consumption.
warm_progress=[]
for step in range(6):
 r=json.loads(q(settings+"SET app.union_pnl_evidence_memo='';"+report_call))
 assert r['payment_authorized'] is False
 if 'accepted_cash_hands' in r:break
 assert r['status']=='warming',r
 warm_progress.append(r)
else:raise AssertionError(('full_report_did_not_progress',r))
assert warm_progress

r2=json.loads(q(settings+"SET app.union_pnl_evidence_memo='';"+report_call));assert r2==r
cases.append('actual_full_report_after_composition_cold_and_cachehit_reaches_real84_typed_reader')
q(settings+"SET native.report_warm_stop='on';SET app.union_pnl_evidence_memo='';"+report_call)
w=json.loads(q(settings+"SET native.report_warm_stop='on';SET app.union_pnl_evidence_memo='';"+report_call));assert w['status']=='warming' and w['payment_authorized'] is False
cases.append('actual_full_report_warming_never_authorizes_payment')
stale_part=json.loads(q(settings+"BEGIN;UPDATE accounting_close_partials SET computed_at='2000-01-01 00:00Z' WHERE kind='pnl_hands_window' AND window_start='2026-10-19 07:00Z';SET LOCAL app.union_pnl_evidence_memo='';"+report_call+';ROLLBACK;'))
assert stale_part['status']=='warming' and stale_part['payment_authorized']is False
cases.append('actual_full_report_stale_hand_part_rebuilt_by_original_advance_returns_warming')
# Every original exact owner guard remains active after composition.
read_actual=q("SELECT pg_get_functiondef('smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)'::regprocedure)")+'\n'
q(settings+'BEGIN;'+read_actual.replace('DECLARE w record;','DECLARE w record; -- native changed owner\n')+";SET LOCAL app.union_pnl_evidence_memo='';"+report_call,'weekly_hand_parts_owner_changed')
cases.append('actual_full_report_changed_reader_whole_owner_refused')
bad_source=json.loads(q(settings+"BEGIN;CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql AS 'SELECT false';SET LOCAL app.union_pnl_evidence_memo='';"+report_call+';ROLLBACK;'))
assert bad_source['status']=='blocked' and bad_source['basis_certified']is False and bad_source['payment_authorized']is False
cases.append('actual_full_report_bad_original_source_authority_uncertified_fallback_preserved')
# Restore mutable external cache harness for later retained regression.
q('TRUNCATE native_report_certificates;')
(O/'actual-composed-report-result.json').write_text(json.dumps({'cold':r,'cachehit':r2,'warming':w,'limits':'Full original report SQL, real84 advance/reduce/witness/read; explicit empty tournament/capture/ECO external populations. Actual65 source authority is separately qualified, never rebound to these controlled helpers.'},indent=2)+'\n')

if os.environ.get('ORB_REPORT_MEMBERSHIP_NATIVE'):
 exec(Path(os.environ['ORB_REPORT_MEMBERSHIP_NATIVE']).joinpath('native-report-extension.py').read_text())

for body in restore_readers.values():q(body)
q(original_report)
