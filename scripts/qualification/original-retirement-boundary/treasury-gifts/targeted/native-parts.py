# Unchanged 245 finite family remains the harness's explicitly controlled lane.
# This executes the COMPLETE original window producer, reduce/read/witness bodies.
V=P/'old-reader-owners'
q('CREATE TABLE public.union_pnl_projection_build(projection text,completed_at timestamptz)')
q('CREATE TABLE public.union_pnl_cash_outcome_link_resolutions(table_id uuid,hand_number bigint,hand_id uuid,outcome_payload_hash text,outcome_evidence_md5 text,proof_md5 text,proof jsonb,game_scope jsonb,evidence jsonb)')
for f in json.loads((R/'current-part-witness-dependencies.json').read_text()):
 if not f['signature'].startswith('fn_accounting_close_certificate'):q(f['body'])
for f in json.loads((P/'current-outcome-owners.json').read_text()):
 if f['signature'].startswith('fn_union_pnl_linked_cash_outcomes'):q(f['body'])
for owner in json.loads((P/'current-close-window-owners.json').read_text()):q(owner['body'])
for table in ['union_pnl_cash_outcomes','union_pnl_cash_outcome_touches','union_pnl_cash_outcome_link_resolutions']:
 q('CREATE TRIGGER original_pnl_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.'+table+' FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable()')
q('CREATE TRIGGER posthand_escrow_certificate_immutable BEFORE INSERT OR UPDATE OR DELETE ON smarter_private.posthand_escrow_certificates FOR EACH ROW EXECUTE FUNCTION smarter_private.posthand_escrow_certificate_immutable()')
q('CREATE TRIGGER posthand_escrow_certificate_no_truncate BEFORE TRUNCATE ON smarter_private.posthand_escrow_certificates FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.posthand_escrow_certificate_immutable()')
hand_hash=q("SELECT md5(pg_get_functiondef('public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean)'::regprocedure))")
witness=(V/'smarter_private-weekly_hand_parts_witness.sql').read_text().replace('0c69388b1406858f3bed04f54639fab6',hand_hash)
read=(V/'smarter_private-weekly_hand_parts_read.sql').read_text().replace('d4665eb6e43425a93816c55ded55f644',hand_hash)
q(witness);q((V/'smarter_private-weekly_hand_parts_reduce.sql').read_text());q(read)
for name in ['weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)','weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean)','weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)']:
 q('REVOKE ALL ON FUNCTION smarter_private.'+name+' FROM PUBLIC')
# Only external prerequisite certificate authority is controlled; no financial
# producer logic below is extracted or replaced. All new writers/readers execute.
q("CREATE OR REPLACE FUNCTION public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS 'SELECT CASE WHEN $1=''earned_plan'' THEN ''{}''::jsonb END'")
report=next(f['body']for f in json.loads((P/'current-generation-cache-owners.json').read_text())if f['signature'].startswith('fn_union_pnl_evidence_report'))
q(report)
q('TRUNCATE native_blocked_basis_cache')
gen=q('SELECT smarter_private.original_inventory_basis_generation()')
q('INSERT INTO native_blocked_basis_cache VALUES(jsonb_build_object(\'status\',\'blocked\',\'_original_inventory_generation\','+lit(old_flow_generation)+'))')
assert gen!=old_flow_generation
advance=(R/'advance-original.sql').read_text()
for old,sig in [('f85d5f26253365ec1052b74ed23a14cc','public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'),('491323192dc49931df7c36e4699eac9a','smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)'),('1ecd757e644477bb02400a17b53edd32','smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)')]:
 advance=advance.replace(old,q('SELECT md5(pg_get_functiondef('+lit(sig)+'::regprocedure))'))
