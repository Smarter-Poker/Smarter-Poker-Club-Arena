-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820133935 "union_law_p1_rakeback_returns_to_club_wallet"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3a506cb95cc62f0f508e03e6ee4f20eb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- P1 — RAKEBACK RETURNS TO THE CLUB WALLET (2026-08-20)
--
-- Rake is taken from chips the player bought with CLUB money, but all three
-- rakeback payout paths credited the single global player wallet. Every
-- rakeback run therefore moved money club -> global: the same leak class as the
-- tournament payouts closed earlier, and it runs on a schedule.
--
-- Also fixes a latent bug in credit_player_rakeback: when the player's club
-- could not be resolved it hardcoded SHARK CLUB as the audit club, silently
-- misattributing JAQK players' rakeback in chip_transactions.
--
-- One resolver ("where does this player's money live") is introduced and used
-- by every payout path, so rakeback, settlements and future payouts can never
-- disagree about the destination.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_player_home_club(p_user_id uuid, p_club_hint uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;
  -- Global wallet remains the destination while club scoping is off.
  IF NOT public.fn_club_scoped_chips_enabled() THEN RETURN NULL; END IF;

  -- 1. An explicit, valid membership hint wins.
  IF p_club_hint IS NOT NULL AND EXISTS (
       SELECT 1 FROM club_members m
        WHERE m.user_id = p_user_id AND m.club_id = p_club_hint
          AND m.status IN ('active','approved')) THEN
    RETURN p_club_hint;
  END IF;

  -- 2. The club they are currently playing under.
  SELECT ts.club_id INTO v_club
    FROM table_seats ts
   WHERE ts.user_id = p_user_id AND ts.left_at IS NULL AND ts.club_id IS NOT NULL
   ORDER BY ts.joined_at DESC LIMIT 1;
  IF v_club IS NOT NULL THEN RETURN v_club; END IF;

  -- 3. The club they most recently played under.
  SELECT ts.club_id INTO v_club
    FROM table_seats ts
   WHERE ts.user_id = p_user_id AND ts.club_id IS NOT NULL
   ORDER BY ts.joined_at DESC LIMIT 1;
  IF v_club IS NOT NULL THEN RETURN v_club; END IF;

  -- 4. Fall back to their oldest union membership (never a hardcoded club).
  SELECT m.club_id INTO v_club
    FROM club_members m
    JOIN union_clubs uc ON uc.club_id = m.club_id
   WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
   ORDER BY m.joined_at ASC NULLS LAST, m.club_id
   LIMIT 1;

  RETURN v_club;
END $function$;

-- Payout helper shared by every credit path --------------------------------
CREATE OR REPLACE FUNCTION public.fn_pay_player_chips(p_user_id uuid, p_amount numeric, p_category text, p_description text, p_club_hint uuid DEFAULT NULL, p_related_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid; v_balance numeric; v_source text := 'global_wallet';
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('paid', false, 'reason', 'non_positive');
  END IF;

  v_club := public.fn_player_home_club(p_user_id, p_club_hint);

  IF v_club IS NOT NULL THEN
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance,0) + p_amount, updated_at = NOW()
     WHERE user_id = p_user_id AND club_id = v_club
     RETURNING chip_balance INTO v_balance;
    IF FOUND THEN
      v_source := 'club_chips';
    ELSE
      v_club := NULL;
    END IF;
  END IF;

  IF v_club IS NULL THEN
    INSERT INTO wallets (user_id, wallet_type, balance)
         VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) DO UPDATE
       SET balance = wallets.balance + p_amount, updated_at = NOW()
    RETURNING balance INTO v_balance;
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, related_entity_id, balance_after)
  VALUES
    (p_user_id, 'PLAYER', 'credit', p_amount, p_category,
     p_description || CASE WHEN v_club IS NOT NULL THEN ' [club chips]' ELSE '' END,
     p_related_id, v_balance);

  RETURN jsonb_build_object('paid', true, 'club_id', v_club,
                            'source', v_source, 'balance_after', v_balance);
END $function$;

-- 1/3 -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_pay_player_rakeback(p_user_id uuid, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF p_amount <= 0 THEN RETURN; END IF;
  -- UNION LAW: rakeback goes back to the club whose chips generated the rake.
  PERFORM public.fn_pay_player_chips(p_user_id, p_amount, 'rakeback', 'Rakeback payout', NULL, NULL);
END; $function$;

-- 2/3 -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_pay_player_rakeback(p_snapshot_id uuid, p_player_id uuid, p_amount numeric, p_period_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_inserted integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO wallet_credit_idempotency (key, user_id, amount)
    VALUES (p_idempotency_key, p_player_id, p_amount)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN RETURN; END IF;
  END IF;

  PERFORM public.fn_pay_player_chips(
    p_player_id, p_amount, 'rakeback',
    'Rakeback payout (snapshot ' || p_snapshot_id::text || ', period ' || p_period_id::text || ')',
    NULL, p_snapshot_id);
END;
$function$;

-- 3/3 -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_player_rakeback(p_user_id uuid, p_amount numeric, p_description text DEFAULT ''::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_inserted integer;
  v_res jsonb;
BEGIN
  IF p_amount <= 0 THEN RETURN false; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO wallet_credit_idempotency (key, user_id, amount)
    VALUES (p_idempotency_key, p_user_id, p_amount)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN RETURN false; END IF;
  END IF;

  v_res := public.fn_pay_player_chips(
    p_user_id, p_amount, 'rakeback',
    COALESCE(NULLIF(p_description, ''), 'Rakeback credit'), NULL, NULL);

  -- Audit row. The club is the RESOLVED payout club; the old code fell back to
  -- a hardcoded SHARK CLUB id, misattributing other clubs' rakeback.
  v_club_id := NULLIF(v_res->>'club_id','')::uuid;
  IF v_club_id IS NULL THEN
    SELECT club_id INTO v_club_id FROM club_members WHERE user_id = p_user_id
     ORDER BY joined_at ASC NULLS LAST LIMIT 1;
  END IF;

  IF v_club_id IS NOT NULL THEN
    INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type, notes)
    VALUES (v_club_id, p_user_id, p_amount, 'rakeback',
            COALESCE(NULLIF(p_description, ''), 'Rakeback credit'));
  END IF;

  RETURN true;
END; $function$;

