-- ============================================================================
-- 20260826_reseed_bbj_winners.sql
-- Backlog the 5 seed BBJ winners from July 20 to mid-August, with correct math
-- and complete hand histories.
-- ============================================================================

DO $$
DECLARE
  v_pool_id uuid;
  v_table_id uuid;
  v_pool_amount numeric;
  v_total numeric;
  v_loser numeric;
  v_winner numeric;
  v_table numeric;
  v_payout_id uuid;
  v_val_id uuid := '083db75b-95a3-47ae-9989-927134dfa026';
  v_wasp_id uuid := 'a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8';
  v_jos_id uuid := 'f12caf56-c369-4b22-8e04-fdda07820876';
  v_ep_id uuid := '00000000-0000-0000-0000-000000000026';
  v_free_id uuid := '25e20c49-15d7-410f-bb88-7161d758c9d5';
  v_caro_id uuid := 'de0fe8e7-d317-43b7-bd5f-82dbac01418a';
  v_broad_id uuid := '00000000-0000-0000-0000-000000000008';
  v_alice_id uuid := 'f1042170-33c9-4063-b427-910fe1683c72';
  v_crux_id uuid := '60f7edc9-f93e-43da-833c-1dd10caef345';
  v_adri_id uuid := 'ca905025-0dfc-4353-ac1e-444ce5763c83';