advance=advance.replace('d4665eb6e43425a93816c55ded55f644',hand_hash)
q(advance)
q('CREATE UNIQUE INDEX native_original_partial_identity ON accounting_close_partials(kind,union_id,period_start,period_end,window_start)')
settings="SET app.weekly_accounting_chunked='on';SET app.accounting_close_memo='on';SET app.weekly_accounting_scope_deadline='"+q("SELECT clock_timestamp()+interval'8 minutes'")+"';"
r=q(settings+'SELECT fn_accounting_union_earned_plan_advance'+call);assert r=='f',r
recomputed=json.loads(q("SELECT jsonb_build_object('windows',count(*),'bad',sum((value->>'bad')::int),'all_new_generation',bool_and(value->>'generation'="+lit(gen)+"))FROM accounting_close_partials WHERE kind='pnl_flows_window'"));assert recomputed=={'windows':84,'bad':0,'all_new_generation':True},recomputed
assert other_parts_digest==q("SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY kind,window_start)::text)FROM accounting_close_partials p WHERE kind IN('earned_plan_window','round2_union_window')")
assert q("SELECT count(*)FROM accounting_close_partials p CROSS JOIN LATERAL(SELECT coalesce(jsonb_agg(to_jsonb(f)ORDER BY ledger_id),'[]'::jsonb)expected FROM smarter_private.union_pnl_original_flow_evidence_window(p.union_id,p.period_start,p.period_end,p.window_start,p.window_end)f)e WHERE p.kind='pnl_flows_window' AND(SELECT coalesce(jsonb_agg(v ORDER BY v->>'ledger_id'),'[]'::jsonb)FROM jsonb_array_elements(p.value->'flows')v)IS DISTINCT FROM e.expected")=='0'
(O/'stale-original-84-flow-windows-after.json').write_text(json.dumps(recomputed,indent=2)+'\n')
cases.append('actual_old84_flow_windows_91bad_recomputed_to0_by_original_advance_no_retag_168_earned_R2_parts_unchanged')
q('TRUNCATE native_blocked_basis_cache')
q('INSERT INTO native_blocked_basis_cache VALUES(jsonb_build_object(\'status\',\'ready\',\'_original_inventory_generation\','+lit(gen)+'))')
r=q(settings+'SELECT fn_accounting_union_earned_plan_advance'+call);assert r=='f',r
count=q("SELECT count(*)FROM accounting_close_partials WHERE kind='pnl_hands_window'");assert count=='84',count
r=q(settings+'SELECT fn_accounting_union_earned_plan_advance'+call);assert r=='t',r
stored=q("SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY window_start)::text)FROM accounting_close_partials p")
r=q(settings+"SELECT smarter_private.weekly_hand_parts_read('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z',smarter_private.original_inventory_basis_generation(),false)")
assert json.loads(r)==json.loads(q("SELECT smarter_private.weekly_hand_parts_reduce('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z',false)"))
assert stored==q("SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY window_start)::text)FROM accounting_close_partials p")
for name,body in [('witness-candidate.sql',witness),('parts-read-candidate.sql',read),('advance-candidate.sql',advance)]: (O/name).write_text(body)
cases.append('whole_actual_advance_produces84_original_windows_replay_read_reduce_exact_financial_parity')
if os.environ.get('ORB_REPORT_COMPOSITION_NATIVE'):
 exec(compile(Path(os.environ['ORB_REPORT_COMPOSITION_NATIVE']).read_text(),os.environ['ORB_REPORT_COMPOSITION_NATIVE'],'exec'),globals(),globals())
signatures=['public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)','smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)','public.fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)','public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean)','smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)','smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)','public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)']
postimages=json.loads(q('SELECT jsonb_agg(jsonb_build_object(\'signature\',signature,\'body\',pg_get_functiondef(p.oid),\'md5\',md5(pg_get_functiondef(p.oid)),\'owner\',p.proowner::regrole::text,\'security_definer\',p.prosecdef,\'volatility\',p.provolatile,\'config\',p.proconfig,\'acl\',p.proacl::text)ORDER BY signature)FROM(VALUES'+','.join('('+lit(sig)+')'for sig in signatures)+')s(signature)JOIN pg_proc p ON p.oid=to_regprocedure(signature)'))
(O/'reader-authority-postimages.json').write_text(json.dumps(postimages,indent=2)+'\n')
q((P.parent/'preserve-public-owner-acls.sql').read_text())
exec(compile((P/'assert-delivery-owned.py').read_text(),str(P/'assert-delivery-owned.py'),'exec'),globals(),globals())
# Restore only controlled prerequisite boundary used by later existing regression.
q('DROP FUNCTION smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)')
