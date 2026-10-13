CREATE OR REPLACE FUNCTION fixture_diamond_scene(p_swap boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $scene$
DECLARE a constant uuid:='002c2d27-9584-4e52-835a-bb2be148fc81';
 u constant uuid:='11111111-1111-4111-8111-111111111111';
 v constant uuid:='22222222-2222-4222-8222-222222222222';
 g constant uuid:='33333333-3333-4333-8333-333333333333';
 t1 constant uuid:='44444444-4444-4444-8444-444444444444';
 t2 constant uuid:='55555555-5555-4555-8555-555555555555';
 m1 constant uuid:='66666666-6666-4666-8666-666666666666';
 m2 constant uuid:='77777777-7777-4777-8777-777777777777';
 s table_seats%ROWTYPE; projection jsonb;
BEGIN
 TRUNCATE cash_seat_move_receipts,cash_seat_moves,cash_cluster_events,cash_game_roster,
   cash_player_session,cash_games,poker_diamond_custody,table_seats,tables,clubs,profiles,
   ca_arena_settings,diamond_purchase_lots,diamond_debts,table_waitlist,cash_game_waitlist,cash_rejoin_constraints;
 INSERT INTO clubs(id,name,asset,is_platform,union_id) VALUES(a,'Diamond Fixture','diamonds',true,NULL);
 INSERT INTO ca_arena_settings(id,club_id,cash_games_enabled,settlement_window_days) VALUES(1,a,true,7);
 INSERT INTO profiles(id,diamonds) VALUES(u,1000),(v,1000);
 INSERT INTO tables(id,name,club_id,union_id,cluster_id,tournament_id,game_variant,status,
   small_blind,big_blind,min_buy_in,max_buy_in,max_players,role,main_index,lifecycle,
   rake_percent,rake_cap_bb,bbj_percent,run_it_twice,allow_run_it_twice,run_it_twice_enabled,
   bomb_pot_enabled,insurance_enabled,nit_game,seven_deuce_enabled,ante)
 VALUES(t1,'Diamond Main',a,NULL,g,NULL,'nlh','running',1,2,20,200,6,'main',1,'live',
   0,0,0,false,false,false,false,false,false,false,0),
   (t2,'Diamond Feeder',a,NULL,g,NULL,'nlh','running',1,2,20,200,6,'feeder',NULL,'live',
   0,0,0,false,false,false,false,false,false,false,0);
 SELECT jsonb_object_agg(k,to_jsonb(t)->k) INTO projection FROM tables t,unnest(ARRAY['min_buy_in','max_buy_in','rake_percent','rake_cap_bb','bbj_percent','insurance_enabled','seven_deuce_enabled','nit_game','all_in_or_fold','pineapple_holdem','cap_enabled','run_it_twice','allow_run_it_twice','run_it_twice_enabled','run_it_mode','straddle_enabled','auto_utg_straddle','voluntary_straddle','ante','ante_enabled','big_blind_ante_enabled','bomb_pot_enabled','bomb_pot_variant','bomb_pot_ante_fixed','bomb_pot_ante_multiplier','bomb_pot_board_count','bomb_pot_double_board','bomb_pot_trigger_mode','bomb_pot_frequency','bomb_pot_interval_seconds','action_time_seconds']) k WHERE t.id=t1;
 INSERT INTO cash_games(id,club_id,name,template_name,variant,sb,bb,handedness,
   ruleset_snapshot,must_move,lightning_enabled,cluster_mode)
 VALUES(g,a,'Diamond Main','classic','nlh',1,2,6,
   fn_cash_template_defaults('classic','nlh')||jsonb_build_object('asset','diamonds','diamond_table',projection),
   true,false,'must_move');
 INSERT INTO table_seats(table_id,seat_number,user_id,club_id,stack,joined_at)
 VALUES(t1,1,u,a,100,'2026-10-01') RETURNING * INTO s;
 INSERT INTO poker_diamond_custody(user_id,arena_id,purpose,target_id,entry_key,balance,state,
   seat_id,seat_joined_at,occupancy_id,created_at)
 VALUES(u,a,'cash_seat',t1,'original-entry',100,'active',s.id,s.joined_at,s.occupancy_id,'2026-10-01');
 INSERT INTO cash_seat_moves(id,game_id,player_id,from_table_id,to_table_id,reason,
   expires_at,source_occupancy_id,source_seat_number,swap_move_id,ready_at)
 VALUES(m1,g,u,t1,t2,CASE WHEN p_swap THEN 'seat_change' ELSE 'must_move' END,
   now()+interval '5 minutes',s.occupancy_id,1,CASE WHEN p_swap THEN m2 END,now());
 IF p_swap THEN
  INSERT INTO table_seats(table_id,seat_number,user_id,club_id,stack,joined_at,is_sitting_out,sit_out_at)
  VALUES(t2,2,v,a,70,'2026-10-02',true,'2026-10-02') RETURNING * INTO s;
  INSERT INTO poker_diamond_custody(user_id,arena_id,purpose,target_id,entry_key,balance,state,
    seat_id,seat_joined_at,occupancy_id,created_at)
  VALUES(v,a,'cash_seat',t2,'partner-entry',70,'active',s.id,s.joined_at,s.occupancy_id,'2026-10-02');
  INSERT INTO cash_seat_moves(id,game_id,player_id,from_table_id,to_table_id,reason,
    expires_at,source_occupancy_id,source_seat_number,swap_move_id,ready_at)
  VALUES(m2,g,v,t2,t1,'seat_change',now()+interval '5 minutes',s.occupancy_id,2,m1,now());
 END IF;
END;
$scene$;
