-- First archived Spin: restore the canonical terminal path from authentic evidence.
-- Version reserved by scripts/reserve-migration-version.sh, 2026-09-27 00:58:12 UTC.
-- Original event 2aa4cba1-506f-426b-a1ba-d8e22e018533 played, but its retained
-- first/last-hand projections outlived full hand rows. Never label it unplayed,
-- refund its tournament playing units, invent history, or manufacture fee terms.
-- The original sole survivor ShoveBandito (aef849b8-2906-4dc0-b108-251710e76d3c)
-- is owed the recorded 200 prize in funding club a41434bb-8d0c-400a-8f0d-e8b3d65afed4.
-- RiverJester (036f0b55-c601-4d09-982a-5294cf4ea15d) and AceSniper
-- (72f2fedb-a5f9-4d10-b147-d92e18102d3f) retain second/third place and zero prizes.
-- Install a finite service-only, source/preimage/lease-guarded entry point into
-- the existing canonical launch and terminal owners. Admission and terminal
-- share one transaction; replay retains operation identity. Existing live paths
-- remain unchanged when there is no bound archived admission.
-- This migration INSTALLS authority only. It does not execute a payout.
-- A subsequent qualified invocation must retain the unresolved 24 fee in escrow
-- unless its actual earning evidence qualifies; player finality is not accounting
-- finality. No history insertion, direct wallet write, scheduled repair, or
-- incident closure is performed here. Full source qualification and one-call
-- self-aborting production proof are prerequisites to any production payout.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';

