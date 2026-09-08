BEGIN;
SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_claim_entry_purchase_receipt' AND md5(pg_get_functiondef(p.oid))='0d1183a2a50441a6a582ea2e5cbb5d2a') THEN RAISE EXCEPTION 'Shared receipt dependency changed: fn_claim_entry_purchase_receipt';END IF;END $guard$;
DO $guard$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_record_entry_purchase_receipt' AND md5(pg_get_functiondef(p.oid))='8311abb5ac10247b078e54f163792f5a') THEN RAISE EXCEPTION 'Shared receipt dependency changed: fn_record_entry_purchase_receipt';END IF;END $guard$;
DO $guard$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='atomic_table_rebuy' AND md5(pg_get_functiondef(p.oid))='9b873349ba3d04b8f26ba56f3d57a644') THEN RAISE EXCEPTION 'Function changed: atomic_table_rebuy';END IF;END $guard$;
CREATE OR REPLACE FUNCTION public.atomic_table_rebuy(p_user_id uuid, p_table_id uuid, p_amount numeric, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
  v_balance numeric;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Cannot rebuy for another player' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL OR p_table_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Rebuy requires a player, table and purchase key' USING ERRCODE='22023';
  END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount<=0 OR p_amount<>round(p_amount,2) THEN
    RAISE EXCEPTION 'Rebuy amount must be positive whole cents' USING ERRCODE='22023';
  END IF;

  v_request := jsonb_build_object(
    'door', 'atomic_table_rebuy',
    'user_id', p_user_id,
    'table_id', p_table_id,
    'amount', p_amount
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    'cash_transaction', p_idempotency_key::text, v_request
  );
  IF NOT COALESCE((v_response->>'claimed')::boolean, false) THEN
    RETURN (v_response->'response'->>'balance')::numeric;
  END IF;
  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.transaction_idempotency_keys k
     WHERE k.key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical cash key does not prove its table'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: scheduled maintenance has closed cash rebuys; no chips moved'
      USING ERRCODE = '55006', HINT = 'Retry after the maintenance break has ended.';
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  v_balance := public.atomic_table_rebuy_before_maintenance_announcement_gate(
    p_user_id, p_table_id, p_amount, p_idempotency_key
  );
  v_response := public.fn_record_entry_purchase_receipt(
    'cash_transaction',
    p_idempotency_key::text,
    v_request,
    jsonb_build_object('balance', v_balance)
  );
  RETURN (v_response->>'balance')::numeric;
END;
$function$
;
REVOKE ALL ON FUNCTION public.atomic_table_rebuy(uuid,uuid,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.atomic_table_rebuy(uuid,uuid,numeric,uuid) TO authenticated,service_role;
DO $guard$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='atomic_table_rebuy_before_maintenance_announcement_gate' AND md5(pg_get_functiondef(p.oid))='540305402201fb9b711046767aaea900') THEN RAISE EXCEPTION 'Function changed: atomic_table_rebuy_before_maintenance_announcement_gate';END IF;END $guard$;
CREATE OR REPLACE FUNCTION public.atomic_table_rebuy_before_maintenance_announcement_gate(p_user_id uuid, p_table_id uuid, p_amount numeric, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_new_balance numeric; v_club_id uuid; v_union_id uuid; v_ban_id uuid; v_seat_club uuid;
  v_seat_id uuid; v_pending uuid;
  v_context jsonb; v_setting text;
BEGIN
  -- ── A DEAD SESSION MOVES NO MONEY (Dan 2026-09-03) ────────────────────
  -- "I WAS LOGGED OUT, BUT SOMEHOW ABLE TO SIT DOWN AND BUY CHIPS AND GET
  -- DEALT A HAND. THAT CAN NEVER HAPPEN." It could, because this project
  -- issues SEVEN-DAY access tokens and PostgREST verifies a JWT locally -
  -- signature and exp only. It never asks GoTrue whether the session behind
  -- that token still exists, so signing out left a bearer token that kept
  -- spending real chips as its owner for the rest of the week. The engine
  -- was never fooled (it verifies through auth.getUser, which checks the
  -- session), only the database was. fn_caller_session_is_live closes that
  -- gap at the money door itself.
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot rebuy for another player';
  END IF;

  IF p_user_id IS NULL OR p_table_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Rebuy requires a player, table and purchase key' USING ERRCODE='22023';
  END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount<=0 OR p_amount<>round(p_amount,2) THEN
    RAISE EXCEPTION 'Rebuy amount must be positive whole cents' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.transaction_idempotency_keys(key,user_id,action,amount)
  VALUES(p_idempotency_key,p_user_id,'atomic_table_rebuy',p_amount) ON CONFLICT(key) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unbound rebuy key must be resolved by the shared purchase receipt' USING ERRCODE='55000';
  END IF;

  /* ZERO-DRIFT (2026-08-31): lock the seat so it cannot vacate between this
     check and the debit below. */
  SELECT ts.id, ts.club_id INTO v_seat_id, v_seat_club
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not seated at this table (cannot rebuy a vacated seat)';
  END IF;

  SELECT t.club_id, c.union_id INTO v_club_id, v_union_id
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id WHERE t.id = p_table_id LIMIT 1;
  IF v_club_id IS NOT NULL THEN
    SELECT id INTO v_ban_id FROM blacklists
     WHERE user_id = p_user_id AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_club_id OR (v_union_id IS NOT NULL AND union_id = v_union_id))
     LIMIT 1;
    IF v_ban_id IS NOT NULL THEN RAISE EXCEPTION 'Banned from this club'; END IF;
  END IF;

  IF v_seat_club IS NULL THEN
    v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, NULL);
  END IF;
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this rebuy';
  END IF;

  SELECT jsonb_object_agg(k,coalesce(current_setting(k,true),'')) INTO v_context
   FROM unnest(array['app.money_path','app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament']) settings(k);
  PERFORM set_config('app.money_path','atomic_table_rebuy',true);
  PERFORM set_config('app.ledger_category','rebuy',true);
  PERFORM set_config('app.ledger_counterparty','table_stack',true);
  PERFORM set_config('app.ledger_counterparty_entity',p_table_id::text,true);
  PERFORM set_config('app.ledger_tournament','',true);
  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;
  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for rebuy (club %)', v_seat_club;
  END IF;

  /* CHIP STANDARD C3 (2026-09-02): the chips do NOT go onto the seat here.
     This used to be a relative `stack + p_amount` UPDATE on table_seats,
     racing the engine's absolute writes: a rebuy committing after
     loadSeatedPlayers and before the next syncStacks was erased from the felt
     while the wallet stayed debited. The debit and this row land in ONE
     transaction; the engine's resolve_pending_addon delivers the chips into its
     own memory first and only then persists, so nothing can overwrite them. */
  INSERT INTO public.table_pending_addons (table_id, user_id, amount, kind)
  VALUES (p_table_id, p_user_id, p_amount, 'rebuy')
  RETURNING id INTO v_pending;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'rebuy',
            'Cash game rebuy (club wallet)', p_table_id, v_new_balance);

  FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
    PERFORM set_config(v_setting,v_context->>v_setting,true);
  END LOOP;
  RETURN v_new_balance;
END;
$function$
;
REVOKE ALL ON FUNCTION public.atomic_table_rebuy_before_maintenance_announcement_gate(uuid,uuid,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.atomic_table_rebuy_before_maintenance_announcement_gate(uuid,uuid,numeric,uuid) TO postgres;
NOTIFY pgrst,'reload schema';
COMMIT;
