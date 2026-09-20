\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
DO $isolation$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
 OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_mixed_qualification.execution_uuid')::uuid::text,'-','')
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
 THEN RAISE EXCEPTION 'independent observer requires exact private nonsuper backend'; END IF;
END $isolation$;
CREATE FUNCTION pg_temp.mixed_state() RETURNS jsonb LANGUAGE plpgsql SET timezone TO 'UTC' AS $state$
DECLARE result jsonb:='{}'; name text; rows jsonb; tid uuid:=current_setting('spin_mixed_qualification.tournament_id')::uuid;
BEGIN
 FOREACH name IN ARRAY ARRAY['tournament_players','tournament_payouts','tournament_obligations',
   'tournament_escrow','tournament_terminal_settlements','tournament_refund_entitlements',
   'tournament_entry_close_receipts','tournament_launch_receipts','spin_draw_receipts','spin_reserve_ledger',
   'chip_ledger','tournament_knockout_candidates','ca_spin_mixed_basis_v1','ca_spin_mixed_completion_v1','ca_spin_mixed_dispatch_v1'] LOOP
   EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM public.%I r WHERE tournament_id=$1',name) INTO rows USING tid;
   result:=result||jsonb_build_object(name,rows);
 END LOOP;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO rows FROM public.wallet_transactions r WHERE related_entity_id=tid;
 result:=result||jsonb_build_object('wallet_transactions',rows);
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO rows FROM public.tournaments r WHERE id=tid;
 result:=result||jsonb_build_object('tournaments',rows);
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO rows FROM public.tables r WHERE tournament_id=tid;
 result:=result||jsonb_build_object('tables',rows);
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO rows FROM public.table_seats r
   WHERE table_id IN (SELECT id FROM public.tables WHERE tournament_id=tid);
 result:=result||jsonb_build_object('table_seats',rows);
 FOREACH name IN ARRAY ARRAY['hand_history','hand_atomic_commits','settlement_idempotency_keys'] LOOP
   EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM public.%I r WHERE table_id IN(SELECT id FROM public.tables WHERE tournament_id=$1)',name) INTO rows USING tid;
   result:=result||jsonb_build_object(name,rows);
 END LOOP;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.club_id,r.user_id),'[]'::jsonb) INTO rows FROM public.club_members r
   WHERE EXISTS(SELECT 1 FROM public.tournament_refund_entitlements e WHERE e.tournament_id=tid
     AND e.refund_wallet_club_id=r.club_id AND e.user_id=r.user_id);
 RETURN result||jsonb_build_object('source_wallets',rows);
END $state$;
CREATE FUNCTION pg_temp.whole_cash_estate() RETURNS jsonb LANGUAGE plpgsql SET timezone TO 'UTC' AS $estate$
DECLARE name text; rows jsonb; result jsonb:='{}';
BEGIN
 FOREACH name IN ARRAY ARRAY['club_members','clubs','spin_bonus_pools','tournament_escrow',
 'chip_ledger','wallet_transactions','wallet_credit_idempotency','wallets','tournament_payouts',
 'tournament_obligations','spin_reserve_ledger','tournament_terminal_settlements','accounting_tournament_fee_batches','accounting_tournament_fee_sources','accounting_tournament_fee_recognitions','accounting_tournament_recognized_sources','accounting_routed_settlement_runs','accounting_period_recompute_requests'] LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM public.%I r',name) INTO rows;
 result:=result||jsonb_build_object(name,rows);
 END LOOP;
 RETURN result;
END $estate$;
SELECT jsonb_build_object('pid',pg_backend_pid(),'backend_start',(SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()),'user',current_user,'session_user',session_user,'database',current_database(),'state',pg_temp.mixed_state(),'estate',pg_temp.whole_cash_estate());
ROLLBACK;
