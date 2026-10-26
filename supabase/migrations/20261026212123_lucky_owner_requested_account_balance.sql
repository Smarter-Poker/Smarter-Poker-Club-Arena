-- Lucky: owner requested all-table exit, 225 chips, and working Lightning rejoin.
-- Cashout already returned 202 through original occupancy receipts; this records
-- the exact once-only 23-chip house credit. The key prevents a repeat on install.
-- Rejoining a funded anchor must enter its room; an empty disconnected anchor
-- must release through canonical cashout before the ordinary new buy-in.
-- @live-proof: (SELECT p.prosecdef AND has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND pg_get_functiondef(p.oid) LIKE '%fn_lightning_pool_enter(s.id)%' FROM pg_proc p WHERE p.oid='public.fn_lightning_rejoin_seated(uuid)'::regprocedure)
-- @live-proof: (SELECT count(*)=1 FROM public.wallet_credit_idempotency WHERE key='owner-lucky-225:01a17a14' AND user_id='388dc5ea-0e9f-4a49-865f-d14737f58713' AND amount=23)
BEGIN;
SET LOCAL lock_timeout='1500ms';
DO $account$
DECLARE v_adj uuid; v_ok boolean; v_bal numeric;
BEGIN
 PERFORM set_config('lock_timeout','1500ms',true);
 IF EXISTS(SELECT 1 FROM wallet_credit_idempotency WHERE key='owner-lucky-225:01a17a14' AND user_id='388dc5ea-0e9f-4a49-865f-d14737f58713' AND amount=23) THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM table_seats WHERE user_id='388dc5ea-0e9f-4a49-865f-d14737f58713' AND left_at IS NULL) THEN RAISE EXCEPTION 'ACTIVE_SEAT'; END IF;
 SELECT chip_balance INTO v_bal FROM club_members WHERE user_id='388dc5ea-0e9f-4a49-865f-d14737f58713' AND club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4' FOR UPDATE;
 IF v_bal<>202 THEN RAISE EXCEPTION 'BALANCE_CHANGED:%',v_bal; END IF;
 v_adj:=fn_ca_adjustment_under_10_9(NULL,'388dc5ea-0e9f-4a49-865f-d14737f58713',23,'Owner explicitly requested Lucky be removed from every table and have 225 chips in his account on 2026-10-26. His two seats returned 202 chips and zero chips through occupancy cashout receipts. This house-funded 23-chip credit completes the requested 225 balance without rewriting gameplay losses or other players balances. Migration 20261026212123_lucky_owner_requested_account_balance records the operation.','20261026212123_lucky_owner_requested_account_balance','Codex lucky-rejoin-01a17a14');
 PERFORM fn_ca_declare_ledger('settlement','club_treasury','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',NULL,'owner-lucky-225:01a17a14',ARRAY['clubs']);
 PERFORM set_config('app.ledger_correlation',v_adj::text,true);
 PERFORM set_config('app.ledger_club_id','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',true);
 UPDATE clubs SET chip_treasury=chip_treasury-23,updated_at=now() WHERE id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4' AND chip_treasury>=23;
 IF NOT FOUND THEN RAISE EXCEPTION 'TREASURY_UNAVAILABLE'; END IF;
 v_ok:=fn_credit_and_log('388dc5ea-0e9f-4a49-865f-d14737f58713',23,'owner-lucky-225:01a17a14','settlement','Owner requested Lucky account balance 225 after all-table cashout');
 SELECT chip_balance INTO v_bal FROM club_members WHERE user_id='388dc5ea-0e9f-4a49-865f-d14737f58713' AND club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
 IF v_ok IS NOT TRUE OR v_bal<>225 THEN RAISE EXCEPTION 'CREDIT_NOT_CONFIRMED'; END IF;
END $account$;
CREATE OR REPLACE FUNCTION public.fn_lightning_rejoin_seated(p_cluster_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp AS $function$
DECLARE u uuid:=auth.uid(); s record; g record; v_pool uuid; v_exit jsonb;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE='28000'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
 -- Same user lock as buy-in/cashout, before reading or changing an occupancy.
 PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0));
 SELECT id,cluster_mode INTO g FROM public.cash_games WHERE id=p_cluster_id FOR SHARE;
 IF NOT FOUND OR g.cluster_mode IS DISTINCT FROM 'lightning' THEN RETURN NULL; END IF;
 SELECT ts.* INTO s FROM public.table_seats ts JOIN public.tables t ON t.id=ts.table_id
 WHERE ts.user_id=u AND ts.left_at IS NULL AND t.cluster_id=p_cluster_id
 ORDER BY ts.joined_at DESC LIMIT 1 FOR UPDATE OF ts;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- A hand/reservation owns the chips until settlement, including an all-in zero.
 IF public.fn_lightning_player_in_hand(u,p_cluster_id) OR EXISTS(
  SELECT 1 FROM public.lightning_reservation WHERE player_id=u AND cluster_id=p_cluster_id
   AND state IN ('pending','committed')) THEN
  SELECT id INTO v_pool FROM public.lightning_pool_session
   WHERE player_id=u AND cluster_id=p_cluster_id AND exited_at IS NULL;
  IF v_pool IS NULL THEN RAISE EXCEPTION 'LIGHTNING_REJOIN_PENDING'; END IF;
  RETURN jsonb_build_object('table_id',s.table_id,'pool_session_id',v_pool);
 END IF;
 IF s.stack IS NULL OR s.stack<0 OR s.stack::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'INVALID_ANCHOR_STACK'; END IF;
 IF s.stack=0 THEN
  -- A disconnected busted occupancy is not a bought-in seat. Close through
  -- the canonical receipt/session door, never DELETE, then allow a fresh buy-in.
  v_exit:=public.atomic_seat_cashout_locked(u,s.table_id,s.seat_number,'voluntary');
  IF v_exit->>'ok' IS DISTINCT FROM 'true' OR (v_exit->>'stack')::numeric<>0 THEN
   RAISE EXCEPTION 'LIGHTNING_REJOIN_EXIT_UNCONFIRMED';
  END IF;
  RETURN NULL;
 END IF;
 IF public.fn_cash_game_barred_seconds(p_cluster_id,u) IS NOT NULL THEN RAISE EXCEPTION 'GAME_BARRED:%',public.fn_cash_game_barred_seconds(p_cluster_id,u) USING ERRCODE='23514'; END IF;
 -- Re-open the existing funded anchor through the same RG/joins/eligibility
 -- checks as a new entry. No wallet debit and no second occupancy.
 v_pool:=public.fn_lightning_pool_enter(s.id);
 IF v_pool IS NULL THEN RAISE EXCEPTION 'LIGHTNING_REJOIN_UNAVAILABLE'; END IF;
 RETURN jsonb_build_object('table_id',s.table_id,'pool_session_id',v_pool);
END $function$;
REVOKE ALL ON FUNCTION public.fn_lightning_rejoin_seated(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_rejoin_seated(uuid) TO authenticated,service_role;

COMMIT;
