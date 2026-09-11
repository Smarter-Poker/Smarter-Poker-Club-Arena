-- Breakfast Turbo c1f15c30: the paid record stands; the post-finish ladder rewrite is voided; the event completes
-- through the ordinary terminal authority. ONE transaction. No prize money moves (all six places are already paid
-- exactly); the only ledger movement is the event's own 20.00 fee escrow -> its rake destination, which every
-- completion performs.
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL application_name = 'ruling:c1f15c30-breakfast-turbo';
-- Engine authority for fn_guard_managed_game_lifecycle (payout_structure is a protected key once players registered).
-- auth.uid() stays NULL, so fn_capture_managed_game_contract records the change as a system_revision.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 0. Same first locks as fn_complete_tournament_terminal (G then B), taken BEFORE any row lock, so the engine's
--    recoverStuckCompleting sweep (it retries this event every 1-2 minutes) cannot deadlock with us.
SELECT public.fn_ca_lock_settlement_lane_global();
SELECT 1 FROM public.tournaments WHERE id = 'c1f15c30-33c4-4a64-85ac-44037519ca5b' FOR UPDATE;

-- 1. PREFLIGHT: the exact state this ruling was written against, or nothing happens.
DO $pre$
DECLARE
  v_tid constant uuid := 'c1f15c30-33c4-4a64-85ac-44037519ca5b';
  v_win constant uuid := '5a0cd7e0-174a-466f-ba1d-6d2c80d9252a';
  n integer; s numeric; v text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = v_tid AND t.status = 'COMPLETING'
                   AND t.prize_pool = 180.00 AND t.prize_pool_finalized AND t.bounty_pool = 0 AND t.ended_at IS NULL
                   AND md5(t.payout_structure) = '56c764dbf0b4a775017b1ac8c09ed946'
                   AND t.satellite_target_id IS NULL AND NOT t.is_bounty AND NOT t.is_pko AND NOT t.is_mystery_bounty) THEN
    RAISE EXCEPTION 'preflight: tournament row is not the COMPLETING 180.00 event carrying the four-place v4 ladder';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id = v_tid)
     OR EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches WHERE tournament_id = v_tid)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id = v_tid)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts WHERE tournament_id = v_tid AND source = 'final_table_deal') THEN
    RAISE EXCEPTION 'preflight: a terminal receipt, place batch, rake settlement or deal already exists';
  END IF;
  SELECT version, md5(contract->>'payout_structure') INTO n, v FROM public.managed_game_contract_versions
   WHERE game_kind = 'tournament' AND game_id = v_tid ORDER BY version DESC LIMIT 1;
  IF n IS DISTINCT FROM 4 OR v IS DISTINCT FROM '56c764dbf0b4a775017b1ac8c09ed946'
     OR NOT EXISTS (SELECT 1 FROM public.managed_game_contract_versions WHERE game_kind = 'tournament' AND game_id = v_tid
                     AND version = 3 AND md5(contract->>'payout_structure') = '418b1c97aea58c66029a9a21ba46c7e7') THEN
    RAISE EXCEPTION 'preflight: contract history is not v3 six-place -> v4 four-place (latest %, %)', n, v;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id = v_tid AND e.prize_out = 180.00
                   AND e.prize_balance = 0 AND e.bounty_balance = 0 AND e.fee_balance = 20.00
                   AND e.closed_at IS NULL AND e.close_note IS NULL) THEN
    RAISE EXCEPTION 'preflight: escrow is not prize 0 / bounty 0 / fee 20.00 open';
  END IF;
  SELECT count(*) INTO n FROM public.tournament_obligations o
   WHERE o.tournament_id = v_tid AND o.kind = 'place' AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed
     AND (o.place, o.user_id, o.amount_owed) IN (
       (1, v_win, 58.55), (2, 'face0000-0000-0000-0000-000000000001'::uuid, 42.16),
       (3, '57d5af45-0b1c-417c-bc41-64ca9fd1b4b9'::uuid, 30.35), (4, '1e6efb0b-61f4-4303-9ee8-1569fbf50cbd'::uuid, 21.85),
       (5, '00000000-0000-0000-0000-000000000006'::uuid, 15.73), (6, 'e7925474-ad31-4cfb-826b-010039bcff3d'::uuid, 11.36));
  IF n <> 6 OR (SELECT count(*) FROM public.tournament_obligations WHERE tournament_id = v_tid) <> 6 THEN
    RAISE EXCEPTION 'preflight: obligations are not exactly the six settled places (% matched)', n;
  END IF;
  SELECT count(*), sum(amount) INTO n, s FROM public.tournament_payouts p
   WHERE p.tournament_id = v_tid AND p.source = 'structure'
     AND (p.position, p.user_id, p.amount) IN (
       (1, v_win, 58.55), (2, 'face0000-0000-0000-0000-000000000001'::uuid, 42.16),
       (3, '57d5af45-0b1c-417c-bc41-64ca9fd1b4b9'::uuid, 30.35), (4, '1e6efb0b-61f4-4303-9ee8-1569fbf50cbd'::uuid, 21.85),
       (5, '00000000-0000-0000-0000-000000000006'::uuid, 15.73), (6, 'e7925474-ad31-4cfb-826b-010039bcff3d'::uuid, 11.36));
  IF n <> 6 OR s <> 180.00 OR (SELECT count(*) FROM public.tournament_payouts WHERE tournament_id = v_tid) <> 6 THEN
    RAISE EXCEPTION 'preflight: payouts are not exactly the six structure rows summing to 180.00';
  END IF;
  SELECT count(*) INTO n FROM public.wallet_transactions WHERE related_entity_id = v_tid AND category = 'prize' AND type = 'credit';
  SELECT sum(amount) INTO s FROM public.wallet_transactions WHERE related_entity_id = v_tid AND category = 'prize' AND type = 'credit';
  IF n <> 6 OR s <> 180.00 THEN RAISE EXCEPTION 'preflight: prize credits are not 6 / 180.00 (% / %)', n, s; END IF;
  IF (SELECT count(*) FROM public.tournament_players WHERE tournament_id = v_tid) <> 40
     OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id = v_tid AND status = 'winner') <> 1
     OR NOT EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = v_tid AND user_id = v_win AND status = 'winner'
                      AND position = 1 AND eliminated_at IS NULL AND elimination_sequence IS NULL)
     OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id = v_tid AND status = 'eliminated'
           AND position BETWEEN 2 AND 40 AND elimination_sequence = 41 - position) <> 39
     OR (SELECT count(DISTINCT position) FROM public.tournament_players WHERE tournament_id = v_tid) <> 40 THEN
    RAISE EXCEPTION 'preflight: standings are not the recorded 1..40 ladder with its bootstrapped sequence';
  END IF;
  IF (SELECT count(*) FROM public.tournament_players WHERE tournament_id = v_tid AND position BETWEEN 2 AND 6
        AND (position, user_id, prize) IN ((2,'face0000-0000-0000-0000-000000000001'::uuid,42.16),
             (3,'57d5af45-0b1c-417c-bc41-64ca9fd1b4b9'::uuid,30.35),(4,'1e6efb0b-61f4-4303-9ee8-1569fbf50cbd'::uuid,21.85),
             (5,'00000000-0000-0000-0000-000000000006'::uuid,15.73),(6,'e7925474-ad31-4cfb-826b-010039bcff3d'::uuid,11.36))) <> 5 THEN
    RAISE EXCEPTION 'preflight: paid places 2-6 no longer hold the paid players';
  END IF;
  SELECT count(*), sum(rake_amount) INTO n, s FROM public.rake_records WHERE tournament_id = v_tid AND is_tournament;
  IF n <> 40 OR s <> 20.00 THEN RAISE EXCEPTION 'preflight: rake records are not 40 / 20.00 (% / %)', n, s; END IF;
  IF (SELECT count(*) FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
       WHERE tb.tournament_id = v_tid AND s.left_at IS NULL) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.table_seats WHERE id = 'e8469c2c-d7eb-4a6c-a064-6216e5bd8b53'
                      AND user_id = v_win AND left_at IS NULL) THEN
    RAISE EXCEPTION 'preflight: live seats are not exactly the winner''s chair';
  END IF;
  PERFORM set_config('ruling.union_rake_before',
    (SELECT rake_wallet::text FROM public.union_wallets WHERE union_id = 'fade0000-0000-0000-0000-000000000001'), true);
