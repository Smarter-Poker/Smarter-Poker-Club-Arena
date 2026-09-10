-- Disposable PostgreSQL native immutable Spin launch composition.
-- Real entry/reserve/journal/escrow writes, final receipt failure, exact replay,
-- and played/vacated recovery through the lease-bound launch completion RPC.
-- The final PASS exception rolls back the complete fixture.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user <> 'postgres'
     OR to_regprocedure('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)') IS NULL
     OR to_regprocedure('public.fn_prove_played_spin_launch_recovery(uuid)') IS NULL
     OR to_regprocedure('public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'native Spin launch probe requires the disposable composed rehearsal database';
  END IF;
  IF md5(pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure))
       IS DISTINCT FROM '6d2328689637d1d28c9ce9256a0d6252'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_spin_book_entry(uuid)'::regprocedure)
       IS DISTINCT FROM '604113bd4172433183cdd1d59af04e0f'
     OR (SELECT md5(prosrc) FROM pg_proc
          WHERE oid='public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)'::regprocedure)
       IS DISTINCT FROM 'a0f5a4d8edb0c0e403d3c00a9aadaa95' THEN
    RAISE EXCEPTION 'native Spin launch money authority fingerprint changed';
  END IF;
  IF EXISTS(SELECT 1 FROM (VALUES
      ('spin_reserve_ledger','spin_reserve_row_requires_exact_journal'),
      ('chip_ledger','zz_ca_escrow_reserve_leg'),
      ('spin_bonus_pools','trg_ca_autoledger'),
      ('tournament_escrow','zz_spin_escrow_is_enforced'),
      ('spin_draw_receipts','spin_draw_receipt_is_immutable')) guards(table_name,trigger_name)
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid=to_regclass('public.'||guards.table_name)
         AND t.tgname=guards.trigger_name AND t.tgenabled='O')) THEN
    RAISE EXCEPTION 'native Spin launch requires enabled money and receipt guards';
  END IF;
END;
$fixture_guard$;

SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id)
SELECT md5('current-spin-shared3-user:' || g.i::text)::uuid
  FROM generate_series(1,3) g(i);

INSERT INTO public.profiles(id,username,display_name)
SELECT md5('current-spin-shared3-user:' || g.i::text)::uuid,
       'current_spin_shared3_' || g.i,
       'Current Spin Launch ' || g.i
  FROM generate_series(1,3) g(i);

INSERT INTO public.clubs(id,name,owner_id,chip_treasury,spins_enabled)
VALUES (
  '96000000-0000-0000-0000-000000000001',
  'Current Shared Reserve Second Probe Club',
  md5('current-spin-shared3-user:1')::uuid,
  1000,
  true
);

INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
SELECT '96000000-0000-0000-0000-000000000001',
       md5('current-spin-shared3-user:' || g.i::text)::uuid,
       CASE WHEN g.i=1 THEN 'owner' ELSE 'player' END,
       'active',
       100
  FROM generate_series(1,3) g(i);

INSERT INTO public.spin_bonus_pools(
  id,club_id,balance,total_deposited,total_drawn,spin_count,bonus_count,
  seeded_amount,ceiling_amount,highest_stake,surplus_returned,is_active,
  owner_kind,offered_max_stake,seed_returned_amount,required_seed_at_activation
) VALUES (
  '96030000-0000-0000-0000-000000000001',
  '96000000-0000-0000-0000-000000000001',
  0,0,0,0,0,0,10000,1,0,true,'club',1,0,0
);

INSERT INTO public.tournaments(
  id,club_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
  start_time,status,current_players,max_players,min_players,starting_chips,
  blind_structure,table_size,prize_pool,payout_structure,spin_locked_tiers,
  synchronized_breaks
) VALUES (
  '96010000-0000-0000-0000-000000000001',
  '96000000-0000-0000-0000-000000000001',
  'Current Spin Launch Recovery',
  'NLH','spin','SPIN',1,0,now(),'REGISTERING',3,3,3,1000,
  '[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"duration":180}]',3,3,
  '[{"place":1,"percentage":100}]',NULL,false
);

INSERT INTO public.tables(
  id,club_id,name,game_type,game_variant,max_players,current_players,status,
  starting_chips,is_spins,tournament_id,lifecycle
) VALUES (
  '96020000-0000-0000-0000-000000000001',
  '96000000-0000-0000-0000-000000000001',
  'Current Spin Launch Table',
  'tournament','nlh',3,3,'waiting',1000,true,
  '96010000-0000-0000-0000-000000000001','live'
);

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,username,chips,status,table_id,seat_number,club_id
)
SELECT md5('current-spin-shared3-player:' || g.i::text)::uuid,
       '96010000-0000-0000-0000-000000000001',
       md5('current-spin-shared3-user:' || g.i::text)::uuid,
       'Current Spin Launch ' || g.i,
       1000,
       'playing',
       '96020000-0000-0000-0000-000000000001',
       g.i,
       '96000000-0000-0000-0000-000000000001'
  FROM generate_series(1,3) g(i);

INSERT INTO public.table_seats(
  id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,
  is_sitting_out,is_away,club_id
)
SELECT md5('current-spin-shared3-seat:' || g.i::text)::uuid,
       '96020000-0000-0000-0000-000000000001',
       g.i,
       md5('current-spin-shared3-user:' || g.i::text)::uuid,
       1000,
       'active',NULL,false,false,false,
       '96000000-0000-0000-0000-000000000001'
  FROM generate_series(1,3) g(i);

INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,overlay_in,
  satellite_in,prize_out,bounty_out,fee_out,refund_prize,refund_bounty,
  refund_fee,reserve_out,reserve_in,prize_balance,bounty_balance,fee_balance,
  opened_from,opened_at,updated_at,enforced
) VALUES (
  '96010000-0000-0000-0000-000000000001',3,0,0,0,0,0,0,0,0,0,0,0,
  0,0,3,0,0,'current-spin-shared3-probe',now(),now(),true
);

INSERT INTO public.wallet_transactions(
  id,user_id,wallet_type,amount,type,category,description,related_entity_id,
  balance_after
)
SELECT md5('current-spin-shared3-wallet:' || g.i::text)::uuid,
       md5('current-spin-shared3-user:' || g.i::text)::uuid,
       'PLAYER',1,'debit','tournament_buyin',
       'Current Spin launch probe buy-in',
       '96010000-0000-0000-0000-000000000001',
       99
  FROM generate_series(1,3) g(i);

INSERT INTO public.chip_ledger(
  id,performed_by,from_type,from_entity_id,to_type,to_entity_id,
  amount,category,club_id,tournament_id,description
)
SELECT md5('current-spin-shared3-source-ledger:' || g.i::text)::uuid,
       md5('current-spin-shared3-user:' || g.i::text)::uuid,
       'player_wallet',md5('current-spin-shared3-user:' || g.i::text)::uuid,
       'prize_liability','96010000-0000-0000-0000-000000000001',
       1,'tournament_buyin','96000000-0000-0000-0000-000000000001',
       '96010000-0000-0000-0000-000000000001',
       'Current Spin launch probe source charge'
  FROM generate_series(1,3) g(i);

INSERT INTO public.tournament_refund_entitlements(
  id,tournament_id,user_id,entitlement_kind,charge_category,
  refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
  source_ledger_id,registration_id,source_satellite_id,source_award_place,
  source_ticket_id,escrow_bucket,evidence_kind
)
SELECT md5('current-spin-shared3-entitlement:' || g.i::text)::uuid,
       '96010000-0000-0000-0000-000000000001',
       md5('current-spin-shared3-user:' || g.i::text)::uuid,
       'wallet_charge','tournament_buyin',
       '96000000-0000-0000-0000-000000000001',
       1,1,0,0,
       md5('current-spin-shared3-source-ledger:' || g.i::text)::uuid,
       NULL,NULL,NULL,NULL,'wallet_gross','cutover_wallet_charge'
  FROM generate_series(1,3) g(i);

INSERT INTO public.tournament_launch_receipts(
  tournament_id,launch_id,started_at,claimed_at,completed_at,lease_generation
) VALUES (
  '96010000-0000-0000-0000-000000000001',
  '96040000-0000-4000-8000-000000000001',
  transaction_timestamp(),transaction_timestamp(),NULL,
  '96050000-0000-4000-8000-000000000001'
);


INSERT INTO public.engine_tournament_leases(
 tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version)
VALUES ('96010000-0000-0000-0000-000000000001','native-spin-probe','native-spin-probe',
 transaction_timestamp(),clock_timestamp(),'96050000-0000-4000-8000-000000000001',2);