-- Component: supabase/components/spin-archived-first-witness.sql
-- Private pre-admission reader. This component confers NO launch, standings,
-- lease, wallet, or terminal authority. Admission must be qualified separately.
-- The immutable source manifest is compiled below; it is not accepted as an
-- RPC argument or a caller-writable session setting.
CREATE SCHEMA IF NOT EXISTS smarter_private;
CREATE OR REPLACE FUNCTION smarter_private.spin_archived_first_manifest()
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $manifest$
 SELECT $original${"evidence_kind":"archived_database_projection","source_sha256":"8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","board_observed_at":"2026-09-15 04:32:06.7117+00","history_observed_at":"2026-09-15 04:33:53.557373+00","result_observed_at":"2026-09-15 04:35:19.921753+00","original_board":{"id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","name":"100 Chip Spin PLO4","status":"REGISTERING","club_id":"fade0000-0000-0000-0000-000000000001","variant":"spin","ended_at":null,"union_id":"fade0000-0000-0000-0000-000000000001","created_at":"2026-09-08T14:31:23.973275+00:00","prize_pool":200,"started_at":null,"total_rake":0,"updated_at":"2026-09-08T14:31:23.973275+00:00","max_players":3,"buy_in_amount":100,"spin_reveal_at":"2026-09-08T14:45:15.91+00:00","starting_chips":300,"current_players":1,"spin_multiplier":2,"prize_pool_finalized":true},"original_roster":[{"id":"06377b59-94e6-4663-9fc0-5dba12675b9d","chips":900,"prize":0,"status":"playing","user_id":"aef849b8-2906-4dc0-b108-251710e76d3c","position":null,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","chip_count":0,"seat_number":1,"eliminated_at":null,"registered_at":"2026-09-08T14:44:51.55749+00:00","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","terminal_closed_at":null},{"id":"1350d845-cdf8-41ad-86bf-abf2f2460cab","chips":0,"prize":0,"status":"eliminated","user_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","position":3,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","chip_count":0,"seat_number":2,"eliminated_at":"2026-09-08T14:50:41.689+00:00","registered_at":"2026-09-08T14:44:51.55749+00:00","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","terminal_closed_at":null},{"id":"bcab2749-47c7-4617-9d72-9e56de4eb616","chips":0,"prize":0,"status":"eliminated","user_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","position":2,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","chip_count":0,"seat_number":3,"eliminated_at":"2026-09-08T14:50:47.159+00:00","registered_at":"2026-09-08T14:45:08.753219+00:00","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","terminal_closed_at":null}],"original_first_history":{"id":"ff938472-99cc-41fc-9092-9b08c116e8d3","source":"manual","ended_at":"2026-09-08T14:48:55.295+00:00","pot_size":20,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","created_at":"2026-09-08T14:48:56.020255+00:00","started_at":"2026-09-08T14:48:50.491+00:00","hand_number":8217978,"rake_amount":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533"},"original_last_history":{"id":"865f8f8b-57e9-4d4e-911b-5ea51a25b745","source":"manual","ended_at":"2026-09-08T14:50:26.175+00:00","pot_size":850,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","created_at":"2026-09-08T14:50:26.846305+00:00","started_at":"2026-09-08T14:49:44.223+00:00","hand_number":8218417,"rake_amount":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533"},"original_result":{"id":"865f8f8b-57e9-4d4e-911b-5ea51a25b745","source":"manual","players":[{"seat":1,"cards":[],"stack":900,"userId":"aef849b8-2906-4dc0-b108-251710e76d3c","username":"ShoveBandito"},{"seat":2,"cards":[],"stack":0,"userId":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","username":"AceSniper"},{"seat":3,"cards":[],"stack":0,"userId":"036f0b55-c601-4d09-982a-5294cf4ea15d","username":"RiverJester"}],"summary":null,"winners":[{"hand":{"name":"Straight","cards":[{"rank":"A","suit":"hearts"},{"rank":"K","suit":"spades"},{"rank":"Q","suit":"hearts"},{"rank":"J","suit":"clubs"},{"rank":"T","suit":"clubs"}],"ranking":5},"amount":850,"userId":"aef849b8-2906-4dc0-b108-251710e76d3c","potIndex":0}]},"original_atomic_commit":null,"captured_preimage":{"tournaments":[{"id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","name":"100 Chip Spin PLO4","is_pko":false,"status":"REGISTERING","club_id":"fade0000-0000-0000-0000-000000000001","is_xmtt":false,"variant":"spin","ban_chat":false,"ended_at":null,"free_buy":false,"is_rebuy":false,"is_turbo":false,"on_break":false,"union_id":"fade0000-0000-0000-0000-000000000001","game_type":"PLO4","is_bounty":false,"is_pinned":false,"spin_type":"standard","addon_cost":0,"buy_in_fee":0,"created_at":"2026-09-08T14:31:23.973275+00:00","day_number":1,"is_private":false,"is_reentry":false,"max_rebuys":0,"prize_pool":200,"rebuy_cost":0,"start_time":"2026-09-08T14:48:48.55749+00:00","started_at":null,"table_size":3,"total_days":1,"total_rake":0,"updated_at":"2026-09-08T14:31:23.973275+00:00","addon_chips":0,"blind_speed":"standard","bounty_pool":0,"description":null,"is_vip_only":false,"max_players":3,"min_players":3,"rebuy_chips":0,"schedule_id":null,"addon_levels":1,"is_multi_day":false,"label_as_new":false,"rebuy_levels":4,"bounty_amount":0,"break_ends_at":null,"buy_in_amount":100,"current_level":2,"flight_number":null,"late_reg_mins":0,"max_reentries":0,"all_in_or_fold":false,"big_blind_ante":false,"hide_club_name":false,"payout_percent":10,"spin_reveal_at":"2026-09-08T14:45:15.91+00:00","starting_chips":300,"accelerated_mtt":false,"blind_structure":"[{\"level\":1,\"smallBlind\":10,\"bigBlind\":20,\"ante\":0,\"duration\":180},{\"level\":2,\"smallBlind\":15,\"bigBlind\":30,\"ante\":0,\"duration\":180},{\"level\":3,\"smallBlind\":20,\"bigBlind\":40,\"ante\":0,\"duration\":180},{\"level\":4,\"smallBlind\":30,\"bigBlind\":60,\"ante\":0,\"duration\":180},{\"level\":5,\"smallBlind\":40,\"bigBlind\":80,\"ante\":0,\"duration\":180},{\"level\":6,\"smallBlind\":50,\"bigBlind\":100,\"ante\":0,\"duration\":180},{\"level\":7,\"smallBlind\":60,\"bigBlind\":120,\"ante\":0,\"duration\":180},{\"level\":8,\"smallBlind\":75,\"bigBlind\":150,\"ante\":0,\"duration\":180},{\"level\":9,\"smallBlind\":90,\"bigBlind\":180,\"ante\":0,\"duration\":180},{\"level\":10,\"smallBlind\":105,\"bigBlind\":210,\"ante\":0,\"duration\":180},{\"level\":11,\"smallBlind\":145,\"bigBlind\":290,\"ante\":0,\"duration\":180},{\"level\":12,\"smallBlind\":205,\"bigBlind\":410,\"ante\":0,\"duration\":180}]","current_players":1,"format_contract":"spin-v1","is_premium_spin":false,"late_reg_levels":0,"satellite_seats":null,"spin_multiplier":2,"tournament_type":"SPIN","add_on_available":false,"addon_from_start":false,"bounty_pool_paid":0,"break_started_at":null,"early_bird_chips":0,"guaranteed_prize":0,"level_started_at":"2026-09-08T14:54:54.19+00:00","payout_structure":"[{\"place\":1,\"percentage\":100}]","satellite_target":null,"allow_rabbit_hunt":true,"blind_level_state":null,"bubble_protection":false,"is_mystery_bounty":false,"payout_unit_cents":1,"restart_source_id":null,"short_description":null,"spin_locked_tiers":[],"early_bird_enabled":false,"mystery_bounty_max":0,"mystery_bounty_min":0,"spin_reveal_lag_ms":6157,"action_time_seconds":15,"addon_break_minutes":1,"payout_math_version":1,"satellite_target_id":null,"synchronized_breaks":false,"addon_period_ends_at":null,"mystery_bounty_stage":"pending","parent_tournament_id":null,"prize_pool_finalized":true,"survivors_advance_to":null,"entry_contract_locked":true,"final_table_triggered":true,"restart_every_minutes":null,"addon_period_triggered":false,"authorized_to_register":false,"mystery_bounty_profile":"classic","addon_period_started_at":null,"final_table_deal_enabled":false,"flight_end_chips_snapshot":null,"mystery_bounty_activation":"at_the_money","mystery_bounty_pool_cents":null,"mystery_bounty_top_percent":20,"mystery_bounty_activated_at":null,"mystery_bounty_pool_percent":50,"mystery_bounty_activation_value":null,"mystery_bounty_activated_players":null,"mystery_bounty_regular_pool_percent":50,"mystery_bounty_activation_generation":0}],"tournament_players":[{"id":"06377b59-94e6-4663-9fc0-5dba12675b9d","chips":900,"prize":0,"add_on":false,"rebuys":0,"status":"playing","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","user_id":"aef849b8-2906-4dc0-b108-251710e76d3c","position":null,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","chip_count":0,"seat_number":1,"push_2m_sent":true,"eliminated_at":null,"push_15m_sent":true,"registered_at":"2026-09-08T14:44:51.55749+00:00","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"rebuy_prompt_until":null,"terminal_closed_at":null,"source_satellite_id":null,"elimination_sequence":null,"mystery_bounty_value":0,"is_satellite_qualifier":false},{"id":"1350d845-cdf8-41ad-86bf-abf2f2460cab","chips":0,"prize":0,"add_on":false,"rebuys":0,"status":"eliminated","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","user_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","position":3,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","chip_count":0,"seat_number":2,"push_2m_sent":true,"eliminated_at":"2026-09-08T14:50:41.689+00:00","push_15m_sent":true,"registered_at":"2026-09-08T14:44:51.55749+00:00","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"rebuy_prompt_until":null,"terminal_closed_at":null,"source_satellite_id":null,"elimination_sequence":null,"mystery_bounty_value":0,"is_satellite_qualifier":false},{"id":"bcab2749-47c7-4617-9d72-9e56de4eb616","chips":0,"prize":0,"add_on":false,"rebuys":0,"status":"eliminated","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","user_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","position":2,"table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","chip_count":0,"seat_number":3,"push_2m_sent":true,"eliminated_at":"2026-09-08T14:50:47.159+00:00","push_15m_sent":true,"registered_at":"2026-09-08T14:45:08.753219+00:00","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"rebuy_prompt_until":null,"terminal_closed_at":null,"source_satellite_id":null,"elimination_sequence":null,"mystery_bounty_value":0,"is_satellite_qualifier":false}],"tables":[{"id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","ante":0,"name":"100 Chip Spin PLO4","role":null,"cap_bb":null,"stakes":"20/40","status":"running","ante_bb":0,"avg_pot":0,"club_id":"fade0000-0000-0000-0000-000000000001","live_at":null,"ban_chat":false,"is_spins":false,"nit_game":false,"settings":{},"union_id":"fade0000-0000-0000-0000-000000000001","auto_muck":true,"big_blind":40,"game_mode":"regular","game_type":"tournament","kill_mode":"off","ko_bounty":false,"lifecycle":null,"max_buyin":null,"min_buyin":null,"opened_at":null,"cluster_id":null,"created_at":"2026-09-08T14:31:24.359315+00:00","created_by":null,"deleted_at":null,"deleted_by":null,"is_deleted":false,"is_private":false,"live_state":null,"main_index":null,"max_buy_in":0,"min_buy_in":0,"no_rathole":false,"sng_buy_in":0,"start_time":null,"updated_at":"2026-09-09T17:25:29.616789+00:00","bbj_percent":100,"cap_enabled":false,"hands_dealt":0,"is_featured":false,"is_template":false,"is_vip_only":false,"max_players":3,"rake_cap_bb":-1,"run_it_mode":"none","small_blind":20,"ante_enabled":false,"auto_restart":false,"double_board":false,"game_variant":"plo4","is_anonymous":false,"label_as_new":false,"rake_percent":-1,"run_it_twice":true,"triple_board":false,"custom_add_on":false,"f06_lifecycle":199835,"max_buy_in_bb":null,"max_straddles":1,"min_buy_in_bb":null,"multi_day_mtt":false,"straddle_type":"utg","tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","all_in_or_fold":false,"allow_straddle":true,"auto_extension":false,"big_blind_ante":false,"gtd_prize_pool":false,"hide_club_name":false,"ip_restriction":false,"maintain_hands":10,"starting_chips":1500,"accelerated_mtt":false,"blind_structure":"standard","current_players":1,"enable_straddle":true,"gps_restriction":true,"max_players_mtt":300,"min_players_mtt":30,"promote_pending":false,"restrict_device":true,"save_start_time":false,"seat_game_scope":"table:6eaddeaf-1511-4265-bb38-37811ae82ad9","bomb_pot_enabled":false,"bomb_pot_variant":null,"break_started_at":null,"calltime_enabled":false,"final_table_deal":false,"payout_structure":"winner_takes_all","pineapple_holdem":false,"sng_player_count":9,"spins_multiplier":null,"straddle_enabled":false,"add_on_multiplier":1,"allow_rabbit_hunt":true,"auto_create_table":false,"auto_muck_enabled":true,"auto_utg_straddle":false,"blinds_up_minutes":10,"bubble_protection":false,"dealing_halted_at":null,"first_button_seat":2,"game_length_hours":12,"insurance_enabled":false,"kill_threshold_bb":10,"short_description":"","show_hand_enabled":true,"sng_custom_buy_in":false,"time_bank_enabled":true,"allow_run_it_twice":true,"auto_start_players":2,"bomb_pot_frequency":0,"career_percent_min":0,"restrict_observers":false,"seat_admission_key":"tournament:2aa4cba1-506f-426b-a1ba-d8e22e018533","seven_deuce_amount":2,"terminal_closed_at":null,"time_bank_max_uses":4,"voluntary_straddle":false,"wait_for_big_blind":true,"action_time_seconds":15,"bomb_pot_ante_fixed":null,"featured_tournament":false,"next_step_satellite":false,"observer_show_cards":false,"seven_deuce_enabled":false,"synchronized_breaks":true,"tournament_schedule":false,"agent_downline_limit":null,"bomb_pot_board_count":1,"bomb_pot_min_players":3,"bomb_pot_next_due_at":null,"bomb_pot_sched_state":null,"break_eligible_since":null,"buy_in_authorization":false,"maintain_percent_min":0,"run_it_twice_enabled":false,"bomb_pot_double_board":false,"bomb_pot_trigger_mode":"every_n_hands","dealing_halted_reason":null,"authorized_to_register":false,"big_blind_ante_enabled":false,"bomb_pot_button_policy":"regular","prefer_check_over_fold":true,"bomb_pot_manual_pending":false,"early_bird_registration":false,"late_registration_level":6,"pc_emulator_restriction":false,"bomb_pot_ante_multiplier":2,"dealing_halt_observed_at":null,"max_consecutive_timeouts":3,"restart_tournament_every":false,"bomb_pot_announce_seconds":null,"bomb_pot_interval_seconds":null,"custom_rebuy_reentry_cost":false,"disconnect_timeout_seconds":30,"number_of_rebuys_reentries":3,"add_on_break_length_minutes":1,"photo_rotation_verification":false}],"table_seats":[{"id":"3eaf38cc-08d0-4b7b-be7e-af3be36c1617","stack":0,"status":"active","club_id":"a0000000-0000-0000-0000-000000000001","is_away":false,"left_at":"2026-09-08T14:50:31.239+00:00","user_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","horse_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","joined_at":"2026-09-08T14:44:51.55749+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":2,"occupancy_id":"b449271a-faa6-41c0-bc10-a340562fd884","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"8b786212-a6e2-4fb2-934f-45cfdb2bb5f5","stack":0,"status":"active","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","is_away":false,"left_at":"2026-09-08T14:50:31.239+00:00","user_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","horse_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","joined_at":"2026-09-08T14:45:08.753219+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":3,"occupancy_id":"dac26e3c-ec74-4c6a-abef-038249fae1a1","leave_pending":false,"is_sitting_out":false,"active_game_scope":null,"active_parent_key":null,"entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2},{"id":"fd0e0c3a-1efa-4262-8122-4c05e328f9ac","stack":900,"status":"active","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","is_away":false,"left_at":null,"user_id":"aef849b8-2906-4dc0-b108-251710e76d3c","horse_id":"aef849b8-2906-4dc0-b108-251710e76d3c","table_id":"6eaddeaf-1511-4265-bb38-37811ae82ad9","joined_at":"2026-09-08T14:44:51.55749+00:00","member_id":null,"player_id":null,"auto_rebuy":false,"entry_hold":null,"sit_out_at":null,"seat_number":1,"occupancy_id":"fd840a1b-e483-4b9c-99e7-bd4ddb672cb0","leave_pending":false,"is_sitting_out":false,"active_game_scope":"table:6eaddeaf-1511-4265-bb38-37811ae82ad9","active_parent_key":"tournament:2aa4cba1-506f-426b-a1ba-d8e22e018533","entry_post_agreed":false,"terminal_closed_at":null,"time_bank_remaining":40,"scheduled_leave_hands":null,"time_bank_uses_remaining":2}],"tournament_escrow":[{"fee_out":0,"enforced":true,"gross_in":300,"bounty_in":0,"closed_at":null,"opened_at":"2026-09-08T14:44:51.55749+00:00","prize_out":0,"bounty_out":0,"close_note":null,"overlay_in":0,"refund_fee":0,"reserve_in":200,"updated_at":"2026-09-08T14:45:16.289264+00:00","fee_balance":24,"opened_from":"shadow at first sight (tournament_buyin)","reserve_out":276,"refund_prize":0,"satellite_in":0,"prize_balance":200,"refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","bounty_balance":0,"fee_entries_in":24,"satellite_fee_in":0,"terminal_closed_at":null}],"spin_reserve_ledger":[{"id":"0936892f-9964-4428-8ea5-befc64ccf306","kind":"jackpot_draw","note":"prize pool","seats":3,"amount":-200,"buy_in":100,"club_id":"fade0000-0000-0000-0000-000000000001","created_at":"2026-09-08T14:45:16.289264+00:00","house_rake":24,"multiplier":2,"balance_after":51909,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","terminal_closed_at":null},{"id":"aebfeae5-8e2c-451e-b977-bbe26f50803c","kind":"contribution","note":"buy-ins less fixed rake, booked when the last seat was paid","seats":3,"amount":276,"buy_in":100,"club_id":"fade0000-0000-0000-0000-000000000001","created_at":"2026-09-08T14:45:08.753219+00:00","house_rake":24,"multiplier":null,"balance_after":52100.72,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","terminal_closed_at":null}],"tournament_refund_entitlements":[{"id":"36ef28d8-48fc-47bd-889f-16b21cb938f6","gross":100,"user_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","created_at":"2026-09-08T14:45:08.753219+00:00","refund_fee":0,"refund_prize":100,"escrow_bucket":"wallet_gross","evidence_kind":"cutover_wallet_charge","refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","charge_category":"tournament_buyin","registration_id":null,"entitlement_kind":"wallet_charge","source_ledger_id":"5df62b73-4be1-4bfe-8f15-f6cce478e5f4","source_ticket_id":null,"source_award_place":null,"source_satellite_id":null,"refund_wallet_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4"},{"id":"c83d6065-8f24-4b3e-9c7f-1ff6a4057264","gross":100,"user_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","created_at":"2026-09-08T14:44:51.55749+00:00","refund_fee":0,"refund_prize":100,"escrow_bucket":"wallet_gross","evidence_kind":"cutover_wallet_charge","refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","charge_category":"tournament_buyin","registration_id":null,"entitlement_kind":"wallet_charge","source_ledger_id":"58f5eefc-524e-471f-9932-6ca026231d35","source_ticket_id":null,"source_award_place":null,"source_satellite_id":null,"refund_wallet_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4"},{"id":"daebecf0-d844-4719-a56e-f26498170897","gross":100,"user_id":"aef849b8-2906-4dc0-b108-251710e76d3c","created_at":"2026-09-08T14:44:51.55749+00:00","refund_fee":0,"refund_prize":100,"escrow_bucket":"wallet_gross","evidence_kind":"cutover_wallet_charge","refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","charge_category":"tournament_buyin","registration_id":null,"entitlement_kind":"wallet_charge","source_ledger_id":"3d0f2790-9314-40ba-8b52-32be054daea6","source_ticket_id":null,"source_award_place":null,"source_satellite_id":null,"refund_wallet_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4"}],"chip_ledger":[{"id":"1a26ffb6-6646-4c77-b831-ea470ea3c11a","notes":null,"amount":200,"status":"posted","club_id":"fade0000-0000-0000-0000-000000000001","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"spin_prize","epoch_id":2,"metadata":null,"row_hash":"a21fd74a31786bc44a20acc0172c738312d0ec05238056887e35b463cda83520","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706220,"from_type":"spin_reserve","prev_hash":"469e3d198a0528063f1b5d50c6f50d16fe5e402e5a43354e9906d142b9238cd7","created_at":"2026-09-08T14:45:16.289264+00:00","from_label":"spin_bonus_pools.balance","description":"auto-ledgered spin_bonus_pools.balance delta -200.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"2d968239-acdd-4a2c-99f2-a369ff37ae31","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":52109,"post_from_balance":51909},{"id":"3d0f2790-9314-40ba-8b52-32be054daea6","notes":null,"amount":100,"status":"posted","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"tournament_buyin","epoch_id":2,"metadata":null,"row_hash":"35f3b5dc39fc72f832b1a64642e7dc25cb2d7d13f9155f33499744cf04d3a1bc","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706054,"from_type":"player_wallet","prev_hash":"abb08f780a9cc27aad0127bb38ab0b687a53e8cbb2388fbc5bf886ab19a292a0","created_at":"2026-09-08T14:44:51.55749+00:00","from_label":null,"description":"auto-audited club_members.chip_balance delta -100.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"aef849b8-2906-4dc0-b108-251710e76d3c","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":null,"post_from_balance":null},{"id":"40b79d23-cb09-4b1f-bc11-00100c87b411","notes":null,"amount":276,"status":"posted","club_id":"fade0000-0000-0000-0000-000000000001","db_role":"postgres","hand_id":null,"to_type":"spin_reserve","category":"spin_entry","epoch_id":2,"metadata":null,"row_hash":"24f652ee019f1d1911fdd2664d1bd9a0dc4bd6d5a600987f45bf3427633ccca1","table_id":null,"to_label":"spin_bonus_pools.balance","union_id":null,"chain_seq":2706159,"from_type":"prize_liability","prev_hash":"016769c30fe7a3b46439ab77eb79646c4f62bfd1c117f4be027c81d552b57c7f","created_at":"2026-09-08T14:45:08.753219+00:00","from_label":null,"description":"auto-ledgered spin_bonus_pools.balance delta 276.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2d968239-acdd-4a2c-99f2-a369ff37ae31","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","pre_to_balance":51824.72,"idempotency_key":null,"post_to_balance":52100.72,"pre_from_balance":null,"post_from_balance":null},{"id":"58f5eefc-524e-471f-9932-6ca026231d35","notes":null,"amount":100,"status":"posted","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"tournament_buyin","epoch_id":2,"metadata":null,"row_hash":"0a9f34f772c203e58eec16b8da7e0d4e1ff8ed1bd5e2890892e9c6b26be10ed7","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706055,"from_type":"player_wallet","prev_hash":"35f3b5dc39fc72f832b1a64642e7dc25cb2d7d13f9155f33499744cf04d3a1bc","created_at":"2026-09-08T14:44:51.55749+00:00","from_label":null,"description":"auto-audited club_members.chip_balance delta -100.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":null,"post_from_balance":null},{"id":"5df62b73-4be1-4bfe-8f15-f6cce478e5f4","notes":null,"amount":100,"status":"posted","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"tournament_buyin","epoch_id":2,"metadata":null,"row_hash":"dff329f08f5c4a4e81a39984fb758dc89b384224559f60648e49a5c11daa8883","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706154,"from_type":"player_wallet","prev_hash":null,"created_at":"2026-09-08T14:45:08.753219+00:00","from_label":null,"description":"auto-audited club_members.chip_balance delta -100.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":null,"post_from_balance":null}]},"reviewed_fee_proof":{"fee":24,"gross":300,"reserve":{"draw":{"id":"0936892f-9964-4428-8ea5-befc64ccf306","kind":"jackpot_draw","note":"prize pool","seats":3,"amount":-200,"buy_in":100,"club_id":"fade0000-0000-0000-0000-000000000001","created_at":"2026-09-08T14:45:16.289264+00:00","house_rake":24,"multiplier":2,"balance_after":51909,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533"},"draw_ledger":{"id":"1a26ffb6-6646-4c77-b831-ea470ea3c11a","notes":null,"amount":200,"status":"posted","club_id":"fade0000-0000-0000-0000-000000000001","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"spin_prize","epoch_id":2,"metadata":null,"row_hash":"a21fd74a31786bc44a20acc0172c738312d0ec05238056887e35b463cda83520","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706220,"from_type":"spin_reserve","prev_hash":"469e3d198a0528063f1b5d50c6f50d16fe5e402e5a43354e9906d142b9238cd7","created_at":"2026-09-08T14:45:16.289264+00:00","from_label":"spin_bonus_pools.balance","description":"auto-ledgered spin_bonus_pools.balance delta -200.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"2d968239-acdd-4a2c-99f2-a369ff37ae31","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":52109,"post_from_balance":51909},"contribution":{"id":"aebfeae5-8e2c-451e-b977-bbe26f50803c","kind":"contribution","note":"buy-ins less fixed rake, booked when the last seat was paid","seats":3,"amount":276,"buy_in":100,"club_id":"fade0000-0000-0000-0000-000000000001","created_at":"2026-09-08T14:45:08.753219+00:00","house_rake":24,"multiplier":null,"balance_after":52100.72,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533"},"contribution_ledger":{"id":"40b79d23-cb09-4b1f-bc11-00100c87b411","notes":null,"amount":276,"status":"posted","club_id":"fade0000-0000-0000-0000-000000000001","db_role":"postgres","hand_id":null,"to_type":"spin_reserve","category":"spin_entry","epoch_id":2,"metadata":null,"row_hash":"24f652ee019f1d1911fdd2664d1bd9a0dc4bd6d5a600987f45bf3427633ccca1","table_id":null,"to_label":"spin_bonus_pools.balance","union_id":null,"chain_seq":2706159,"from_type":"prize_liability","prev_hash":"016769c30fe7a3b46439ab77eb79646c4f62bfd1c117f4be027c81d552b57c7f","created_at":"2026-09-08T14:45:08.753219+00:00","from_label":null,"description":"auto-ledgered spin_bonus_pools.balance delta 276.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2d968239-acdd-4a2c-99f2-a369ff37ae31","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","pre_to_balance":51824.72,"idempotency_key":null,"post_to_balance":52100.72,"pre_from_balance":null,"post_from_balance":null}},"contributors":[{"ledger":{"id":"5df62b73-4be1-4bfe-8f15-f6cce478e5f4","notes":null,"amount":100,"status":"posted","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"tournament_buyin","epoch_id":2,"metadata":null,"row_hash":"dff329f08f5c4a4e81a39984fb758dc89b384224559f60648e49a5c11daa8883","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706154,"from_type":"player_wallet","prev_hash":null,"created_at":"2026-09-08T14:45:08.753219+00:00","from_label":null,"description":"auto-audited club_members.chip_balance delta -100.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":null,"post_from_balance":null},"club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","player_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","entitlement":{"id":"36ef28d8-48fc-47bd-889f-16b21cb938f6","gross":100,"user_id":"036f0b55-c601-4d09-982a-5294cf4ea15d","created_at":"2026-09-08T14:45:08.753219+00:00","refund_fee":0,"refund_prize":100,"escrow_bucket":"wallet_gross","evidence_kind":"cutover_wallet_charge","refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","charge_category":"tournament_buyin","registration_id":null,"entitlement_kind":"wallet_charge","source_ledger_id":"5df62b73-4be1-4bfe-8f15-f6cce478e5f4","source_ticket_id":null,"source_award_place":null,"source_satellite_id":null,"refund_wallet_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4"},"registered_at":"2026-09-08T14:45:08.753219+00:00","registration_id":"bcab2749-47c7-4617-9d72-9e56de4eb616"},{"ledger":{"id":"58f5eefc-524e-471f-9932-6ca026231d35","notes":null,"amount":100,"status":"posted","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"tournament_buyin","epoch_id":2,"metadata":null,"row_hash":"0a9f34f772c203e58eec16b8da7e0d4e1ff8ed1bd5e2890892e9c6b26be10ed7","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706055,"from_type":"player_wallet","prev_hash":"35f3b5dc39fc72f832b1a64642e7dc25cb2d7d13f9155f33499744cf04d3a1bc","created_at":"2026-09-08T14:44:51.55749+00:00","from_label":null,"description":"auto-audited club_members.chip_balance delta -100.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":null,"post_from_balance":null},"club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","player_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","entitlement":{"id":"c83d6065-8f24-4b3e-9c7f-1ff6a4057264","gross":100,"user_id":"72f2fedb-a5f9-4d10-b147-d92e18102d3f","created_at":"2026-09-08T14:44:51.55749+00:00","refund_fee":0,"refund_prize":100,"escrow_bucket":"wallet_gross","evidence_kind":"cutover_wallet_charge","refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","charge_category":"tournament_buyin","registration_id":null,"entitlement_kind":"wallet_charge","source_ledger_id":"58f5eefc-524e-471f-9932-6ca026231d35","source_ticket_id":null,"source_award_place":null,"source_satellite_id":null,"refund_wallet_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4"},"registered_at":"2026-09-08T14:44:51.55749+00:00","registration_id":"1350d845-cdf8-41ad-86bf-abf2f2460cab"},{"ledger":{"id":"3d0f2790-9314-40ba-8b52-32be054daea6","notes":null,"amount":100,"status":"posted","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","db_role":"postgres","hand_id":null,"to_type":"prize_liability","category":"tournament_buyin","epoch_id":2,"metadata":null,"row_hash":"35f3b5dc39fc72f832b1a64642e7dc25cb2d7d13f9155f33499744cf04d3a1bc","table_id":null,"to_label":null,"union_id":null,"chain_seq":2706054,"from_type":"player_wallet","prev_hash":"abb08f780a9cc27aad0127bb38ab0b687a53e8cbb2388fbc5bf886ab19a292a0","created_at":"2026-09-08T14:44:51.55749+00:00","from_label":null,"description":"auto-audited club_members.chip_balance delta -100.00","causation_id":null,"performed_by":"2d1cd6c3-5700-4af9-a271-d4863fdab20d","to_entity_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","actor_service":"PostgREST 14.5","settlement_id":null,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","correlation_id":null,"from_entity_id":"aef849b8-2906-4dc0-b108-251710e76d3c","pre_to_balance":null,"idempotency_key":null,"post_to_balance":null,"pre_from_balance":null,"post_from_balance":null},"club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","player_id":"aef849b8-2906-4dc0-b108-251710e76d3c","entitlement":{"id":"daebecf0-d844-4719-a56e-f26498170897","gross":100,"user_id":"aef849b8-2906-4dc0-b108-251710e76d3c","created_at":"2026-09-08T14:44:51.55749+00:00","refund_fee":0,"refund_prize":100,"escrow_bucket":"wallet_gross","evidence_kind":"cutover_wallet_charge","refund_bounty":0,"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","charge_category":"tournament_buyin","registration_id":null,"entitlement_kind":"wallet_charge","source_ledger_id":"3d0f2790-9314-40ba-8b52-32be054daea6","source_ticket_id":null,"source_award_place":null,"source_satellite_id":null,"refund_wallet_club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4"},"registered_at":"2026-09-08T14:44:51.55749+00:00","registration_id":"06377b59-94e6-4663-9fc0-5dba12675b9d"}],"tournament_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","scope_versions":[{"id":485637,"club_id":"fade0000-0000-0000-0000-000000000001","game_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","version":1,"contract":{"id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","name":"100 Chip Spin PLO4","is_pko":false,"club_id":"fade0000-0000-0000-0000-000000000001","is_xmtt":false,"variant":"spin","ban_chat":false,"free_buy":false,"is_rebuy":false,"union_id":"fade0000-0000-0000-0000-000000000001","game_type":"PLO4","is_bounty":false,"is_pinned":false,"spin_type":"standard","addon_cost":0,"buy_in_fee":0,"is_private":false,"is_reentry":false,"max_rebuys":0,"rebuy_cost":0,"start_time":"2026-09-08T14:33:05.409+00:00","table_size":3,"total_days":1,"addon_chips":0,"is_vip_only":false,"max_players":3,"min_players":3,"rebuy_chips":0,"addon_levels":1,"is_multi_day":false,"label_as_new":false,"rebuy_levels":4,"bounty_amount":0,"buy_in_amount":100,"late_reg_mins":0,"max_reentries":0,"all_in_or_fold":false,"big_blind_ante":false,"hide_club_name":false,"payout_percent":10,"starting_chips":300,"accelerated_mtt":false,"blind_structure":"[{\"level\":1,\"smallBlind\":10,\"bigBlind\":20,\"ante\":0,\"duration\":180},{\"level\":2,\"smallBlind\":15,\"bigBlind\":30,\"ante\":0,\"duration\":180},{\"level\":3,\"smallBlind\":20,\"bigBlind\":40,\"ante\":0,\"duration\":180},{\"level\":4,\"smallBlind\":30,\"bigBlind\":60,\"ante\":0,\"duration\":180},{\"level\":5,\"smallBlind\":40,\"bigBlind\":80,\"ante\":0,\"duration\":180},{\"level\":6,\"smallBlind\":50,\"bigBlind\":100,\"ante\":0,\"duration\":180},{\"level\":7,\"smallBlind\":60,\"bigBlind\":120,\"ante\":0,\"duration\":180},{\"level\":8,\"smallBlind\":75,\"bigBlind\":150,\"ante\":0,\"duration\":180},{\"level\":9,\"smallBlind\":90,\"bigBlind\":180,\"ante\":0,\"duration\":180},{\"level\":10,\"smallBlind\":105,\"bigBlind\":210,\"ante\":0,\"duration\":180},{\"level\":11,\"smallBlind\":145,\"bigBlind\":290,\"ante\":0,\"duration\":180},{\"level\":12,\"smallBlind\":205,\"bigBlind\":410,\"ante\":0,\"duration\":180}]","late_reg_levels":0,"tournament_type":"SPIN","add_on_available":false,"addon_from_start":false,"early_bird_chips":0,"guaranteed_prize":0,"payout_structure":"[{\"place\":1,\"percentage\":100}]","bubble_protection":false,"is_mystery_bounty":false,"early_bird_enabled":false,"mystery_bounty_max":0,"mystery_bounty_min":0,"action_time_seconds":15,"addon_break_minutes":1,"synchronized_breaks":false,"authorized_to_register":false,"mystery_bounty_profile":"classic","final_table_deal_enabled":false,"mystery_bounty_activation":"at_the_money","mystery_bounty_top_percent":20,"mystery_bounty_pool_percent":50,"mystery_bounty_regular_pool_percent":50},"union_id":"fade0000-0000-0000-0000-000000000001","game_kind":"tournament","published_at":"2026-09-08T14:31:23.973275+00:00","published_by":null,"change_reason":"created","contract_hash":"f1b99b281968b29da5fa95b9ad7a0d306eb831dc57a400fb406ab94910e57370"},{"id":485859,"club_id":"fade0000-0000-0000-0000-000000000001","game_id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","version":2,"contract":{"id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","name":"100 Chip Spin PLO4","is_pko":false,"club_id":"fade0000-0000-0000-0000-000000000001","is_xmtt":false,"variant":"spin","ban_chat":false,"free_buy":false,"is_rebuy":false,"union_id":"fade0000-0000-0000-0000-000000000001","game_type":"PLO4","is_bounty":false,"is_pinned":false,"spin_type":"standard","addon_cost":0,"buy_in_fee":0,"is_private":false,"is_reentry":false,"max_rebuys":0,"rebuy_cost":0,"start_time":"2026-09-08T14:48:48.55749+00:00","table_size":3,"total_days":1,"addon_chips":0,"is_vip_only":false,"max_players":3,"min_players":3,"rebuy_chips":0,"addon_levels":1,"is_multi_day":false,"label_as_new":false,"rebuy_levels":4,"bounty_amount":0,"buy_in_amount":100,"late_reg_mins":0,"max_reentries":0,"all_in_or_fold":false,"big_blind_ante":false,"hide_club_name":false,"payout_percent":10,"starting_chips":300,"accelerated_mtt":false,"blind_structure":"[{\"level\":1,\"smallBlind\":10,\"bigBlind\":20,\"ante\":0,\"duration\":180},{\"level\":2,\"smallBlind\":15,\"bigBlind\":30,\"ante\":0,\"duration\":180},{\"level\":3,\"smallBlind\":20,\"bigBlind\":40,\"ante\":0,\"duration\":180},{\"level\":4,\"smallBlind\":30,\"bigBlind\":60,\"ante\":0,\"duration\":180},{\"level\":5,\"smallBlind\":40,\"bigBlind\":80,\"ante\":0,\"duration\":180},{\"level\":6,\"smallBlind\":50,\"bigBlind\":100,\"ante\":0,\"duration\":180},{\"level\":7,\"smallBlind\":60,\"bigBlind\":120,\"ante\":0,\"duration\":180},{\"level\":8,\"smallBlind\":75,\"bigBlind\":150,\"ante\":0,\"duration\":180},{\"level\":9,\"smallBlind\":90,\"bigBlind\":180,\"ante\":0,\"duration\":180},{\"level\":10,\"smallBlind\":105,\"bigBlind\":210,\"ante\":0,\"duration\":180},{\"level\":11,\"smallBlind\":145,\"bigBlind\":290,\"ante\":0,\"duration\":180},{\"level\":12,\"smallBlind\":205,\"bigBlind\":410,\"ante\":0,\"duration\":180}]","late_reg_levels":0,"tournament_type":"SPIN","add_on_available":false,"addon_from_start":false,"early_bird_chips":0,"guaranteed_prize":0,"payout_structure":"[{\"place\":1,\"percentage\":100}]","bubble_protection":false,"is_mystery_bounty":false,"early_bird_enabled":false,"mystery_bounty_max":0,"mystery_bounty_min":0,"action_time_seconds":15,"addon_break_minutes":1,"synchronized_breaks":false,"authorized_to_register":false,"mystery_bounty_profile":"classic","final_table_deal_enabled":false,"mystery_bounty_activation":"at_the_money","mystery_bounty_top_percent":20,"mystery_bounty_pool_percent":50,"mystery_bounty_regular_pool_percent":50},"union_id":"fade0000-0000-0000-0000-000000000001","game_kind":"tournament","published_at":"2026-09-08T14:44:51.55749+00:00","published_by":null,"change_reason":"system_revision","contract_hash":"7c7e42911728c912f78129e3dedc9aef24ba0730fdfc5bb79b269f0782d531ae"}],"raw_source_count":1,"source_fingerprint":"bfb56dac635bc7a238383d785ea88f35","recognized_contributors":3},"fee_proof_observed_at":"2026-09-26 14:29:18.62487+00","fee_proof_capture_sha256":"a36d0be735a1d931c343351722c4a1163621402591585b1ca1fd7f7551d245f6"}$original$::jsonb;
$manifest$;
ALTER FUNCTION smarter_private.spin_archived_first_manifest() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_manifest() FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION smarter_private.spin_archived_first_preimage()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $fn$
DECLARE original jsonb; observed jsonb := '{}'::jsonb; part jsonb; rowset record;
 t uuid := '2aa4cba1-506f-426b-a1ba-d8e22e018533';
BEGIN
 original := smarter_private.spin_archived_first_manifest();
 IF original->>'evidence_kind' IS DISTINCT FROM 'archived_database_projection'
 OR original->>'source_sha256' IS DISTINCT FROM '8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5'
 OR original->>'tournament_id' IS DISTINCT FROM t::text
 OR original->'original_atomic_commit' IS DISTINCT FROM 'null'::jsonb THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_SOURCE_IDENTITY' USING ERRCODE='P0404';
 END IF;
 FOR rowset IN SELECT * FROM (VALUES
 ('tournaments','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),''[]'') FROM public.tournaments r WHERE r.id=$1'),
 ('tournament_players','SELECT coalesce(jsonb_agg(to_jsonb(r)-''username'' ORDER BY r.id),''[]'') FROM public.tournament_players r WHERE r.tournament_id=$1'),
 ('tables','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),''[]'') FROM public.tables r WHERE r.tournament_id=$1'),
 ('table_seats','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),''[]'') FROM public.table_seats r JOIN public.tables b ON b.id=r.table_id WHERE b.tournament_id=$1'),
 ('tournament_escrow','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.tournament_id),''[]'') FROM public.tournament_escrow r WHERE r.tournament_id=$1'),
 ('spin_reserve_ledger','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),''[]'') FROM public.spin_reserve_ledger r WHERE r.tournament_id=$1'),
 ('tournament_refund_entitlements','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),''[]'') FROM public.tournament_refund_entitlements r WHERE r.tournament_id=$1'),
 ('chip_ledger','SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),''[]'') FROM public.chip_ledger r WHERE r.tournament_id=$1')
 ) sources(name,query) LOOP
  EXECUTE rowset.query INTO part USING t;
  observed := observed || jsonb_build_object(rowset.name,part);
 END LOOP;
 IF observed IS DISTINCT FROM original->'captured_preimage' THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_PREIMAGE_CHANGED' USING ERRCODE='40001';
 END IF;
 -- This result attests only unchanged source inputs. A financial caller must
 -- independently admit lease/operation, immutable funding and fee custody,
 -- preserve ordinary guards, and atomically produce canonical terminal proof.
 RETURN jsonb_build_object('preimage_matched',true,'financial_authority',false,
  'evidence_kind',original->'evidence_kind','source_sha256',original->'source_sha256',
  'tournament_id',t,'original_atomic_commit',NULL,
  'first_history',original->'original_first_history',
  'last_history',original->'original_last_history',
  'original_result',original->'original_result');
END $fn$;
ALTER FUNCTION smarter_private.spin_archived_first_preimage() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_preimage()
 FROM PUBLIC,anon,authenticated,service_role;

-- Component: supabase/components/spin-archived-first-admission.sql
-- FIRST-CASE CANDIDATE ONLY. Not a migration; full connected native financial
-- qualification remains required before any installation. No scheduled caller.
-- Requires the compiled first witness and exact current provider functions.
CREATE TABLE smarter_private.spin_archived_first_admission (
 tournament_id uuid PRIMARY KEY CHECK(tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'),
 operation_id uuid NOT NULL UNIQUE,
 lease_generation uuid NOT NULL,
 owner_instance text NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256='8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5'),
 original_fee_proof jsonb NOT NULL,
 admitted_xid bigint NOT NULL DEFAULT txid_current(),
 admitted_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE smarter_private.spin_archived_first_admission OWNER TO postgres;
ALTER TABLE smarter_private.spin_archived_first_admission ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE smarter_private.spin_archived_first_admission FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.spin_archived_first_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN RAISE EXCEPTION 'ARCHIVED_SPIN_ADMISSION_IMMUTABLE' USING ERRCODE='55000'; END $fn$;
CREATE TRIGGER spin_archived_first_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.spin_archived_first_admission FOR EACH ROW
 EXECUTE FUNCTION smarter_private.spin_archived_first_immutable();
CREATE TRIGGER spin_archived_first_no_truncate BEFORE TRUNCATE
 ON smarter_private.spin_archived_first_admission FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.spin_archived_first_immutable();
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_immutable() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.spin_archived_first_launch_witness(p_tournament uuid,p_started_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $fn$
DECLARE admitted smarter_private.spin_archived_first_admission%ROWTYPE; witness jsonb;
BEGIN
 SELECT * INTO admitted FROM smarter_private.spin_archived_first_admission WHERE tournament_id=p_tournament;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF admitted.admitted_xid IS DISTINCT FROM txid_current()
 OR NOT EXISTS(SELECT 1 FROM public.engine_tournament_leases
   WHERE tournament_id=p_tournament AND protocol_version=2
   AND lease_generation=admitted.lease_generation AND instance_id=admitted.owner_instance
   AND heartbeat_at>=clock_timestamp()-interval '30 seconds') THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_LAUNCH_AUTHORITY_CHANGED' USING ERRCODE='40001'; END IF;
 witness:=smarter_private.spin_archived_first_preimage();
 IF p_started_at IS DISTINCT FROM (witness->'first_history'->>'created_at')::timestamptz THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_FIRST_HAND_IDENTITY' USING ERRCODE='40001'; END IF;
 RETURN jsonb_build_object('ok',true,'evidence_kind','archived_database_projection',
  'source_sha256',admitted.source_sha256,'operation_id',admitted.operation_id,
  'first_hand_at',p_started_at,'playing',1,'eliminated',2,'dealt_field',3,
  'required_players',3,'original_atomic_commit',NULL);
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_launch_witness(uuid,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.spin_archived_first_standings(p_tournament uuid,p_winner uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $fn$
DECLARE admitted smarter_private.spin_archived_first_admission%ROWTYPE;
 original jsonb; original_player jsonb; actual_player jsonb; terminal_time timestamptz;
 original_busts jsonb; expected_prize numeric; player_count integer;
BEGIN
 SELECT * INTO admitted FROM smarter_private.spin_archived_first_admission WHERE tournament_id=p_tournament;
 IF NOT FOUND THEN RETURN NULL; END IF;
 original:=smarter_private.spin_archived_first_manifest();
 IF p_winner IS DISTINCT FROM 'aef849b8-2906-4dc0-b108-251710e76d3c'::uuid
 OR admitted.source_sha256 IS DISTINCT FROM original->>'source_sha256'
 OR (admitted.admitted_xid<>txid_current() AND NOT EXISTS(
  SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament)) THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_STANDINGS_IDENTITY' USING ERRCODE='P0404'; END IF;
 SELECT completed_at INTO terminal_time FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament;
 SELECT count(*) INTO player_count FROM public.tournament_players WHERE tournament_id=p_tournament;
 IF player_count<>3 THEN RAISE EXCEPTION 'ARCHIVED_SPIN_ROSTER_CHANGED' USING ERRCODE='40001'; END IF;
 expected_prize:=(original->'captured_preimage'->'tournaments'->0->>'prize_pool')::numeric;
 FOR original_player IN SELECT value FROM jsonb_array_elements(original->'captured_preimage'->'tournament_players') LOOP
  SELECT to_jsonb(p)-'username' INTO actual_player FROM public.tournament_players p
   WHERE p.tournament_id=p_tournament AND p.id=(original_player->>'id')::uuid;
  IF actual_player IS NULL OR (actual_player->>'terminal_closed_at')::timestamptz IS DISTINCT FROM terminal_time THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_ROSTER_CLOSURE_CHANGED' USING ERRCODE='40001'; END IF;
  IF original_player->>'user_id'=p_winner::text THEN
   IF (actual_player-ARRAY['status','position','prize','terminal_closed_at'])
       IS DISTINCT FROM (original_player-ARRAY['status','position','prize','terminal_closed_at'])
    OR actual_player->>'status' IS DISTINCT FROM 'winner'
    OR actual_player->'position' IS DISTINCT FROM '1'::jsonb
    OR actual_player->>'prize' IS NULL
    OR (actual_player->>'prize')::numeric NOT IN(0,expected_prize) THEN
    RAISE EXCEPTION 'ARCHIVED_SPIN_WINNER_CHANGED' USING ERRCODE='40001'; END IF;
  ELSIF actual_player-'terminal_closed_at' IS DISTINCT FROM original_player-'terminal_closed_at' THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_RECORDED_PLACE_CHANGED' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT jsonb_agg(value ORDER BY value->>'id') INTO original_busts
 FROM jsonb_array_elements(original->'captured_preimage'->'tournament_players') WHERE value->>'user_id'<>p_winner::text;
 RETURN jsonb_build_object('evidence_kind','archived_database_projection','operation_id',admitted.operation_id,
  'source_sha256',admitted.source_sha256,'tournament_id',p_tournament,'winner_id',p_winner,
  'original_ranks',original_busts,'original_outcome','recorded_standings',
  'original_first_history',original->'original_first_history',
  'original_last_history',original->'original_last_history','original_atomic_commit',NULL,
  'admitted_at',admitted.admitted_at);
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_standings(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.spin_archived_first_requires_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE cash jsonb;
BEGIN
 SELECT cash_receipt INTO cash FROM public.tournament_terminal_settlements WHERE tournament_id=NEW.tournament_id;
 IF cash IS NULL OR cash->'original_standings' IS DISTINCT FROM smarter_private.spin_archived_first_standings(
  NEW.tournament_id,'aef849b8-2906-4dc0-b108-251710e76d3c')
 OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=NEW.tournament_id AND status='COMPLETED') THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_ATOMIC_TERMINAL_REQUIRED' USING ERRCODE='P0404'; END IF;
 RETURN NULL;
END $fn$;
CREATE CONSTRAINT TRIGGER spin_archived_first_requires_terminal AFTER INSERT
 ON smarter_private.spin_archived_first_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION smarter_private.spin_archived_first_requires_terminal();
REVOKE ALL ON FUNCTION smarter_private.spin_archived_first_requires_terminal() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_complete_first_archived_spin(p_operation_id uuid,p_expected_source_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private SET timezone='UTC'
SET statement_timeout='30s' SET lock_timeout='3s' AS $fn$
DECLARE t uuid:='2aa4cba1-506f-426b-a1ba-d8e22e018533';
 winner uuid:='aef849b8-2906-4dc0-b108-251710e76d3c';
 tab uuid:='6eaddeaf-1511-4265-bb38-37811ae82ad9';
 owner_name text; admitted smarter_private.spin_archived_first_admission%ROWTYPE;
 claimed record; witness jsonb; funding jsonb; result jsonb;
BEGIN
 IF public.fn_caller_is_engine() IS DISTINCT FROM true THEN RAISE EXCEPTION 'service authority required' USING ERRCODE='28000'; END IF;
 IF p_operation_id IS NULL OR p_expected_source_sha256 IS DISTINCT FROM
  smarter_private.spin_archived_first_manifest()->>'source_sha256' THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_SOURCE_REQUIRED' USING ERRCODE='22023'; END IF;
 -- Serialize this finite entry point before reading its immutable admission.
 -- No ordinary manager consumes this operation lock. A committed replay never
 -- renews a lease or reacquires the financial writer lane.
 PERFORM pg_advisory_xact_lock(hashtextextended('archived-spin-first-operation:'||t::text,0));
 SELECT * INTO admitted FROM smarter_private.spin_archived_first_admission WHERE tournament_id=t;
 IF FOUND THEN
  IF admitted.operation_id IS DISTINCT FROM p_operation_id OR admitted.source_sha256 IS DISTINCT FROM p_expected_source_sha256 THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_REPLAY_MISMATCH' USING ERRCODE='40001'; END IF;
  result:=public.fn_ca_tournament_terminal_receipt(t,winner);
  IF (SELECT cash_receipt->'original_standings' FROM public.tournament_terminal_settlements WHERE tournament_id=t)
   IS DISTINCT FROM smarter_private.spin_archived_first_standings(t,winner) THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_TERMINAL_WITNESS_CHANGED' USING ERRCODE='P0404'; END IF;
  RETURN result;
 END IF;
 -- Match canonical launch admission before taking any event lease/lane/row.
 -- Maintenance/ABI writers must not wait behind an event lock held by a
 -- recovery transaction that is itself waiting for their admission authority.
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 PERFORM public.fn_ca_lock_mtt_admission_contract();
 owner_name:='service:archived-spin-first:'||p_operation_id::text;
 SELECT * INTO claimed FROM public.claim_tournament_lease_v2(t,owner_name,'archived-database-projection-v1',p_operation_id,30);
 IF claimed.granted IS DISTINCT FROM true OR claimed.holder IS DISTINCT FROM owner_name
  OR claimed.lease_generation IS DISTINCT FROM p_operation_id THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_COMPETING_OWNER' USING ERRCODE='40001'; END IF;
 -- The actual PostgREST manager prehook holds its lease before a financial
 -- endpoint takes the settlement lane. Taking that lane before our exclusive
 -- lease claim would invert that order and can deadlock a real manager.
 PERFORM public.fn_ca_lock_settlement_lane_for_finish(t);
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 -- The real lease claim precedes the parent row lock, including when the lease
 -- row is absent. Locking an absent row alone cannot fence a concurrent insert.
 -- Public launch ownership takes this same lease -> tournament order.
 PERFORM 1 FROM public.tournaments WHERE id=t FOR UPDATE;
 -- Recheck after blocking lease/lane/parent acquisition. The dedicated finite
 -- operation lock serializes ordinary same-operation calls; this also refuses
 -- unexpected privileged admission drift instead of attempting a second write.
 SELECT * INTO admitted FROM smarter_private.spin_archived_first_admission WHERE tournament_id=t;
 IF FOUND THEN
  IF admitted.operation_id IS DISTINCT FROM p_operation_id OR admitted.source_sha256 IS DISTINCT FROM p_expected_source_sha256 THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_REPLAY_MISMATCH' USING ERRCODE='40001'; END IF;
  result:=public.fn_ca_tournament_terminal_receipt(t,winner);
  IF (SELECT cash_receipt->'original_standings' FROM public.tournament_terminal_settlements WHERE tournament_id=t)
   IS DISTINCT FROM smarter_private.spin_archived_first_standings(t,winner) THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_TERMINAL_WITNESS_CHANGED' USING ERRCODE='P0404'; END IF;
  RETURN result;
 END IF;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.tournament_obligations WHERE tournament_id=t ORDER BY kind,place,id FOR UPDATE;
 PERFORM 1 FROM public.tournament_escrow WHERE tournament_id=t FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s JOIN public.tables b ON b.id=s.table_id WHERE b.tournament_id=t ORDER BY s.id FOR UPDATE OF s;
 PERFORM 1 FROM public.chip_ledger WHERE tournament_id=t ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.tournament_refund_entitlements WHERE tournament_id=t ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.spin_reserve_ledger WHERE tournament_id=t ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.managed_game_contract_versions WHERE game_id=t ORDER BY id FOR SHARE;
 IF EXISTS(SELECT 1 FROM public.hand_history WHERE tournament_id=t OR table_id=tab)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=tab)
 OR EXISTS(SELECT 1 FROM public.tournament_launch_receipts WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.engine_table_leases WHERE table_id=tab)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=tab AND is_complete IS NOT TRUE)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=tab)
 OR EXISTS(SELECT 1 FROM public.tournament_payouts WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_obligations WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id=t)
 OR EXISTS(SELECT 1 FROM public.wallet_credit_idempotency
   WHERE key>='tourney:'||t::text||':' AND key<'tourney:'||t::text||';') THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_LATER_AUTHORITY' USING ERRCODE='40001'; END IF;
 witness:=smarter_private.spin_archived_first_preimage();
 PERFORM 1 FROM public.rake_records WHERE tournament_id=t ORDER BY id FOR SHARE;
 funding:=public.fn_ca_legacy_spin_original_fee_proof(t);
 IF funding IS DISTINCT FROM smarter_private.spin_archived_first_manifest()->'reviewed_fee_proof' THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_ORIGINAL_FUNDING_CHANGED' USING ERRCODE='P0404'; END IF;
 INSERT INTO smarter_private.spin_archived_first_admission(tournament_id,operation_id,lease_generation,owner_instance,source_sha256,original_fee_proof)
 VALUES(t,p_operation_id,p_operation_id,owner_name,p_expected_source_sha256,funding);
 result:=public.fn_begin_tournament_launch_atomic(t,p_operation_id,(witness->'first_history'->>'created_at')::timestamptz,p_operation_id);
 IF (result->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ARCHIVED_SPIN_LAUNCH_BEGIN_REFUSED: %',result USING ERRCODE='P0404'; END IF;
 result:=public.fn_complete_tournament_launch_atomic(t,p_operation_id,p_operation_id);
 IF (result->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ARCHIVED_SPIN_LAUNCH_COMPLETE_REFUSED: %',result USING ERRCODE='P0404'; END IF;
 result:=public.fn_complete_tournament_terminal(t,winner,'places');
 IF (result->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'ARCHIVED_SPIN_TERMINAL_REFUSED: %',result USING ERRCODE='P0404'; END IF;
 RETURN result;
END $fn$;
ALTER FUNCTION public.fn_complete_first_archived_spin(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_complete_first_archived_spin(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_first_archived_spin(uuid,text) TO service_role;
ALTER FUNCTION smarter_private.spin_archived_first_immutable() OWNER TO postgres;
ALTER FUNCTION smarter_private.spin_archived_first_launch_witness(uuid,timestamptz) OWNER TO postgres;
ALTER FUNCTION smarter_private.spin_archived_first_standings(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION smarter_private.spin_archived_first_requires_terminal() OWNER TO postgres;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
 VALUES('fn_complete_first_archived_spin','approved',
  'Finite first archived Spin: real service lease, original source/funding, atomic canonical terminal')
 ON CONFLICT(proname) DO NOTHING;
DO $registry$
BEGIN
 IF (SELECT status FROM public.ca_money_rpc_registry
  WHERE proname='fn_complete_first_archived_spin') IS DISTINCT FROM 'approved' THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_REGISTRY_AUTHORITY_CHANGED' USING ERRCODE='55000';
 END IF;
 IF NOT has_function_privilege('service_role','public.fn_complete_first_archived_spin(uuid,text)','EXECUTE')
  OR has_function_privilege('anon','public.fn_complete_first_archived_spin(uuid,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_complete_first_archived_spin(uuid,text)','EXECUTE') THEN
  RAISE EXCEPTION 'ARCHIVED_SPIN_CALLER_ACL_CHANGED' USING ERRCODE='55000';
 END IF;
END $registry$;

-- Component: supabase/components/spin-archived-first-bridge.sql
-- Candidate bridge: exact-source guards; native financial qualification pending.
-- Exact installed authority captured 2026-09-27T03:20:30Z. Refuse drift before replacement.
DO $bridge_acl$
DECLARE target record; actual_owner text; actual_acl text[];
BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('public.fn_prove_played_launch_recovery(uuid,timestamp with time zone)', ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]),
  ('public.fn_settle_tournament_places(uuid,uuid)', ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]),
  ('public.fn_ca_tournament_terminal_receipt(uuid,uuid)', ARRAY['postgres=X/postgres']::text[])
 ) AS expected(signature,acl) LOOP
  SELECT pg_get_userbyid(p.proowner),ARRAY(SELECT a::text FROM unnest(coalesce(p.proacl,acldefault('f',p.proowner))) a ORDER BY a::text)
   INTO actual_owner,actual_acl FROM pg_proc p WHERE p.oid=target.signature::regprocedure;
  IF actual_owner IS DISTINCT FROM 'postgres' OR actual_acl IS DISTINCT FROM target.acl THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_BRIDGE_ACL_CHANGED: %',target.signature;
  END IF;
 END LOOP;
END;
$bridge_acl$;
DO $fee_source$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_legacy_spin_original_fee_proof(uuid)'::regprocedure)) IS DISTINCT FROM 'f5aff07c84bade11fc68e063e0998400' THEN RAISE EXCEPTION 'ARCHIVED_SPIN_PROVIDER_SOURCE_CHANGED: original fee proof'; END IF; END $fee_source$;

DO $guard$ BEGIN IF md5(pg_get_functiondef('public.fn_prove_played_launch_recovery(uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'c2fc5742cb5e6596aa7eea1f256d72e6' THEN RAISE EXCEPTION 'ARCHIVED_SPIN_PROVIDER_SOURCE_CHANGED: fn_prove_played_launch_recovery(uuid,timestamp with time zone)'; END IF; END $guard$;

CREATE OR REPLACE FUNCTION public.fn_prove_played_launch_recovery(p_tournament_id uuid, p_started_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_required int;
  v_finalized boolean;
  v_playing int;
  v_eliminated int;
  v_other int;
  v_hands bigint;
  v_first_hand timestamptz;
  v_seated int;
BEGIN
  SELECT CASE WHEN COALESCE(t.max_players, 0) > 0
              THEN GREATEST(2, LEAST(3, t.max_players))
              ELSE 3 END,
         COALESCE(t.prize_pool_finalized, false)
    INTO v_required, v_finalized
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_required IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF NOT v_finalized THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_not_finalized');
  END IF;

  SELECT count(*) FILTER (WHERE p.status = 'playing'),
         count(*) FILTER (WHERE p.status = 'eliminated'),
         count(*) FILTER (WHERE p.status NOT IN ('playing', 'eliminated'))
    INTO v_playing, v_eliminated, v_other
    FROM public.tournament_players p
   WHERE p.tournament_id = p_tournament_id;

  SELECT count(*), min(h.created_at)
    INTO v_hands, v_first_hand
    FROM public.hand_history h
    JOIN public.tables tb ON tb.id = h.table_id
   WHERE tb.tournament_id = p_tournament_id;

  IF COALESCE(v_hands, 0) = 0 THEN
    RETURN COALESCE(smarter_private.spin_archived_first_launch_witness(p_tournament_id,p_started_at),
      jsonb_build_object('ok', false, 'reason', 'no_hand_was_dealt'));
  END IF;

  IF p_started_at IS NULL OR v_first_hand IS DISTINCT FROM p_started_at THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'the_receipt_is_not_the_deal_that_happened',
      'first_hand_at', v_first_hand,
      'receipt_started_at', p_started_at
    );
  END IF;

  IF v_other <> 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'an_entrant_was_never_dealt_in',
      'pre_deal_entrants', v_other
    );
  END IF;

  IF v_playing + v_eliminated < v_required THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'the_field_that_was_dealt_is_short',
      'dealt_field', v_playing + v_eliminated,
      'required_players', v_required
    );
  END IF;

  SELECT count(*)
    INTO v_seated
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND s.left_at IS NULL;

  IF v_playing < 1 OR v_seated <> v_playing THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'the_surviving_field_is_not_seated',
      'playing', v_playing,
      'live_seats', v_seated
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'hands_dealt', v_hands,
    'first_hand_at', v_first_hand,
    'dealt_field', v_playing + v_eliminated,
    'required_players', v_required,
    'playing', v_playing,
    'eliminated', v_eliminated
  );
END;
$function$;

DO $guard$ BEGIN IF md5(pg_get_functiondef('public.fn_settle_tournament_places(uuid,uuid)'::regprocedure)) IS DISTINCT FROM 'eae9b56b7a7d8d82a3297ba793a2616f' THEN RAISE EXCEPTION 'ARCHIVED_SPIN_PROVIDER_SOURCE_CHANGED: fn_settle_tournament_places(uuid,uuid)'; END IF; END $guard$;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record;
  v_ladder jsonb;
  v_payouts jsonb := '[]'::jsonb;
  v_status text;
  v_live_count integer;
  v_field_size integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_bubble_place integer;
  v_bubble_user_id uuid;
  v_bubble_amount numeric := 0;
  v_bubble_payout_count integer := 0;
  v_bubble_paid numeric := 0;
  v_bubble_ob_count integer := 0;
  v_bubble_ob public.tournament_obligations%ROWTYPE;
  v_bubble_result jsonb;
  v_winner public.tournament_players%ROWTYPE;
  v_row record;
  v_place integer;
  v_amount numeric;
  v_user_id uuid;
  v_ob public.tournament_obligations%ROWTYPE;
  v_evidence numeric;
  v_evidence_count integer;
  v_total_expected numeric := 0;
  v_winner_amount numeric := 0;
  v_result jsonb;
  v_guarantee_result jsonb;
  v_rows integer;
  v_unwitnessed_busts integer;
  v_misplaced_busts integer;
  v_original_witness jsonb;
  v_original_standings jsonb;
BEGIN
  -- Every rolling and terminal money authority enters one transaction lane
  -- before it can own an event, obligation, bank, or recipient row.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'place settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- Canonical lock order. Re-locks inside owner-only callees are rows already
  -- owned by this transaction and therefore cannot invert a wait dependency.
  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_status := upper(COALESCE(v_t.status,''));
  IF v_status NOT IN ('RUNNING','COMPLETING','COMPLETED') THEN
    RAISE EXCEPTION 'tournament % cannot settle from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_t.variant,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite, not an ordinary cash ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id
                AND lower(COALESCE(p.source,'')) = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind = 'final_table_deal') THEN
    RAISE EXCEPTION
      'tournament % carries final-table-deal evidence; use the deal authority',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Funding the advertised guarantee is part of this settlement transaction,
  -- not a best-effort request made by the game process immediately beforehand.
  -- fn_apply_prize_guarantee re-locks the row already owned here and either
  -- debits the event-owned bank plus finalizes the pool, or raises. Prove its
  -- receipt against the refreshed row before deriving even the first place; a
  -- refusal therefore rolls back the overlay, every payout and the finish.
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_t.prize_pool USING ERRCODE = '22003';
  END IF;
  IF v_t.guaranteed_prize IS NOT NULL
     AND (v_t.guaranteed_prize::text IN ('NaN','Infinity','-Infinity')
       OR v_t.guaranteed_prize < 0
       OR v_t.guaranteed_prize IS DISTINCT FROM round(v_t.guaranteed_prize, 2)) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent guarantee %',
      p_tournament_id, v_t.guaranteed_prize USING ERRCODE = '22003';
  END IF;
  v_guarantee_result := public.fn_apply_prize_guarantee(
    p_tournament_id, 'engine.fn_settle_tournament_places');
  IF COALESCE((v_guarantee_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_guarantee_result->>'overlay')::numeric,0) > 0
         AND COALESCE(
           (v_guarantee_result->>'overlay_journaled')::boolean,false)
             IS NOT TRUE) THEN
    RAISE EXCEPTION 'tournament % guarantee funding refused: %',
      p_tournament_id, v_guarantee_result USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2)
     OR v_t.prize_pool < COALESCE(v_t.guaranteed_prize, 0)
     OR v_guarantee_result->>'prize_pool' IS NULL
     OR (v_guarantee_result->>'prize_pool')::numeric IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % guarantee funding did not produce one finalized locked pool: result %, pool %, guarantee %, finalized %',
      p_tournament_id, v_guarantee_result, v_t.prize_pool,
      v_t.guaranteed_prize, v_t.prize_pool_finalized USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id FOR UPDATE;
  SELECT count(*) INTO v_field_size
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.status::text = 'registered') THEN
    RAISE EXCEPTION 'tournament % still has a registered unresolved player',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- The helper counts the final field, so derive only after the complete
  -- roster has joined the canonical tournament -> roster lock sequence.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',a.place,'amount',a.amount) ORDER BY a.place),'[]'::jsonb)
    INTO v_ladder
    FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
  IF jsonb_array_length(v_ladder) = 0 THEN
    RAISE EXCEPTION 'tournament % derived an empty ladder', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_live_count FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'tournament % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    -- The observed last survivor may already have crossed through
    -- `eliminated` in an all-in race. The committed transition sequence, not
    -- a wall clock, proves that this row was the final elimination.
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'tournament % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
              OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'observed winner % does not match locked winner % for tournament %',
      p_observed_winner_id, v_winner.user_id, p_tournament_id
      USING ERRCODE = '40001';
  END IF;

  -- Lock the whole set once, before validation or the ascending-place walk.
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND (o.place IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = o.place))
  ) THEN
    RAISE EXCEPTION
      'tournament % has a place obligation outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  IF v_status = 'COMPLETED' THEN
    IF v_winner.status::text <> 'winner' OR v_winner.position <> 1 THEN
      RAISE EXCEPTION
        'COMPLETED tournament % is not an exact replay: winner is not durable',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  ELSE
    -- Recorded finish positions are the engine's live witness. Never rebuild
    -- an all-busted field from timestamps. Promotion may fill first place, but
    -- it cannot displace another recorded first or vacate a ladder place.
    IF EXISTS (SELECT 1 FROM public.tournament_players tp
                WHERE tp.tournament_id = p_tournament_id
                  AND tp.position = 1
                  AND tp.user_id <> v_winner.user_id) THEN
      RAISE EXCEPTION 'tournament % assigns first place to another player',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF v_winner.position IS NOT NULL AND v_winner.position <> 1
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder) a
                    WHERE (a->>'place')::integer = v_winner.position) THEN
      RAISE EXCEPTION
        'promoting winner % would vacate cash place % in tournament %',
        v_winner.user_id, v_winner.position, p_tournament_id
        USING ERRCODE = '55000';
    END IF;
    UPDATE public.tournament_players
       SET status = 'winner', position = 1,
           eliminated_at = NULL, elimination_sequence = NULL
     WHERE id = v_winner.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'tournament % could not promote exactly one winner',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    v_original_witness:=smarter_private.breakfast_standings_witness(p_tournament_id,p_observed_winner_id);
    v_original_standings:=COALESCE(smarter_private.spin_original_standings_witness(p_tournament_id,p_observed_winner_id),
      smarter_private.spin_archived_first_standings(p_tournament_id,p_observed_winner_id));
    IF v_original_witness IS NULL AND v_original_standings IS NULL THEN
    -- Final numeric positions are derived from the transition witness, not
    -- from the field size that happened to exist when each player busted.
    -- This is the root fix for late registration enlarging the field after an
    -- early elimination. Existing money evidence is never relabelled: a
    -- legacy event whose paid place would move fails closed for explicit
    -- adjudication instead of rewriting settled history.
    SELECT count(*), count(tp.elimination_sequence),
           count(DISTINCT tp.elimination_sequence)
      INTO v_eliminated_count, v_sequenced_count, v_rows
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated';
    IF v_eliminated_count <> v_field_size - 1
       OR v_sequenced_count <> v_eliminated_count
       OR v_rows <> v_eliminated_count THEN
      RAISE EXCEPTION
        'tournament % has no complete durable elimination sequence (%/% of %)',
        p_tournament_id, v_sequenced_count, v_rows, v_eliminated_count
        USING ERRCODE = 'P0404';
    END IF;

    /* A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11). Places were
       numbered in elimination_sequence order, which a trigger stamps when
       the knockout door RECORDS a bust, so a bust the door recorded hours
       late was paid a place it did not finish in. Each eliminated row is now
       ranked by when its bust happened, derived in the statement that uses
       it from what the door proved: the commit time of the accepted hand of
       the player's latest 'eliminated' knockout generation, plus one
       microsecond per earlier rank in that hand (smaller hand-start stack
       first, then user id - the rule the door stamps eliminated_at with).
       Busts in different hands are ordered by those hands' commit times.
       The hand-history prune deletes a horse-only hand's commit row after
       its retention window, and only a PENDING generation protects it; the
       generation rows themselves are never pruned, so a hand whose commit
       is gone is timed by when its first generation was captured (the
       earliest created_at of that hand's generations, written before the
       commit) - one time for the whole hand, so the same-hand stack rank
       still decides within it - never by when a bust was recorded. A row
       with no such witness keeps its eliminated_at; a row with neither is
       refused, never guessed. Equal times fall back to
       elimination_sequence, then id. elimination_sequence alone still names
       the last elimination, and so the winner, above. The same order decides
       whether anything moves, so a ladder already in true order is left
       exactly as it is. */
    WITH busts AS (
      SELECT tp.id, tp.position, tp.elimination_sequence,
             COALESCE((
               SELECT COALESCE(a.committed_at,
                               (SELECT min(g.created_at)
                                  FROM public.tournament_knockout_candidates g
                                 WHERE g.tournament_id = c.tournament_id
                                   AND g.table_id = c.table_id
                                   AND g.hand_number = c.hand_number
                                   AND g.hand_id = c.hand_id))
                      + (SELECT count(*)
                           FROM public.tournament_knockout_candidates s
                          WHERE s.tournament_id = c.tournament_id
                            AND s.table_id = c.table_id
                            AND s.hand_number = c.hand_number
                            AND s.hand_id = c.hand_id
                            AND (s.stack_before, s.eliminated_user_id)
                                < (c.stack_before, c.eliminated_user_id))::integer
                        * interval '1 microsecond'
                 FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                              k.hand_id, k.stack_before, k.eliminated_user_id
                         FROM public.tournament_knockout_candidates k
                        WHERE k.tournament_id = tp.tournament_id
                          AND k.eliminated_user_id = tp.user_id
                          AND k.state = 'eliminated'
                        ORDER BY k.hand_number DESC, k.id DESC
                        LIMIT 1) c
                 LEFT JOIN public.hand_atomic_commits a
                   ON a.table_id = c.table_id
                  AND a.hand_number = c.hand_number
                  AND a.hand_id = c.hand_id
             ), tp.eliminated_at) AS bust_at
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
    ),
    ranked AS (
      SELECT b.id, b.position, b.bust_at,
             row_number() OVER (
               ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
             )::integer + 1 AS expected_position
        FROM busts b
    )
    SELECT count(*) FILTER (WHERE ranked.bust_at IS NULL),
           count(*) FILTER (WHERE ranked.position IS DISTINCT FROM ranked.expected_position)
      INTO v_unwitnessed_busts, v_misplaced_busts
      FROM ranked;
    IF v_unwitnessed_busts > 0 THEN
      RAISE EXCEPTION
        'tournament % has % eliminated player(s) with no bust witness and no eliminated_at',
        p_tournament_id, v_unwitnessed_busts USING ERRCODE = 'P0404';
    END IF;

    IF v_misplaced_busts > 0 THEN
      IF EXISTS (
        SELECT 1 FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p."position" IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM public.tournament_obligations o
         WHERE o.tournament_id = p_tournament_id
           AND o.kind = 'place'
      ) THEN
        /* Paid places are never relabelled. A COMPLETING event whose
           places are exactly the recording-order ladder was settled by the
           rule this replaces, and is replayed as it was paid, not refused. */
        IF v_status <> 'COMPLETING' OR EXISTS (
          SELECT 1
            FROM (
              SELECT tp.position,
                     row_number() OVER (
                       ORDER BY tp.elimination_sequence DESC, tp.id ASC
                     )::integer + 1 AS expected_position
                FROM public.tournament_players tp
               WHERE tp.tournament_id = p_tournament_id
                 AND tp.status::text = 'eliminated'
            ) recorded
           WHERE recorded.position IS DISTINCT FROM recorded.expected_position
        ) THEN
          RAISE EXCEPTION
            'tournament % needs a late-entry position normalization but already carries settled place evidence',
            p_tournament_id USING ERRCODE = 'P0404';
        END IF;
      ELSE
        UPDATE public.tournament_players tp
           SET position = NULL
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated';

        WITH busts AS (
        SELECT tp.id, tp.position, tp.elimination_sequence,
               COALESCE((
                 SELECT COALESCE(a.committed_at,
                                 (SELECT min(g.created_at)
                                    FROM public.tournament_knockout_candidates g
                                   WHERE g.tournament_id = c.tournament_id
                                     AND g.table_id = c.table_id
                                     AND g.hand_number = c.hand_number
                                     AND g.hand_id = c.hand_id))
                        + (SELECT count(*)
                             FROM public.tournament_knockout_candidates s
                            WHERE s.tournament_id = c.tournament_id
                              AND s.table_id = c.table_id
                              AND s.hand_number = c.hand_number
                              AND s.hand_id = c.hand_id
                              AND (s.stack_before, s.eliminated_user_id)
                                  < (c.stack_before, c.eliminated_user_id))::integer
                          * interval '1 microsecond'
                   FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                                k.hand_id, k.stack_before, k.eliminated_user_id
                           FROM public.tournament_knockout_candidates k
                          WHERE k.tournament_id = tp.tournament_id
                            AND k.eliminated_user_id = tp.user_id
                            AND k.state = 'eliminated'
                          ORDER BY k.hand_number DESC, k.id DESC
                          LIMIT 1) c
                   LEFT JOIN public.hand_atomic_commits a
                     ON a.table_id = c.table_id
                    AND a.hand_number = c.hand_number
                    AND a.hand_id = c.hand_id
               ), tp.eliminated_at) AS bust_at
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated'
        ),
        ranked AS (
          SELECT b.id,
                 row_number() OVER (
                   ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
                 )::integer + 1 AS expected_position
            FROM busts b
        )
        UPDATE public.tournament_players tp
           SET position = ranked.expected_position
          FROM ranked
         WHERE tp.id = ranked.id;
      END IF;
    END IF;
    END IF;
  END IF;

  -- Derive the single pool-funded bubble promise after standings are final.
  -- The percentage helper has already reserved this exact amount from its
  -- ladder. Satellites never enter this authority: their bubble is paid the
  -- residual that cannot buy a full seat by the satellite settle path.
  SELECT max((a->>'place')::integer) + 1
    INTO v_bubble_place
    FROM jsonb_array_elements(v_ladder) a;
  IF COALESCE(v_t.bubble_protection, false)
     AND v_bubble_place IS NOT NULL
     AND v_bubble_place <= v_field_size THEN
    IF v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount <= 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION 'tournament % has invalid bubble buy-in %',
        p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
    END IF;
    v_bubble_amount := round(v_t.buy_in_amount, 2);
    IF v_bubble_amount > v_t.prize_pool THEN
      RAISE EXCEPTION 'tournament % bubble amount % exceeds pool %',
        p_tournament_id, v_bubble_amount, v_t.prize_pool
        USING ERRCODE = '23514';
    END IF;

    SELECT count(*), min(tp.user_id::text)::uuid
      INTO v_rows, v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_place
       AND tp.status::text = 'eliminated';
    IF v_rows <> 1 OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no single eliminated stone bubble at place %',
        p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), COALESCE(sum(p.amount), 0)
    INTO v_bubble_payout_count, v_bubble_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  SELECT count(*) INTO v_bubble_ob_count
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection';

  IF v_bubble_amount = 0 THEN
    IF v_bubble_payout_count <> 0 OR v_bubble_paid <> 0
       OR v_bubble_ob_count <> 0 THEN
      RAISE EXCEPTION 'tournament % carries bubble evidence but no bubble is due',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_bubble_paid > v_bubble_amount
       OR EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.tournament_id = p_tournament_id
            AND p.source = 'bubble_protection'
            AND (p.user_id IS DISTINCT FROM v_bubble_user_id
              OR p."position" IS NOT NULL
              OR p.amount IS NULL
              OR p.amount::text IN ('NaN','Infinity','-Infinity')
              OR p.amount <= 0
              OR p.amount IS DISTINCT FROM round(p.amount, 2)
              OR p.idempotency_key IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM public.wallet_credit_idempotency k
                 WHERE k.key = p.idempotency_key
                   AND k.user_id = p.user_id
                   AND k.amount = p.amount))) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble payout evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT * INTO v_bubble_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection'
       AND o.user_id = v_bubble_user_id;
    IF v_bubble_ob_count > 0
       AND (v_bubble_ob_count <> 1 OR v_bubble_ob.id IS NULL
         OR v_bubble_ob.place IS NOT NULL
         OR v_bubble_ob.amount_owed IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_paid
         OR v_bubble_ob.amount_paid < 0
         OR v_bubble_ob.amount_paid > v_bubble_ob.amount_owed
         OR (v_bubble_ob.amount_paid = v_bubble_ob.amount_owed) IS DISTINCT FROM
            (v_bubble_ob.settled_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble obligation evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_bubble_ob_count = 0
       AND (v_bubble_payout_count <> 0 OR v_bubble_paid <> 0) THEN
      RAISE EXCEPTION 'tournament % has bubble money without its debt record',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_status = 'COMPLETED'
       AND (v_bubble_ob_count <> 1
         OR v_bubble_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.settled_at IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id
              AND tp.user_id = v_bubble_user_id
              AND tp.position = v_bubble_place
              AND tp.prize IS NOT DISTINCT FROM v_bubble_amount)) THEN
      RAISE EXCEPTION 'COMPLETED tournament % has no exact bubble replay',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  END IF;

  -- Anything paid from the prize bank outside the derived ladder makes a full
  -- structure payout unsafe. Bounty/seat sources belong to other authorities.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND COALESCE(p.source,'') NOT IN
           ('bounty','own_bounty','mystery_bounty','mystery_bounty_residual',
            'bounty_residual','satellite_seat','bubble_protection')
       AND (p."position" IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = p."position"))
  ) THEN
    RAISE EXCEPTION 'tournament % has prize evidence outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Obligation-shaped wallet identity with no exact payout row is mixed
  -- evidence. It is checked globally before any place can move.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
      JOIN public.wallet_credit_idempotency k
        ON k.key LIKE 'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.idempotency_key = k.key
            AND p.tournament_id = p_tournament_id
            AND p.user_id = k.user_id AND p.amount = k.amount)
  ) THEN
    RAISE EXCEPTION
      'tournament % has wallet-credit identity without payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Preflight every place before settling the first one.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    v_place := v_row.place; v_amount := v_row.amount; v_user_id := v_row.user_id;
    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no finisher for cash place %',
        p_tournament_id, v_place USING ERRCODE = '23502';
    END IF;
    IF v_amount::text IN ('NaN','Infinity','-Infinity') OR v_amount < 0
       OR v_amount IS DISTINCT FROM round(v_amount,2) THEN
      RAISE EXCEPTION 'tournament % derived invalid amount % for place %',
        p_tournament_id, v_amount, v_place USING ERRCODE = '22003';
    END IF;
    v_total_expected := v_total_expected + v_amount;
    IF v_place = 1 THEN v_winner_amount := v_amount; END IF;
    IF v_status = 'COMPLETED'
       AND v_row.cached_prize IS DISTINCT FROM v_amount THEN
      RAISE EXCEPTION
        'COMPLETED tournament %, place % has stale prize cache % (expected %)',
        p_tournament_id, v_place, v_row.cached_prize, v_amount
        USING ERRCODE = '55000';
    END IF;

    -- Each payout row is also required to name an exact wallet-credit identity.
    IF EXISTS (
      SELECT 1 FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id AND p."position" = v_place
         AND (p.user_id IS DISTINCT FROM v_user_id OR p.amount IS NULL
           OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount < 0
           OR p.amount IS DISTINCT FROM round(p.amount,2)
           OR p.idempotency_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM public.wallet_credit_idempotency k
              WHERE k.key = p.idempotency_key AND k.user_id = p.user_id
                AND k.amount = p.amount))
    ) THEN
      RAISE EXCEPTION
        'tournament %, place % has mixed/malformed/wrong-recipient evidence',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*), COALESCE(sum(p.amount),0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p."position" = v_place;
    v_evidence := round(v_evidence,2);
    IF v_evidence > v_amount THEN
      RAISE EXCEPTION 'tournament %, place % records % above entitlement %',
        p_tournament_id, v_place, v_evidence, v_amount USING ERRCODE = '23514';
    END IF;

    v_ob := NULL;
    SELECT * INTO v_ob FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place' AND o.place = v_place;
    IF FOUND THEN
      IF v_ob.user_id IS DISTINCT FROM v_user_id OR v_ob.amount_owed IS NULL
         OR v_ob.amount_paid IS NULL
         OR v_ob.amount_owed::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_paid::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_owed IS DISTINCT FROM round(v_ob.amount_owed,2)
         OR v_ob.amount_paid IS DISTINCT FROM round(v_ob.amount_paid,2)
         OR v_ob.amount_owed < 0 OR v_ob.amount_paid < 0
         OR v_ob.amount_paid > v_ob.amount_owed
         OR v_ob.amount_owed > v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_evidence THEN
        RAISE EXCEPTION 'tournament %, place % has incompatible obligation',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_amount = 0 THEN
      -- Zero-valued ladder places are standings, not debts.
      IF v_evidence <> 0 OR (v_ob.id IS NOT NULL
         AND (v_ob.amount_owed <> 0 OR v_ob.amount_paid <> 0)) THEN
        RAISE EXCEPTION 'zero-value place % in tournament % carries money evidence',
          v_place, p_tournament_id USING ERRCODE = '23514';
      END IF;
    ELSIF v_status = 'COMPLETED' THEN
      IF v_ob.id IS NULL OR v_ob.amount_owed IS DISTINCT FROM v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_amount
         OR v_evidence IS DISTINCT FROM v_amount THEN
        RAISE EXCEPTION 'COMPLETED tournament %, place % is not an exact replay',
          p_tournament_id, v_place USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;

  IF round(v_total_expected + v_bubble_amount, 2)
       IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % ladder % plus bubble % does not equal locked pool %',
      p_tournament_id, v_total_expected, v_bubble_amount, v_t.prize_pool
      USING ERRCODE = '23514';
  END IF;

  IF v_status <> 'COMPLETED' THEN
    -- Materialize the bubble and the entire positive ladder before the first
    -- wallet credit. The payment walk is driven from one complete locked debt
    -- set, so failure on any recipient rolls every obligation and credit back.
    IF v_bubble_amount > 0 AND v_bubble_ob_count = 0 THEN
      INSERT INTO public.tournament_obligations
        (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
      VALUES
        (p_tournament_id,'bubble_protection',NULL,v_bubble_user_id,
         v_bubble_amount,0,'engine.fn_settle_tournament_places',NULL)
      RETURNING * INTO v_bubble_ob;
      v_bubble_ob_count := 1;
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place;

      IF v_original_witness IS NOT NULL AND EXISTS(SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id=p_tournament_id AND o.kind='place' AND o.place=v_row.place
        AND o.amount_owed=v_row.amount AND o.amount_paid=v_row.amount AND o.settled_at IS NOT NULL) THEN
        v_rows:=1; -- Preserve already-paid original obligation metadata.
      ELSE
      UPDATE public.tournament_obligations o
         SET amount_owed = v_row.amount,
             source = COALESCE(o.source, 'engine.fn_settle_tournament_places'),
             updated_at = now()
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      END IF;
      IF v_rows = 0 THEN
        INSERT INTO public.tournament_obligations
          (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
        VALUES
          (p_tournament_id,'place',v_row.place,v_row.user_id,v_row.amount,
           v_evidence,'engine.fn_settle_tournament_places',
           CASE WHEN v_evidence = v_row.amount THEN now() ELSE NULL END);
      ELSIF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament %, place % matched % obligations',
          p_tournament_id, v_row.place, v_rows USING ERRCODE = '23505';
      END IF;
    END LOOP;

    -- Re-lock/prove the complete set immediately before any raw payer runs.
    PERFORM 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind IN ('bubble_protection','place')
     ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

    IF v_bubble_amount > 0 THEN
      v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
        p_tournament_id, v_bubble_user_id, v_bubble_amount);
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      v_result := public.fn_ca_settle_tournament_place_raw(
        p_tournament_id,v_row.place,v_row.user_id,v_row.amount);
      IF COALESCE((v_result->>'fully_settled')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION 'tournament %, place % returned a partial settlement',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    -- tournament_players.prize is presentation cache, stamped only from the
    -- successfully settled DB ladder and in this same transaction.
    UPDATE public.tournament_players SET prize = 0
     WHERE tournament_id = p_tournament_id;
    FOR v_row IN SELECT (a->>'place')::integer AS place,
                         (a->>'amount')::numeric AS amount
                   FROM jsonb_array_elements(v_ladder) a
    LOOP
      UPDATE public.tournament_players SET prize = v_row.amount
       WHERE tournament_id = p_tournament_id AND position = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'could not stamp one prize cache for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    IF v_bubble_amount > 0 THEN
      UPDATE public.tournament_players
         SET prize = v_bubble_amount
       WHERE tournament_id = p_tournament_id
         AND user_id = v_bubble_user_id
         AND position = v_bubble_place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION
          'could not stamp one bubble prize cache for tournament %, place %',
          p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_status = 'RUNNING' THEN
      UPDATE public.tournaments SET status = 'COMPLETING'
       WHERE id = p_tournament_id AND status = 'RUNNING';
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament % lost its RUNNING finish claim',
          p_tournament_id USING ERRCODE = '40001';
      END IF;
      v_status := 'COMPLETING';
    END IF;
  END IF;

  IF v_bubble_amount > 0 AND v_status = 'COMPLETED' THEN
    -- Exact replay only: the completed preflight above proved this call cannot
    -- move money, while the raw helper proves every durable receipt again.
    v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
      p_tournament_id, v_bubble_user_id, v_bubble_amount);
  END IF;

  IF v_bubble_amount > 0 AND NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = v_bubble_user_id
       AND tp.position = v_bubble_place
       AND tp.prize IS NOT DISTINCT FROM v_bubble_amount
  ) THEN
    RAISE EXCEPTION
      'post-settlement bubble prize-cache proof failed for tournament %, place %',
      p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
  END IF;

  -- Prove the durable end-state and build the presentation-only receipt.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    IF v_row.cached_prize IS DISTINCT FROM v_row.amount THEN
      RAISE EXCEPTION 'post-settlement prize-cache proof failed for tournament %, place %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
    IF v_row.amount > 0 THEN
      v_ob := NULL;
      SELECT * INTO v_ob FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place AND p.user_id = v_row.user_id;
      IF v_ob.id IS NULL OR v_ob.user_id IS DISTINCT FROM v_row.user_id
         OR v_ob.amount_owed IS DISTINCT FROM v_row.amount
         OR v_ob.amount_paid IS DISTINCT FROM v_row.amount
         OR v_evidence IS DISTINCT FROM v_row.amount THEN
        RAISE EXCEPTION 'post-settlement proof failed for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END IF;
    v_payouts := v_payouts || jsonb_build_object(
      'place',v_row.place,'user_id',v_row.user_id,'amount',v_row.amount);
  END LOOP;

  v_original_witness:=smarter_private.breakfast_standings_witness(p_tournament_id,p_observed_winner_id);
  v_original_standings:=COALESCE(smarter_private.spin_original_standings_witness(p_tournament_id,p_observed_winner_id),
      smarter_private.spin_archived_first_standings(p_tournament_id,p_observed_winner_id));
  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',true,
    'status',v_status,
    'payouts',v_payouts,
    'bubble_protection',CASE WHEN v_bubble_amount > 0 THEN
      jsonb_build_object('user_id',v_bubble_user_id,'position',v_bubble_place,
                         'amount',v_bubble_amount)
      ELSE 'null'::jsonb END,
    'winner_amount',v_winner_amount) || CASE WHEN v_original_witness IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('original_witness',v_original_witness) END || CASE WHEN v_original_standings IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('original_standings',v_original_standings) END;