END
$pre$;

-- 2. THE RULING: void the post-finish rewrite (v4, written at 14:53:50 by zz_ca_fund_overlay_on_lock when the
--    played-but-registering sweep relabelled REGISTERING -> COMPLETING) and restore, byte for byte, the v3 ladder that
--    was in force from 14:24:55 and against which every paid place was priced.
DO $rule$
DECLARE n integer;
BEGIN
  UPDATE public.tournaments
     SET payout_structure = '[{"place":1,"percentage":32.53},{"place":2,"percentage":23.42},{"place":3,"percentage":16.86},{"place":4,"percentage":12.14},{"place":5,"percentage":8.74},{"place":6,"percentage":6.31}]'
   WHERE id = 'c1f15c30-33c4-4a64-85ac-44037519ca5b' AND status = 'COMPLETING'
     AND md5(payout_structure) = '56c764dbf0b4a775017b1ac8c09ed946';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'ruling: expected to restore exactly one payout_structure, did %', n; END IF;
  IF (SELECT md5(payout_structure) FROM public.tournaments WHERE id = 'c1f15c30-33c4-4a64-85ac-44037519ca5b')
       <> '418b1c97aea58c66029a9a21ba46c7e7' THEN
    RAISE EXCEPTION 'ruling: restored ladder is not byte-identical to contract v3';
  END IF;
