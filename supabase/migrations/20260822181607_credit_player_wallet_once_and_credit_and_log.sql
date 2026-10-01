-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260822181607 as "credit_player_wallet_once_and_credit_and_log"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
CREATE OR REPLACE FUNCTION public.fn_credit_player_wallet_once(
  p_user_id uuid,
  p_amount numeric,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_inserted integer; v_tourn uuid; v_club uuid; v_balance numeric;
  v_is_tournament boolean := false; v_has_any_club boolean;
BEGIN
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO wallet_credit_idempotency (key, user_id, amount)
        VALUES (p_idempotency_key, p_user_id, p_amount)
        ON CONFLICT (key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        -- FALSE, not void: the caller needs to know it must NOT write a
        -- ledger row for a credit somebody else already made.
        IF v_inserted = 0 THEN RETURN false; END IF;
    END IF;

    IF p_idempotency_key IS NOT NULL AND p_idempotency_key LIKE 'tourney:%' THEN
      v_is_tournament := true;
      BEGIN
        v_tourn := (split_part(p_idempotency_key, ':', 2))::uuid;
      EXCEPTION WHEN OTHERS THEN v_tourn := NULL;
      END;
      IF v_tourn IS NOT NULL THEN
        SELECT tp.club_id INTO v_club FROM tournament_players tp
         WHERE tp.tournament_id = v_tourn AND tp.user_id = p_user_id LIMIT 1;
        IF v_club IS NULL THEN
          SELECT t.club_id INTO v_club FROM tournaments t WHERE t.id = v_tourn;
          v_club := COALESCE(public.fn_player_home_club(p_user_id, NULL), v_club);
        END IF;
      END IF;
    END IF;

    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(p_user_id, NULL);
    END IF;

    IF v_club IS NOT NULL THEN
      PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
      UPDATE club_members
         SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
       WHERE user_id = p_user_id AND club_id = v_club
       RETURNING chip_balance INTO v_balance;
      IF v_balance IS NOT NULL THEN RETURN true; END IF;
    END IF;

    SELECT EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = p_user_id)
      INTO v_has_any_club;

    IF v_is_tournament OR v_has_any_club THEN
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical','credit_player_wallet',
              'Club Arena credit could not resolve a club wallet - payment refused rather than pooled',
              jsonb_build_object('user_id',p_user_id,'amount',p_amount,
                                 'idempotency_key',p_idempotency_key,'tournament_id',v_tourn));
      RAISE EXCEPTION 'No club wallet resolves for Club Arena credit to player %', p_user_id;
    END IF;

    UPDATE wallets SET balance = balance + p_amount, updated_at = NOW()
      WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    IF NOT FOUND THEN
        INSERT INTO wallets (user_id, wallet_type, balance, locked_balance, created_at, updated_at)
        VALUES (p_user_id, 'PLAYER', p_amount, 0, NOW(), NOW());
    END IF;

    RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.credit_player_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  PERFORM public.fn_credit_player_wallet_once(p_user_id, p_amount, p_idempotency_key);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_credit_player_wallet_once(uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_credit_player_wallet_once(uuid, numeric, text) FROM anon;
REVOKE ALL ON FUNCTION public.fn_credit_player_wallet_once(uuid, numeric, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_player_wallet_once(uuid, numeric, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_credit_and_log(
  p_user_id           uuid,
  p_amount            numeric,
  p_idempotency_key   text,
  p_category          text,
  p_description       text,
  p_related_entity_id uuid    DEFAULT NULL,
  p_wallet_type       text    DEFAULT 'PLAYER',
  p_table_id          uuid    DEFAULT NULL,
  p_hand_id           uuid    DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_credited boolean;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'fn_credit_and_log requires an idempotency key';
  END IF;

  v_credited := public.fn_credit_player_wallet_once(p_user_id, p_amount, p_idempotency_key);

  IF NOT v_credited THEN
    RETURN false;
  END IF;

  PERFORM public.log_wallet_transaction(
    p_user_id, p_wallet_type, p_amount, 'credit', p_category, p_description,
    p_table_id, p_hand_id, p_related_entity_id);

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid) TO service_role;

DO $assert$
DECLARE v_ret text; v_sec boolean;
BEGIN
  SELECT pg_get_function_result(p.oid), p.prosecdef INTO v_ret, v_sec
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_credit_player_wallet_once';
  IF v_ret IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'fn_credit_player_wallet_once must return boolean, got %', v_ret;
  END IF;
  IF v_sec THEN
    RAISE EXCEPTION 'fn_credit_player_wallet_once must NOT be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'credit_player_wallet'
       AND pg_get_function_result(p.oid) = 'void') THEN
    RAISE EXCEPTION 'credit_player_wallet changed shape - callers would break';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_credit_and_log') THEN
    RAISE EXCEPTION 'fn_credit_and_log was not created';
  END IF;

  IF has_function_privilege('anon',
       'public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_credit_and_log is reachable by a player role';
  END IF;

  IF has_function_privilege('anon',
       'public.fn_credit_player_wallet_once(uuid, numeric, text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_credit_player_wallet_once(uuid, numeric, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_credit_player_wallet_once is reachable by a player role';
  END IF;
END $assert$;