INSERT INTO public.tournaments(id,name,description,game_type,variant,buy_in_amount,buy_in_fee,guaranteed_prize,start_time,status,current_players,max_players,late_reg_mins,starting_chips,blind_structure,payout_structure,created_at,updated_at,club_id,started_at,ended_at,current_level,prize_pool,is_rebuy,add_on_available,rebuy_cost,rebuy_chips,rebuy_levels,addon_cost,addon_chips,min_players,tournament_type,is_bounty,bounty_amount,is_pko,is_mystery_bounty,mystery_bounty_min,mystery_bounty_max,is_xmtt,union_id,is_multi_day,parent_tournament_id,flight_number,day_number,total_days,flight_end_chips_snapshot,survivors_advance_to,is_pinned,spin_multiplier,is_premium_spin,prize_pool_finalized,is_turbo,blind_speed,spin_type,total_rake,late_reg_levels,addon_levels,is_reentry,satellite_target,max_rebuys,max_reentries,level_started_at,addon_period_triggered,satellite_target_id,final_table_triggered,bounty_pool,bounty_pool_paid,on_break,break_started_at,break_ends_at,is_private,spin_locked_tiers,short_description,is_vip_only,ban_chat,all_in_or_fold,label_as_new,hide_club_name,action_time_seconds,table_size,accelerated_mtt,addon_break_minutes,big_blind_ante,authorized_to_register,early_bird_enabled,early_bird_chips,bubble_protection,final_table_deal_enabled,restart_every_minutes,synchronized_breaks,satellite_seats,schedule_id,mystery_bounty_activation,mystery_bounty_activation_value,mystery_bounty_profile,mystery_bounty_top_percent,mystery_bounty_regular_pool_percent,mystery_bounty_pool_percent,mystery_bounty_stage,mystery_bounty_activated_at,mystery_bounty_activated_players,mystery_bounty_pool_cents,allow_rabbit_hunt,spin_reveal_lag_ms,addon_period_started_at,addon_period_ends_at,payout_percent,free_buy,addon_from_start,spin_reveal_at,mystery_bounty_activation_generation,entry_contract_locked) SELECT id,name,description,game_type,variant,buy_in_amount,buy_in_fee,guaranteed_prize,start_time,status,current_players,max_players,late_reg_mins,starting_chips,blind_structure,payout_structure,created_at,updated_at,club_id,started_at,ended_at,current_level,prize_pool,is_rebuy,add_on_available,rebuy_cost,rebuy_chips,rebuy_levels,addon_cost,addon_chips,min_players,tournament_type,is_bounty,bounty_amount,is_pko,is_mystery_bounty,mystery_bounty_min,mystery_bounty_max,is_xmtt,union_id,is_multi_day,parent_tournament_id,flight_number,day_number,total_days,flight_end_chips_snapshot,survivors_advance_to,is_pinned,spin_multiplier,is_premium_spin,prize_pool_finalized,is_turbo,blind_speed,spin_type,total_rake,late_reg_levels,addon_levels,is_reentry,satellite_target,max_rebuys,max_reentries,level_started_at,addon_period_triggered,satellite_target_id,final_table_triggered,bounty_pool,bounty_pool_paid,on_break,break_started_at,break_ends_at,is_private,spin_locked_tiers,short_description,is_vip_only,ban_chat,all_in_or_fold,label_as_new,hide_club_name,action_time_seconds,table_size,accelerated_mtt,addon_break_minutes,big_blind_ante,authorized_to_register,early_bird_enabled,early_bird_chips,bubble_protection,final_table_deal_enabled,restart_every_minutes,synchronized_breaks,satellite_seats,schedule_id,mystery_bounty_activation,mystery_bounty_activation_value,mystery_bounty_profile,mystery_bounty_top_percent,mystery_bounty_regular_pool_percent,mystery_bounty_pool_percent,mystery_bounty_stage,mystery_bounty_activated_at,mystery_bounty_activated_players,mystery_bounty_pool_cents,allow_rabbit_hunt,spin_reveal_lag_ms,addon_period_started_at,addon_period_ends_at,payout_percent,free_buy,addon_from_start,spin_reveal_at,mystery_bounty_activation_generation,entry_contract_locked FROM (SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object('id','96010000-0000-0000-0000-000000000002'::uuid,'name','Current Shared Reserve 2'))).* FROM public.tournaments t WHERE id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.tables(id,club_id,name,game_type,stakes,small_blind,big_blind,min_buy_in,max_buy_in,max_players,current_players,status,is_private,settings,created_at,updated_at,game_variant,enable_straddle,run_it_twice,auto_muck,ante,allow_rabbit_hunt,allow_run_it_twice,allow_straddle,game_mode,is_vip_only,is_anonymous,ban_chat,label_as_new,is_featured,hide_club_name,is_template,bomb_pot_enabled,double_board,triple_board,pineapple_holdem,seven_deuce_enabled,nit_game,cap_enabled,no_rathole,action_time_seconds,ante_bb,career_percent_min,maintain_percent_min,maintain_hands,auto_start_players,game_length_hours,created_by,calltime_enabled,auto_extension,auto_restart,auto_create_table,auto_utg_straddle,voluntary_straddle,insurance_enabled,run_it_mode,rake_percent,rake_cap_bb,agent_downline_limit,buy_in_authorization,restrict_device,restrict_observers,gps_restriction,ip_restriction,pc_emulator_restriction,photo_rotation_verification,short_description,accelerated_mtt,all_in_or_fold,custom_rebuy_reentry_cost,number_of_rebuys_reentries,add_on_multiplier,custom_add_on,add_on_break_length_minutes,ko_bounty,gtd_prize_pool,final_table_deal,big_blind_ante,authorized_to_register,late_registration_level,early_bird_registration,bubble_protection,featured_tournament,min_players_mtt,max_players_mtt,multi_day_mtt,save_start_time,start_time,restart_tournament_every,tournament_schedule,synchronized_breaks,sng_buy_in,blind_structure,payout_structure,starting_chips,blinds_up_minutes,next_step_satellite,sng_custom_buy_in,sng_player_count,is_spins,spins_multiplier,is_deleted,deleted_at,deleted_by,bbj_percent,tournament_id,live_state,union_id,big_blind_ante_enabled,straddle_enabled,straddle_type,max_straddles,run_it_twice_enabled,auto_muck_enabled,show_hand_enabled,disconnect_timeout_seconds,max_consecutive_timeouts,prefer_check_over_fold,time_bank_max_uses,time_bank_enabled,ante_enabled,bomb_pot_frequency,bomb_pot_ante_multiplier,wait_for_big_blind,seven_deuce_amount,hands_dealt,avg_pot,bomb_pot_double_board,cap_bb,bomb_pot_board_count,bomb_pot_trigger_mode,bomb_pot_interval_seconds,bomb_pot_min_players,bomb_pot_ante_fixed,first_button_seat,bomb_pot_variant,bomb_pot_next_due_at,bomb_pot_sched_state,bomb_pot_manual_pending,bomb_pot_button_policy,bomb_pot_announce_seconds,cluster_id,role,main_index,lifecycle,opened_at,live_at,break_started_at,break_eligible_since,promote_pending,terminal_closed_at) SELECT id,club_id,name,game_type,stakes,small_blind,big_blind,min_buy_in,max_buy_in,max_players,current_players,status,is_private,settings,created_at,updated_at,game_variant,enable_straddle,run_it_twice,auto_muck,ante,allow_rabbit_hunt,allow_run_it_twice,allow_straddle,game_mode,is_vip_only,is_anonymous,ban_chat,label_as_new,is_featured,hide_club_name,is_template,bomb_pot_enabled,double_board,triple_board,pineapple_holdem,seven_deuce_enabled,nit_game,cap_enabled,no_rathole,action_time_seconds,ante_bb,career_percent_min,maintain_percent_min,maintain_hands,auto_start_players,game_length_hours,created_by,calltime_enabled,auto_extension,auto_restart,auto_create_table,auto_utg_straddle,voluntary_straddle,insurance_enabled,run_it_mode,rake_percent,rake_cap_bb,agent_downline_limit,buy_in_authorization,restrict_device,restrict_observers,gps_restriction,ip_restriction,pc_emulator_restriction,photo_rotation_verification,short_description,accelerated_mtt,all_in_or_fold,custom_rebuy_reentry_cost,number_of_rebuys_reentries,add_on_multiplier,custom_add_on,add_on_break_length_minutes,ko_bounty,gtd_prize_pool,final_table_deal,big_blind_ante,authorized_to_register,late_registration_level,early_bird_registration,bubble_protection,featured_tournament,min_players_mtt,max_players_mtt,multi_day_mtt,save_start_time,start_time,restart_tournament_every,tournament_schedule,synchronized_breaks,sng_buy_in,blind_structure,payout_structure,starting_chips,blinds_up_minutes,next_step_satellite,sng_custom_buy_in,sng_player_count,is_spins,spins_multiplier,is_deleted,deleted_at,deleted_by,bbj_percent,tournament_id,live_state,union_id,big_blind_ante_enabled,straddle_enabled,straddle_type,max_straddles,run_it_twice_enabled,auto_muck_enabled,show_hand_enabled,disconnect_timeout_seconds,max_consecutive_timeouts,prefer_check_over_fold,time_bank_max_uses,time_bank_enabled,ante_enabled,bomb_pot_frequency,bomb_pot_ante_multiplier,wait_for_big_blind,seven_deuce_amount,hands_dealt,avg_pot,bomb_pot_double_board,cap_bb,bomb_pot_board_count,bomb_pot_trigger_mode,bomb_pot_interval_seconds,bomb_pot_min_players,bomb_pot_ante_fixed,first_button_seat,bomb_pot_variant,bomb_pot_next_due_at,bomb_pot_sched_state,bomb_pot_manual_pending,bomb_pot_button_policy,bomb_pot_announce_seconds,cluster_id,role,main_index,lifecycle,opened_at,live_at,break_started_at,break_eligible_since,promote_pending,terminal_closed_at FROM (SELECT (jsonb_populate_record(NULL::public.tables,to_jsonb(t)||jsonb_build_object('id','96020000-0000-0000-0000-000000000002'::uuid,'tournament_id','96010000-0000-0000-0000-000000000002'::uuid,'name','Current Shared Reserve Table 2'))).* FROM public.tables t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.tournament_players(id,tournament_id,user_id,username,chips,status,"position",prize,rebuys,add_on,registered_at,eliminated_at,bounties_collected,bounty_winnings,mystery_bounty_value,current_bounty,table_id,seat_number,chip_count,club_id,is_satellite_qualifier,rebuy_prompt_until,push_15m_sent,push_2m_sent,source_satellite_id,elimination_sequence,terminal_closed_at) SELECT id,tournament_id,user_id,username,chips,status,"position",prize,rebuys,add_on,registered_at,eliminated_at,bounties_collected,bounty_winnings,mystery_bounty_value,current_bounty,table_id,seat_number,chip_count,club_id,is_satellite_qualifier,rebuy_prompt_until,push_15m_sent,push_2m_sent,source_satellite_id,elimination_sequence,terminal_closed_at FROM (SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(t)||jsonb_build_object('id',md5('shared-player:'||'96010000-0000-0000-0000-000000000002'::uuid||':'||user_id)::uuid,'tournament_id','96010000-0000-0000-0000-000000000002'::uuid,'table_id','96020000-0000-0000-0000-000000000002'::uuid))).* FROM public.tournament_players t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,player_id,member_id,stack,is_sitting_out,is_away,joined_at,horse_id,scheduled_leave_hands,left_at,status,leave_pending,auto_rebuy,time_bank_remaining,time_bank_uses_remaining,club_id,sit_out_at,entry_hold,entry_post_agreed,terminal_closed_at) SELECT id,table_id,seat_number,user_id,player_id,member_id,stack,is_sitting_out,is_away,joined_at,horse_id,scheduled_leave_hands,left_at,status,leave_pending,auto_rebuy,time_bank_remaining,time_bank_uses_remaining,club_id,sit_out_at,entry_hold,entry_post_agreed,terminal_closed_at FROM (SELECT (jsonb_populate_record(NULL::public.table_seats,to_jsonb(t)||jsonb_build_object('id',md5('shared-seat:'||'96010000-0000-0000-0000-000000000002'::uuid||':'||user_id)::uuid,'table_id','96020000-0000-0000-0000-000000000002'::uuid))).* FROM public.table_seats t WHERE table_id='96020000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.tournament_escrow(tournament_id,enforced,gross_in,fee_entries_in,satellite_fee_in,bounty_in,overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,refund_bounty,refund_fee,prize_balance,bounty_balance,fee_balance,opened_at,opened_from,updated_at,closed_at,close_note,reserve_out,reserve_in,terminal_closed_at) SELECT tournament_id,enforced,gross_in,fee_entries_in,satellite_fee_in,bounty_in,overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,refund_bounty,refund_fee,prize_balance,bounty_balance,fee_balance,opened_at,opened_from,updated_at,closed_at,close_note,reserve_out,reserve_in,terminal_closed_at FROM (SELECT (jsonb_populate_record(NULL::public.tournament_escrow,to_jsonb(t)||jsonb_build_object('tournament_id','96010000-0000-0000-0000-000000000002'::uuid))).* FROM public.tournament_escrow t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.wallet_transactions(id,user_id,wallet_type,amount,type,category,description,related_entity_id,table_id,hand_id,created_at,balance_after,terminal_closed_at) SELECT id,user_id,wallet_type,amount,type,category,description,related_entity_id,table_id,hand_id,created_at,balance_after,terminal_closed_at FROM (SELECT (jsonb_populate_record(NULL::public.wallet_transactions,to_jsonb(t)||jsonb_build_object('id',md5('shared-wallet:'||'96010000-0000-0000-0000-000000000002'::uuid||':'||user_id)::uuid,'related_entity_id','96010000-0000-0000-0000-000000000002'::uuid))).* FROM public.wallet_transactions t WHERE related_entity_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,from_label,to_type,to_entity_id,to_label,amount,category,description,notes,club_id,union_id,table_id,hand_id,tournament_id,created_at,idempotency_key,correlation_id,causation_id,settlement_id,epoch_id,actor_service,db_role,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,status,metadata,chain_seq,prev_hash,row_hash) SELECT id,performed_by,from_type,from_entity_id,from_label,to_type,to_entity_id,to_label,amount,category,description,notes,club_id,union_id,table_id,hand_id,tournament_id,created_at,idempotency_key,correlation_id,causation_id,settlement_id,epoch_id,actor_service,db_role,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,status,metadata,chain_seq,prev_hash,row_hash FROM (SELECT (jsonb_populate_record(NULL::public.chip_ledger,to_jsonb(t)||jsonb_build_object('id',md5('shared-charge:'||'96010000-0000-0000-0000-000000000002'::uuid||':'||from_entity_id)::uuid,'tournament_id','96010000-0000-0000-0000-000000000002'::uuid,'to_entity_id','96010000-0000-0000-0000-000000000002'::uuid))).* FROM public.chip_ledger t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.tournament_refund_entitlements(id,tournament_id,user_id,entitlement_kind,charge_category,refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,source_ledger_id,registration_id,source_satellite_id,source_award_place,source_ticket_id,escrow_bucket,evidence_kind,created_at) SELECT id,tournament_id,user_id,entitlement_kind,charge_category,refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,source_ledger_id,registration_id,source_satellite_id,source_award_place,source_ticket_id,escrow_bucket,evidence_kind,created_at FROM (SELECT (jsonb_populate_record(NULL::public.tournament_refund_entitlements,to_jsonb(t)||jsonb_build_object('id',md5('shared-entitlement:'||'96010000-0000-0000-0000-000000000002'::uuid||':'||user_id)::uuid,'tournament_id','96010000-0000-0000-0000-000000000002'::uuid,'source_ledger_id',md5('shared-charge:'||'96010000-0000-0000-0000-000000000002'::uuid||':'||user_id)::uuid))).* FROM public.tournament_refund_entitlements t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.tournament_launch_receipts(tournament_id,launch_id,started_at,claimed_at,completed_at,lease_generation) SELECT tournament_id,launch_id,started_at,claimed_at,completed_at,lease_generation FROM (SELECT (jsonb_populate_record(NULL::public.tournament_launch_receipts,to_jsonb(t)||jsonb_build_object('tournament_id','96010000-0000-0000-0000-000000000002'::uuid,'launch_id','96040000-0000-4000-8000-000000000002'::uuid,'lease_generation','96050000-0000-4000-8000-000000000002'::uuid))).* FROM public.tournament_launch_receipts t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version) SELECT tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version FROM (SELECT (jsonb_populate_record(NULL::public.engine_tournament_leases,to_jsonb(t)||jsonb_build_object('tournament_id','96010000-0000-0000-0000-000000000002'::uuid,'lease_generation','96050000-0000-4000-8000-000000000002'::uuid))).* FROM public.engine_tournament_leases t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.tournaments(id,name,description,game_type,variant,buy_in_amount,buy_in_fee,guaranteed_prize,start_time,status,current_players,max_players,late_reg_mins,starting_chips,blind_structure,payout_structure,created_at,updated_at,club_id,started_at,ended_at,current_level,prize_pool,is_rebuy,add_on_available,rebuy_cost,rebuy_chips,rebuy_levels,addon_cost,addon_chips,min_players,tournament_type,is_bounty,bounty_amount,is_pko,is_mystery_bounty,mystery_bounty_min,mystery_bounty_max,is_xmtt,union_id,is_multi_day,parent_tournament_id,flight_number,day_number,total_days,flight_end_chips_snapshot,survivors_advance_to,is_pinned,spin_multiplier,is_premium_spin,prize_pool_finalized,is_turbo,blind_speed,spin_type,total_rake,late_reg_levels,addon_levels,is_reentry,satellite_target,max_rebuys,max_reentries,level_started_at,addon_period_triggered,satellite_target_id,final_table_triggered,bounty_pool,bounty_pool_paid,on_break,break_started_at,break_ends_at,is_private,spin_locked_tiers,short_description,is_vip_only,ban_chat,all_in_or_fold,label_as_new,hide_club_name,action_time_seconds,table_size,accelerated_mtt,addon_break_minutes,big_blind_ante,authorized_to_register,early_bird_enabled,early_bird_chips,bubble_protection,final_table_deal_enabled,restart_every_minutes,synchronized_breaks,satellite_seats,schedule_id,mystery_bounty_activation,mystery_bounty_activation_value,mystery_bounty_profile,mystery_bounty_top_percent,mystery_bounty_regular_pool_percent,mystery_bounty_pool_percent,mystery_bounty_stage,mystery_bounty_activated_at,mystery_bounty_activated_players,mystery_bounty_pool_cents,allow_rabbit_hunt,spin_reveal_lag_ms,addon_period_started_at,addon_period_ends_at,payout_percent,free_buy,addon_from_start,spin_reveal_at,mystery_bounty_activation_generation,entry_contract_locked) SELECT id,name,description,game_type,variant,buy_in_amount,buy_in_fee,guaranteed_prize,start_time,status,current_players,max_players,late_reg_mins,starting_chips,blind_structure,payout_structure,created_at,updated_at,club_id,started_at,ended_at,current_level,prize_pool,is_rebuy,add_on_available,rebuy_cost,rebuy_chips,rebuy_levels,addon_cost,addon_chips,min_players,tournament_type,is_bounty,bounty_amount,is_pko,is_mystery_bounty,mystery_bounty_min,mystery_bounty_max,is_xmtt,union_id,is_multi_day,parent_tournament_id,flight_number,day_number,total_days,flight_end_chips_snapshot,survivors_advance_to,is_pinned,spin_multiplier,is_premium_spin,prize_pool_finalized,is_turbo,blind_speed,spin_type,total_rake,late_reg_levels,addon_levels,is_reentry,satellite_target,max_rebuys,max_reentries,level_started_at,addon_period_triggered,satellite_target_id,final_table_triggered,bounty_pool,bounty_pool_paid,on_break,break_started_at,break_ends_at,is_private,spin_locked_tiers,short_description,is_vip_only,ban_chat,all_in_or_fold,label_as_new,hide_club_name,action_time_seconds,table_size,accelerated_mtt,addon_break_minutes,big_blind_ante,authorized_to_register,early_bird_enabled,early_bird_chips,bubble_protection,final_table_deal_enabled,restart_every_minutes,synchronized_breaks,satellite_seats,schedule_id,mystery_bounty_activation,mystery_bounty_activation_value,mystery_bounty_profile,mystery_bounty_top_percent,mystery_bounty_regular_pool_percent,mystery_bounty_pool_percent,mystery_bounty_stage,mystery_bounty_activated_at,mystery_bounty_activated_players,mystery_bounty_pool_cents,allow_rabbit_hunt,spin_reveal_lag_ms,addon_period_started_at,addon_period_ends_at,payout_percent,free_buy,addon_from_start,spin_reveal_at,mystery_bounty_activation_generation,entry_contract_locked FROM (SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object('id','96010000-0000-0000-0000-000000000003'::uuid,'name','Current Shared Reserve 3'))).* FROM public.tournaments t WHERE id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.tables(id,club_id,name,game_type,stakes,small_blind,big_blind,min_buy_in,max_buy_in,max_players,current_players,status,is_private,settings,created_at,updated_at,game_variant,enable_straddle,run_it_twice,auto_muck,ante,allow_rabbit_hunt,allow_run_it_twice,allow_straddle,game_mode,is_vip_only,is_anonymous,ban_chat,label_as_new,is_featured,hide_club_name,is_template,bomb_pot_enabled,double_board,triple_board,pineapple_holdem,seven_deuce_enabled,nit_game,cap_enabled,no_rathole,action_time_seconds,ante_bb,career_percent_min,maintain_percent_min,maintain_hands,auto_start_players,game_length_hours,created_by,calltime_enabled,auto_extension,auto_restart,auto_create_table,auto_utg_straddle,voluntary_straddle,insurance_enabled,run_it_mode,rake_percent,rake_cap_bb,agent_downline_limit,buy_in_authorization,restrict_device,restrict_observers,gps_restriction,ip_restriction,pc_emulator_restriction,photo_rotation_verification,short_description,accelerated_mtt,all_in_or_fold,custom_rebuy_reentry_cost,number_of_rebuys_reentries,add_on_multiplier,custom_add_on,add_on_break_length_minutes,ko_bounty,gtd_prize_pool,final_table_deal,big_blind_ante,authorized_to_register,late_registration_level,early_bird_registration,bubble_protection,featured_tournament,min_players_mtt,max_players_mtt,multi_day_mtt,save_start_time,start_time,restart_tournament_every,tournament_schedule,synchronized_breaks,sng_buy_in,blind_structure,payout_structure,starting_chips,blinds_up_minutes,next_step_satellite,sng_custom_buy_in,sng_player_count,is_spins,spins_multiplier,is_deleted,deleted_at,deleted_by,bbj_percent,tournament_id,live_state,union_id,big_blind_ante_enabled,straddle_enabled,straddle_type,max_straddles,run_it_twice_enabled,auto_muck_enabled,show_hand_enabled,disconnect_timeout_seconds,max_consecutive_timeouts,prefer_check_over_fold,time_bank_max_uses,time_bank_enabled,ante_enabled,bomb_pot_frequency,bomb_pot_ante_multiplier,wait_for_big_blind,seven_deuce_amount,hands_dealt,avg_pot,bomb_pot_double_board,cap_bb,bomb_pot_board_count,bomb_pot_trigger_mode,bomb_pot_interval_seconds,bomb_pot_min_players,bomb_pot_ante_fixed,first_button_seat,bomb_pot_variant,bomb_pot_next_due_at,bomb_pot_sched_state,bomb_pot_manual_pending,bomb_pot_button_policy,bomb_pot_announce_seconds,cluster_id,role,main_index,lifecycle,opened_at,live_at,break_started_at,break_eligible_since,promote_pending,terminal_closed_at) SELECT id,club_id,name,game_type,stakes,small_blind,big_blind,min_buy_in,max_buy_in,max_players,current_players,status,is_private,settings,created_at,updated_at,game_variant,enable_straddle,run_it_twice,auto_muck,ante,allow_rabbit_hunt,allow_run_it_twice,allow_straddle,game_mode,is_vip_only,is_anonymous,ban_chat,label_as_new,is_featured,hide_club_name,is_template,bomb_pot_enabled,double_board,triple_board,pineapple_holdem,seven_deuce_enabled,nit_game,cap_enabled,no_rathole,action_time_seconds,ante_bb,career_percent_min,maintain_percent_min,maintain_hands,auto_start_players,game_length_hours,created_by,calltime_enabled,auto_extension,auto_restart,auto_create_table,auto_utg_straddle,voluntary_straddle,insurance_enabled,run_it_mode,rake_percent,rake_cap_bb,agent_downline_limit,buy_in_authorization,restrict_device,restrict_observers,gps_restriction,ip_restriction,pc_emulator_restriction,photo_rotation_verification,short_description,accelerated_mtt,all_in_or_fold,custom_rebuy_reentry_cost,number_of_rebuys_reentries,add_on_multiplier,custom_add_on,add_on_break_length_minutes,ko_bounty,gtd_prize_pool,final_table_deal,big_blind_ante,authorized_to_register,late_registration_level,early_bird_registration,bubble_protection,featured_tournament,min_players_mtt,max_players_mtt,multi_day_mtt,save_start_time,start_time,restart_tournament_every,tournament_schedule,synchronized_breaks,sng_buy_in,blind_structure,payout_structure,starting_chips,blinds_up_minutes,next_step_satellite,sng_custom_buy_in,sng_player_count,is_spins,spins_multiplier,is_deleted,deleted_at,deleted_by,bbj_percent,tournament_id,live_state,union_id,big_blind_ante_enabled,straddle_enabled,straddle_type,max_straddles,run_it_twice_enabled,auto_muck_enabled,show_hand_enabled,disconnect_timeout_seconds,max_consecutive_timeouts,prefer_check_over_fold,time_bank_max_uses,time_bank_enabled,ante_enabled,bomb_pot_frequency,bomb_pot_ante_multiplier,wait_for_big_blind,seven_deuce_amount,hands_dealt,avg_pot,bomb_pot_double_board,cap_bb,bomb_pot_board_count,bomb_pot_trigger_mode,bomb_pot_interval_seconds,bomb_pot_min_players,bomb_pot_ante_fixed,first_button_seat,bomb_pot_variant,bomb_pot_next_due_at,bomb_pot_sched_state,bomb_pot_manual_pending,bomb_pot_button_policy,bomb_pot_announce_seconds,cluster_id,role,main_index,lifecycle,opened_at,live_at,break_started_at,break_eligible_since,promote_pending,terminal_closed_at FROM (SELECT (jsonb_populate_record(NULL::public.tables,to_jsonb(t)||jsonb_build_object('id','96020000-0000-0000-0000-000000000003'::uuid,'tournament_id','96010000-0000-0000-0000-000000000003'::uuid,'name','Current Shared Reserve Table 3'))).* FROM public.tables t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.tournament_players(id,tournament_id,user_id,username,chips,status,"position",prize,rebuys,add_on,registered_at,eliminated_at,bounties_collected,bounty_winnings,mystery_bounty_value,current_bounty,table_id,seat_number,chip_count,club_id,is_satellite_qualifier,rebuy_prompt_until,push_15m_sent,push_2m_sent,source_satellite_id,elimination_sequence,terminal_closed_at) SELECT id,tournament_id,user_id,username,chips,status,"position",prize,rebuys,add_on,registered_at,eliminated_at,bounties_collected,bounty_winnings,mystery_bounty_value,current_bounty,table_id,seat_number,chip_count,club_id,is_satellite_qualifier,rebuy_prompt_until,push_15m_sent,push_2m_sent,source_satellite_id,elimination_sequence,terminal_closed_at FROM (SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(t)||jsonb_build_object('id',md5('shared-player:'||'96010000-0000-0000-0000-000000000003'::uuid||':'||user_id)::uuid,'tournament_id','96010000-0000-0000-0000-000000000003'::uuid,'table_id','96020000-0000-0000-0000-000000000003'::uuid))).* FROM public.tournament_players t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,player_id,member_id,stack,is_sitting_out,is_away,joined_at,horse_id,scheduled_leave_hands,left_at,status,leave_pending,auto_rebuy,time_bank_remaining,time_bank_uses_remaining,club_id,sit_out_at,entry_hold,entry_post_agreed,terminal_closed_at) SELECT id,table_id,seat_number,user_id,player_id,member_id,stack,is_sitting_out,is_away,joined_at,horse_id,scheduled_leave_hands,left_at,status,leave_pending,auto_rebuy,time_bank_remaining,time_bank_uses_remaining,club_id,sit_out_at,entry_hold,entry_post_agreed,terminal_closed_at FROM (SELECT (jsonb_populate_record(NULL::public.table_seats,to_jsonb(t)||jsonb_build_object('id',md5('shared-seat:'||'96010000-0000-0000-0000-000000000003'::uuid||':'||user_id)::uuid,'table_id','96020000-0000-0000-0000-000000000003'::uuid))).* FROM public.table_seats t WHERE table_id='96020000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.tournament_escrow(tournament_id,enforced,gross_in,fee_entries_in,satellite_fee_in,bounty_in,overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,refund_bounty,refund_fee,prize_balance,bounty_balance,fee_balance,opened_at,opened_from,updated_at,closed_at,close_note,reserve_out,reserve_in,terminal_closed_at) SELECT tournament_id,enforced,gross_in,fee_entries_in,satellite_fee_in,bounty_in,overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,refund_bounty,refund_fee,prize_balance,bounty_balance,fee_balance,opened_at,opened_from,updated_at,closed_at,close_note,reserve_out,reserve_in,terminal_closed_at FROM (SELECT (jsonb_populate_record(NULL::public.tournament_escrow,to_jsonb(t)||jsonb_build_object('tournament_id','96010000-0000-0000-0000-000000000003'::uuid))).* FROM public.tournament_escrow t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.wallet_transactions(id,user_id,wallet_type,amount,type,category,description,related_entity_id,table_id,hand_id,created_at,balance_after,terminal_closed_at) SELECT id,user_id,wallet_type,amount,type,category,description,related_entity_id,table_id,hand_id,created_at,balance_after,terminal_closed_at FROM (SELECT (jsonb_populate_record(NULL::public.wallet_transactions,to_jsonb(t)||jsonb_build_object('id',md5('shared-wallet:'||'96010000-0000-0000-0000-000000000003'::uuid||':'||user_id)::uuid,'related_entity_id','96010000-0000-0000-0000-000000000003'::uuid))).* FROM public.wallet_transactions t WHERE related_entity_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,from_label,to_type,to_entity_id,to_label,amount,category,description,notes,club_id,union_id,table_id,hand_id,tournament_id,created_at,idempotency_key,correlation_id,causation_id,settlement_id,epoch_id,actor_service,db_role,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,status,metadata,chain_seq,prev_hash,row_hash) SELECT id,performed_by,from_type,from_entity_id,from_label,to_type,to_entity_id,to_label,amount,category,description,notes,club_id,union_id,table_id,hand_id,tournament_id,created_at,idempotency_key,correlation_id,causation_id,settlement_id,epoch_id,actor_service,db_role,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,status,metadata,chain_seq,prev_hash,row_hash FROM (SELECT (jsonb_populate_record(NULL::public.chip_ledger,to_jsonb(t)||jsonb_build_object('id',md5('shared-charge:'||'96010000-0000-0000-0000-000000000003'::uuid||':'||from_entity_id)::uuid,'tournament_id','96010000-0000-0000-0000-000000000003'::uuid,'to_entity_id','96010000-0000-0000-0000-000000000003'::uuid))).* FROM public.chip_ledger t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.tournament_refund_entitlements(id,tournament_id,user_id,entitlement_kind,charge_category,refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,source_ledger_id,registration_id,source_satellite_id,source_award_place,source_ticket_id,escrow_bucket,evidence_kind,created_at) SELECT id,tournament_id,user_id,entitlement_kind,charge_category,refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,source_ledger_id,registration_id,source_satellite_id,source_award_place,source_ticket_id,escrow_bucket,evidence_kind,created_at FROM (SELECT (jsonb_populate_record(NULL::public.tournament_refund_entitlements,to_jsonb(t)||jsonb_build_object('id',md5('shared-entitlement:'||'96010000-0000-0000-0000-000000000003'::uuid||':'||user_id)::uuid,'tournament_id','96010000-0000-0000-0000-000000000003'::uuid,'source_ledger_id',md5('shared-charge:'||'96010000-0000-0000-0000-000000000003'::uuid||':'||user_id)::uuid))).* FROM public.tournament_refund_entitlements t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.tournament_launch_receipts(tournament_id,launch_id,started_at,claimed_at,completed_at,lease_generation) SELECT tournament_id,launch_id,started_at,claimed_at,completed_at,lease_generation FROM (SELECT (jsonb_populate_record(NULL::public.tournament_launch_receipts,to_jsonb(t)||jsonb_build_object('tournament_id','96010000-0000-0000-0000-000000000003'::uuid,'launch_id','96040000-0000-4000-8000-000000000003'::uuid,'lease_generation','96050000-0000-4000-8000-000000000003'::uuid))).* FROM public.tournament_launch_receipts t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version) SELECT tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version FROM (SELECT (jsonb_populate_record(NULL::public.engine_tournament_leases,to_jsonb(t)||jsonb_build_object('tournament_id','96010000-0000-0000-0000-000000000003'::uuid,'lease_generation','96050000-0000-4000-8000-000000000003'::uuid))).* FROM public.engine_tournament_leases t WHERE tournament_id='96010000-0000-0000-0000-000000000001') AS native_fixture_copy;
SET LOCAL session_replication_role=origin; SELECT public.fn_spin_book_entry(('96010000-0000-0000-0000-00000000000'||n)::uuid) FROM generate_series(1,3) n; SELECT public.fn_spin_settle_game('96010000-0000-0000-0000-000000000003','96000000-0000-0000-0000-000000000001',1,3,5,0.08); DO $funding$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.spin_bonus_pools WHERE id='96030000-0000-0000-0000-000000000001' AND balance=3.28 AND total_deposited=8.28 AND total_drawn=5 AND spin_count=3) THEN RAISE EXCEPTION 'native scarce reserve did not conserve actual funding and prior draw'; END IF; END $funding$; COMMIT;