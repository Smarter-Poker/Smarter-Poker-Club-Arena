R=P
q('CREATE TABLE public.union_pnl_cash_outcome_resolutions(table_id uuid,hand_number bigint,hand_id uuid,outcome_payload_hash text,outcome_evidence_md5 text)')
q('CREATE TABLE smarter_private.posthand_escrow_certificates(table_id uuid,hand_number bigint)')
q("CREATE FUNCTION public.fn_union_pnl_posthand_escrow_participants(public.union_pnl_cash_outcomes) RETURNS jsonb LANGUAGE sql AS 'SELECT $1.evidence->''participants'''")
q('CREATE TABLE public.union_pnl_cash_outcome_touches(table_id uuid,hand_number bigint,game_union_id text,recognized_at timestamptz,accepted_rake text,participants jsonb,shaped boolean)')
q("CREATE FUNCTION public.fn_union_pnl_posthand_escrow_touch(public.union_pnl_cash_outcome_touches) RETURNS jsonb LANGUAGE sql AS 'SELECT $1.participants'")
accepted=json.loads((P/'current-outcome-owners.json').read_text())[0]['body']
q(accepted)
assert q('SELECT count(*) FROM union_pnl_cash_outcomes o WHERE fn_union_pnl_cash_outcome_accepted(o)')=='0'
q((R/'accepted-candidate.sql').read_text())
assert q('SELECT count(*) FROM union_pnl_cash_outcomes o WHERE fn_union_pnl_cash_outcome_accepted(o)')=='78'
example=q('SELECT to_jsonb(o)FROM union_pnl_cash_outcomes o LIMIT 1')
assert q('BEGIN;SET LOCAL ROLE service_role;SELECT fn_union_pnl_cash_outcome_accepted(jsonb_populate_record(NULL::public.union_pnl_cash_outcomes,'+lit(example)+'::jsonb));ROLLBACK;')=='t'
cases.append('service_role_uses_original_accepted_boolean_without_exposing_private_proof_helper')
q((R/'compact-participants.sql').read_text())
q("INSERT INTO union_pnl_cash_outcome_touches SELECT table_id,hand_number,game_scope->>'game_union_id',recognized_at,evidence->>'accepted_rake',fn_union_pnl_compact_participants(evidence->'participants'),true FROM union_pnl_cash_outcomes")
q((R/'hand-lines-candidate.sql').read_text())
scope=q("SELECT game_scope->>'game_union_id' FROM union_pnl_cash_outcomes LIMIT 1")
for projected in ['false','true']:
 got=json.loads(q("SELECT jsonb_agg(jsonb_build_object('rake',hand_accepted_rake,'participants',hand_participants)ORDER BY hand_accepted_rake,hand_participants::text) FROM fn_union_pnl_week_hand_lines("+lit(scope)+"::uuid,'2026-10-19 07:00Z','2026-10-26 07:00Z',"+projected+")"))
 assert len(got)==78
 expect=sorted([{'rake':e['accepted_rake'],'participants':e['participants']}for e in effective],key=lambda e:(e['rake'],json.dumps(e['participants'],sort_keys=True)))
 assert sum(float(e['rake'])for e in got)==sum(float(e['accepted_rake'])for e in effective)
 assert sorted(json.dumps(e['participants'],sort_keys=True)for e in got)==sorted(json.dumps(e['participants'],sort_keys=True)for e in effective)
assert outdigest==q('SELECT md5(jsonb_agg(to_jsonb(o)ORDER BY hand_number)::text)FROM union_pnl_cash_outcomes o')
cases.append('actual_accepted_78_and_both_original_projected_hand_line_readers_effective_financial_only')
# Original full/window owners, not a mock projection. Unrelated finite-restoration
# family is an explicit empty boundary in this seven-row fixture; full43 follows.
B=P.parent.parent/'wallet-jackpot'
deps=json.loads((B/'actual-reader-dependencies.json').read_text())
for table in deps['schemas']:
 q(table['ddl'])
 for name,typ in table['columns']:q('ALTER TABLE public.'+table['relname']+' ADD COLUMN IF NOT EXISTS '+name+' '+typ)
for f in deps['functions']:
 if not f['signature'].startswith(('fn_cash_original_funding_lineage','fn_pnl_evidence_cents')):q(f['body'])
for name in ['original_restoration_cash_returns','original_erased_cash_discharge_returns']:
 q('CREATE OR REPLACE FUNCTION smarter_private.'+name+"(uuid,timestamptz,timestamptz)RETURNS TABLE(ledger_id uuid,club_id uuid,user_id uuid,buyins numeric,cashouts numeric,kind text,valid boolean) LANGUAGE sql AS 'SELECT NULL::uuid,NULL::uuid,NULL::uuid,0::numeric,0::numeric,NULL::text,false WHERE false'")
q('DROP FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)')
originals=(B/'original-owners.sql').read_text().split('$function$;')[:2]
originals=[s+'$function$;'for s in originals]
exec(compile((R/'native-bbj-combination.py').read_text(),str(R/'native-bbj-combination.py'),'exec'),globals(),globals())
for s in originals:q(s)
call="('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')"
assert q('SELECT count(*) FROM fn_union_pnl_original_flow_evidence'+call+' WHERE NOT valid')=='7'
exec(compile((R/'compose-flow.py').read_text(),str(R/'compose-flow.py'),'exec'),globals(),globals())
for s in originals:q(compose_treasury_flow(s))
a=json.loads(q('SELECT jsonb_agg(to_jsonb(f)ORDER BY ledger_id)FROM fn_union_pnl_original_flow_evidence'+call+' f'))
b=json.loads(q("SELECT jsonb_agg(to_jsonb(f)ORDER BY ledger_id)FROM smarter_private.union_pnl_original_flow_evidence_window('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-19 07:00Z','2026-10-26 07:00Z') f"))
assert a==b and len(a)==91 and all(x['valid']for x in a),a
from decimal import Decimal
assert sum(Decimal(str(x['cashouts']))for x in a if x['ledger_id']not in {f['ledger_id']for f in raw['original_flows']})==Decimal('33465.32')
a=[x for x in a if x['ledger_id']in {f['ledger_id']for f in raw['original_flows']}]
assert sum(float(x['buyins'])for x in a)==947 and sum(float(x['cashouts'])for x in a)==2661.33
(O/'actual-seven-composed-flow-result.json').write_text(json.dumps(a,indent=2)+'\n')
cases.append('actual_seven_full_and_window_flow_owners_proven_gift947_return2661_33_exact_parity')
exec(compile((R/'native-future-return.py').read_text(),str(R/'native-future-return.py'),'exec'),globals(),globals())
exec(compile((R/'native-parts.py').read_text(),str(R/'native-parts.py'),'exec'),globals(),globals())
# Later existing cache regression creates its own original table at its step.
q('DROP TABLE accounting_close_partials')