END;
$function$;

DO $guard$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '7e3c5da7f79762ec5197febb2f46019f' THEN RAISE EXCEPTION 'ARCHIVED_SPIN_PROVIDER_SOURCE_CHANGED: terminal receipt'; END IF; END $guard$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_terminal_receipt(p_tournament_id uuid, p_observed_winner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;v_custody boolean:=false;v_resolved boolean:=false;v_original_witness jsonb;v_spin_witness jsonb;v_spin_original jsonb;
  v_h public.tournament_terminal_settlements%ROWTYPE;
  v_t record;
  v_e public.tournament_escrow%ROWTYPE;
  v_r record;
  v_cash_count integer;
  v_cash_total numeric(15,2);
  v_cash_obligation_total numeric(15,2);
  v_bounty_total numeric(15,2);
  v_rake_total numeric(15,2);
  v_roster_count integer;
  v_winner_count integer;
  v_raw_winner_id uuid;
  v_raw_winner_amount numeric(15,2);
  v_bubble jsonb;
  v_durable_payouts jsonb;
  v_durable_deal_shares jsonb;
  v_durable_bubble jsonb;
  v_durable_table_ids uuid[];
  v_durable_table_count integer;
  v_durable_seat_ids uuid[];
  v_durable_seat_count integer;
  v_durable_released_count integer;
  v_mystery_evidence jsonb;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal receipt requires a tournament id'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_terminal_settlements h
   WHERE h.tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable terminal receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_accounting:=CASE WHEN v_h.accounting_state='fee_custody_unresolved' THEN public.fn_ca_tournament_fee_custody_receipt(p_tournament_id) ELSE public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id) END;
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  v_custody:=v_h.accounting_state='fee_custody_unresolved';
  v_resolved:=v_custody AND COALESCE((v_accounting->>'accounting_complete')::boolean,false);
  IF v_h.accounting_state IS DISTINCT FROM COALESCE(v_accounting->>'status','legacy')
     OR (v_accounting IS NOT NULL AND v_h.receipt_version<>CASE WHEN v_custody THEN 3 ELSE 2 END) THEN
    RAISE EXCEPTION 'terminal accounting state has no exact durable receipt' USING ERRCODE='P0404';
  END IF;
  IF p_observed_winner_id IS NOT NULL
     AND v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'tournament % receipt winner % differs from observed winner %',
      p_tournament_id, v_h.winner_id, p_observed_winner_id
      USING ERRCODE = '40001';
  END IF;

  SELECT t.id,t.status,t.variant,t.tournament_type,t.satellite_target_id,
         t.satellite_target,t.prize_pool,t.bounty_pool,t.bounty_pool_paid,
         t.is_bounty,t.is_pko,t.is_mystery_bounty,t.mystery_bounty_stage,
         t.mystery_bounty_pool_cents,t.club_id,t.ended_at,t.on_break,
         t.break_started_at,t.break_ends_at
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_t.id IS NULL THEN
    RAISE EXCEPTION 'terminal receipt lost tournament %', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;
  IF lower(COALESCE(v_t.variant::text, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'terminal receipt % belongs to a satellite', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_t.status::text, '')) <> 'COMPLETED'
     OR v_t.ended_at IS DISTINCT FROM v_h.completed_at
     OR COALESCE(v_t.on_break, false)
     OR v_t.break_started_at IS NOT NULL
     OR v_t.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is not durably closed by its receipt',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Every mutable child carries the same tuple-owned close fact. This makes a
  -- replay prove the synchronous marker transition itself, while queued
  -- writers can reject from OLD after a row-lock wait without relying on a
  -- pre-wait statement snapshot of the parent or receipt.
  IF EXISTS (SELECT 1 FROM public.tournament_players x
              WHERE x.tournament_id=p_tournament_id
                AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.rake_records x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=p_tournament_id
          AND s.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions x
                 WHERE x.related_entity_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_award_recipients r
       JOIN public.tournament_bounty_awards a ON a.id=r.award_id
        WHERE a.tournament_id=p_tournament_id
          AND r.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_escrow x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.kind NOT IN ('contribution','jackpot_draw')
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at) THEN
    RAISE EXCEPTION 'tournament % mutable evidence lacks its exact terminal marker',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Table closure is money-adjacent terminal state, not an asynchronous UI
  -- cleanup. The immutable identities prove that no tournament table vanished,
  -- appeared or reopened after this receipt and that every seat released by
  -- the terminal transaction still has its exact terminal state.
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[]),count(*)
    INTO v_durable_table_ids,v_durable_table_count
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[]),count(*)
    INTO v_durable_seat_ids,v_durable_seat_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_durable_released_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND s.id = ANY(v_h.released_seat_ids)
     AND s.left_at IS NOT DISTINCT FROM v_h.completed_at
     AND COALESCE(s.status,'') = 'left'
     AND COALESCE(s.leave_pending,false) IS FALSE
     AND COALESCE(s.is_sitting_out,false) IS FALSE;
  IF v_durable_table_ids IS DISTINCT FROM v_h.closed_table_ids
     OR v_durable_table_count IS DISTINCT FROM v_h.closed_table_count
     OR v_durable_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR v_durable_seat_count IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text,'')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle,'')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.completed_at))
     OR EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id = s.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (s.left_at IS NULL
            OR s.status IS DISTINCT FROM 'left'
            OR s.terminal_closed_at IS DISTINCT FROM v_h.completed_at
            OR s.leave_pending IS DISTINCT FROM false
            OR s.is_sitting_out IS DISTINCT FROM false
            OR s.is_away IS DISTINCT FROM false
            OR s.sit_out_at IS NOT NULL
            OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'tournament % table or seat closure differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_t.prize_pool,2) IS DISTINCT FROM v_h.prize_pool
     OR v_t.bounty_pool IS NULL
     OR v_t.bounty_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_t.bounty_pool,2) IS DISTINCT FROM v_h.bounty_pool THEN
    RAISE EXCEPTION 'tournament % pools differ from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE tp.status::text = 'winner'
                            AND tp.position = 1)
    INTO v_roster_count,v_winner_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_roster_count < 1 OR v_winner_count <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_h.winner_id
          AND tp.status::text = 'winner' AND tp.position = 1
          AND tp.eliminated_at IS NULL
          AND tp.elimination_sequence IS NULL)
     OR (SELECT count(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR (SELECT count(DISTINCT tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR (SELECT min(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> 1
     OR (SELECT max(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.status::text NOT IN ('winner','eliminated')) THEN
    RAISE EXCEPTION 'tournament % has ambiguous or incomplete final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF jsonb_typeof(v_h.cash_receipt->'payouts') <> 'array'
     OR COALESCE((v_h.cash_receipt->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_h.cash_receipt->>'fully_settled')::boolean,false) IS NOT TRUE
     OR upper(COALESCE(v_h.cash_receipt->>'status','')) <> 'COMPLETING'
     OR v_h.cash_receipt->>'winner_amount' IS NULL
     OR (v_h.cash_receipt->>'winner_amount')::numeric < 0
     OR (v_h.cash_receipt->>'winner_amount')::numeric IS DISTINCT FROM
          round((v_h.cash_receipt->>'winner_amount')::numeric,2)
     OR (v_h.settlement_mode = 'final_table_deal'
         AND v_h.cash_receipt->>'money_path'
               IS DISTINCT FROM 'fn_settle_tournament_final_table_deal') THEN
    RAISE EXCEPTION 'tournament % stored a malformed cash authority receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF to_regprocedure('smarter_private.breakfast_standings_witness(uuid,uuid)') IS NOT NULL THEN
    EXECUTE 'SELECT smarter_private.breakfast_standings_witness($1,$2)' INTO v_original_witness USING p_tournament_id,v_h.winner_id;
  END IF;
  IF NULLIF(v_h.cash_receipt->'original_witness','null'::jsonb) IS DISTINCT FROM NULLIF(v_original_witness,'null'::jsonb) THEN
    RAISE EXCEPTION 'terminal cash original witness disagrees with immutable standings' USING ERRCODE='P0404';
  END IF;
  v_spin_original:=public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id);
  IF to_regprocedure('smarter_private.spin_original_standings_witness(uuid,uuid)') IS NOT NULL THEN
    EXECUTE 'SELECT COALESCE(smarter_private.spin_original_standings_witness($1,$2),smarter_private.spin_archived_first_standings($1,$2))' INTO v_spin_witness USING p_tournament_id,v_h.winner_id;
  END IF;
  IF (v_spin_original IS NOT NULL AND jsonb_typeof(v_spin_witness) IS DISTINCT FROM 'object')
    OR NULLIF(v_h.cash_receipt->'original_standings','null'::jsonb) IS DISTINCT FROM NULLIF(v_spin_witness,'null'::jsonb) THEN
    RAISE EXCEPTION 'terminal cash original Spin standings disagree with immutable authority' USING ERRCODE='P0404';
  END IF;
  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric
    INTO v_raw_winner_id,v_raw_winner_amount
    FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p
   WHERE (p->>'place')::integer = 1;
  IF v_raw_winner_id IS DISTINCT FROM v_h.winner_id
     OR v_raw_winner_amount IS DISTINCT FROM
          (v_h.cash_receipt->>'winner_amount')::numeric
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p
        WHERE p->>'place' IS NULL OR p->>'user_id' IS NULL
           OR p->>'amount' IS NULL
           OR (p->>'place')::integer < 1
           OR (p->>'amount')::numeric < 0
           OR (p->>'amount')::numeric IS DISTINCT FROM
                round((p->>'amount')::numeric,2)
           OR NOT EXISTS (
             SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.position = (p->>'place')::integer
                AND tp.user_id = (p->>'user_id')::uuid))
     OR (SELECT count(*) FROM jsonb_array_elements(v_h.cash_receipt->'payouts')) < 1
     OR (SELECT count(DISTINCT (p->>'place')::integer)
           FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p)
          <> (SELECT count(*) FROM jsonb_array_elements(v_h.cash_receipt->'payouts')) THEN
    RAISE EXCEPTION 'tournament % cash receipt does not name exact finishers',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Satellite and bounty records never consume the ordinary prize pool.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source IN ('satellite_seat','satellite_ticket','satellite_remainder')
  ) THEN
    RAISE EXCEPTION 'non-satellite tournament % carries satellite payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*),round(COALESCE(sum(p.amount),0),2)
    INTO v_cash_count,v_cash_total
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_count IS DISTINCT FROM v_h.cash_payout_count
     OR v_cash_total IS DISTINCT FROM v_h.cash_payout_total
     OR v_cash_total IS DISTINCT FROM v_h.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source NOT IN (
            'bounty','bounty_residual','own_bounty','mystery_bounty',
            'mystery_bounty_residual','satellite_seat','satellite_ticket',
            'satellite_remainder')
          AND (p.amount IS NULL
            OR p.amount::text IN ('NaN','Infinity','-Infinity')
            OR p.amount <= 0 OR p.amount IS DISTINCT FROM round(p.amount,2)
            OR p.idempotency_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % cash payout evidence is incomplete or malformed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_durable_payouts
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source <> 'bubble_protection'
         AND p.source NOT IN (
           'bounty','bounty_residual','own_bounty','mystery_bounty',
           'mystery_bounty_residual','satellite_seat','satellite_ticket',
           'satellite_remainder')
       GROUP BY tp.position,p.user_id
    ) q;
  IF v_h.prize_pool = 0 AND v_durable_payouts = '[]'::jsonb THEN
    -- A zero-cash event has a real winner and no wallet/payout mutation. Keep
    -- that explicit standings line in the receipt without inventing durable
    -- payment evidence.
    v_durable_payouts := jsonb_build_array(jsonb_build_object(
      'place',1,'user_id',v_h.winner_id,'amount',0));
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_durable_deal_shares
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'final_table_deal'
       GROUP BY tp.position,p.user_id
    ) q;
  -- Match the terminal writer's one-recipient receipt across every verified
  -- partial credit interval. The exact credit-key and total checks still apply.
  IF (SELECT count(DISTINCT p.user_id) FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'bubble_protection') > 1 THEN
    RAISE EXCEPTION 'tournament % has multiple durable bubble payout recipients',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT jsonb_build_object(
           'user_id',p.user_id,'position',tp.position,'amount',round(sum(p.amount),2))
    INTO v_durable_bubble
    FROM public.tournament_payouts p
    JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection'
   GROUP BY p.user_id,tp.position;
  v_durable_bubble := COALESCE(v_durable_bubble,'null'::jsonb);
  IF v_h.cash_receipt->'payouts' IS DISTINCT FROM v_durable_payouts
     OR jsonb_typeof(v_h.cash_receipt->'deal_shares') <> 'array'
     OR v_h.cash_receipt->'deal_shares' IS DISTINCT FROM
          (CASE WHEN v_h.settlement_mode = 'final_table_deal'
                THEN v_durable_deal_shares ELSE '[]'::jsonb END)
     OR COALESCE(v_h.cash_receipt->'bubble_protection','null'::jsonb)
          IS DISTINCT FROM v_durable_bubble
     OR ((SELECT round(COALESCE(sum((p->>'amount')::numeric),0),2)
            FROM jsonb_array_elements(v_durable_payouts) p)
         + (CASE WHEN v_durable_bubble = 'null'::jsonb THEN 0
                 ELSE (v_durable_bubble->>'amount')::numeric END))
          IS DISTINCT FROM v_h.cash_payout_total THEN
    RAISE EXCEPTION
      'tournament % stored cash lines differ from complete durable payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(o.amount_paid),0),2)
    INTO v_cash_obligation_total
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind IN ('place','bubble_protection','final_table_deal');
  IF v_cash_obligation_total IS DISTINCT FROM v_h.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id
          AND (o.amount_owed IS NULL OR o.amount_paid IS NULL
            OR o.amount_owed::text IN ('NaN','Infinity','-Infinity')
            OR o.amount_paid::text IN ('NaN','Infinity','-Infinity')
            OR o.amount_owed < 0 OR o.amount_paid < 0
            OR o.amount_owed IS DISTINCT FROM round(o.amount_owed,2)
            OR o.amount_paid IS DISTINCT FROM round(o.amount_paid,2)
            OR o.amount_paid IS DISTINCT FROM o.amount_owed
            OR o.settled_at IS NULL)) THEN
    RAISE EXCEPTION 'tournament % has incomplete or malformed obligations',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(w.amount),0),2)
    INTO v_bounty_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id AND lower(w.category) = 'bounty';
  -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    SELECT e.bounty_out INTO v_bounty_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF v_bounty_total IS DISTINCT FROM v_h.bounty_payout_total
     OR v_bounty_total IS DISTINCT FROM v_h.bounty_pool
     OR EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.related_entity_id = p_tournament_id
          AND lower(w.category) = 'bounty'
          AND (lower(w.type) <> 'credit' OR w.amount <= 0
            OR w.amount::text IN ('NaN','Infinity','-Infinity')
            OR w.amount IS DISTINCT FROM round(w.amount,2)))
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_h.bounty_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'tournament % bounty pool is underfunded, overfunded or still open',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.bounty_pool > 0 THEN
    IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false))
       OR COALESCE((v_h.bounty_receipt->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.bounty_receipt->>'funded')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'tournament % bounty receipt is not a funded close',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
        OR COALESCE(v_t.is_mystery_bounty,false)
        OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                    WHERE o.tournament_id = p_tournament_id
                      AND o.kind IN ('bounty','bounty_residual','mystery_bounty'))
        OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                    WHERE c.tournament_id = p_tournament_id)
        OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                    WHERE a.tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'ordinary tournament % carries unfunded bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.mystery_was_active THEN
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_h.winner_id);
    IF COALESCE(v_t.is_mystery_bounty,false) IS NOT TRUE
       OR v_t.mystery_bounty_stage IS DISTINCT FROM 'complete'
       OR COALESCE(v_t.mystery_bounty_pool_cents,0)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR COALESCE((v_h.mystery_receipt->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.mystery_receipt->>'balanced')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.mystery_receipt->>'pool_cents')::bigint,-1)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR COALESCE((v_h.mystery_receipt->>'settled_cents')::bigint,-1)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR (SELECT COALESCE(sum(c.amount_cents),0)
             FROM public.tournament_bounty_chests c
            WHERE c.tournament_id = p_tournament_id)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR v_h.mystery_receipt->'payment_evidence'
            IS DISTINCT FROM v_mystery_evidence
       OR COALESCE((v_h.mystery_receipt->>'residual_paid_cents')::bigint,-1)
            IS DISTINCT FROM
              COALESCE((v_mystery_evidence->>'void_chest_cents')::bigint,0)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id
                     AND c.status NOT IN ('paid','void'))
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id
                     AND a.status NOT IN ('completed','void'))
       OR EXISTS (
         SELECT 1 FROM public.tournament_bounty_awards a
          WHERE a.tournament_id = p_tournament_id
            AND ((a.status = 'completed' AND (
                  a.paid_at IS NULL OR
                  (SELECT COALESCE(sum(r.amount_cents),0)
                     FROM public.tournament_bounty_award_recipients r
                    WHERE r.award_id = a.id) <> a.amount_cents OR
                  EXISTS (SELECT 1
                            FROM public.tournament_bounty_award_recipients r
                           WHERE r.award_id = a.id
                             AND r.amount_cents > 0 AND r.paid_at IS NULL)))
              OR (a.status = 'void' AND EXISTS (
                  SELECT 1 FROM public.tournament_bounty_award_recipients r
                   WHERE r.award_id = a.id AND r.paid_at IS NOT NULL)))) THEN
      RAISE EXCEPTION 'tournament % has open or inconsistent mystery bounty evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_h.mystery_pool_cents <> 0
       OR COALESCE(v_h.mystery_receipt->>'reason','')
            NOT IN ('never_activated','not_a_mystery_tournament')
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id) THEN
      RAISE EXCEPTION 'tournament % stored an invalid non-active mystery close',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM (CASE WHEN v_custody AND NOT v_resolved THEN v_h.rake_amount ELSE 0::numeric END)
     OR v_e.closed_at IS DISTINCT FROM v_h.escrow_closed_at
     OR v_e.close_note IS DISTINCT FROM v_h.escrow_close_note THEN
    RAISE EXCEPTION 'tournament % escrow is not an exact durable zero close',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    -- DIAMOND PHASE 8: a Diamond event's fee is its fee bank, settled to the house.
    SELECT e.fee_balance + e.fee_out INTO v_rake_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF v_custody THEN
    IF v_accounting->>'status' IS DISTINCT FROM 'fee_custody_unresolved'
      OR (v_accounting->>'held_amount')::numeric IS DISTINCT FROM v_h.rake_amount
      OR v_h.rake_amount IS DISTINCT FROM v_rake_total
      OR v_h.rake_destination IS DISTINCT FROM 'tournament_escrow'
      OR v_h.rake_settled_at IS NOT NULL OR v_h.rake_attributed_at IS NOT NULL
      OR v_h.rake_attributed_users IS DISTINCT FROM 0 OR v_h.escrow_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'terminal unresolved fee proof disagrees with original custody' USING ERRCODE='P0404';
    END IF;
  ELSE
  SELECT rs.* INTO v_r FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF v_r.tournament_id IS NULL
     OR v_r.amount IS DISTINCT FROM v_rake_total
     OR v_r.amount IS DISTINCT FROM v_h.rake_amount
     OR v_r.destination IS DISTINCT FROM v_h.rake_destination
     OR v_r.settled_at IS DISTINCT FROM v_h.rake_settled_at
     OR v_r.attributed_at IS DISTINCT FROM v_h.rake_attributed_at
     OR v_r.attributed_users IS DISTINCT FROM v_h.rake_attributed_users
     OR v_r.attributed_users IS NULL OR v_r.attributed_users < 0
     OR (v_r.attribution_error IS NOT NULL AND NOT v_deferred)
     OR lower(v_r.destination) IN ('pending','')
     OR (v_r.amount > 0 AND v_t.club_id IS NOT NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id) AND NOT v_deferred
         AND (v_r.attributed_users < 1
           OR v_r.destination NOT LIKE 'union:%'
              AND v_r.destination NOT LIKE 'chip_retirement:%'
              AND NOT (v_h.receipt_version=1 AND v_h.accounting_state='legacy'
                       AND v_r.destination LIKE 'club_treasury:%'))) THEN
    RAISE EXCEPTION 'tournament % rake is not durably and successfully attributed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  END IF;

  v_bubble := CASE WHEN v_h.cash_receipt ? 'bubble_protection'
                    THEN v_h.cash_receipt->'bubble_protection'
                   ELSE 'null'::jsonb END;

  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',NOT v_custody OR v_resolved,
    'player_result','final',
    'accounting_complete',(NOT v_custody AND NOT v_deferred) OR v_resolved,
    'accounting_state',CASE WHEN v_resolved THEN 'recognized' ELSE v_h.accounting_state END,
    'status','COMPLETED',
    'tournament_id',v_h.tournament_id,
    'winner_id',v_h.winner_id,
    'mode',v_h.settlement_mode,
    'settlement_mode',v_h.settlement_mode,
    'payouts',v_h.cash_receipt->'payouts',
    'deal_shares',v_h.cash_receipt->'deal_shares',
    'winner_amount',(v_h.cash_receipt->>'winner_amount')::numeric,
    'bubble_protection',v_bubble,
    'cash',v_h.cash_receipt,
    'mystery_bounty',v_h.mystery_receipt,
    'bounty',v_h.bounty_receipt,
    'closed_table_count',v_h.closed_table_count,
    'source_seat_count',v_h.source_seat_count,
    'released_seat_count',v_h.released_seat_count,
    'table_closure',jsonb_build_object(
      'closed_table_count',v_h.closed_table_count,
      'closed_table_ids',to_jsonb(v_h.closed_table_ids),
      'source_seat_count',v_h.source_seat_count,
      'source_seat_ids',to_jsonb(v_h.source_seat_ids),
      'released_seat_count',v_h.released_seat_count,
      'released_seat_ids',to_jsonb(v_h.released_seat_ids)),
    'rake',jsonb_build_object(
      'amount',v_h.rake_amount,
      'destination',v_h.rake_destination,
      'attributed',NOT (v_deferred OR v_custody),
      'accounting',v_accounting,
      'attributed_users',v_h.rake_attributed_users,
      'settled_at',v_h.rake_settled_at,
      'attributed_at',v_h.rake_attributed_at),
    'escrow',jsonb_build_object(
      'prize_balance',v_e.prize_balance,
      'bounty_balance',v_e.bounty_balance,
      'fee_balance',v_e.fee_balance,
      'closed_at',v_h.escrow_closed_at,
      'close_note',v_h.escrow_close_note),
    'cash_payout_total',v_h.cash_payout_total,
    'bounty_payout_total',v_h.bounty_payout_total,
    'receipt_version',v_h.receipt_version,
    'settled_at',v_h.settled_at);
