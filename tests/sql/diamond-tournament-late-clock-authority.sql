CREATE OR REPLACE FUNCTION public.fn_ca_text_without_dollar(p_text text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE WHEN p_text IS NULL OR position('$' IN p_text) = 0 THEN p_text ELSE
    replace(
     regexp_replace(
      regexp_replace(
       regexp_replace(
        regexp_replace(
         regexp_replace(
          regexp_replace(p_text,
            '^\$([0-9]+) (Base|Guaranteed) Prize Pool\. Entry Is Free\..*$', '\1 Chip Guarantee'),
          'Free Entry\. \$([0-9]+) Base Prize Pool\.', 'Free Entry. \1 Chip Guarantee.', 'g'),
         '\$([0-9]+)((?: [A-Za-z0-9]+)*?) Freeroll', '\1 Chip Guarantee\2 Freeroll', 'g'),
        'Cost \$([0-9]+)(?:\.00)? And', 'Cost \1 Chips And', 'g'),
       'One \$([0-9]+)(?:\.00)? Add-On', 'One \1 Chip Add-On', 'g'),
      '\$([0-9]+(?:\.[0-9]+)?)', '\1', 'g'),
    '$', '') END
$function$;
ALTER FUNCTION public.fn_ca_text_without_dollar(text) OWNER TO postgres;
DO $pin$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_text_without_dollar(text)'::regprocedure))<>'e89852747fd101f64c5ddec377379a3b' THEN RAISE EXCEPTION 'late_clock_copy_capture_changed'; END IF; END $pin$;
-- Read-only production authority capture, 2026-10-18 19:03 UTC. Private native fixture only.
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_guarantee_copy(p_text text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$ SELECT replace(p_text, 'Chip Guarantee', 'Diamond Guarantee') $function$;
ALTER FUNCTION public.fn_ca_diamond_guarantee_copy(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_guarantee_copy(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_guarantee_copy(text) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_guarantee_copy(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_guarantee_copy(text) TO service_role;
DO $pin$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_diamond_guarantee_copy(text)'::regprocedure))<>'4003d69bc76ca430bd347c1d9eaa3228' THEN RAISE EXCEPTION 'late_clock_authority_capture_changed'; END IF; END $pin$;
CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_engine boolean := COALESCE(auth.role(), '') = 'service_role';
  v_managed_command boolean :=
    COALESCE(current_setting('app.managed_game_lifecycle', true), '') = 'on';
  v_protected_tournament_keys text[] := ARRAY[
    'name', 'start_time', 'max_players', 'buy_in_amount', 'buy_in_fee',
    'guaranteed_prize', 'late_reg_mins', 'starting_chips', 'blind_structure',
    'payout_structure', 'game_type', 'variant', 'tournament_type', 'is_rebuy',
    'rebuy_cost', 'rebuy_chips', 'rebuy_levels', 'add_on_available',
    'addon_cost', 'addon_chips', 'is_bounty', 'bounty_amount', 'is_pko',
    'is_mystery_bounty', 'mystery_bounty_min', 'mystery_bounty_max',
    'description', 'short_description', 'min_players', 'late_reg_levels',
    'is_reentry', 'max_rebuys', 'max_reentries', 'addon_levels',
    'addon_break_minutes', 'is_private', 'is_vip_only', 'ban_chat',
    'all_in_or_fold', 'label_as_new', 'hide_club_name', 'is_pinned',
    'action_time_seconds', 'table_size', 'accelerated_mtt', 'big_blind_ante',
    'authorized_to_register', 'early_bird_enabled', 'early_bird_chips',
    'bubble_protection', 'final_table_deal_enabled', 'restart_every_minutes',
    'synchronized_breaks', 'is_multi_day', 'total_days', 'is_xmtt',
    'union_id', 'satellite_target_id', 'satellite_seats', 'spin_type',
    'mystery_bounty_profile', 'mystery_bounty_activation',
    'mystery_bounty_activation_value', 'mystery_bounty_pool_percent',
    'mystery_bounty_top_percent', 'settings'
  ];
  v_key text;
  v_new_document jsonb;
  v_old_document jsonb;
BEGIN
  IF TG_TABLE_NAME = 'tables' THEN
    IF lower(COALESCE(NEW.status, '')) IN ('closed', 'deleted')
       AND lower(COALESCE(OLD.status, '')) NOT IN ('closed', 'deleted')
       AND EXISTS (
         SELECT 1
         FROM public.table_seats ts
         WHERE ts.table_id = NEW.id
           AND ts.left_at IS NULL
       ) THEN
      RAISE EXCEPTION 'This table cannot be closed while players are seated'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine
       AND NOT v_managed_command
       AND (
         lower(COALESCE(NEW.status, '')) = 'deleted'
         AND lower(COALESCE(OLD.status, '')) <> 'deleted'
         OR COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false)
       ) THEN
      RAISE EXCEPTION 'Table lifecycle changes must use fn_close_managed_game'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tournaments'
     AND EXISTS (
       SELECT 1
       FROM public.tournament_players tp
       WHERE tp.tournament_id = NEW.id
     ) THEN
    IF NOT v_is_engine
       AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
       AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED')
       -- DIAMOND PHASE 10: platform staff cancel a Diamond event through
       -- fn_poker_diamond_cancel_tournament, which names that one event here,
       -- in its own transaction, around the Diamond cancellation authority
       -- that first returns every entry from its own custody row.
       AND COALESCE(current_setting('app.poker_diamond_staff_cancel', true), '') IS DISTINCT FROM NEW.id::text THEN
      RAISE EXCEPTION 'This tournament cannot be cancelled after a player has registered'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine THEN
      v_new_document := to_jsonb(NEW);
      v_old_document := to_jsonb(OLD);
      FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        -- THE CLUB ARENA SHOWS NO DOLLAR SIGN (2026-10-09): the one change a
        -- registered event's display text may take is the dollar-free rewrite
        -- of the text it already had (public.fn_ca_text_without_dollar).
        CONTINUE WHEN v_key IN ('name', 'short_description', 'description')
          AND jsonb_typeof(v_old_document -> v_key) = 'string'
          AND (v_new_document ->> v_key) IS NOT DISTINCT FROM
              public.fn_ca_text_without_dollar(v_old_document ->> v_key);
        -- Only the canonical Diamond denomination correction may alter a registered event.
        CONTINUE WHEN v_key IN ('name', 'short_description', 'description')
          AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
          AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = NEW.club_id AND c.asset = 'diamonds')
          AND jsonb_typeof(v_old_document -> v_key) = 'string'
          AND (v_new_document ->> v_key) IS NOT DISTINCT FROM
              public.fn_ca_diamond_guarantee_copy(v_old_document ->> v_key);
        IF (v_new_document -> v_key) IS DISTINCT FROM (v_old_document -> v_key) THEN
          RAISE EXCEPTION 'This tournament cannot be modified after a player has registered'
            USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF NOT v_is_engine
     AND NOT v_managed_command
     AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
     AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
    RAISE EXCEPTION 'Tournament lifecycle changes must use fn_close_managed_game'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_guard_managed_game_lifecycle() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_guard_managed_game_lifecycle() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_lifecycle() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_lifecycle() TO service_role;
DO $pin$ BEGIN IF md5(pg_get_functiondef('public.fn_guard_managed_game_lifecycle()'::regprocedure))<>'d223c76125333604fde0fc88afb372ad' THEN RAISE EXCEPTION 'late_clock_authority_capture_changed'; END IF; END $pin$;
