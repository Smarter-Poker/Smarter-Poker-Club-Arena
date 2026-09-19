-- Private native PostgreSQL only. Every replay begins with an actual paid
-- wheel award and a real settled bonus, never a manufactured JSON receipt.
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL request.jwt.claims='{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated"}';
DO $$
#variable_conflict use_variable
DECLARE
 player uuid:='d1000000-0000-4000-8000-000000000005';
 stranger uuid:='d1000000-0000-4000-8000-000000000001';
 club uuid:='d1000000-0000-4000-8000-000000000003';
 game text; boosted integer; game_ord integer; target integer; nonce bigint;
 lo integer; hi integer; up_lo integer; up_hi integer; point numeric; point2 numeric; roll numeric;
 i integer; seed text; game_seed text; commit uuid; game_commit uuid; award uuid; entry uuid; rid uuid; share_id uuid;
 spun jsonb; started jsonb; settled jsonb; replay jsonb; repeated jsonb; shared jsonb; feed jsonb; history jsonb;
 expected numeric; cell integer; before_chips numeric; before_diamonds integer; ids uuid[]:='{}'; first_share uuid;
 refused boolean; post uuid; payload jsonb; keys text[]; expected_road integer; failed_share uuid;
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Requires The Isolated Fixture'; END IF;
 UPDATE public.wheel_configs SET exposure_allowance_chips=100000 WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips)
 SELECT club,'club',g,true,0,100000 FROM unnest(ARRAY['crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET exposure_allowance_chips=100000,min_seconds_between_rounds=0 WHERE host_id=club;
 UPDATE public.diamond_game_configs SET max_multiplier_cents=100000,growth_k=.12 WHERE host_id=club AND diamond_game_configs.game='crash';
 IF NOT EXISTS(SELECT 1 FROM public.diamond_game_configs WHERE host_id=club AND diamond_game_configs.game='crash' AND max_multiplier_cents=10000 AND growth_k=.04)
  OR public.fn_crash_multiplier_cents(.04,10000,10000)<>149 OR public.fn_crash_multiplier_cents(.04,120000,10000)<>10000 THEN
  RAISE EXCEPTION 'Future Crash Configuration Does Not Enforce Slow 100x Flight';
 END IF;
 UPDATE public.diamond_wheel_release SET enabled=true;
 -- An established player exercises the canonical social reward trigger too.
 UPDATE public.profiles SET created_at=now()-interval '2 days' WHERE id=player;
 FOR boosted IN 1..2 LOOP
  FOREACH game IN ARRAY ARRAY['plinko','crash','crossing','mines'] LOOP
   game_ord:=array_position(ARRAY['plinko','crash','crossing','mines'],game);
   target:=CASE WHEN boosted=2 THEN 12 ELSE (ARRAY[1,4,7,10])[game_ord] END;
   SELECT coalesce(sum(weight) FILTER(WHERE ord<target),0),sum(weight) FILTER(WHERE ord<=target) INTO lo,hi FROM public.fn_wheel_v3_model();
   SELECT coalesce(sum(weight) FILTER(WHERE ord<game_ord),0),sum(weight) FILTER(WHERE ord<=game_ord) INTO up_lo,up_hi FROM public.fn_wheel_v3_upgrade_model();
   SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=player;
   FOR i IN 1..100000 LOOP
    seed:=encode(extensions.digest('replay-wheel-'||boosted||'-'||game||'-'||i,'sha256'),'hex');
    point:=floor((('x'||substr(encode(extensions.hmac('wheel-v3:replay-client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
    point2:=floor((('x'||substr(encode(extensions.hmac('wheel-v3-upgrade:replay-client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
    EXIT WHEN point>=lo AND point<hi AND (boosted=1 OR (point2>=up_lo AND point2<up_hi));
   END LOOP;
   commit:=gen_random_uuid();
   INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
   SET LOCAL ROLE authenticated;
   spun:=public.fn_wheel_spin_v2(club,commit,'replay-client',100,'paid',NULL);
   RESET ROLE;
   IF spun->>'ok' IS DISTINCT FROM 'true' OR (spun#>>'{outcome,ord}')::integer IS DISTINCT FROM target OR spun#>>'{bonus,game}' IS DISTINCT FROM game THEN RAISE EXCEPTION 'Replay Award Failed: %',spun; END IF;
   award:=(spun#>>'{bonus,id}')::uuid;
   IF game='crash' THEN SELECT count(*)+1 INTO nonce FROM public.crash_rounds WHERE user_id=player;
   ELSE SELECT count(*)+1 INTO nonce FROM public.diamond_choice_rounds WHERE user_id=player AND diamond_choice_rounds.game=game; END IF;
   FOR i IN 1..10000 LOOP
    game_seed:=encode(extensions.digest('replay-game-'||game||'-'||boosted||'-'||i,'sha256'),'hex');
    roll:=(('x'||substr(encode(extensions.hmac('replay-game:'||nonce||CASE WHEN game='crossing' THEN ':road' ELSE '' END,game_seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric;
    EXIT WHEN game IN('plinko','mines') OR (game='crossing' AND ((boosted=1 AND roll<281474976710656*.1) OR (boosted=2 AND roll>281474976710656*.9))) OR
      (game='crash' AND ((boosted=1 AND public.fn_crash_point_cents(roll,1,.1)>400) OR (boosted=2 AND public.fn_crash_point_cents(roll,3,.3)=100)));
   END LOOP;
   game_commit:=gen_random_uuid();
   INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(game_commit,player,game,game_seed,encode(extensions.digest(game_seed,'sha256'),'hex'));
   SET LOCAL ROLE authenticated;
   started:=public.fn_wheel_bonus_start(award,game_commit,'replay-game',boosted=2,CASE WHEN game='mines' THEN '5' ELSE 'steady' END,100,1,NULL,2);
   RESET ROLE;
   IF started->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Replay Game Start Failed: %',started; END IF;
   SELECT id INTO entry FROM public.diamond_bonus_entries WHERE commit_id=game_commit;
   ids:=array_append(ids,entry);
   rid:=coalesce(started->>'round_id',started->>'id')::uuid;
   IF game<>'plinko' THEN
    SET LOCAL ROLE authenticated;
    replay:=public.fn_diamond_bonus_replay(entry);
    shared:=public.fn_diamond_bonus_share(entry);
    history:=public.fn_diamond_bonus_replays(club);
    RESET ROLE;
    IF replay->>'ok' IS DISTINCT FROM 'false' OR shared->>'ok' IS DISTINCT FROM 'false' OR EXISTS(SELECT 1 FROM jsonb_array_elements(history->'replays') r WHERE r->>'id'=entry::text) THEN RAISE EXCEPTION 'Open Outcome Leaked'; END IF;
    IF game='crash' THEN
     IF NOT EXISTS(SELECT 1 FROM public.crash_rounds WHERE id=rid AND growth_k=.04 AND cap_cents<=10000) THEN RAISE EXCEPTION 'New Flight Used Old Speed Or Cap'; END IF;
     UPDATE public.crash_rounds SET started_at=clock_timestamp()-interval '25 seconds' WHERE id=rid;
     SET LOCAL ROLE authenticated;
     settled:=public.fn_crash_cashout(rid,257);
     RESET ROLE;
    ELSE
     IF game='mines' THEN SELECT n INTO cell FROM generate_series(0,24) n,public.diamond_choice_rounds r WHERE r.id=rid AND (n=ANY(r.mine_cells))=(boosted=2) LIMIT 1; ELSE cell:=0; END IF;
     SET LOCAL ROLE authenticated;
     settled:=public.fn_choice_act(rid,'pick',cell,0);
     RESET ROLE;
     IF coalesce(settled#>>'{outcome,status}',settled->>'status')='open' THEN
      SET LOCAL ROLE authenticated;
      settled:=public.fn_choice_act(rid,'cashout',NULL,1);
      RESET ROLE;
     END IF;
    END IF;
   END IF;
   SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
   SELECT diamonds INTO before_diamonds FROM public.profiles WHERE id=player;
   SET LOCAL ROLE authenticated;
   replay:=public.fn_diamond_bonus_replay(entry);
   repeated:=public.fn_diamond_bonus_replay(entry);
   shared:=public.fn_diamond_bonus_share(entry);
   RESET ROLE;
   payload:=replay->'replay';
   IF replay->>'ok' IS DISTINCT FROM 'true' OR repeated IS DISTINCT FROM replay OR payload->>'game' IS DISTINCT FROM game OR (payload->>'boost')::integer IS DISTINCT FROM boosted OR
     (payload->>'diamonds')::integer IS DISTINCT FROM (CASE WHEN boosted=2 THEN 300 ELSE 100 END) THEN RAISE EXCEPTION 'Replay Lost Entry Or Super Budget: %',replay; END IF;
   SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(payload) k;
   IF keys IS DISTINCT FROM ARRAY['boost','completed_at','data','diamonds','game','payout_chips','version']::text[] OR payload::text ~ '(server_seed|client_seed|user_id|club_id|owner_id|balance|commit_id)' THEN RAISE EXCEPTION 'Replay Contains Private Receipt Data: %',payload; END IF;
   IF game='plinko' THEN
    IF payload->'data' IS DISTINCT FROM jsonb_build_object('multipliers_cents',started->'multipliers_cents','drops',started->'drops','diamonds_per_drop',started->'diamonds_per_drop','table_name',started->'table_name') OR payload->'payout_chips' IS DISTINCT FROM started->'payout_chips' THEN RAISE EXCEPTION 'Plinko Replay Does Not Match Actual Drops'; END IF;
   ELSIF game='crash' THEN
    IF (payload->>'payout_chips')::numeric<>(CASE WHEN boosted=2 THEN .3 ELSE 2.57 END) OR (payload#>>'{data,growth_k}')::numeric<>.04 OR
      (boosted=1 AND ((payload#>>'{data,cashout_cents}')::integer IS DISTINCT FROM 257 OR payload#>>'{data,status}' IS DISTINCT FROM 'cashed')) OR
      (boosted=2 AND (payload#>>'{data,cashout_cents}' IS NOT NULL OR payload#>>'{data,status}' IS DISTINCT FROM 'crashed')) THEN RAISE EXCEPTION 'Crash Replay Does Not Match Exact Settlement: %',payload; END IF;
   ELSE
    IF payload#>'{data,picked}' IS DISTINCT FROM (SELECT to_jsonb(picked) FROM public.diamond_choice_rounds WHERE id=rid) OR payload#>'{data,mine_cells}' IS DISTINCT FROM (SELECT to_jsonb(mine_cells) FROM public.diamond_choice_rounds WHERE id=rid) OR (payload->>'payout_chips')::numeric IS DISTINCT FROM (SELECT payout_chips FROM public.diamond_choice_rounds WHERE id=rid) THEN RAISE EXCEPTION 'Choice Replay Does Not Match Sealed Round'; END IF;
    IF boosted=2 AND ((payload->>'payout_chips')::numeric IS DISTINCT FROM .3::numeric OR payload#>>'{data,status}' IS DISTINCT FROM 'lost') THEN RAISE EXCEPTION 'Super Loss Replay Lost Its Protected Minimum'; END IF;
    IF game='crossing' THEN
     SELECT count(*) INTO expected_road FROM public.diamond_choice_rounds d CROSS JOIN LATERAL unnest(d.prizes) p WHERE d.id=rid AND (d.road_roll::numeric+1)/281474976710656 <= (d.bet_chips*.8-d.minimum_payout_chips)/(p-d.minimum_payout_chips);
     IF (payload#>>'{data,road_end}')::integer IS DISTINCT FROM expected_road THEN RAISE EXCEPTION 'Crossing Full Road Reveal Changed'; END IF;
    END IF;
   END IF;
   share_id:=(shared->>'share_id')::uuid;
   IF share_id IS NULL OR share_id=entry THEN RAISE EXCEPTION 'Private Entry Reused As Public Token'; END IF;
   first_share:=coalesce(first_share,share_id);
   SET LOCAL ROLE authenticated;
   repeated:=public.fn_diamond_bonus_share(entry);
   RESET ROLE;
   IF repeated IS DISTINCT FROM shared OR (SELECT count(*) FROM public.diamond_bonus_shares WHERE bonus_id=entry)<>1 THEN RAISE EXCEPTION 'Sharing Duplicate Changed Token'; END IF;
   PERFORM set_config('test.user','',true); PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
   SET LOCAL ROLE anon;
   shared:=public.fn_shared_bonus_replay(share_id);
   repeated:=public.fn_shared_bonus_replay(entry);
   RESET ROLE;
   IF shared IS DISTINCT FROM replay OR repeated->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Public Replay Privacy Or Snapshot Failed'; END IF;
   PERFORM set_config('test.user',player::text,true); PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',player,'role','authenticated')::text,true);
   IF (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM before_chips OR (SELECT diamonds FROM public.profiles WHERE id=player) IS DISTINCT FROM before_diamonds THEN RAISE EXCEPTION 'Viewing Or Sharing Moved A Wallet'; END IF;
  END LOOP;
 END LOOP;
 SET LOCAL ROLE authenticated;
 history:=public.fn_diamond_bonus_replays(club);
 repeated:=public.fn_diamond_bonus_replays('a0000000-0000-0000-0000-000000000001');
 RESET ROLE;
 IF jsonb_array_length(history->'replays')<>8 OR jsonb_array_length(repeated->'replays')<>0 THEN RAISE EXCEPTION 'History Mixed Clubs Or Lost Settled Games'; END IF;
 SET LOCAL ROLE authenticated;
 repeated:=public.fn_diamond_bonus_replays(club,(history#>>'{replays,3,created_at}')::timestamptz,(history#>>'{replays,3,id}')::uuid);
 RESET ROLE;
 IF jsonb_array_length(repeated->'replays')<>4 OR EXISTS(SELECT 1 FROM jsonb_array_elements(repeated->'replays') r WHERE r->>'id' IN (SELECT p->>'id' FROM jsonb_array_elements(history->'replays') WITH ORDINALITY a(p,n) WHERE n<=4)) THEN RAISE EXCEPTION 'Stable Cursor Duplicated History'; END IF;
 PERFORM set_config('test.user',stranger::text,true); PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',stranger,'role','authenticated')::text,true);
 SET LOCAL ROLE authenticated;
 replay:=public.fn_diamond_bonus_replay(ids[1]); shared:=public.fn_diamond_bonus_share(ids[1]); feed:=public.fn_diamond_bonus_share_to_feed(first_share); history:=public.fn_diamond_bonus_replays(club);
 RESET ROLE;
 IF replay->>'ok' IS DISTINCT FROM 'false' OR shared->>'ok' IS DISTINCT FROM 'false' OR feed->>'ok' IS DISTINCT FROM 'false' OR jsonb_array_length(history->'replays')<>0 THEN RAISE EXCEPTION 'Another Player Read Or Published Private Replay'; END IF;
 PERFORM set_config('test.user',player::text,true); PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',player,'role','authenticated')::text,true);
 SELECT diamonds INTO before_diamonds FROM public.profiles WHERE id=player;
 SET LOCAL ROLE authenticated;
 feed:=public.fn_diamond_bonus_share_to_feed(first_share); repeated:=public.fn_diamond_bonus_share_to_feed(first_share);
 RESET ROLE;
 post:=(feed->>'post_id')::uuid;
 IF feed->>'ok' IS DISTINCT FROM 'true' OR feed IS DISTINCT FROM repeated OR post IS NULL OR
   (SELECT count(*) FROM public.social_posts WHERE author_id=player)<>1 OR
   (SELECT count(*) FROM public.social_stories WHERE author_id=player)<>1 OR
   NOT EXISTS(SELECT 1 FROM public.social_posts WHERE id=post AND content_type='text' AND visibility='public' AND achievement_data->>'share_id'=first_share::text AND position('/bonus-replay/'||first_share::text IN content)>0) THEN RAISE EXCEPTION 'Social Retry Did Not Produce One Canonical Post/Story: %',feed; END IF;
 IF (SELECT diamonds FROM public.profiles WHERE id=player) IS DISTINCT FROM before_diamonds+10 OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=player AND transaction_type='social_post')<>1 THEN RAISE EXCEPTION 'Real Social Reward Was Lost Or Duplicated'; END IF;
 -- A genuine canonical-post failure must not seal a false publication receipt
 -- or retain its wallet/story effects. The temporary constraint is rolled back
 -- with the deliberately failed subtransaction, never disabled on real tables.
 SELECT id INTO failed_share FROM public.diamond_bonus_shares WHERE id<>first_share LIMIT 1;
 refused:=false;
 BEGIN
  ALTER TABLE public.social_posts ADD CONSTRAINT isolated_replay_post_refusal CHECK(false) NOT VALID;
  SET LOCAL ROLE authenticated;
  PERFORM public.fn_diamond_bonus_share_to_feed(failed_share);
  RESET ROLE;
 EXCEPTION WHEN raise_exception THEN
  RESET ROLE;
  IF position('The Replay Could Not Be Shared:' IN SQLERRM)=0 THEN RAISE; END IF;
  refused:=true;
 END;
 IF NOT refused OR (SELECT social_post_id FROM public.diamond_bonus_shares WHERE id=failed_share) IS NOT NULL OR
   (SELECT count(*) FROM public.social_posts WHERE author_id=player)<>1 OR
   (SELECT count(*) FROM public.social_stories WHERE author_id=player)<>1 OR
   (SELECT diamonds FROM public.profiles WHERE id=player) IS DISTINCT FROM before_diamonds+10 THEN RAISE EXCEPTION 'Failed Publication Retained Side Effects'; END IF;
 refused:=false;
 BEGIN
  SET LOCAL ROLE authenticated;
  UPDATE public.profiles SET diamonds=diamonds+1 WHERE id=player;
  RESET ROLE;
 EXCEPTION WHEN insufficient_privilege THEN RESET ROLE; refused:=true;
 END;
 IF NOT refused THEN RAISE EXCEPTION 'Replay Sharing Opened Direct Wallet Writes'; END IF;
 -- A later unrelated grant must not close the public content link. The exact
 -- production event trigger remains active and still protects money helpers.
 GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_share(uuid) TO authenticated;
 IF NOT has_function_privilege('anon','public.fn_shared_bonus_replay(uuid)','EXECUTE')
 OR to_regprocedure('public.fn_diamond_bonus_shared(uuid)') IS NOT NULL
 OR md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_autorevoke_privileged_anon()'::regprocedure)) <> '4508beb8e21b1a964ed2d21cf68c374c'
 OR NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtname='trg_autorevoke_privileged_anon' AND evtenabled='O')
 THEN RAISE EXCEPTION 'Public Replay Grant Did Not Survive The Actual Money Guard'; END IF;
 IF has_function_privilege('anon','public.fn_diamond_bonus_replay(uuid)','EXECUTE') OR has_function_privilege('anon','public.fn_diamond_bonus_share(uuid)','EXECUTE') OR has_function_privilege('anon','public.fn_diamond_bonus_share_to_feed(uuid)','EXECUTE') OR has_table_privilege('authenticated','public.diamond_bonus_shares','SELECT') OR has_table_privilege('authenticated','public.diamond_bonus_shares','INSERT') THEN RAISE EXCEPTION 'Private Replay Authority Widened'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
 RAISE NOTICE 'PASS Bonus replays: eight actual normal/Super settlements, private open and foreign refusal, exact payloads and 257cashout, slow100x, scoped cursor, random public snapshot, stable token, one canonical post/story/reward and unchanged game wallets';
END $$;
ROLLBACK;