END
$rule$;

-- 3. Complete through the ordinary authority (proves the ladder, pays nothing new, settles rake, closes escrow,
--    releases the chair, closes tables, writes the immutable terminal receipt).
DO $done$
DECLARE r jsonb;
BEGIN
  r := public.fn_complete_tournament_terminal('c1f15c30-33c4-4a64-85ac-44037519ca5b',
                                              '5a0cd7e0-174a-466f-ba1d-6d2c80d9252a', 'places');
  IF COALESCE((r->>'ok')::boolean, false) IS NOT TRUE OR r->>'mode' IS DISTINCT FROM 'places'
     OR (r->'cash'->>'winner_amount')::numeric IS DISTINCT FROM 58.55
     OR COALESCE(jsonb_array_length(r->'cash'->'payouts'), 0) <> 6
     OR (r->'rake'->>'amount')::numeric IS DISTINCT FROM 20.00 THEN
    RAISE EXCEPTION 'terminal authority returned an unexpected receipt: %', r;
  END IF;
  RAISE NOTICE 'terminal receipt: %', r;
END
$done$;

-- 4. The audit record: why this is a ruling, the true bust order, and who is owed what under it.
SELECT public.fn_raise_server_financial_alert(
  'warning', 'tournament_ruling',
  'Breakfast Turbo c1f15c30 was completed by ruling on 2026-09-11. The six places paid on 2026-09-08 (58.55, 42.16, '
  || '30.35, 21.85, 15.73, 11.36 = 180.00, the whole pool) stand and nothing was clawed back. The stored ladder was '
  || 'restored from the post-finish four-place rewrite (contract v4, 14:53:50, zz_ca_fund_overlay_on_lock on the '
  || 'REGISTERING->COMPLETING relabel) to the six-place v3 ladder in force from 14:24:55 against which every place was '
  || 'priced. The paid standings disagree with bust chronology: place 2 was recorded at 14:36:38 while seven players '
  || 'still held all 480,000 chips; the true places 2-7 (recorded 35-40) busted in hands at 14:38-14:42. '
  || 'Under the v3 ladder 121.45 is owed as house-funded make-good to five accounts (context.make_good_v3). All 40 '
  || 'entrants are horses (profiles.is_horse).',
  jsonb_build_object(
    'tournament_id', 'c1f15c30-33c4-4a64-85ac-44037519ca5b',
    'ruling', 'paid_record_stands; payout_structure v4 voided, v3 restored; completed via fn_complete_tournament_terminal(places)',
    'contract', jsonb_build_object('voided_version', 4, 'voided_md5', '56c764dbf0b4a775017b1ac8c09ed946',
                                   'restored_from_version', 3, 'restored_md5', '418b1c97aea58c66029a9a21ba46c7e7'),
    'paid_record', '[{"place":1,"user_id":"5a0cd7e0-174a-466f-ba1d-6d2c80d9252a","amount":58.55,"true_place":1},{"place":2,"user_id":"face0000-0000-0000-0000-000000000001","amount":42.16,"true_place":10},{"place":3,"user_id":"57d5af45-0b1c-417c-bc41-64ca9fd1b4b9","amount":30.35,"true_place":8},{"place":4,"user_id":"1e6efb0b-61f4-4303-9ee8-1569fbf50cbd","amount":21.85,"true_place":9},{"place":5,"user_id":"00000000-0000-0000-0000-000000000006","amount":15.73,"true_place":13},{"place":6,"user_id":"e7925474-ad31-4cfb-826b-010039bcff3d","amount":11.36,"true_place":11}]'::jsonb,
    'make_good_v3', '[{"user_id":"1c0dee1e-8ab9-4d42-897e-e1dd6da9f4be","true_place":2,"owed":42.16},{"user_id":"c6dc3bfa-d9dd-4174-9704-d4a0a285f876","true_place":3,"owed":30.35},{"user_id":"00000000-0000-0000-0000-000000000025","true_place":4,"owed":21.85},{"user_id":"2d6c5e7a-7352-4d1d-aecf-c5237d626e3d","true_place":5,"owed":15.73},{"user_id":"165df98e-f59d-46aa-bc74-a974c0ded83f","true_place":6,"owed":11.36}]'::jsonb,
    'make_good_v3_total', 121.45,
    'make_good_if_payout_percent_10_ladder', '[{"user_id":"5a0cd7e0-174a-466f-ba1d-6d2c80d9252a","true_place":1,"owed":19.07},{"user_id":"1c0dee1e-8ab9-4d42-897e-e1dd6da9f4be","true_place":2,"owed":44.57},{"user_id":"c6dc3bfa-d9dd-4174-9704-d4a0a285f876","true_place":3,"owed":32.22},{"user_id":"00000000-0000-0000-0000-000000000025","true_place":4,"owed":25.59}]'::jsonb,
    'true_bust_order_evidence', 'hand_history end-of-hand stacks: last hand with stack 0, ordered by hand end (commit) time desc, same-hand ties by starting stack desc (platform rule). No tournament_knockout_candidates / hand_atomic_commits exist for this event (both start 2026-09-08 14:56-15:03).',
    'true_bust_order', '["5a0cd7e0-174a-466f-ba1d-6d2c80d9252a","1c0dee1e-8ab9-4d42-897e-e1dd6da9f4be","c6dc3bfa-d9dd-4174-9704-d4a0a285f876","00000000-0000-0000-0000-000000000025","2d6c5e7a-7352-4d1d-aecf-c5237d626e3d","165df98e-f59d-46aa-bc74-a974c0ded83f","f39893fa-6830-49b6-9f80-b32191328ac0","57d5af45-0b1c-417c-bc41-64ca9fd1b4b9","1e6efb0b-61f4-4303-9ee8-1569fbf50cbd","face0000-0000-0000-0000-000000000001","e7925474-ad31-4cfb-826b-010039bcff3d","9313a5e1-6f18-4829-be70-c932adf12625","00000000-0000-0000-0000-000000000006","aaa1dbd5-baa8-4503-8681-26ebe1ccf8a6","7f99084b-e99a-4312-a258-1be6451c0c8b","a916c222-1eb9-4e73-89ee-a92e289b80eb","d4c7cab4-cff5-464e-a611-e43011838872","64168748-ce1d-48f4-884d-3c77d69d53d1","0860d731-0d86-409a-8384-41a17b99a1f4","036f0b55-c601-4d09-982a-5294cf4ea15d","8ba5f4d2-91ce-4d7b-9182-192663784a92","56315bf9-8a2b-4625-9e53-c7fe4bde9a8c","00000000-0000-0000-0000-000000000024","face0000-0000-0000-0000-000000000002","fb825ba4-09a8-44c6-a719-13c682893e04","8b3b6f26-589a-4532-8392-003fddfb7d1b","5d2d902a-17fb-43c0-97bf-e4fcece2ec8f","00000000-0000-0000-0000-000000000005","c702f6e3-a7c2-48fc-b3be-a965ae81289f","2d48c8ed-c8e4-4188-a3a8-b0fa3b2da10d","1000eabd-a6a4-4bdc-acfc-11019ce61b0c","face0000-0000-0000-0000-00000000000a","aba9beb0-16b9-420a-8247-f5ceabe76b47","b4cd2cf5-7b88-4383-9b3c-d1cc231828e7","7e52a91c-4372-4b4e-aec2-5b7d59f19730","e94d80fb-4973-452e-b745-6c3ca68c9b16","a93a8432-a399-4ac6-9005-3c77f1e37080","97a78c88-d500-421b-bff0-992271e24b09","face0000-0000-0000-0000-000000000006","d3f422d8-ccab-4ee9-ba50-7678a17ba776"]'::jsonb,
    'all_entrants_are_horses', true),
  'ruled-finish:c1f15c30-33c4-4a64-85ac-44037519ca5b');

