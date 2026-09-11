-- RULING R1 - Early Bird Freeroll (NLH) a5aa6984: record river222's real bust.
-- One transaction. Writes: tournament_players (1 row: river222 chips 2500 -> 0,
-- then the knockout door's own status/position/eliminated_at CAS), the door's
-- tournament_knockout_candidates CAS (d0ac2895 pending -> eliminated), and one
-- durable manager wake. Moves no money.
--
-- THE RULING. river222 busted in hand 8569325 (committed 2026-09-09
-- 06:13:09.079372; stack 2,330 -> 0). His decision window closed at
-- 06:13:39.003. At 06:28:26.464, 14m47s later, a 1.00 rebuy leg was posted
-- (wallet_transactions 77480914, chip_ledger a0378437, entitlement 834c1864):
-- the 09-09 money core took it without a knockout generation or a window
-- check, found no live seat, and credited 2,500 to tournament_players.chips
-- only. Nothing ever seated him and no later hand dealt him in, so the
-- purchase bought nothing - a leg the current process_tournament_rebuy would
-- refuse ('Rebuy or re-entry decision window has closed'). It is therefore
-- REFUNDED, not honoured: honouring it would seat a player whose window had
-- closed, heads-up for the title against a 320,000 stack, on chips nobody had a
-- right to buy. The refund is owed by the house through the make-good door (see
-- MAKEGOOD_undelivered_rebuy_legs_readonly.sql for why not the event refund
-- door); this transaction only records the bust.
--
-- Why he is stuck: the knockout door refuses a 'playing' row whose mirror
-- reads chips > 0 ('not_busted'), the engine's bust scan reads the same mirror,
-- and the absent-player sweep leaves a player with a non-rebought latest
-- generation to the door. The 2,500 are zeroed first; every other gate of
-- fn_eliminate_tournament_player_atomic runs unchanged and passes.
--
-- REHEARSED on a PostgreSQL 17 copy (all 2,573 plpgsql bodies md5-identical to
-- production, the event's rows copied): the door returns ok/claimed at place 2,
-- eliminated_at = 06:13:09.079372; the engine's own terminal authority
-- (fn_complete_tournament_terminal) then COMPLETES the event paying 99.30 in
-- true bust order - 1 MIAJordan 27.85, 2 d.kim94 16.00, 3 Rebuy Gia 11.57,
-- 4 MamaRob 9.19, 5 UncleJules 7.69, 6 RexSr 6.64, 7 tim 5.87, 8 andre 5.27,
-- 9 pokerchad 4.81, 10 lake13 4.41 - with river222 100th, escrow closed at zero.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $window$
BEGIN
  IF extract(minute FROM clock_timestamp() AT TIME ZONE 'UTC') >= 50
     OR extract(minute FROM clock_timestamp() AT TIME ZONE 'UTC') < 3 THEN
    RAISE EXCEPTION 'R1 refuses to run inside the :50-:03 UTC break window';
  END IF;
END $window$;

-- Canonical lock order: tournament -> roster -> knockout generations.
SELECT count(*) AS locked_tournament FROM (SELECT id FROM public.tournaments
 WHERE id = 'a5aa6984-6c1c-4b59-aeb7-9e7878853bdd' FOR UPDATE) x;
SELECT count(*) AS locked_roster FROM (SELECT id FROM public.tournament_players
 WHERE tournament_id = 'a5aa6984-6c1c-4b59-aeb7-9e7878853bdd' ORDER BY id FOR UPDATE) x;
SELECT count(*) AS locked_generations FROM (SELECT id FROM public.tournament_knockout_candidates
 WHERE tournament_id = 'a5aa6984-6c1c-4b59-aeb7-9e7878853bdd'
   AND eliminated_user_id = 'dca6c345-c2ab-456f-98d9-dfbca3a43f7d'
 ORDER BY hand_number, id FOR UPDATE) x;

DO $pre$
DECLARE
  v_t  constant uuid := 'a5aa6984-6c1c-4b59-aeb7-9e7878853bdd';
  v_r  constant uuid := 'dca6c345-c2ab-456f-98d9-dfbca3a43f7d';   -- river222
  v_m  constant uuid := '4f7f8abb-ba34-464c-9ecb-0ab7a972a978';   -- MIAJordan
  v_k  constant uuid := 'd0ac2895-ecb8-41dd-a89b-27ee58fa14d5';   -- stale pending generation
  n integer;
BEGIN
  PERFORM 1 FROM public.tournaments t
   WHERE t.id = v_t AND t.status = 'RUNNING' AND t.prize_pool = 99.30
     AND t.prize_pool_finalized AND NOT COALESCE(t.is_bounty,false)
     AND NOT COALESCE(t.is_pko,false) AND NOT COALESCE(t.is_mystery_bounty,false);
  IF NOT FOUND THEN RAISE EXCEPTION 'PRE: tournament is not the RUNNING 99.30 non-bounty event this ruling was written for'; END IF;

  IF EXISTS (SELECT 1 FROM public.tournament_payouts WHERE tournament_id = v_t)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations WHERE tournament_id = v_t)
     OR EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches WHERE tournament_id = v_t)
     OR EXISTS (SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id = v_t) THEN
    RAISE EXCEPTION 'PRE: place money or a terminal receipt already exists';
  END IF;
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = v_t AND e.prize_balance = 99.30 AND e.fee_balance = 2.70
     AND e.prize_out = 0 AND e.refund_prize = 0 AND e.refund_fee = 0 AND e.closed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRE: escrow is not the untouched 99.30 / 2.70 bank'; END IF;

  SELECT count(*) INTO n FROM public.tournament_players WHERE tournament_id = v_t;
  IF n <> 100 THEN RAISE EXCEPTION 'PRE: roster has % rows, expected 100', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_players
   WHERE tournament_id = v_t AND status = 'eliminated' AND position IS NOT NULL AND elimination_sequence IS NOT NULL;
  IF n <> 98 THEN RAISE EXCEPTION 'PRE: % positioned eliminated rows, expected 98', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_players WHERE tournament_id = v_t AND status = 'playing';
  IF n <> 2 THEN RAISE EXCEPTION 'PRE: % playing rows, expected 2', n; END IF;
  PERFORM 1 FROM public.tournament_players
   WHERE tournament_id = v_t AND user_id = v_r AND status = 'playing' AND chips = 2500
     AND rebuys = 1 AND table_id IS NULL AND COALESCE(prize,0) = 0;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRE: river222 is not the seatless playing 2500-chip mirror row'; END IF;
  PERFORM 1 FROM public.tournament_players tp
    JOIN public.table_seats s ON s.user_id = tp.user_id AND s.left_at IS NULL
    JOIN public.tables tb ON tb.id = s.table_id AND tb.tournament_id = v_t
   WHERE tp.tournament_id = v_t AND tp.user_id = v_m AND tp.status = 'playing'
     AND tp.chips = 320000 AND s.stack = 320000;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRE: MIAJordan is not the seated 320000 survivor'; END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = v_t AND s.user_id = v_r AND s.left_at IS NULL) THEN
    RAISE EXCEPTION 'PRE: river222 holds a live seat';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = v_t AND position = 2) THEN
    RAISE EXCEPTION 'PRE: place 2 is already held';
  END IF;

  SELECT count(*) INTO n FROM public.tournament_knockout_candidates
   WHERE tournament_id = v_t AND eliminated_user_id = v_r;
  IF n <> 1 THEN RAISE EXCEPTION 'PRE: river222 has % knockout generations, expected 1', n; END IF;
  PERFORM 1 FROM public.tournament_knockout_candidates c
    JOIN public.hand_atomic_commits a
      ON a.table_id = c.table_id AND a.hand_number = c.hand_number AND a.hand_id = c.hand_id
   WHERE c.id = v_k AND c.tournament_id = v_t AND c.eliminated_user_id = v_r
     AND c.state = 'pending' AND c.hand_number = 8569325
     AND c.rebuy_prompt_until = '2026-09-09 06:13:39.003239+00'
     AND c.rebuy_prompt_until < clock_timestamp()
     AND a.committed_at = '2026-09-09 06:13:09.079372+00'
     AND (a.stack_result->'written'->>v_r::text)::numeric = 0;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRE: generation d0ac2895 is not the pending, committed zero-stack bust of hand 8569325'; END IF;
  IF public.fn_ca_latest_committed_knockout_candidate(v_t, v_r) IS DISTINCT FROM v_k THEN
    RAISE EXCEPTION 'PRE: the door would not bind generation d0ac2895';
  END IF;

  -- The only purchase after that bust: one 1.00 rebuy leg, 14m47s after the
  -- decision window closed, that never reached a seat.
  SELECT count(*) INTO n FROM public.wallet_transactions
   WHERE related_entity_id = v_t AND user_id = v_r;
  IF n <> 1 THEN RAISE EXCEPTION 'PRE: river222 has % wallet rows in this event, expected 1', n; END IF;
  PERFORM 1 FROM public.wallet_transactions
   WHERE id = '77480914-a763-4033-9b2e-ab3be78cac36' AND related_entity_id = v_t AND user_id = v_r
     AND type = 'debit' AND category = 'rebuy' AND amount = 1.00
     AND created_at = '2026-09-09 06:28:26.46404+00';
  IF NOT FOUND THEN RAISE EXCEPTION 'PRE: the late rebuy leg is not the recorded 1.00 debit'; END IF;
  IF EXISTS (SELECT 1 FROM public.hand_history h
              WHERE h.tournament_id = v_t AND h.hand_number > 8569325
                AND (h.players @> jsonb_build_array(jsonb_build_object('userId', v_r::text))
                  OR h.players @> jsonb_build_array(jsonb_build_object('user_id', v_r::text)))) THEN
    RAISE EXCEPTION 'PRE: river222 was dealt a later hand';
  END IF;
