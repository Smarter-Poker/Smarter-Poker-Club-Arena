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
       AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
      RAISE EXCEPTION 'This tournament cannot be cancelled after a player has registered'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine THEN
      FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        IF (to_jsonb(NEW) -> v_key) IS DISTINCT FROM (to_jsonb(OLD) -> v_key) THEN
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
$function$