END;
$function$;

-- CREATE OR REPLACE retains ACLs; explicitly preserve the observed authority
-- so the maintained installation and its security checks describe the same grants.
REVOKE ALL ON FUNCTION public.fn_prove_played_launch_recovery(uuid,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_prove_played_launch_recovery(uuid,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_terminal_receipt(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
DO $bridge_acl$
DECLARE target record; actual_owner text; actual_acl text[];
BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('public.fn_prove_played_launch_recovery(uuid,timestamp with time zone)', ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]),
  ('public.fn_settle_tournament_places(uuid,uuid)', ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]),
  ('public.fn_ca_tournament_terminal_receipt(uuid,uuid)', ARRAY['postgres=X/postgres']::text[])
 ) AS expected(signature,acl) LOOP
  SELECT pg_get_userbyid(p.proowner),ARRAY(SELECT a::text FROM unnest(coalesce(p.proacl,acldefault('f',p.proowner))) a ORDER BY a::text)
   INTO actual_owner,actual_acl FROM pg_proc p WHERE p.oid=target.signature::regprocedure;
  IF actual_owner IS DISTINCT FROM 'postgres' OR actual_acl IS DISTINCT FROM target.acl THEN
   RAISE EXCEPTION 'ARCHIVED_SPIN_BRIDGE_ACL_CHANGED: %',target.signature;
  END IF;
 END LOOP;
END;
$bridge_acl$;

COMMIT;
