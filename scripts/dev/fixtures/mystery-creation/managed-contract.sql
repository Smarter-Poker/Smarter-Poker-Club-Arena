CREATE OR REPLACE FUNCTION public.fn_managed_game_contract_document(p_kind text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_kind
    WHEN 'table' THEN p_row - ARRAY[
      'current_players', 'status', 'created_at', 'updated_at', 'deleted_at',
      'lifecycle', 'role', 'main_index', 'opened_at', 'live_at',
      'break_started_at', 'break_eligible_since', 'promote_pending',
      'deleted_by', 'is_deleted', 'current_hand_id', 'hand_number',
      'last_activity_at', 'tournament_id', 'engine_instance_id',
      'first_button_seat', 'bomb_pot_manual_pending', 'bomb_pot_sched_state',
      'bomb_pot_next_due_at', 'engine_lease_owner', 'engine_lease_expires_at', 'seat_game_scope', 'seat_admission_key'
    ]::text[]
    WHEN 'tournament' THEN jsonb_strip_nulls(
      jsonb_build_object(
        'id', p_row -> 'id', 'club_id', p_row -> 'club_id',
        'union_id', p_row -> 'union_id', 'name', p_row -> 'name',
        'description', p_row -> 'description',
        'short_description', p_row -> 'short_description',
        'game_type', p_row -> 'game_type', 'variant', p_row -> 'variant',
        'tournament_type', p_row -> 'tournament_type',
        'buy_in_amount', p_row -> 'buy_in_amount',
        'buy_in_fee', p_row -> 'buy_in_fee',
        'starting_chips', p_row -> 'starting_chips',
        'max_players', p_row -> 'max_players',
        'min_players', p_row -> 'min_players',
        'blind_structure', p_row -> 'blind_structure',
        'payout_structure', p_row -> 'payout_structure',
        'payout_percent', p_row -> 'payout_percent',
        'payout_math_version', CASE WHEN p_row->>'payout_math_version'='2' THEN p_row->'payout_math_version' END,
        'payout_unit_cents', CASE WHEN p_row->>'payout_math_version'='2' THEN p_row->'payout_unit_cents' END,
        'guaranteed_prize', p_row -> 'guaranteed_prize'
      ) || jsonb_build_object(
        'late_reg_levels', p_row -> 'late_reg_levels',
        'late_reg_mins', p_row -> 'late_reg_mins',
        'rebuy_levels', p_row -> 'rebuy_levels',
        'start_time', p_row -> 'start_time',
        'is_rebuy', p_row -> 'is_rebuy',
        'is_reentry', p_row -> 'is_reentry',
        'rebuy_cost', p_row -> 'rebuy_cost',
        'rebuy_chips', p_row -> 'rebuy_chips',
        'max_rebuys', p_row -> 'max_rebuys',
        'max_reentries', p_row -> 'max_reentries',
        'free_buy', p_row -> 'free_buy',
        'add_on_available', p_row -> 'add_on_available',
        'addon_from_start', p_row -> 'addon_from_start',
        'addon_cost', p_row -> 'addon_cost',
        'addon_chips', p_row -> 'addon_chips',
        'addon_levels', p_row -> 'addon_levels',
        'addon_break_minutes', p_row -> 'addon_break_minutes'
      ) || jsonb_build_object(
        'is_bounty', p_row -> 'is_bounty',
        'bounty_amount', p_row -> 'bounty_amount',
        'is_pko', p_row -> 'is_pko',
        'is_mystery_bounty', p_row -> 'is_mystery_bounty',
        'mystery_bounty_min', p_row -> 'mystery_bounty_min',
        'mystery_bounty_max', p_row -> 'mystery_bounty_max',
        'mystery_bounty_profile', p_row -> 'mystery_bounty_profile',
        'mystery_bounty_activation', p_row -> 'mystery_bounty_activation',
        'mystery_bounty_activation_value', p_row -> 'mystery_bounty_activation_value',
        'mystery_bounty_pool_percent', p_row -> 'mystery_bounty_pool_percent',
        'mystery_bounty_regular_pool_percent', p_row -> 'mystery_bounty_regular_pool_percent',
        'mystery_bounty_top_percent', p_row -> 'mystery_bounty_top_percent',
        'spin_type', p_row -> 'spin_type',
        'satellite_target_id', p_row -> 'satellite_target_id',
        'satellite_target', p_row -> 'satellite_target',
        'satellite_seats', p_row -> 'satellite_seats'
      ) || jsonb_build_object(
        'is_xmtt', p_row -> 'is_xmtt',
        'is_private', p_row -> 'is_private',
        'is_vip_only', p_row -> 'is_vip_only',
        'ban_chat', p_row -> 'ban_chat',
        'all_in_or_fold', p_row -> 'all_in_or_fold',
        'label_as_new', p_row -> 'label_as_new',
        'hide_club_name', p_row -> 'hide_club_name',
        'action_time_seconds', p_row -> 'action_time_seconds',
        'table_size', p_row -> 'table_size',
        'accelerated_mtt', p_row -> 'accelerated_mtt',
        'big_blind_ante', p_row -> 'big_blind_ante',
        'authorized_to_register', p_row -> 'authorized_to_register',
        'early_bird_enabled', p_row -> 'early_bird_enabled',
        'early_bird_chips', p_row -> 'early_bird_chips',
        'bubble_protection', p_row -> 'bubble_protection',
        'final_table_deal_enabled', p_row -> 'final_table_deal_enabled',
        'restart_every_minutes', p_row -> 'restart_every_minutes',
        'synchronized_breaks', p_row -> 'synchronized_breaks'
      ) || jsonb_build_object(
        'is_multi_day', p_row -> 'is_multi_day',
        'total_days', p_row -> 'total_days',
        'is_pinned', p_row -> 'is_pinned',
        'schedule_id', p_row -> 'schedule_id'
      )
    )
    ELSE '{}'::jsonb
  END
$function$

