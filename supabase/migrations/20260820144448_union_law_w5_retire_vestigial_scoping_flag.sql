-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820144448 "union_law_w5_retire_vestigial_scoping_flag"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6474ebfd9367be243bea4feb7b9e220f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- W5 — RETIRE THE VESTIGIAL CLUB-SCOPING FLAG (2026-08-20)
--
-- union.club_scoped_chips was the rollout switch for club-scoped chips. After
-- W1 the money paths are unconditionally club-only (per the owner's rule there
-- is no global wallet in Club Arena at all), so the flag no longer controls
-- any transaction — but fn_player_spendable_balance still consulted it.
--
-- That combination is a footgun: setting the flag to 'off' would make the UI
-- display a GLOBAL balance while every buy-in still spent CLUB chips — the
-- exact display/transaction mismatch fixed in pass 5, reintroduced by a switch
-- that no longer does anything.
--
-- The flag is therefore pinned on, documented as retired, and the balance
-- function no longer branches on it. fn_club_scoped_chips_enabled() is kept
-- (other guards call it) but now always reports true.
-- ============================================================================

UPDATE public.platform_policies
   SET value = 'on',
       description = 'RETIRED 2026-08-20. Club Arena money paths are now '
         || 'unconditionally club-scoped: every club a player joins is its own '
         || 'standalone wallet and there is no global wallet inside Club Arena. '
         || 'This key is pinned on and no longer switches behaviour; changing it '
         || 'has no effect on any transaction.',
       updated_at = now()
 WHERE key = 'union.club_scoped_chips';

CREATE OR REPLACE FUNCTION public.fn_club_scoped_chips_enabled()
 RETURNS boolean
 LANGUAGE sql IMMUTABLE
AS $function$
  -- Retired switch: Club Arena is always club-scoped. Kept so existing guards
  -- and self-tests continue to compile and read true.
  SELECT true;
$function$;

-- Balance display must match what the transaction will actually spend,
-- unconditionally.
CREATE OR REPLACE FUNCTION public.fn_player_spendable_balance(p_user_id uuid, p_club_id uuid DEFAULT NULL, p_table_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid := NULL;
  v_balance numeric := 0;
  v_source text := 'club_chips';
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('balance', 0, 'source', 'none', 'club_id', NULL);
  END IF;

  IF p_table_id IS NOT NULL THEN
    -- Seated or sitting down: the seat's own club is the wallet that will be
    -- debited by a rebuy or add-on.
    SELECT ts.club_id INTO v_club
      FROM table_seats ts
     WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
     LIMIT 1;
    IF v_club IS NULL THEN
      v_club := public.fn_seat_club_for_user(p_user_id, p_table_id, p_club_id);
    END IF;
  ELSIF p_club_id IS NOT NULL THEN
    SELECT m.club_id INTO v_club
      FROM club_members m
     WHERE m.user_id = p_user_id AND m.club_id = p_club_id
     LIMIT 1;
  END IF;

  IF v_club IS NULL THEN
    v_club := public.fn_player_home_club(p_user_id, p_club_hint => NULL);
  END IF;

  IF v_club IS NOT NULL THEN
    SELECT COALESCE(chip_balance, 0) INTO v_balance
      FROM club_members WHERE user_id = p_user_id AND club_id = v_club;
  ELSE
    -- No club anywhere: a pure smarter.poker user, whose only wallet is global.
    SELECT COALESCE(balance, 0) INTO v_balance
      FROM wallets WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    v_source := 'smarter_poker_wallet';
  END IF;

  RETURN jsonb_build_object(
    'balance', COALESCE(v_balance, 0),
    'source', v_source,
    'club_id', v_club,
    'club_scoped', true
  );
END $function$;

