# Isolated-only native extension, injected after current typed owner setup.
# Source quality and receipt-request lifecycle remain explicit fixture boundaries.
q("CREATE TABLE ca_mint_ledger(op_id text,chip_ledger_id uuid,amount numeric);ALTER TABLE accounting_period_recompute_requests ADD COLUMN attempted_at timestamptz;CREATE TABLE tournament_rake_settlements(destination text,settled_at timestamptz,amount numeric);CREATE TABLE fixture_clock(n timestamptz);INSERT INTO fixture_clock VALUES('2026-10-26 09:00Z');CREATE TABLE fixture_scope(club_id uuid PRIMARY KEY,kind text DEFAULT 'club');CREATE TABLE fixture_order(seq bigserial,kind text,club_id uuid);")
q("CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_clock()RETURNS timestamptz LANGUAGE sql VOLATILE AS $$SELECT n FROM fixture_clock$$;CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_scope_plan(p_end timestamptz,p_now timestamptz)RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_agg(jsonb_build_object('kind',kind,'id',club_id,'period_start','2026-10-19T07:00:00Z','period_end','2026-10-26T07:00:00Z')ORDER BY club_id)FROM fixture_scope$$;")
for version,name in [('20261016142840','fn_weekly_accounting_attempt_begin'),('20260928164258','fn_weekly_accounting_deadline_check'),('20260928211132','fn_weekly_accounting_attempt_end')]:
    t=next((R/'supabase/migrations').glob(version+'_*')).read_text();at=t.index('FUNCTION public.'+name+'(');at=t.rfind('CREATE ',0,at);end=t.index('$function$;',at)+len('$function$;');q(t[at:end].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
for row in json.loads((R/'scripts/ci/fixtures/inventory-proof-lifetime-sources.json').read_text())['functions']:
    if row['signature']=='public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)':q('SET check_function_bodies=off;'+row['definition']+';')
for row in json.loads((R/'scripts/ci/fixtures/weekly-fee-preparation/original-owners.json').read_text()):
    if row['signature']=='fn_accounting_close_windows(timestamp with time zone,timestamp with time zone)':q('SET check_function_bodies=off;'+row['definition']+';')
lifetime=(R/'supabase/migrations/20261016123337_the_weekly_close_proofs_outlive_the_close.sql').read_text();at=lifetime.index('CREATE OR REPLACE FUNCTION public.fn_accounting_close_proof_lifetime()');q(lifetime[at:lifetime.index('$function$;',at)+len('$function$;')])
load(R/'tests/fixtures/weekly-close-scale/preimage/fn_accounting_week_clubs.sql')
exact=q("SELECT pg_get_functiondef('smarter_private.weekly_payout_execute(uuid)'::regprocedure)").stdout.strip()
canonical_before=exact+'\n'
assert hashlib.md5(canonical_before.encode()).hexdigest()=='f34d653a6d05b9245c81336d69e2c453'
assert exact.count('statement_timestamp()')==1
q(exact.replace('statement_timestamp()','smarter_private.weekly_payout_clock()'))
q("CREATE OR REPLACE FUNCTION fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS $$SELECT '{\"status\":\"ready\",\"count\":0,\"sources\":[]}'::jsonb$$;")
# The synthetic history IDs are globally unique across independently seeded clubs.
history=q("SELECT pg_get_functiondef('own_history(bigint,text,text,timestamptz,jsonb)'::regprocedure)").stdout.strip()
history=history.replace('VALUES(p_id,p_type',"VALUES(p_id+abs(hashtext(current_setting('test.own_namespace',true))::bigint)*100000,p_type")
q(history)
q("CREATE FUNCTION fixture_observe_current_money()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.category='commission'AND NEW.status='posted'THEN INSERT INTO fixture_order(kind,club_id)VALUES('agent',NEW.club_id);ELSIF NEW.category='rakeback'AND NEW.status='posted'AND NEW.to_type IN('agent_wallet','player_wallet')THEN IF current_setting('fixture.refuse_secondary',true)='on'THEN RAISE EXCEPTION 'fixture-current-secondary-fault';END IF;IF(SELECT count(*)FROM accounting_routed_settlement_runs WHERE round_no=2 AND period_start='2026-10-19 07:00Z')<>3 THEN RAISE EXCEPTION 'secondary-before-three-gross-rounds';END IF;INSERT INTO fixture_order(kind,club_id)VALUES('secondary',NEW.club_id);END IF;RETURN NEW;END$$;CREATE TRIGGER fixture_current_money AFTER INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fixture_observe_current_money();")
# Reuse the documented external mint transport adapter; the original bank owner runs.
board=(R/'scripts/ci/fixtures/weekly-payout-owned-phase/financial-board.sql').read_text()
at=board.index('CREATE FUNCTION public.fn_ca_fund_club(');end=board.index('CREATE FUNCTION fixture_owned_seed()',at)
q(board[at:end])
freeze_source=board[board.index('CREATE OR REPLACE FUNCTION public.fn_freeze_bypass_active()'):board.index('ALTER TABLE profiles ADD COLUMN is_horse')]
q(freeze_source[:freeze_source.index('CREATE TRIGGER')])
for trigger in freeze_source[freeze_source.index('CREATE TRIGGER'):].splitlines():
    if not trigger.startswith('CREATE TRIGGER'):continue
    table=re.search(r' ON (\w+) ',trigger).group(1)
    old=q("SELECT pg_get_triggerdef(oid)FROM pg_trigger WHERE tgrelid='"+table+"'::regclass AND tgname='zz_freeze_guard'").stdout.strip()
    if old:assert 'fn_refuse_while_frozen()'in old,(table,old)
    else:q(trigger)

q("ALTER TABLE profiles ADD COLUMN is_horse boolean NOT NULL DEFAULT false;")
# Native initial capture timestamps are explicit at INSERT, never rewritten.
seed=q("SELECT pg_get_functiondef('own_playing_seed(boolean,integer,boolean)'::regprocedure)").stdout.strip()
old="accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract)VALUES(src,rr,caw_u('A'),club,earned,amt,contract)"
new="accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract,recorded_at)VALUES(src,rr,caw_u('A'),club,earned,amt,contract,earned)"
assert seed.count(old)==1
q(seed.replace(old,new))
exec(compile((EXT/'union_setup.py').read_text(),str(EXT/'union_setup.py'),'exec'))
seed_sql=""
for ns in ['global-typed-first','global-typed-second']:
    seed_sql+="SET LOCAL test.own_namespace='"+ns+"';SELECT own_playing_seed();INSERT INTO fixture_scope(club_id)VALUES(caw_u('club'));SELECT caw_assert((smarter_private.prepare_own_agent_interpretation(NULL,caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z'))->>'ready'='true','native original source interpretation');SELECT fn_rakeback_split_write(caw_u('club'),'2026-10-19','2026-10-25',ARRAY[caw_u('A')]);"
    # Initial synthetic rows model capture at earning time; never production data.
    seed_sql+="INSERT INTO accounting_period_recompute_requests(club_id,period_start,period_end,status,last_requested_at,attempted_at,last_result)VALUES(caw_u('club'),'2026-10-19','2026-10-25','complete',clock_timestamp()-interval '1 second',clock_timestamp(),jsonb_build_object('accounting_version',2,'status','ready','club_id',caw_u('club'),'period_start','2026-10-19','period_end','2026-10-25')) ON CONFLICT(club_id,period_start,period_end)DO UPDATE SET status=excluded.status,last_requested_at=excluded.last_requested_at,attempted_at=excluded.attempted_at,last_result=excluded.last_result;"
seed_sql+=union_seed_sql
seed_sql+="UPDATE profiles SET is_horse=true WHERE id IN(SELECT user_id FROM agents WHERE role='agent');INSERT INTO engine_table_leases VALUES('cae11000-0000-0000-0000-000000000001','fixture-current-engine','fixture',now(),'2026-10-26 09:00Z','cae11000-0000-0000-0000-000000000002',2);INSERT INTO weekly_accounting_payout_pauses(run_id,ownership_token,period_start,period_end,announced_at,money_starts_at,money_deadline_at,expires_at,scope_plan)VALUES('cae11000-0000-0000-0000-000000000003','cae11000-0000-0000-0000-000000000004','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-26 08:58Z','2026-10-26 09:00Z','2026-10-26 09:04Z','2026-10-26 09:05Z',smarter_private.weekly_payout_scope_plan('2026-10-26 07:00Z','2026-10-26 09:00Z'));"
ack="SELECT fn_weekly_accounting_payout_pause_ack('cae11000-0000-0000-0000-000000000003','cae11000-0000-0000-0000-000000000004','fixture-current-engine','[{\"scope\":\"cash\",\"table_id\":\"cae11000-0000-0000-0000-000000000001\",\"tournament_id\":null,\"lease_generation\":\"cae11000-0000-0000-0000-000000000002\"}]');"
call="SELECT smarter_private.weekly_payout_execute('cae11000-0000-0000-0000-000000000003');"
prefix="BEGIN;SET LOCAL statement_timeout='240s';SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_budget='3 minutes';"
checks="""
SET CONSTRAINTS ALL IMMEDIATE;
SELECT caw_assert((SELECT agent_wallet_balance=30.70 FROM agents WHERE user_id=md5('commission-agent-wallet:global-typed-union:A')::uuid),'union own agent30.70');SELECT caw_assert((SELECT chip_balance=1000.70 FROM club_members WHERE user_id=md5('commission-agent-wallet:global-typed-union:A')::uuid),'union own player70c');SELECT caw_assert((SELECT agent_wallet_balance=14 FROM agents WHERE user_id=md5('commission-agent-wallet:global-typed-union:S')::uuid),'union upline14');
SELECT caw_assert((SELECT count(*)=2 AND sum(chip_treasury)=2113.20 FROM clubs WHERE id IN(SELECT club_id FROM fixture_scope)),'two original banks102 minus real45.40 each');
SELECT caw_assert((SELECT count(*)=2 AND sum(agent_wallet_balance)=61.40 FROM agents WHERE club_id IN(SELECT club_id FROM fixture_scope)AND role='agent'),'two own-playing agents receive gross plus typed secondary');
SELECT caw_assert((SELECT count(*)=2 AND sum(chip_balance)=2001.40 FROM club_members WHERE club_id IN(SELECT club_id FROM fixture_scope)AND role='agent'),'legacy player portion exactly70c each');
SELECT caw_assert((SELECT count(*)=6 FROM accounting_rakeback_wallet_transfers),'two destinations per current typed payout');
SELECT caw_assert((SELECT sum(amount)=204 FROM ca_mint_ledger),'two original R1 bank amounts');
SELECT caw_assert((SELECT max(seq)FROM fixture_order WHERE kind='bank')<(SELECT min(seq)FROM fixture_order WHERE kind='agent'),'all bank rounds before gross agent rounds');
SELECT caw_assert((SELECT max(seq)FROM fixture_order WHERE kind='agent')<(SELECT min(seq)FROM fixture_order WHERE kind='secondary'),'all gross before any typed secondary');
SELECT caw_assert((SELECT chip_treasury=1046.40 FROM clubs WHERE id=md5('commission-agent-wallet:global-typed-union:club')::uuid),'union member gets90pct102 less original downline45.40');SELECT caw_assert((SELECT rake_wallet=0 AND chip_balance=10.20 FROM union_wallets WHERE union_id='cae11000-0000-0000-0000-000000000100'),'union retained10pct and exact rake debit');SELECT caw_assert((SELECT count(*)=3 AND bool_and(payers=CASE WHEN round_no=1 THEN 1 ELSE 0 END)FROM union_settlement_rounds WHERE union_id='cae11000-0000-0000-0000-000000000100'),'all original union receipt payer defaults');SELECT caw_assert((SELECT phase='released'AND result->>'success'='true'FROM weekly_accounting_payout_pauses),'original phase success');
SELECT caw_assert(NOT EXISTS(SELECT FROM smarter_private.weekly_payout_owned_transactions),'capability retired');
"""
# Independently cover Union bank/receipts and private phase state in addition
# to the maintained club/agent/player ledger/document snapshot.
q("""CREATE FUNCTION fixture_native_all_money_fingerprint()RETURNS text LANGUAGE plpgsql STABLE AS $native$DECLARE t text;r jsonb;v jsonb:=jsonb_build_object('original',caw_money());BEGIN FOREACH t IN ARRAY ARRAY['public.union_wallets','public.union_wallet_transactions','public.union_settlement_rounds','public.ca_settlements','public.union_rakeback_log','public.weekly_accounting_payout_pauses','smarter_private.weekly_payout_financial_receipts','smarter_private.weekly_payout_owned_transactions','public.accounting_cash_bank_receipts','public.accounting_cash_rake_sources','public.accounting_own_agent_interpretations','public.accounting_own_agent_source_reviews','public.accounting_own_agent_preparation_versions','public.accounting_rakeback_wallet_contracts','public.accounting_rakeback_wallet_transfers','public.accounting_invoice_counters','public.accounting_invoice_deliveries','public.notifications','public.social_messages']LOOP EXECUTE format($rows$SELECT coalesce(jsonb_agg(to_jsonb(x)ORDER BY to_jsonb(x)::text),'[]'::jsonb) FROM %s x$rows$,t::regclass)INTO r;v:=v||jsonb_build_object(t,r);END LOOP;RETURN md5(v::text);END$native$;""")
# Reproduce the real Union blocker on the original current controller first.
freeze="INSERT INTO engine_maintenance_break VALUES(true,clock_timestamp()-interval '2 minutes','counting_down',clock_timestamp(),clock_timestamp()+interval '5 minutes');SELECT caw_assert(fn_platform_frozen(),'actual original freeze reader sees native break');"
before=q('SELECT fixture_native_all_money_fingerprint()').stdout.strip()
failed=q(prefix+seed_sql+freeze+ack+call+'ROLLBACK;',check=False)
assert failed.returncode and 'null value in column "payers"'in failed.stderr,failed.stderr[-6000:]
assert q('SELECT fixture_native_all_money_fingerprint()').stdout.strip()==before
(OUT/'before-original-union-null-payers.log').write_text(failed.stdout+failed.stderr)
print('PASS original-current-Union-R2-NULL-payers-reproduced-and-all-money-rolled-back',flush=True)
# Restore the exact current canonical owner before applying the real candidate.
q(canonical_before)
controller_catalog=json.loads((EXT/'current-controller-catalog.json').read_text())
old_metadata=controller_catalog['owner']['metadata']
native_metadata=json.loads(q("SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE p.oid='smarter_private.weekly_payout_execute(uuid)'::regprocedure").stdout.strip())
# Only PostgreSQL catalog identity differs in isolation. No operational metadata
# or function source is normalized, and production constants are source-bound.
context_fields={'oid','proowner','pronamespace','prolang'}
assert {k:v for k,v in old_metadata.items()if k not in context_fields}=={k:v for k,v in native_metadata.items()if k not in context_fields}
actual_metadata_json=json.dumps(old_metadata,separators=(',',':'))
native_metadata_json=json.dumps(native_metadata,separators=(',',':'))
assert candidate_controller_sql.count('$metadata$'+actual_metadata_json+'$metadata$')==2,'candidate must retain both actual complete owner metadata guards'
native_candidate=candidate_controller_sql.replace('$metadata$'+actual_metadata_json+'$metadata$','$metadata$'+native_metadata_json+'$metadata$')
old_md5=controller_catalog['owner']['md5'];post_md5='fc3005c0275c0ab6fb4941660c3aaf63'
assert old_md5=='f34d653a6d05b9245c81336d69e2c453'
for name,broken,error in [('preimage',native_candidate.replace("<>'"+old_md5+"'","<>'"+'0'*32+"'",1),'weekly_union_round_receipt_owner_preimage_changed'),('payers-contract',native_candidate.replace("pg_get_expr(d.adbin,d.adrelid)='0'","pg_get_expr(d.adbin,d.adrelid)='1'",1),'weekly_union_round_receipt_payers_contract_changed'),('late-postimage',native_candidate.replace("<>'"+post_md5+"'","<>'"+'0'*32+"'",1),'weekly_union_round_receipt_owner_postimage_changed')]:
    bad=q(broken,check=False)
    assert bad.returncode and error in bad.stderr,(name,bad.stderr[-5000:])
    assert q("SELECT md5(pg_get_functiondef('smarter_private.weekly_payout_execute(uuid)'::regprocedure))").stdout.strip()==old_md5
    assert q('SELECT fixture_native_all_money_fingerprint()').stdout.strip()==before
    print('PASS whole-controller-install-'+name+'-atomic-refusal',flush=True)
q(native_candidate)
assert q("SELECT md5(pg_get_functiondef('smarter_private.weekly_payout_execute(uuid)'::regprocedure))").stdout.strip()==post_md5
assert json.loads(q("SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE p.oid='smarter_private.weekly_payout_execute(uuid)'::regprocedure").stdout.strip())==native_metadata
assert q('SELECT fixture_native_all_money_fingerprint()').stdout.strip()==before
replay=q(native_candidate,check=False)
assert replay.returncode and 'weekly_union_round_receipt_owner_preimage_changed'in replay.stderr
print('PASS whole-current-controller-installer-complete-metadata-ACL-and-original-paid-state-unchanged',flush=True)
fixed=q("SELECT pg_get_functiondef('smarter_private.weekly_payout_execute(uuid)'::regprocedure)").stdout.strip()
assert fixed.replace('CASE WHEN round=1 THEN 1 ELSE 0 END','CASE WHEN round=1 THEN 1 END')==canonical_before.strip()
# Existing isolated historical clock seam only; all new receipt code runs exact.
q(fixed.replace('statement_timestamp()','smarter_private.weekly_payout_clock()'))
before=q('SELECT fixture_native_all_money_fingerprint()').stdout.strip()
answer=q(prefix+seed_sql+"INSERT INTO engine_maintenance_break VALUES(true,clock_timestamp()-interval '2 minutes','counting_down',clock_timestamp(),clock_timestamp()+interval '5 minutes');SELECT caw_assert(fn_platform_frozen(),'actual original freeze reader sees native break');"+ack+"CREATE TEMP TABLE native_global_started AS SELECT clock_timestamp()started;"+call+"SELECT jsonb_build_object('native_global_elapsed_ms',extract(epoch FROM clock_timestamp()-(SELECT started FROM native_global_started))*1000);"+checks+"CREATE TEMP TABLE replay_before AS SELECT fixture_native_all_money_fingerprint()m;"+call+"SELECT caw_assert((fn_settle_accounting_commission_stage('union',fixture_union(),'2026-10-19 07:00Z','2026-10-26 07:00Z')->>'duplicate')='true'AND(fn_settle_accounting_rakeback_stage('union',fixture_union(),'2026-10-19 07:00Z','2026-10-26 07:00Z')->>'duplicate')='true','released original union R2 R3 replay');SELECT caw_assert((SELECT m FROM replay_before)=fixture_native_all_money_fingerprint(),'global and original union replay no new money');SELECT jsonb_build_object('order',(SELECT jsonb_agg(to_jsonb(o)ORDER BY seq)FROM fixture_order o),'rounds',(SELECT jsonb_agg(to_jsonb(r)ORDER BY scope_id,round_no)FROM accounting_routed_settlement_runs r WHERE period_start='2026-10-19 07:00Z'));ROLLBACK;")
(OUT/'actual-three-scope-typed-global-result.log').write_text(answer.stdout+answer.stderr)
assert q('SELECT fixture_native_all_money_fingerprint()').stdout.strip()==before
for label,body,error in [('secondary-fault',ack+"SET LOCAL fixture.refuse_secondary='on';"+call,'fixture-current-secondary-fault'),('missing-ack',"UPDATE fixture_clock SET n='2026-10-26 09:01Z';"+call,'weekly_payout_not_prepared_and_parked_at_four'),('ordinary-frozen-wallet',"SELECT jsonb_build_object('frozen',fn_platform_frozen(),'bypass',fn_freeze_bypass_active(),'setting',current_setting('app.freeze_bypass',true),'claims',current_setting('request.jwt.claims',true),'ownership',smarter_private.weekly_payout_owned_money_write('clubs'),'triggers',(SELECT jsonb_agg(pg_get_triggerdef(oid))FROM pg_trigger WHERE tgrelid='clubs'::regclass));UPDATE clubs SET chip_treasury=chip_treasury+1 WHERE id IN(SELECT club_id FROM fixture_scope);",'PLATFORM_FROZEN')]:
    failed=q(prefix+seed_sql+"INSERT INTO engine_maintenance_break VALUES(true,clock_timestamp()-interval '2 minutes','counting_down',clock_timestamp(),clock_timestamp()+interval '5 minutes');SELECT caw_assert(fn_platform_frozen(),'actual original freeze reader sees native break');"+body+'ROLLBACK;',check=False)
    assert failed.returncode and error in failed.stderr,(label,failed.stdout[-4000:],failed.stderr[-4000:])
    assert q('SELECT fixture_native_all_money_fingerprint()').stdout.strip()==before
    print('PASS',label,flush=True)
print('PASS currenttyped global three-scope financial extension with actual source interpretation/calculation/current-preparation validator; explicit receipt/source-quality/mint/calendar fixture boundaries; production capacity unqualified',flush=True)

(OUT/'passed.json').write_text(json.dumps({'status':'passed','scopes':3,'standalone_clubs':2,'union_member_clubs':1,'cash_sources':9,'horses':3,'original_scope_seconds':180,'original_statement_seconds':240,'controller_before':old_md5,'controller_after':post_md5,'native_only':True,'production_capacity_qualified':False,'full_precompute_lifecycle_qualified':False,'boundaries':['native inventory/GEN control inherited unchanged','completed-request lifecycle receipt fixture','cash refusal and TQ prerequisites controlled','standalone external mint transport','historical clock/lease rows and one statement-time adapter','controlled top-level scope plan','external FK/epoch registry/tournament branches outside cash proof']},indent=2)+'\n')
