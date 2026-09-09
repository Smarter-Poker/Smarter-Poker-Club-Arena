-- Reconstruct the live Club Arena wallet debit rail in source and close two
-- fail-open edges in the historical declarative body: negative amounts minted
-- chips, and a tournament buy-in with no table id could debit the player's
-- oldest club instead of the club hosting the tournament.
BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

SELECT pg_advisory_xact_lock(hashtext('atomic-deduct-wallet-and-log:v2'));

DO $preflight$
BEGIN
  IF to_regclass('public.club_members') IS NULL
     OR to_regclass('public.wallets') IS NULL
     OR to_regclass('public.tables') IS NULL
     OR to_regclass('public.tournaments') IS NULL
     OR to_regclass('public.chip_transactions') IS NULL
     OR to_regprocedure('public.fn_player_home_club(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_ensure_club_wallet(uuid,uuid)') IS NULL
     OR to_regprocedure(
          'public.atomic_deduct_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid)'
        ) IS NULL THEN
    RAISE EXCEPTION 'canonical Club Arena wallet debit dependencies are missing';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.atomic_deduct_wallet_and_log(
  p_user_id uuid,
  p_amount numeric,
  p_category text DEFAULT 'debit',
  p_description text DEFAULT '',
  p_table_id uuid DEFAULT NULL,
  p_hand_id uuid DEFAULT NULL,
  p_related_entity_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public','extensions','pg_temp'
AS $wallet_debit$
DECLARE
  v_balance numeric;
  v_club_id uuid;
  v_context_club uuid;
  v_declared_club uuid;
  v_declared_text text;
  v_has_club boolean;
BEGIN
  IF p_user_id IS NULL
     OR p_amount IS NULL
     OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount <= 0
     OR p_amount <> round(p_amount,2) THEN
    RAISE EXCEPTION 'wallet debit requires a positive two-decimal amount'
      USING ERRCODE='22023';
  END IF;

  v_declared_text:=NULLIF(current_setting('app.ledger_club_id',true),'');
  IF v_declared_text IS NOT NULL THEN
    BEGIN
      v_declared_club:=v_declared_text::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'wallet debit declared club is not a UUID'
        USING ERRCODE='22023';
    END;
    v_club_id:=v_declared_club;
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT t.club_id INTO v_context_club
      FROM public.tables t
     WHERE t.id=p_table_id;
    IF v_context_club IS NULL THEN
      RAISE EXCEPTION 'wallet debit table % has no club context',p_table_id
        USING ERRCODE='P0002';
    END IF;
    IF v_club_id IS NOT NULL AND v_club_id<>v_context_club THEN
      RAISE EXCEPTION 'wallet debit declared club does not own table %',p_table_id
        USING ERRCODE='22023';
    END IF;
    v_club_id:=v_context_club;
  END IF;

  IF p_related_entity_id IS NOT NULL
     AND lower(COALESCE(p_category,'')) IN
       ('tournament_buyin','tournament_rebuy','rebuy','reentry','addon') THEN
    SELECT t.club_id INTO v_context_club
      FROM public.tournaments t
     WHERE t.id=p_related_entity_id;
    IF v_context_club IS NULL THEN
      RAISE EXCEPTION 'wallet debit tournament % has no club context',
        p_related_entity_id USING ERRCODE='P0002';
    END IF;
    IF v_club_id IS NOT NULL AND v_club_id<>v_context_club THEN
      RAISE EXCEPTION 'wallet debit declared club does not own tournament %',
        p_related_entity_id USING ERRCODE='22023';
    END IF;
    v_club_id:=v_context_club;
  END IF;

  IF v_club_id IS NULL THEN
    v_club_id:=public.fn_player_home_club(p_user_id,NULL);
  END IF;

  IF v_club_id IS NOT NULL THEN
    IF public.fn_ensure_club_wallet(p_user_id,v_club_id) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'player % has no active wallet at club %',p_user_id,v_club_id
        USING ERRCODE='42501';
    END IF;
    SELECT cm.chip_balance INTO v_balance
      FROM public.club_members cm
     WHERE cm.user_id=p_user_id AND cm.club_id=v_club_id
       AND cm.status IN ('active','approved')
     FOR UPDATE;
    IF v_balance IS NULL OR v_balance<p_amount THEN
      RETURN false;
    END IF;
    UPDATE public.club_members cm
       SET chip_balance=cm.chip_balance-p_amount,updated_at=now()
     WHERE cm.user_id=p_user_id AND cm.club_id=v_club_id
       AND cm.status IN ('active','approved')
       AND cm.chip_balance>=p_amount;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    INSERT INTO public.chip_transactions(
      club_id,from_user_id,amount,transaction_type,notes
    ) VALUES (
      v_club_id,p_user_id,p_amount,p_category,
      COALESCE(NULLIF(p_description,''),'Wallet debit')
    );
    RETURN true;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.club_members cm WHERE cm.user_id=p_user_id
  ) INTO v_has_club;
  IF v_has_club THEN
    RAISE EXCEPTION 'No active club wallet resolves for Club Arena debit from player %',
      p_user_id USING ERRCODE='42501';
  END IF;

  UPDATE public.wallets w
     SET balance=w.balance-p_amount,updated_at=now()
   WHERE w.user_id=p_user_id AND w.wallet_type='PLAYER'
     AND w.balance>=p_amount;
  RETURN FOUND;
END;
$wallet_debit$;

REVOKE ALL ON FUNCTION public.atomic_deduct_wallet_and_log(
  uuid,numeric,text,text,uuid,uuid,uuid
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_deduct_wallet_and_log(
  uuid,numeric,text,text,uuid,uuid,uuid
) TO service_role;

COMMENT ON FUNCTION public.atomic_deduct_wallet_and_log(
  uuid,numeric,text,text,uuid,uuid,uuid
) IS 'Service-only atomic debit. Rejects non-positive/non-cent amounts; resolves table and tournament club context before any home-club fallback; writes the club balance and chip transaction in one transaction. wallet_transactions remains the caller-owned single receipt.';

DO $verify$
DECLARE v_source text;
BEGIN
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
    'public.atomic_deduct_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid)'::regprocedure;
  IF v_source NOT LIKE '%p_amount <= 0%'
     OR v_source NOT LIKE '%p_amount <> round(p_amount,2)%'
     OR position('FROM public.tables t' IN v_source)=0
     OR position('FROM public.tournaments t' IN v_source)=0
     OR position('fn_player_home_club(p_user_id,NULL)' IN v_source)=0
     OR position('FROM public.tables t' IN v_source)
          > position('fn_player_home_club(p_user_id,NULL)' IN v_source)
     OR position('FROM public.tournaments t' IN v_source)
          > position('fn_player_home_club(p_user_id,NULL)' IN v_source)
     OR v_source NOT LIKE '%fn_ensure_club_wallet(p_user_id,v_club_id)%'
     OR v_source NOT LIKE '%INSERT INTO public.chip_transactions%'
     OR v_source LIKE '%INSERT INTO public.wallet_transactions%'
     OR has_function_privilege('anon',
          'public.atomic_deduct_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid)',
          'EXECUTE')
     OR has_function_privilege('authenticated',
          'public.atomic_deduct_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid)',
          'EXECUTE')
     OR NOT has_function_privilege('service_role',
          'public.atomic_deduct_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid)',
          'EXECUTE') THEN
    RAISE EXCEPTION 'canonical Club Arena wallet debit verification failed';
  END IF;
END;
$verify$;

COMMIT;
