-- Run only in the private Diamond fixture created by test-accounting-delivery.sh
-- (owner rulings 2026-09-21: R2, R12, R13, R15 and the server half of R18).
-- REAL SPINS, not a copy of the draw: four hundred paid spins through
-- fn_wheel_spin_v2 itself, then a VIP's wheel, then the three-card game, then a
-- run. Everything rolls back.
--
--  A. no two spins in a row pay the same prize, and no two in a row give the
--     same GAME even across the Upgrade tiers; the mix lands on 50/30/20 by
--     chi-square; every receipt carries contract 4, the model name, the row of
--     weights it actually drew from, and the previous outcome it excluded;
--  B. a VIP never draws a throwable, a time bank or a rabbit hunt, and the
--     three cards that replace them pay chips into the member wallet exactly;
--  C. Diamonds pays nothing at the spin and deals three sealed cards; the pick
--     pays exactly one of half, double or triple, once, with its ledger and
--     custody rows, reveals all three, is idempotent, and averages 11/6;
--  D. a run accumulates its unplayed prizes, refuses the spin after the last,
--     ends idempotently, and an award from BEFORE the run still blocks;
--  E. every diamond debit, diamond credit, chip payout and item grant leaves
--     its journal row, its custody movement and its Mint register line.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL "request.jwt.claims"='{"role":"authenticated"}';
DO $guard$ BEGIN
 IF current_database() IS DISTINCT FROM 'diamond_games_probe'
    OR NOT EXISTS (SELECT 1 FROM public.ca_financial_epochs WHERE name='Isolated Diamond financial probe' AND is_current) THEN
  RAISE EXCEPTION 'wheel v4 draw probe requires the isolated fixture';
 END IF;
END $guard$;