END $pre$;

-- 1. The mirror, not the felt: these 2,500 are the chips of the late leg,
--    credited to tournament_players.chips because no seat existed. They were
--    never on a seat and no hand ever carried them.
DO $zero$
DECLARE n integer;
BEGIN
  UPDATE public.tournament_players
     SET chips = 0
   WHERE tournament_id = 'a5aa6984-6c1c-4b59-aeb7-9e7878853bdd'
     AND user_id = 'dca6c345-c2ab-456f-98d9-dfbca3a43f7d'
     AND status = 'playing' AND chips = 2500 AND table_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'zeroing the mirror touched % rows', n; END IF;
END $zero$;

-- 2. Record the bust through the knockout door at its real hand. The place is
--    provisional (the only free one); fn_settle_tournament_places re-ranks every
--    eliminated row by its bust hand's commit time before paying.
DO $door$
DECLARE v jsonb;
BEGIN
  v := public.fn_eliminate_tournament_player_atomic(
         'a5aa6984-6c1c-4b59-aeb7-9e7878853bdd',
         'dca6c345-c2ab-456f-98d9-dfbca3a43f7d', 2, 0, 0);
  RAISE NOTICE 'door: %', v;
  IF COALESCE((v->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v->>'claimed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'knockout door refused: %', v;
  END IF;
END $door$;

-- 3. Wake the manager so the decided field finishes now.
SELECT public.fn_emit_tournament_manager_wake('a5aa6984-6c1c-4b59-aeb7-9e7878853bdd', 'rebuy') AS wake_id;

DO $post$
DECLARE
  v_t  constant uuid := 'a5aa6984-6c1c-4b59-aeb7-9e7878853bdd';
  v_r  constant uuid := 'dca6c345-c2ab-456f-98d9-dfbca3a43f7d';
  v_m  constant uuid := '4f7f8abb-ba34-464c-9ecb-0ab7a972a978';
  n integer;
BEGIN
  PERFORM 1 FROM public.tournament_players
   WHERE tournament_id = v_t AND user_id = v_r AND status = 'eliminated' AND position = 2
     AND chips = 0 AND COALESCE(prize,0) = 0 AND elimination_sequence IS NOT NULL
     AND eliminated_at = '2026-09-09 06:13:09.079372+00';
  IF NOT FOUND THEN RAISE EXCEPTION 'POST: river222 is not eliminated at the hand 8569325 commit time'; END IF;
  PERFORM 1 FROM public.tournament_knockout_candidates
   WHERE id = 'd0ac2895-ecb8-41dd-a89b-27ee58fa14d5' AND state = 'eliminated' AND resolved_at IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'POST: generation d0ac2895 did not close as eliminated'; END IF;
  SELECT count(*) INTO n FROM public.tournament_players WHERE tournament_id = v_t AND status = 'playing';
  IF n <> 1 THEN RAISE EXCEPTION 'POST: % playing rows, expected 1', n; END IF;
  PERFORM 1 FROM public.tournament_players WHERE tournament_id = v_t AND user_id = v_m AND status = 'playing' AND chips = 320000;
  IF NOT FOUND THEN RAISE EXCEPTION 'POST: MIAJordan is not the sole survivor'; END IF;
  SELECT count(*) INTO n FROM public.tournament_players
   WHERE tournament_id = v_t AND status = 'eliminated' AND position IS NOT NULL AND elimination_sequence IS NOT NULL;
  IF n <> 99 THEN RAISE EXCEPTION 'POST: % positioned eliminated rows, expected 99', n; END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_knockout_candidates WHERE tournament_id = v_t AND state = 'pending') THEN
    RAISE EXCEPTION 'POST: a pending generation remains';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts WHERE tournament_id = v_t)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations WHERE tournament_id = v_t)
     OR (SELECT count(*) FROM public.wallet_transactions WHERE related_entity_id = v_t) <> 27
     OR (SELECT count(*) FROM public.chip_ledger WHERE tournament_id = v_t) <> 28 THEN
    RAISE EXCEPTION 'POST: money moved';
  END IF;
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = v_t AND e.prize_balance = 99.30 AND e.fee_balance = 2.70;
  IF NOT FOUND THEN RAISE EXCEPTION 'POST: escrow changed'; END IF;
END $post$;
COMMIT;