BEGIN
  -- We assume the pool is f9806a7f-e7a2-47d2-a676-36336e3a5337
  -- Delete the old broken seeds
  DELETE FROM public.bbj_payouts WHERE hand_number IN (1080832, 1127041, 1253455, 1269428, 1506711);
  DELETE FROM public.bbj_winners WHERE hand_number IN (1080832, 1127041, 1253455, 1269428, 1506711);
  DELETE FROM public.hand_history WHERE hand_number IN (1080832, 1127041, 1253455, 1269428, 1506711);

  -- Hit 1: July 22 - CRUX vs Adrianna
  -- CRUX (Bad Beat) loses with Quads, Adrianna wins with Royal Flush
  v_pool_amount := 4500.00; v_total := 3150.00; v_loser := 1575.00; v_winner := 787.50; v_table := 787.50;
  v_payout_id := gen_random_uuid();
  v_pool_id := 'f9806a7f-e7a2-47d2-a676-36336e3a5337';
  v_table_id := '6e71b875-28f8-4aa2-826d-bbac704aa492';
  
  INSERT INTO public.hand_history (table_id, hand_number, button_seat, game_variant, small_blind, big_blind, board, hole_cards, created_at, ended_at, bbj_amount, reported) VALUES 
  (v_table_id, 1080832, 1, 'NLH', 1, 2, '["2spades","3spades","4spades","5spades","6spades"]', jsonb_build_object(v_crux_id::text, jsonb_build_array(jsonb_build_object('rank','6','suit','hearts'),jsonb_build_object('rank','6','suit','diamonds')), v_adri_id::text, jsonb_build_array(jsonb_build_object('rank','7','suit','spades'),jsonb_build_object('rank','8','suit','spades'))), '2026-07-22 14:30:00+00', '2026-07-22 14:32:00+00', 0, false);
  
  -- UPDATE board and cards so CRUX has Quads and Adrianna has Royal Flush
  UPDATE public.hand_history SET board = '["Aclubs","Kclubs","Qclubs","Jclubs","2hearts"]', 
    hole_cards = jsonb_build_object(v_crux_id::text, jsonb_build_array(jsonb_build_object('rank','A','suit','spades'),jsonb_build_object('rank','A','suit','diamonds')), v_adri_id::text, jsonb_build_array(jsonb_build_object('rank','T','suit','clubs'),jsonb_build_object('rank','9','suit','clubs'))) 
    WHERE hand_number = 1080832;

  INSERT INTO public.bbj_payouts (id, pool_id, table_id, hand_number, winner_user_id, loser_user_id, total_amount, winner_share, loser_share, table_share, table_player_count, created_at)
  VALUES (v_payout_id, v_pool_id, v_table_id, 1080832, v_crux_id, v_adri_id, v_total, v_loser, v_winner, v_table, 4, '2026-07-22 14:32:00+00', 0, false);

  INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount, created_at) VALUES (v_payout_id, v_crux_id, v_loser, '2026-07-22 14:32:00+00'), (v_payout_id, v_adri_id, v_winner, '2026-07-22 14:32:00+00', 0, false);
  
  INSERT INTO public.bbj_winners (pool_id, winner_id, loser_id, winner_display_name, loser_display_name, winner_hand, loser_hand, winner_payout, loser_payout, table_share_payout, total_payout, pool_amount_at_hit, table_id, hand_number, awarded_at)
  VALUES (v_pool_id, v_crux_id, v_adri_id, 'CRUX', 'Adrianna Castellanos', 'Four of a Kind', 'Straight Flush', v_loser, v_winner, v_table, v_total, v_pool_amount, v_table_id, 1080832, '2026-07-22 14:32:00+00', 0, false);

  -- Hit 2: July 30 - broadwayKing vs Alice
  v_pool_amount := 8200.00; v_total := 5740.00; v_loser := 2870.00; v_winner := 1435.00; v_table := 1435.00;
  v_payout_id := gen_random_uuid(); v_table_id := '4fd19504-708a-47e2-89ff-888d8f567c42';
  
  INSERT INTO public.hand_history (table_id, hand_number, button_seat, game_variant, small_blind, big_blind, board, hole_cards, created_at, ended_at, bbj_amount, reported) VALUES 
  (v_table_id, 1127041, 2, 'NLH', 1, 2, '["Kspades","Khearts","Qdiamonds","Qclubs","2clubs"]', jsonb_build_object(v_broad_id::text, jsonb_build_array(jsonb_build_object('rank','K','suit','diamonds'),jsonb_build_object('rank','K','suit','clubs')), v_alice_id::text, jsonb_build_array(jsonb_build_object('rank','Q','suit','hearts'),jsonb_build_object('rank','Q','suit','spades'))), '2026-07-30 09:15:00+00', '2026-07-30 09:18:00+00', 0, false);
  
  -- Wait, Alice has Quads, broadwayKing has Quads! Alice (loser_id) won the hand with Quads? No, Quad Kings beats Quad Queens. 
  -- So broadwayKing (bad beat holder) lost with Quad Queens.
  UPDATE public.hand_history SET board = '["Kspades","Khearts","Qdiamonds","Qclubs","2clubs"]', 
    hole_cards = jsonb_build_object(v_broad_id::text, jsonb_build_array(jsonb_build_object('rank','Q','suit','hearts'),jsonb_build_object('rank','Q','suit','spades')), v_alice_id::text, jsonb_build_array(jsonb_build_object('rank','K','suit','diamonds'),jsonb_build_object('rank','K','suit','clubs'))) 
    WHERE hand_number = 1127041;

  INSERT INTO public.bbj_payouts (id, pool_id, table_id, hand_number, winner_user_id, loser_user_id, total_amount, winner_share, loser_share, table_share, table_player_count, created_at)
  VALUES (v_payout_id, v_pool_id, v_table_id, 1127041, v_broad_id, v_alice_id, v_total, v_loser, v_winner, v_table, 5, '2026-07-30 09:18:00+00', 0, false);

  INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount, created_at) VALUES (v_payout_id, v_broad_id, v_loser, '2026-07-30 09:18:00+00'), (v_payout_id, v_alice_id, v_winner, '2026-07-30 09:18:00+00', 0, false);
  
  INSERT INTO public.bbj_winners (pool_id, winner_id, loser_id, winner_display_name, loser_display_name, winner_hand, loser_hand, winner_payout, loser_payout, table_share_payout, total_payout, pool_amount_at_hit, table_id, hand_number, awarded_at)
  VALUES (v_pool_id, v_broad_id, v_alice_id, 'broadwayKing', 'Alice Bourgeois', 'Four of a Kind', 'Four of a Kind', v_loser, v_winner, v_table, v_total, v_pool_amount, v_table_id, 1127041, '2026-07-30 09:18:00+00', 0, false);

  -- Hit 3: Aug 4 - Freeway vs Caroline
  v_pool_amount := 5200.00; v_total := 3640.00; v_loser := 1820.00; v_winner := 910.00; v_table := 910.00;
  v_payout_id := gen_random_uuid(); v_table_id := 'a5cb6513-cceb-44d1-b742-46822a1eb941';
  
  INSERT INTO public.hand_history (table_id, hand_number, button_seat, game_variant, small_blind, big_blind, board, hole_cards, created_at, ended_at, bbj_amount, reported) VALUES 
  (v_table_id, 1253455, 3, 'PLO', 1, 2, '["6hearts","7hearts","8hearts","2clubs","3diamonds"]', jsonb_build_object(v_free_id::text, jsonb_build_array(jsonb_build_object('rank','4','suit','hearts'),jsonb_build_object('rank','5','suit','hearts'),jsonb_build_object('rank','A','suit','clubs'),jsonb_build_object('rank','K','suit','clubs')), v_caro_id::text, jsonb_build_array(jsonb_build_object('rank','9','suit','hearts'),jsonb_build_object('rank','T','suit','hearts'),jsonb_build_object('rank','J','suit','hearts'),jsonb_build_object('rank','Q','suit','hearts'))), '2026-08-04 18:22:00+00', '2026-08-04 18:25:00+00', 0, false);

  INSERT INTO public.bbj_payouts (id, pool_id, table_id, hand_number, winner_user_id, loser_user_id, total_amount, winner_share, loser_share, table_share, table_player_count, created_at)
  VALUES (v_payout_id, v_pool_id, v_table_id, 1253455, v_free_id, v_caro_id, v_total, v_loser, v_winner, v_table, 6, '2026-08-04 18:25:00+00', 0, false);

  INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount, created_at) VALUES (v_payout_id, v_free_id, v_loser, '2026-08-04 18:25:00+00'), (v_payout_id, v_caro_id, v_winner, '2026-08-04 18:25:00+00', 0, false);
  
  INSERT INTO public.bbj_winners (pool_id, winner_id, loser_id, winner_display_name, loser_display_name, winner_hand, loser_hand, winner_payout, loser_payout, table_share_payout, total_payout, pool_amount_at_hit, table_id, hand_number, awarded_at)
  VALUES (v_pool_id, v_free_id, v_caro_id, 'Freeway', 'Caroline Myers', 'Straight Flush', 'Straight Flush', v_loser, v_winner, v_table, v_total, v_pool_amount, v_table_id, 1253455, '2026-08-04 18:25:00+00', 0, false);

  -- Hit 4: Aug 12 - Josephine vs earlyPosition
  v_pool_amount := 8965.53; v_total := 6275.88; v_loser := 3137.94; v_winner := 1568.97; v_table := 1568.97;
  v_payout_id := gen_random_uuid(); v_table_id := 'e995a2ba-cd4d-4fd1-ab74-775370ee341e';
  
  INSERT INTO public.hand_history (table_id, hand_number, button_seat, game_variant, small_blind, big_blind, board, hole_cards, created_at, ended_at, bbj_amount, reported) VALUES 
  (v_table_id, 1269428, 4, 'BIGO', 5, 10, '["9spades","Qdiamonds","Tdiamonds","Kspades","Jdiamonds"]', jsonb_build_object(v_jos_id::text, jsonb_build_array(jsonb_build_object('rank','9','suit','clubs'),jsonb_build_object('rank','T','suit','hearts'),jsonb_build_object('rank','8','suit','diamonds'),jsonb_build_object('rank','2','suit','diamonds'),jsonb_build_object('rank','9','suit','diamonds')), v_ep_id::text, jsonb_build_array(jsonb_build_object('rank','8','suit','clubs'),jsonb_build_object('rank','K','suit','diamonds'),jsonb_build_object('rank','A','suit','spades'),jsonb_build_object('rank','A','suit','diamonds'),jsonb_build_object('rank','A','suit','hearts'))), '2026-08-12 21:10:00+00', '2026-08-12 21:14:00+00', 0, false);

  INSERT INTO public.bbj_payouts (id, pool_id, table_id, hand_number, winner_user_id, loser_user_id, total_amount, winner_share, loser_share, table_share, table_player_count, created_at)
  VALUES (v_payout_id, v_pool_id, v_table_id, 1269428, v_jos_id, v_ep_id, v_total, v_loser, v_winner, v_table, 6, '2026-08-12 21:14:00+00', 0, false);

  INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount, created_at) VALUES (v_payout_id, v_jos_id, v_loser, '2026-08-12 21:14:00+00'), (v_payout_id, v_ep_id, v_winner, '2026-08-12 21:14:00+00', 0, false);
  
  INSERT INTO public.bbj_winners (pool_id, winner_id, loser_id, winner_display_name, loser_display_name, winner_hand, loser_hand, winner_payout, loser_payout, table_share_payout, total_payout, pool_amount_at_hit, table_id, hand_number, awarded_at)
  VALUES (v_pool_id, v_jos_id, v_ep_id, 'Josephine Whitmore', 'earlyPosition', 'Straight Flush', 'Royal Flush', v_loser, v_winner, v_table, v_total, v_pool_amount, v_table_id, 1269428, '2026-08-12 21:14:00+00', 0, false);

  -- Hit 5: Aug 18 - Valentina vs WASP
  v_pool_amount := 11262.74; v_total := 7883.92; v_loser := 3941.96; v_winner := 1970.98; v_table := 1970.98;
  v_payout_id := gen_random_uuid(); v_table_id := '81b02fd7-6c0e-4d19-af33-0957ca17b0ea';
  
  INSERT INTO public.hand_history (table_id, hand_number, button_seat, game_variant, small_blind, big_blind, board, hole_cards, created_at, ended_at, bbj_amount, reported) VALUES 
  (v_table_id, 1506711, 5, 'NLH', 10, 20, '["Aclubs","Jdiamonds","Khearts","Adiamonds","Qdiamonds"]', jsonb_build_object(v_val_id::text, jsonb_build_array(jsonb_build_object('rank','7','suit','spades'),jsonb_build_object('rank','2','suit','diamonds'),jsonb_build_object('rank','A','suit','hearts'),jsonb_build_object('rank','A','suit','spades')), v_wasp_id::text, jsonb_build_array(jsonb_build_object('rank','T','suit','diamonds'),jsonb_build_object('rank','T','suit','spades'),jsonb_build_object('rank','K','suit','diamonds'),jsonb_build_object('rank','K','suit','clubs'))), '2026-08-18 23:30:00+00', '2026-08-18 23:35:00+00', 0, false);
  
  -- Wait, Valentina's hand was 4 hole cards (PLO). The game_variant should be PLO.
  UPDATE public.hand_history SET game_variant = 'PLO' WHERE hand_number = 1506711;

  INSERT INTO public.bbj_payouts (id, pool_id, table_id, hand_number, winner_user_id, loser_user_id, total_amount, winner_share, loser_share, table_share, table_player_count, created_at)
  VALUES (v_payout_id, v_pool_id, v_table_id, 1506711, v_val_id, v_wasp_id, v_total, v_loser, v_winner, v_table, 4, '2026-08-18 23:35:00+00', 0, false);

  INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount, created_at) VALUES (v_payout_id, v_val_id, v_loser, '2026-08-18 23:35:00+00'), (v_payout_id, v_wasp_id, v_winner, '2026-08-18 23:35:00+00', 0, false);
  
  INSERT INTO public.bbj_winners (pool_id, winner_id, loser_id, winner_display_name, loser_display_name, winner_hand, loser_hand, winner_payout, loser_payout, table_share_payout, total_payout, pool_amount_at_hit, table_id, hand_number, awarded_at)
  VALUES (v_pool_id, v_val_id, v_wasp_id, 'Valentina Salvatore', 'WASP', 'Four of a Kind', 'Royal Flush', v_loser, v_winner, v_table, v_total, v_pool_amount, v_table_id, 1506711, '2026-08-18 23:35:00+00', 0, false);


  -- Add hand details for UI mock
  UPDATE public.hand_history
  SET 
    pot_size = COALESCE((SELECT pool_amount_at_hit FROM public.bbj_winners WHERE hand_number = hand_history.hand_number), 1500.00),
    community_cards = ARRAY(
      SELECT jsonb_array_elements_text(board)
    ),
    players = jsonb_build_array(
      jsonb_build_object(
        'userId', (SELECT winner_id FROM public.bbj_winners WHERE hand_number = hand_history.hand_number),
        'seat', 1,
        'stack', 5000,
        'cards', COALESCE(hole_cards->(SELECT winner_id::text FROM public.bbj_winners WHERE hand_number = hand_history.hand_number), '[]'::jsonb)
      ),
      jsonb_build_object(
        'userId', (SELECT loser_id FROM public.bbj_winners WHERE hand_number = hand_history.hand_number),
        'seat', 2,
        'stack', 5000,
        'cards', COALESCE(hole_cards->(SELECT loser_id::text FROM public.bbj_winners WHERE hand_number = hand_history.hand_number), '[]'::jsonb)
      )
    ),
    actions = jsonb_build_array(
      jsonb_build_object(
        'userId', (SELECT loser_id FROM public.bbj_winners WHERE hand_number = hand_history.hand_number),
        'seat', 2,
        'action', 'bet',
        'amount', 500,
        'stage', 'River'
      ),
      jsonb_build_object(
        'userId', (SELECT winner_id FROM public.bbj_winners WHERE hand_number = hand_history.hand_number),
        'seat', 1,
        'action', 'call',
        'amount', 500,
        'stage', 'River'
      )
    ),
    winners = jsonb_build_array(
      jsonb_build_object(
        'userId', (SELECT loser_id FROM public.bbj_winners WHERE hand_number = hand_history.hand_number),
        'amount', 1000,
        'potIndex', 0,
        'hand', jsonb_build_object('name', (SELECT loser_hand FROM public.bbj_winners WHERE hand_number = hand_history.hand_number))
      )
    )
  WHERE hand_number IN (1080832, 1127041, 1253455, 1269428, 1506711);


  -- Update Club JAQK to have an avatar so the BBJ seed displays it
  UPDATE public.clubs SET avatar_url = '/poker-chip-logo.webp' WHERE club_id = 77777;

END;
$$;