-- 5. POSTFLIGHT: the event is over, nothing but the fee moved, and the record agrees with the money.
DO $post$
DECLARE
  v_tid constant uuid := 'c1f15c30-33c4-4a64-85ac-44037519ca5b';
  v_win constant uuid := '5a0cd7e0-174a-466f-ba1d-6d2c80d9252a';
  h public.tournament_terminal_settlements%ROWTYPE; n integer; s numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = v_tid AND status = 'COMPLETED' AND ended_at IS NOT NULL
                   AND md5(payout_structure) = '418b1c97aea58c66029a9a21ba46c7e7') THEN
    RAISE EXCEPTION 'postflight: tournament is not COMPLETED on the v3 ladder';
  END IF;
  SELECT * INTO h FROM public.tournament_terminal_settlements WHERE tournament_id = v_tid;
  IF h.tournament_id IS NULL OR h.settlement_mode <> 'places' OR h.winner_id <> v_win OR h.cash_payout_count <> 6
     OR h.cash_payout_total <> 180.00 OR h.rake_amount <> 20.00
     OR h.rake_destination <> 'union:fade0000-0000-0000-0000-000000000001'
     OR h.released_seat_count <> 1 OR h.closed_table_count <> 4 THEN
    RAISE EXCEPTION 'postflight: terminal receipt is not the expected places receipt';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.managed_game_contract_versions WHERE game_kind = 'tournament' AND game_id = v_tid
                   AND version = 5 AND change_reason = 'system_revision'
                   AND md5(contract->>'payout_structure') = '418b1c97aea58c66029a9a21ba46c7e7') THEN
    RAISE EXCEPTION 'postflight: contract v5 restoring the v3 ladder was not captured';
  END IF;
  SELECT count(*), sum(amount) INTO n, s FROM public.tournament_payouts WHERE tournament_id = v_tid;
  IF n <> 6 OR s <> 180.00 THEN RAISE EXCEPTION 'postflight: payouts changed (% / %)', n, s; END IF;
  SELECT count(*), sum(amount) INTO n, s FROM public.wallet_transactions
   WHERE related_entity_id = v_tid AND category = 'prize' AND type = 'credit';
  IF n <> 6 OR s <> 180.00 THEN RAISE EXCEPTION 'postflight: a prize credit moved (% / %)', n, s; END IF;
  SELECT count(*) INTO n FROM public.tournament_obligations o
   WHERE o.tournament_id = v_tid AND o.kind = 'place' AND o.amount_paid = o.amount_owed AND o.terminal_closed_at IS NOT NULL
     AND (o.place, o.user_id, o.amount_owed) IN (
       (1, v_win, 58.55), (2, 'face0000-0000-0000-0000-000000000001'::uuid, 42.16),
       (3, '57d5af45-0b1c-417c-bc41-64ca9fd1b4b9'::uuid, 30.35), (4, '1e6efb0b-61f4-4303-9ee8-1569fbf50cbd'::uuid, 21.85),
       (5, '00000000-0000-0000-0000-000000000006'::uuid, 15.73), (6, 'e7925474-ad31-4cfb-826b-010039bcff3d'::uuid, 11.36));
  IF n <> 6 OR (SELECT count(*) FROM public.tournament_obligations WHERE tournament_id = v_tid) <> 6 THEN
    RAISE EXCEPTION 'postflight: obligations changed';
  END IF;
  IF (SELECT count(*) FROM public.tournament_players WHERE tournament_id = v_tid
        AND prize = CASE position WHEN 1 THEN 58.55 WHEN 2 THEN 42.16 WHEN 3 THEN 30.35 WHEN 4 THEN 21.85
                                  WHEN 5 THEN 15.73 WHEN 6 THEN 11.36 ELSE 0 END) <> 40
     OR NOT EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = v_tid AND user_id = v_win AND position = 1 AND status = 'winner')
     OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id = v_tid AND status = 'eliminated'
           AND elimination_sequence = 41 - position) <> 39 THEN
    RAISE EXCEPTION 'postflight: standings or prize cache are not the paid record';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournament_escrow WHERE tournament_id = v_tid AND prize_balance = 0
                   AND bounty_balance = 0 AND fee_balance = 0 AND closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'postflight: escrow did not close at zero';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id = v_tid AND amount = 20.00
                   AND destination = 'union:fade0000-0000-0000-0000-000000000001' AND settled_at IS NOT NULL
                   AND attributed_at IS NOT NULL AND attribution_error IS NULL) THEN
    RAISE EXCEPTION 'postflight: rake settlement is not 20.00 to union fade0000, attributed';
  END IF;
  IF (SELECT rake_wallet FROM public.union_wallets WHERE union_id = 'fade0000-0000-0000-0000-000000000001')
       - current_setting('ruling.union_rake_before')::numeric IS DISTINCT FROM 20.00 THEN
    RAISE EXCEPTION 'postflight: union rake wallet did not move by exactly 20.00';
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = v_tid AND s.left_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.tables WHERE tournament_id = v_tid AND status <> 'closed') THEN
    RAISE EXCEPTION 'postflight: a live seat or open table remains';
  END IF;
  PERFORM public.fn_ca_tournament_terminal_receipt(v_tid, v_win);
  RAISE NOTICE 'postflight ok: COMPLETED, receipt places 6/180.00, rake 20.00, no prize movement';
END
$post$;
COMMIT;
