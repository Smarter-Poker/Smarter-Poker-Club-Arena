# Runs inside the existing full genuine7-flow/78-hand/84-part report lane.
M=Path(os.environ['ORB_REPORT_MEMBERSHIP_NATIVE'])
contract=json.loads((M/'candidate-contract.json').read_text())
actual_generation=q('SELECT smarter_private.original_inventory_basis_generation()')
old_parts=q("SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY kind,window_start)::text)FROM accounting_close_partials p WHERE kind IN('earned_plan_window','round2_union_window')")
old_hands=q("SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY window_start)::text)FROM accounting_close_partials p WHERE kind='pnl_hands_window'")
old_meta=q("SELECT (to_jsonb(p)-'prosrc')::text FROM pg_proc p WHERE oid='public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure")
q((M/'report-candidate.sql').read_text())
assert old_meta==q("SELECT (to_jsonb(p)-'prosrc')::text FROM pg_proc p WHERE oid='public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure")
assert q("SELECT md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure))")==contract['post_md5']['report']
before_advance=q("SELECT pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure)")+'\n'
assert before_advance.count(contract['original_md5']['report'])==1
q(before_advance.replace(contract['original_md5']['report'],contract['post_md5']['report']))
new_generation=q('SELECT smarter_private.original_inventory_basis_generation()');assert new_generation!=actual_generation
advance_complete()
assert q("SELECT count(*)FROM accounting_close_partials WHERE kind='pnl_hands_window' AND value->>'generation'="+lit(new_generation))=='84'
assert q("SELECT count(*)FROM accounting_close_partials WHERE kind='pnl_flows_window' AND value->>'generation'="+lit(new_generation))=='84'
assert old_hands!=q("SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY window_start)::text)FROM accounting_close_partials p WHERE kind='pnl_hands_window'")
assert old_parts==q("SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY kind,window_start)::text)FROM accounting_close_partials p WHERE kind IN('earned_plan_window','round2_union_window')")
q('TRUNCATE native_report_certificates;')
for step in range(6):
 mr=json.loads(q(settings+"SET app.union_pnl_evidence_memo='';"+report_call))
 assert mr['payment_authorized']is False
 if 'accepted_cash_hands'in mr:break
 assert mr['status']=='warming',mr
else:raise AssertionError(('membership_full_report_no_progress',mr))
assert mr==r,(mr,r)
assert json.loads(q(settings+"SET app.union_pnl_evidence_memo='';"+report_call))==mr
cases.append('membership_complete_report_equal_original_economics_real84_GEN_rebuild_earned_R2_unchanged_no_payment')
(O/'membership-complete-report-result.json').write_text(json.dumps({'generation_before':actual_generation,'generation_after':new_generation,'original_report':r,'membership_report':mr,'limits':'Actual full report/84 producer/cache owners; explicit empty tournament boundary; independent48 nonempty full membership bag cases. Actual65 separate genuine finite245 lane.'},indent=2)+'\n')
q(candidate_report);q(before_advance)