-- Force an outcome through the REAL spin: fixed seeds are tried in rolled-back
-- subtransactions until the receipt shows the wanted ord. Nothing about the
-- weights, the follow-up law or the VIP table is assumed.
CREATE FUNCTION pg_temp.force_ord(p_player uuid,p_club uuid,p_ord integer,p_entry integer,p_tag text,p_secondary_kind text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $force$
DECLARE seed text;i integer;commit uuid;outcome jsonb;found jsonb;
BEGIN
 FOR i IN 1..4000 LOOP
  BEGIN
   seed:=encode(extensions.digest('wheel-v4-'||p_tag||'-'||p_ord||'-'||COALESCE(p_secondary_kind,'')||'-'||i,'sha256'),'hex');
   commit:=gen_random_uuid();
   INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash)
    VALUES(commit,p_player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
   SET LOCAL ROLE authenticated;
   outcome:=public.fn_wheel_spin_v2(p_club,commit,'v4probe',p_entry,'paid',NULL);
   RESET ROLE;
   IF outcome->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'A forced spin was refused (ord %): %',p_ord,outcome; END IF;
   IF (outcome#>>'{outcome,ord}')::integer=p_ord
      AND (p_secondary_kind IS NULL OR outcome#>>'{secondary,outcome,kind}'=p_secondary_kind) THEN
    found:=outcome; EXIT;
   END IF;
   RAISE EXCEPTION USING ERRCODE='P0099',MESSAGE='roll this attempt back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
 END LOOP;
 IF found IS NULL THEN RAISE EXCEPTION 'No fixed seed in 4000 real spins reached ord % (secondary %), after ord %',p_ord,p_secondary_kind,
  (SELECT s.outcome_ord FROM public.wheel_spins s WHERE s.user_id=p_player ORDER BY s.nonce DESC LIMIT 1); END IF;
 RETURN found;
END $force$;

-- Free the club's cover between forced outcomes when a probe section is not
-- testing the queue itself. Only the probe does this; the wheel never can.
CREATE FUNCTION pg_temp.clear_queue(p_player uuid,p_host uuid) RETURNS void LANGUAGE plpgsql AS $clear$
BEGIN
 DELETE FROM public.wheel_bonus_awards WHERE user_id=p_player;
 DELETE FROM public.wheel_card_awards WHERE user_id=p_player;
 UPDATE public.diamond_game_pools SET reserved_chips=0,wheel_allocated_diamonds=0 WHERE host_id=p_host;
END $clear$;

DO $probe$
DECLARE
 player uuid:='d1000000-0000-4000-8000-000000000005';
 vip_player uuid:='d1000000-0000-4000-8000-000000000001';
 owner uuid:='d1000000-0000-4000-8000-000000000002';
 club uuid:='d1000000-0000-4000-8000-000000000003';
 entry integer:=25;spins integer:=400;
 i integer;commit uuid;seed text;result jsonb;st jsonb;v_kind text;v_ord integer;game text;
 prev_ord integer;prev_game text;prev_kind text;
 counts jsonb:='{}';games_n integer:=0;chips_n integer:=0;items_n integer:=0;chi numeric;
 base integer[];row_weights integer[];w integer[];
 card_award uuid;card jsonb;recard jsonb;risk integer;paid integer;values_seen integer[];
 owner_before numeric;player_before numeric;member_before numeric;float_before numeric;journal_before bigint;
 run jsonb;run_id uuid;again jsonb;ended jsonb;award_ids uuid[];
 vip_st jsonb;vip_result jsonb;vip_member_before numeric;vip_mult numeric;vip_chips numeric;
 grant_rows bigint;burn_rows bigint;perm_seen integer[]:='{}';half_total integer:=0;card_total numeric:=0;card_games integer:=0;
 d date:=(clock_timestamp() AT TIME ZONE 'America/Chicago')::date;
 samples jsonb:='{}';sample_key text;
BEGIN
 -- ── the host is open, funded and in no hurry ──────────────────────────────
 UPDATE public.wheel_configs SET enabled=true,exposure_allowance_chips=1000000,min_seconds_between_spins=0,
   max_spins_per_player_per_day=100000,purchased_only=false,welcome_spin_enabled=false WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips)
  SELECT club,'club',g,true,0,1000000 FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET enabled=true,exposure_allowance_chips=1000000,min_seconds_between_rounds=0,
   max_multiplier_cents=100000,max_bet_diamonds=7500 WHERE host_id=club;
 -- A three-times card has to be covered before the seed is read, so the host
 -- puts up a float that can carry it at the largest entry this probe uses.
 UPDATE public.wheel_pools SET diamond_float=50000 WHERE host_id=club;
 UPDATE public.diamond_wheel_release SET enabled=true;
 IF (SELECT contract_version FROM public.diamond_wheel_release)<>4 THEN
  RAISE EXCEPTION 'The release row does not name contract 4'; END IF;

 -- ── A. FOUR HUNDRED REAL SPINS ────────────────────────────────────────────
 SELECT array_agg(m.weight ORDER BY m.ord) INTO base FROM public.fn_wheel_v4_model() m;
 prev_ord:=NULL;prev_game:=NULL;
 FOR i IN 1..spins LOOP
  seed:=encode(extensions.digest('wheel-v4-draw-'||i,'sha256'),'hex');
  commit:=gen_random_uuid();
  INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash)
   VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  SET LOCAL ROLE authenticated;
  result:=public.fn_wheel_spin_v2(club,commit,'v4probe',entry,'paid',NULL);
  RESET ROLE;
  IF result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Spin % was refused: %',i,result; END IF;
  v_ord:=(result#>>'{outcome,ord}')::integer;
  v_kind:=result#>>'{outcome,kind}';
  game:=COALESCE(result#>>'{secondary,outcome,game}',result#>>'{outcome,game}');
  -- The receipt says what it is and what it drew from.
  IF result->>'contract_version'<>'4' OR result->>'segment_version'<>'4' OR result->>'model'<>'wheel-v4'
   OR result->>'vip'<>'false' OR result#>>'{fairness,domain}'<>'wheel-v4'
   OR jsonb_array_length(result->'segments')<>12
   OR (SELECT sum((s->>'weight')::integer) FROM jsonb_array_elements(result->'segments') s)<>100000 THEN
   RAISE EXCEPTION 'Spin % is not a v4 receipt: %',i,result->'outcome'; END IF;
  SELECT array_agg(v::integer ORDER BY o) INTO w FROM jsonb_array_elements_text(result#>'{fairness,weights}') WITH ORDINALITY x(v,o);
  row_weights:=public.fn_wheel_v4_weights(prev_ord::smallint,CASE WHEN prev_ord=12 THEN prev_game END);
  IF w IS DISTINCT FROM row_weights THEN
   RAISE EXCEPTION 'Spin % drew from % but the published law after ord % (%) is %',i,w,prev_ord,prev_game,row_weights; END IF;
  IF (result#>>'{fairness,weight_total}')::integer<>(SELECT sum(x) FROM unnest(w) x)
   OR (SELECT array_agg(v::integer ORDER BY v::integer) FROM jsonb_array_elements_text(result#>'{fairness,eligible_ords}') v)
      IS DISTINCT FROM (SELECT array_agg(o ORDER BY o) FROM generate_series(1,12) o WHERE w[o]>0)
   OR w[v_ord]<=0 THEN
   RAISE EXCEPTION 'Spin % has an eligible list that does not match its weights',i; END IF;
  IF prev_ord IS NULL THEN
   IF result#>'{fairness,previous}'<>'null'::jsonb THEN RAISE EXCEPTION 'The first spin invented a previous outcome'; END IF;
  ELSIF (result#>>'{fairness,previous,ord}')::integer<>prev_ord
     OR result#>>'{fairness,previous,game}' IS DISTINCT FROM prev_game THEN
   RAISE EXCEPTION 'Spin % names the wrong previous outcome: %',i,result#>'{fairness,previous}'; END IF;
  -- R12 ITSELF.
  IF prev_ord IS NOT NULL AND v_ord=prev_ord THEN RAISE EXCEPTION 'Spin % repeated ord %',i,v_ord; END IF;
  IF prev_game IS NOT NULL AND game IS NOT NULL AND game=prev_game THEN
   RAISE EXCEPTION 'Spin % repeated the game % across tiers',i,game; END IF;
  IF v_kind IN('bonus','upgrade','diamonds') THEN games_n:=games_n+1;
  ELSIF v_kind='chips' THEN chips_n:=chips_n+1;
  ELSIF v_kind IN('throwables','time_bank','rabbit_hunt') THEN items_n:=items_n+1;
  ELSE RAISE EXCEPTION 'Spin % paid an unknown kind %',i,v_kind; END IF;
  -- Keep the first receipt each ord produced, and the very first spin of all,
  -- so the browser verifier is tested against what Postgres actually wrote.
  IF i=1 THEN samples:=jsonb_set(samples,ARRAY['first'],result); END IF;
  IF NOT samples?v_ord::text THEN samples:=jsonb_set(samples,ARRAY[v_ord::text],result); END IF;
  IF v_kind='upgrade' AND result#>>'{secondary,outcome,kind}'='bonus' AND NOT samples?'upgrade-game' THEN
   samples:=jsonb_set(samples,ARRAY['upgrade-game'],result); END IF;
  IF v_kind='upgrade' AND result#>>'{secondary,outcome,kind}'='chips' AND NOT samples?'upgrade-chips' THEN
   samples:=jsonb_set(samples,ARRAY['upgrade-chips'],result); END IF;
  IF prev_game IS NOT NULL AND prev_ord=12 AND NOT samples?'cross-tier' THEN
   samples:=jsonb_set(samples,ARRAY['cross-tier'],result); END IF;
  prev_ord:=v_ord;prev_game:=game;
  PERFORM pg_temp.clear_queue(player,club);
 END LOOP;
 -- The mix is the base law, so it must land on 50 / 30 / 20.
 chi:=(games_n-spins*.5)^2/(spins*.5)+(chips_n-spins*.3)^2/(spins*.3)+(items_n-spins*.2)^2/(spins*.2);
 IF chi>=13.816 THEN
  RAISE EXCEPTION 'The mix over % spins was %/%/% (chi-square % on two degrees of freedom)',spins,games_n,chips_n,items_n,chi; END IF;

 -- ── B. THE VIP WHEEL (R2) ─────────────────────────────────────────────────
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 UPDATE public.profiles SET is_vip=true,vip_tier='lifetime',vip_expires_at=NULL WHERE id=vip_player;
 PERFORM public.add_diamonds_to_balance(vip_player,100000,'adjustment','VIP probe float','wheel-v4-vip-float',NULL);
 PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
 IF NOT public.fn_wheel_is_vip(vip_player) OR public.fn_wheel_is_vip(player) THEN
  RAISE EXCEPTION 'The VIP helper does not answer the fixture'; END IF;
 PERFORM set_config('test.user',vip_player::text,true);
 SET LOCAL ROLE authenticated;
 vip_st:=public.fn_wheel_state_v2(club,100);
 RESET ROLE;
 samples:=jsonb_set(samples,ARRAY['vip-state'],vip_st);
 IF vip_st->>'vip'<>'true' OR vip_st->>'model_version'<>'wheel-v4' OR vip_st->>'contract_version'<>'4'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(vip_st->'segments') s WHERE s->>'kind' IN('throwables','time_bank','rabbit_hunt'))
  OR (SELECT count(*) FROM jsonb_array_elements(vip_st->'segments') s WHERE s->>'kind'='chips')<>6 THEN
  RAISE EXCEPTION 'A VIP is still shown items before the spin: %',vip_st->'segments'; END IF;
 FOR v_ord IN SELECT unnest(ARRAY[3,6,9]) LOOP
  SELECT COALESCE(chip_balance,0) INTO vip_member_before FROM public.club_members WHERE club_id=club AND user_id=vip_player;
  vip_result:=pg_temp.force_ord(vip_player,club,v_ord,100,'vip');
  vip_mult:=(vip_result#>>'{outcome,multiplier}')::numeric;
  vip_chips:=(vip_result#>>'{outcome,amount}')::numeric;
  IF vip_result->>'vip'<>'true' OR vip_result#>>'{outcome,kind}'<>'chips'
   OR vip_mult IS DISTINCT FROM (CASE v_ord WHEN 3 THEN .2 WHEN 6 THEN .25 ELSE .3 END)
   OR vip_chips<>100*vip_mult/100
   OR (vip_result#>>'{outcome,value_chips}')::numeric<>vip_chips
   OR (SELECT COALESCE(chip_balance,0) FROM public.club_members WHERE club_id=club AND user_id=vip_player)<>vip_member_before+vip_chips
   OR (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key IN('wheel-prize:'||(vip_result->>'spin_id'),'wheel-prize:'||(vip_result->>'spin_id')||':bank') AND status='posted' AND category='wheel_prize' AND to_entity_id=vip_player)<1
   OR (SELECT count(*) FROM public.chip_transactions WHERE club_id=club AND to_user_id=vip_player AND transaction_type='wheel_prize' AND amount=vip_chips)<1 THEN
   RAISE EXCEPTION 'The VIP card on ord % did not pay chips exactly: %',v_ord,vip_result->'outcome'; END IF;
  samples:=jsonb_set(samples,ARRAY['vip-'||v_ord],vip_result);
  PERFORM pg_temp.clear_queue(vip_player,club);
 END LOOP;
 -- Sixty real VIP spins, and not one item among them.
 FOR i IN 1..60 LOOP
  seed:=encode(extensions.digest('wheel-v4-vip-draw-'||i,'sha256'),'hex');
  commit:=gen_random_uuid();
  INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash)
   VALUES(commit,vip_player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  SET LOCAL ROLE authenticated;
  result:=public.fn_wheel_spin_v2(club,commit,'v4probe',100,'paid',NULL);
  RESET ROLE;
  IF result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'A VIP spin was refused: %',result; END IF;
  IF result#>>'{outcome,kind}' IN('throwables','time_bank','rabbit_hunt') OR result->'outcome'->'grants' IS NOT NULL THEN
   RAISE EXCEPTION 'A VIP won an item: %',result->'outcome'; END IF;
  PERFORM pg_temp.clear_queue(vip_player,club);
 END LOOP;
 IF (SELECT count(*) FROM public.feature_purchases WHERE user_id=vip_player AND source='diamond_wheel')<>0 THEN
  RAISE EXCEPTION 'A VIP was granted wheel inventory'; END IF;
 PERFORM set_config('test.user',player::text,true);

 -- ── C. THE THREE-CARD GAME (R15) ──────────────────────────────────────────
 PERFORM pg_temp.clear_queue(player,club);
 SELECT COALESCE(diamonds,0) INTO player_before FROM public.profiles WHERE id=player;
 SELECT COALESCE(diamonds,0) INTO owner_before FROM public.profiles WHERE id=owner;
 SELECT diamond_float INTO float_before FROM public.wheel_pools WHERE host_id=club;
 SELECT count(*) INTO journal_before FROM public.diamond_transactions WHERE user_id=player;
 result:=pg_temp.force_ord(player,club,5,100,'cards');
 card_award:=(result#>>'{outcome,cards,award_id}')::uuid;
 risk:=(result#>>'{outcome,cards,risk_diamonds}')::integer;
 IF card_award IS NULL OR risk<>100 OR result#>>'{outcome,cards,status}'<>'pending'
  OR (result#>>'{outcome,amount}')::integer<>100
  OR result#>'{outcome,cards}'?'values'
  OR (SELECT COALESCE(diamonds,0) FROM public.profiles WHERE id=player)<>player_before-100
  OR EXISTS(SELECT 1 FROM public.diamond_transactions WHERE reference_id='wheel-cards:'||card_award)
  OR (SELECT diamond_float FROM public.wheel_pools WHERE host_id=club)<>float_before+100 THEN
  RAISE EXCEPTION 'The Diamonds outcome paid or revealed before the pick: %',result->'outcome'; END IF;
 -- A pending card blocks the next spin exactly like an unplayed bonus game.
 commit:=gen_random_uuid();
 INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,'blocked','hash');
 SET LOCAL ROLE authenticated;
 again:=public.fn_wheel_spin_v2(club,commit,'v4probe',100,'paid',NULL);
 RESET ROLE;
 IF again->>'ok' IS DISTINCT FROM 'false' OR again->>'error'<>'Pick Your Diamond Card Before Another Spin' THEN
  RAISE EXCEPTION 'An unpicked card did not block the next spin: %',again; END IF;
 SELECT COALESCE(diamonds,0) INTO player_before FROM public.profiles WHERE id=player;
 SELECT count(*) INTO journal_before FROM public.diamond_transactions WHERE user_id=player;
 SELECT diamond_float INTO float_before FROM public.wheel_pools WHERE host_id=club;
 SET LOCAL ROLE authenticated;
 card:=public.fn_wheel_diamond_cards_pick(card_award,2::smallint);
 recard:=public.fn_wheel_diamond_cards_pick(card_award,2::smallint);
 RESET ROLE;
 paid:=(card->>'paid_diamonds')::integer;
 SELECT array_agg(v::integer ORDER BY o) INTO values_seen FROM jsonb_array_elements_text(card->'cards') WITH ORDINALITY x(v,o);
 IF card->>'ok' IS DISTINCT FROM 'true' OR recard->>'ok' IS DISTINCT FROM 'true'
  OR (card->>'picked')::integer<>2 OR (recard->>'paid_diamonds')::integer<>paid
  OR recard->'cards' IS DISTINCT FROM card->'cards' OR recard->>'replayed'<>'true'
  OR cardinality(values_seen)<>3 OR values_seen[2]<>paid
  OR (SELECT count(DISTINCT v) FROM unnest(values_seen) v)<>3
  OR (SELECT array_agg(v ORDER BY v) FROM unnest(values_seen) v) IS DISTINCT FROM ARRAY[50,200,300]
  OR paid NOT IN(50,200,300)
  OR card#>>'{fairness,domain}'<>'wheel-v4-cards'
  OR (card#>>'{fairness,permutation}')::integer NOT BETWEEN 0 AND 5 THEN
  RAISE EXCEPTION 'The card pick did not reveal three sealed prizes and pay one: % / %',card,recard; END IF;
 IF (SELECT COALESCE(diamonds,0) FROM public.profiles WHERE id=player)<>player_before+paid
  OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=player AND reference_id='wheel-cards:'||card_award AND amount=paid AND transaction_type='transfer')<>1
  OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=player)<>journal_before+1
  OR (SELECT count(*) FROM public.diamond_spin_movements dsm WHERE dsm.operation_id='wheel-cards:'||card_award||':custody' AND dsm.owner_id=owner AND dsm.kind='diamond_prize' AND amount=-paid AND day=d)<>1
  OR (SELECT diamond_float FROM public.wheel_pools WHERE host_id=club)<>float_before-paid
  OR (SELECT diamond_float FROM public.wheel_pools WHERE host_id=club)<0 THEN
  RAISE EXCEPTION 'The card payment is not journaled on both sides exactly once'; END IF;
 samples:=jsonb_set(samples,ARRAY['cards'],result);
 samples:=jsonb_set(samples,ARRAY['card-pick'],card);
 samples:=jsonb_set(samples,ARRAY['card-pick-replay'],recard);
 -- The spin after a picked card is allowed again.
 PERFORM pg_temp.clear_queue(player,club);
 -- Over the six sealed orders the game is worth 11/6 of the risk whichever card
 -- the player takes. Read straight from the installed sealer.
 FOR i IN 0..5 LOOP
  values_seen:=public.fn_wheel_card_values(50,100,i::smallint);
  card_total:=card_total+values_seen[1]+values_seen[2]+values_seen[3];
 END LOOP;
 IF card_total<>3*11*100 THEN RAISE EXCEPTION 'The sealed card orders are not worth 11/6 on average: %',card_total; END IF;

 -- ── D. THE RUN (R18) ──────────────────────────────────────────────────────
 -- An award won BEFORE the run still blocks, run or no run. It is a different
 -- game from the run's first spin, because no prize may follow itself.
 result:=pg_temp.force_ord(player,club,10,100,'prerun');
 SET LOCAL ROLE authenticated;
 run:=public.fn_wheel_run_begin(club,5);
 RESET ROLE;
 IF run->>'ok' IS DISTINCT FROM 'true' OR (run->>'spins')::integer<>5 OR (run->>'spins_done')::integer<>0 THEN
  RAISE EXCEPTION 'A run could not be started: %',run; END IF;
 run_id:=(run->>'run_id')::uuid;
 commit:=gen_random_uuid();
 INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,'prerun-block','hash');
 SET LOCAL ROLE authenticated;
 again:=public.fn_wheel_spin_v2(club,commit,'v4probe',100,'paid',NULL);
 RESET ROLE;
 IF again->>'ok' IS DISTINCT FROM 'false' OR again->>'error'<>'Finish Your Bonus Game Before Another Spin' THEN
  RAISE EXCEPTION 'An award won before the run did not block inside it: %',again; END IF;
 -- Begin is idempotent for the same run and refuses a different one.
 SET LOCAL ROLE authenticated;
 again:=public.fn_wheel_run_begin(club,5);
 ended:=public.fn_wheel_run_begin(club,25);
 RESET ROLE;
 IF (again->>'run_id')::uuid<>run_id OR ended->>'ok' IS DISTINCT FROM 'false'
  OR ended->>'error'<>'Finish The Run You Already Started' THEN
  RAISE EXCEPTION 'A second run began beside the open one: % / %',again,ended; END IF;
 PERFORM pg_temp.clear_queue(player,club);
 -- Five spins inside the run, every one of them leaving a prize unplayed.
 award_ids:='{}';
 FOREACH v_ord IN ARRAY ARRAY[1,4,7,10,5] LOOP
  result:=pg_temp.force_ord(player,club,v_ord,100,'run');
  IF (result#>>'{auto_run,run_id}')::uuid<>run_id THEN RAISE EXCEPTION 'A run spin did not name its run: %',result->'auto_run'; END IF;
 END LOOP;
 SET LOCAL ROLE authenticated;
 st:=public.fn_wheel_state_v2(club,100);
 RESET ROLE;
 samples:=jsonb_set(samples,ARRAY['run-state'],st);
 IF (st#>>'{auto_run,run_id}')::uuid<>run_id OR (st#>>'{auto_run,spins_done}')::integer<>5
  OR jsonb_array_length(st->'pending_awards')<>4 OR jsonb_array_length(st->'pending_cards')<>1
  OR st->>'vip'<>'false' OR st->>'model_version'<>'wheel-v4' THEN
  RAISE EXCEPTION 'The state does not show the open run and its queue: %',jsonb_build_object('run',st->'auto_run','awards',st->'pending_awards','cards',st->'pending_cards'); END IF;
 -- The spin after the last one is refused, and nothing is charged for it.
 SELECT COALESCE(diamonds,0) INTO player_before FROM public.profiles WHERE id=player;
 commit:=gen_random_uuid();
 INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,'over-run','hash');
 SET LOCAL ROLE authenticated;
 again:=public.fn_wheel_spin_v2(club,commit,'v4probe',100,'paid',NULL);
 RESET ROLE;
 IF again->>'ok' IS DISTINCT FROM 'false' OR again->>'error'<>'This Run Is Finished. Play The Prizes You Won'
  OR (SELECT COALESCE(diamonds,0) FROM public.profiles WHERE id=player)<>player_before
  OR (SELECT consumed_by FROM public.wheel_seed_commits WHERE id=commit) IS NOT NULL THEN
  RAISE EXCEPTION 'The spin after the last one was not refused cleanly: %',again; END IF;
 SET LOCAL ROLE authenticated;
 ended:=public.fn_wheel_run_end(run_id);
 again:=public.fn_wheel_run_end(run_id);
 RESET ROLE;
 samples:=jsonb_set(samples,ARRAY['run-end'],ended);
 IF ended->>'ok' IS DISTINCT FROM 'true' OR (ended->>'run_id')::uuid<>run_id OR (ended->>'spins_done')::integer<>5
  OR jsonb_array_length(ended->'pending_awards')<>4 OR jsonb_array_length(ended->'pending_cards')<>1
  OR again IS DISTINCT FROM ended THEN
  RAISE EXCEPTION 'The run did not end idempotently with its queue: % / %',ended,again; END IF;
 -- Once the run is closed its own prizes block again.
 commit:=gen_random_uuid();
 INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,'after-run','hash');
 SET LOCAL ROLE authenticated;
 again:=public.fn_wheel_spin_v2(club,commit,'v4probe',100,'paid',NULL);
 RESET ROLE;
 IF again->>'ok' IS DISTINCT FROM 'false' OR again->>'error'<>'Finish Your Bonus Game Before Another Spin' THEN
  RAISE EXCEPTION 'A closed run left its prizes unplayable: %',again; END IF;
 PERFORM pg_temp.clear_queue(player,club);

 -- ── E. EVERY MOVEMENT HAS ITS ROWS ────────────────────────────────────────
 -- An item grant at a quarter of the entry: the feature rows, the custody
 -- movement and the canonical Mint burn that retires the custody diamonds.
 SELECT count(*) INTO grant_rows FROM public.feature_purchases WHERE user_id=player AND source='diamond_wheel';
 SELECT count(*) INTO burn_rows FROM public.ca_mint_ledger WHERE action='burn' AND asset='diamonds' AND holder_id=owner;
 result:=pg_temp.force_ord(player,club,9,100,'item');
 IF (result#>>'{outcome,kind}')<>'rabbit_hunt'
  OR (result#>>'{outcome,amount}')::integer<>((result#>'{outcome,grants}')->0->>'uses')::integer
  OR (SELECT count(*) FROM public.feature_purchases WHERE user_id=player AND source='diamond_wheel')<=grant_rows
  OR (SELECT count(*) FROM public.diamond_spin_movements dsm WHERE dsm.operation_id='wheel:'||(result->>'spin_id')||':inventory' AND dsm.owner_id=owner AND dsm.kind='rabbit_hunt' AND dsm.amount<0)<>1
  OR (SELECT count(*) FROM public.ca_mint_ledger WHERE action='burn' AND asset='diamonds' AND holder_id=owner)<=burn_rows THEN
  RAISE EXCEPTION 'An item grant did not write its rows: %',result->'outcome'; END IF;
 -- A quarter of the entry, not the half v3 paid: 100 diamonds buys five rabbit
 -- hunts at five diamonds each, and the owner's custody is debited exactly 25.
 IF (SELECT -sum(dsm.amount) FROM public.diamond_spin_movements dsm
      WHERE dsm.operation_id IN('wheel:'||(result->>'spin_id')||':inventory','wheel:'||(result->>'spin_id')||':inventory-remainder'))<>25
  OR (result#>>'{outcome,amount}')::integer<>5
  OR (result#>>'{outcome,value_chips}')::numeric<>0.25
  OR jsonb_array_length(result#>'{outcome,grants}')<>1 THEN
  RAISE EXCEPTION 'The item grant is not a quarter of the entry: %',result->'outcome'; END IF;
 PERFORM pg_temp.clear_queue(player,club);
 -- The entry itself, on the spin that just ran: one journal row, one movement.
 IF (SELECT count(*) FROM public.diamond_transactions WHERE user_id=player AND reference_id='wheel:'||(result->>'spin_id') AND amount=-100 AND transaction_type='wheel_spin')<>1
  OR (SELECT count(*) FROM public.diamond_spin_movements dsm WHERE dsm.operation_id='wheel:'||(result->>'spin_id')||':intake' AND dsm.owner_id=owner AND dsm.kind='entry' AND dsm.amount=100)<>1 THEN
  RAISE EXCEPTION 'A spin entry is missing its journal or custody row'; END IF;
 -- The owner's day still equals the sum of its movements.
 IF (SELECT pending_diamonds FROM public.diamond_spin_days WHERE owner_id=owner AND day=d)
    IS DISTINCT FROM (SELECT sum(amount) FROM public.diamond_spin_movements WHERE owner_id=owner AND day=d) THEN
  RAISE EXCEPTION 'The owner day does not equal its movements'; END IF;

 -- ── F. THE RECEIPTS THE BROWSER MUST BE ABLE TO CHECK ─────────────────────
 -- Every ord the four hundred spins did not happen to produce is forced, so the
 -- captured set covers all twelve. Nothing is hand written: these NOTICEs are
 -- what tests/fixtures/diamond-spins/wheel-v4-postgres-receipts.json is built from.
 PERFORM pg_temp.clear_queue(player,club);
 FOREACH v_ord IN ARRAY ARRAY[2,8,11,12] LOOP
  IF NOT samples?v_ord::text THEN
   result:=pg_temp.force_ord(player,club,v_ord,100,'capture');
   samples:=jsonb_set(samples,ARRAY[v_ord::text],result);
   PERFORM pg_temp.clear_queue(player,club);
  END IF;
 END LOOP;
 FOR v_ord IN 1..12 LOOP
  IF NOT samples?v_ord::text THEN RAISE EXCEPTION 'No captured receipt for ord %',v_ord; END IF;
 END LOOP;
 -- An Upgrade landing a Super game, the ordinary spin right after it (whose law
 -- has that game's ordinary card removed as well), and an Upgrade landing chips.
 -- 1x Chips is forced first each time because its row gives Upgrade its best odds.
 IF NOT samples?'upgrade-game' OR NOT samples?'cross-tier' THEN
  PERFORM pg_temp.force_ord(player,club,2,100,'capture-lead');
  result:=pg_temp.force_ord(player,club,12,100,'capture-super','bonus');
  samples:=jsonb_set(samples,ARRAY['upgrade-game'],result);
  PERFORM pg_temp.clear_queue(player,club);
  seed:=encode(extensions.digest('wheel-v4-capture-cross','sha256'),'hex');
  commit:=gen_random_uuid();
  INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash)
   VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  SET LOCAL ROLE authenticated;
  result:=public.fn_wheel_spin_v2(club,commit,'v4probe',100,'paid',NULL);
  RESET ROLE;
  IF result->>'ok' IS DISTINCT FROM 'true' OR result#>>'{fairness,previous,tier}'<>'super' THEN
   RAISE EXCEPTION 'The cross-tier capture did not follow a Super game: %',result; END IF;
  samples:=jsonb_set(samples,ARRAY['cross-tier'],result);
  PERFORM pg_temp.clear_queue(player,club);
 END IF;
 IF NOT samples?'upgrade-chips' THEN
  PERFORM pg_temp.force_ord(player,club,2,100,'capture-lead2');
  result:=pg_temp.force_ord(player,club,12,100,'capture-chips','chips');
  samples:=jsonb_set(samples,ARRAY['upgrade-chips'],result);
  PERFORM pg_temp.clear_queue(player,club);
 END IF;
 SET LOCAL ROLE authenticated;
 st:=public.fn_wheel_state_v2(club,100);
 RESET ROLE;
 samples:=jsonb_set(samples,ARRAY['state'],st);
 FOR sample_key IN SELECT jsonb_object_keys(samples) ORDER BY 1 LOOP
  RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel-v4-'||sample_key,'stake',100,'value',samples->sample_key);
 END LOOP;

 RAISE NOTICE 'PASS Wheel v4 draw and cards: % real spins with no repeated prize or game, the mix %/%/% (chi-square %), every receipt naming contract 4, the model, its row of weights and the outcome it excluded; a lifetime VIP shown and paid six chip cards and never one item in sixty spins; Diamonds sealed and paid exactly one of 50/200/300 once, idempotent, all three revealed, 11/6 over the six orders; a run of five accumulating four games and one card, refusing the sixth spin, ending idempotently, with a pre-run award blocking throughout; and every entry, prize and grant journaled in custody',spins,games_n,chips_n,items_n,round(chi,3);
END $probe$;
ROLLBACK;
