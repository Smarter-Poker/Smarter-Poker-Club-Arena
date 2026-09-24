-- A live Crash round is sealed like every other round, and a game ticket is
-- spent once (fairness audit 2026-09-22, migration 20260922173914).
-- Isolated PostgreSQL only. The real settlement and ticket writers run first
-- and must go through the lock; then every rewrite the lock exists to refuse is
-- attempted and must be refused for the right reason. Everything rolls back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
DO $$
DECLARE
 player uuid:='d1000000-0000-4000-8000-000000000005'; club uuid:='d1000000-0000-4000-8000-000000000003';
 settlement text[]:=ARRAY['status','settled_at','settled_by','elapsed_ms','cashout_cents','payout_chips',
                          'pool_chips_minted_after','pool_chips_paid_after','member_chips_after'];
 cashed uuid; crashed uuid; timed uuid; live uuid; before jsonb; result jsonb;
 col text; change text; msg text; state text; refused integer:=0;
 first_ticket uuid; second_ticket uuid; stale uuid; dealt jsonb; timed_count integer;
BEGIN
 INSERT INTO diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds) VALUES(club,'club','crash',true,0);
 INSERT INTO diamond_game_pools(host_id,game,intake_diamonds) VALUES(club,'crash',10000);

 -- Four open rounds, each exactly as fn_crash_start seals one: a tenth-of-the-stake minimum.
 FOR col IN SELECT unnest(ARRAY['cashed','crashed','timed','live']) LOOP
  INSERT INTO crash_rounds(id,host_id,host_kind,club_id,user_id,bet_diamonds,bet_chips,diamonds_per_chip,commit_id,server_seed_hash,server_seed,client_seed,nonce,roll,crash_cents,cap_cents,growth_k,auto_cashout_cents,reserved_chips,started_at,chips_minted,diamonds_after,minimum_payout_chips)
   VALUES(gen_random_uuid(),club,'club',club,player,100,1,100,gen_random_uuid(),encode(extensions.digest('sealed-'||col,'sha256'),'hex'),'sealed-'||col,'sealed-client',1,1,
    CASE col WHEN 'crashed' THEN 100 ELSE 1000 END,CASE col WHEN 'timed' THEN 300 ELSE 1000 END,.12,NULL,10,
    clock_timestamp()-CASE col WHEN 'timed' THEN interval '1 hour' ELSE interval '10 seconds' END,0,100000,0.10)
   RETURNING id INTO live;
  UPDATE diamond_game_pools SET reserved_chips=reserved_chips+10 WHERE host_id=club AND game='crash';
  IF col='cashed' THEN cashed:=live; ELSIF col='crashed' THEN crashed:=live; ELSIF col='timed' THEN timed:=live; END IF;
 END LOOP;

 -- 1. Every settlement writer goes through the lock, and nothing it sealed moves.
 SELECT to_jsonb(c)-settlement INTO before FROM crash_rounds c WHERE id=cashed;
 SET LOCAL ROLE authenticated;
 result:=fn_crash_cashout(cashed,257);
 RESET ROLE;
 IF result->>'status' IS DISTINCT FROM 'cashed' OR (result#>>'{outcome,payout_chips}')::numeric IS DISTINCT FROM 2.57
    OR (SELECT to_jsonb(c)-settlement FROM crash_rounds c WHERE id=cashed) IS DISTINCT FROM before THEN
  RAISE EXCEPTION 'The player cash-out did not settle through the lock: %',result; END IF;
 SET LOCAL ROLE authenticated;
 result:=fn_crash_settle(crashed,false);
 RESET ROLE;
 IF result->>'status' IS DISTINCT FROM 'crashed' OR (result#>>'{outcome,payout_chips}')::numeric IS DISTINCT FROM 0.10 THEN
  RAISE EXCEPTION 'The instant crash did not settle its minimum through the lock: %',result; END IF;
 timed_count:=public.fn_crash_settle_decided(club);
 IF timed_count<>1 OR (SELECT status||':'||settled_by||':'||cashout_cents FROM crash_rounds WHERE id=timed) IS DISTINCT FROM 'cashed:time:300' THEN
  RAISE EXCEPTION 'The time settlement did not book the cap through the lock: % %',timed_count,(SELECT to_jsonb(c) FROM crash_rounds c WHERE id=timed); END IF;

 -- 2. A live round refuses every sealed column, one at a time.
 FOR col, change IN SELECT * FROM (VALUES
   ('crash_cents','crash_cents+1'),('roll','roll+1'),('server_seed','server_seed||''x'''),
   ('server_seed_hash','server_seed_hash||''x'''),('client_seed','client_seed||''x'''),('nonce','nonce+1'),
   ('started_at','started_at-interval ''1 second'''),('cap_cents','cap_cents+1'),('growth_k','growth_k+0.01'),
   ('auto_cashout_cents','200'),('bet_chips','bet_chips+1'),('bet_diamonds','bet_diamonds+1'),
   ('reserved_chips','reserved_chips+1'),('commit_id','gen_random_uuid()'),('user_id','gen_random_uuid()'),
   ('host_id','gen_random_uuid()'),('club_id','gen_random_uuid()'),('diamonds_per_chip','diamonds_per_chip+1'),
   ('diamonds_after','diamonds_after+1'),('is_fixture','NOT is_fixture'),('created_at','created_at-interval ''1 second'''),
   ('elapsed_ms','5'),('payout_chips','1')) v(c,e) LOOP
  BEGIN
   EXECUTE format('UPDATE crash_rounds SET %I=%s WHERE id=$1',col,change) USING live;
   RAISE EXCEPTION 'A live round took a rewrite of %',col;
  EXCEPTION WHEN integrity_constraint_violation THEN
   GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
   IF msg<>'A Sealed Crash Round Cannot Be Rewritten' THEN RAISE EXCEPTION 'Wrong refusal for %: %',col,msg; END IF;
   refused:=refused+1;
  END;
 END LOOP;
 BEGIN
  UPDATE crash_rounds SET minimum_payout_chips=minimum_payout_chips+0.01 WHERE id=live;
  RAISE EXCEPTION 'A live round took a new minimum';
 EXCEPTION WHEN integrity_constraint_violation THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'The Bonus Minimum Is Fixed When The Round Starts' THEN RAISE EXCEPTION 'Wrong minimum refusal: %',msg; END IF;
  refused:=refused+1;
 END;
 -- A settlement that smuggles a sealed column is refused whole.
 BEGIN
  UPDATE crash_rounds SET status='crashed',settled_at=clock_timestamp(),settled_by='tick',crash_cents=crash_cents+1 WHERE id=live;
  RAISE EXCEPTION 'A settlement carried a new crash point';
 EXCEPTION WHEN integrity_constraint_violation THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'A Sealed Crash Round Cannot Be Rewritten' THEN RAISE EXCEPTION 'Wrong smuggle refusal: %',msg; END IF;
  refused:=refused+1;
 END;
 -- A settled round, and any delete, stay refused as before.
 FOREACH col IN ARRAY ARRAY['settled-update','settled-delete','live-delete'] LOOP
  BEGIN
   IF col='settled-update' THEN UPDATE crash_rounds SET payout_chips=payout_chips+1 WHERE id=cashed;
   ELSIF col='settled-delete' THEN DELETE FROM crash_rounds WHERE id=crashed;
   ELSE DELETE FROM crash_rounds WHERE id=live; END IF;
   RAISE EXCEPTION 'crash_rounds took a %',col;
  EXCEPTION WHEN integrity_constraint_violation THEN
   GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
   IF msg<>'crash_rounds is append-only: a settled round is a fact and is never edited or deleted' THEN RAISE EXCEPTION 'Wrong % refusal: %',col,msg; END IF;
   refused:=refused+1;
  END;
 END LOOP;
 IF (SELECT status FROM crash_rounds WHERE id=live)<>'open' THEN RAISE EXCEPTION 'A refused write moved the live round'; END IF;

 -- 3. Tickets: dealt by the real dealer, spent once, swept only when expired and unused.
 INSERT INTO diamond_game_commits(user_id,game,server_seed,server_seed_hash,created_at,expires_at)
  VALUES(player,'crash','stale-seed',encode(extensions.digest('stale-seed','sha256'),'hex'),now()-interval '1 hour',now()-interval '45 minutes')
  RETURNING id INTO stale;
 SET LOCAL ROLE authenticated;
 dealt:=fn_diamond_game_commit('crash'); first_ticket:=(dealt->>'commit_id')::uuid;
 dealt:=fn_diamond_game_commit('crash'); second_ticket:=(dealt->>'commit_id')::uuid;
 RESET ROLE;
 IF EXISTS(SELECT 1 FROM diamond_game_commits WHERE id=stale) THEN RAISE EXCEPTION 'The expired unused ticket survived the sweep'; END IF;
 IF (SELECT count(*) FROM diamond_game_commits WHERE id IN (first_ticket,second_ticket) AND consumed_by IS NULL)<>2 THEN
  RAISE EXCEPTION 'A live ticket was pulled when another was dealt'; END IF;
 -- The statement every consumer runs once admission has locked the ticket.
 UPDATE diamond_game_commits SET consumed_by=gen_random_uuid() WHERE id=first_ticket;
 FOR state, change IN SELECT * FROM (VALUES
   ('spent','UPDATE diamond_game_commits SET consumed_by=gen_random_uuid() WHERE id=$1'),
   ('spent','UPDATE diamond_game_commits SET consumed_by=NULL WHERE id=$1'),
   ('spent','DELETE FROM diamond_game_commits WHERE id=$1'),
   ('live','UPDATE diamond_game_commits SET server_seed=server_seed||''x'' WHERE id=$1'),
   ('live','UPDATE diamond_game_commits SET server_seed_hash=server_seed_hash||''x'' WHERE id=$1'),
   ('live','UPDATE diamond_game_commits SET expires_at=expires_at+interval ''1 hour'' WHERE id=$1'),
   ('live','UPDATE diamond_game_commits SET consumed_by=gen_random_uuid(),user_id=gen_random_uuid() WHERE id=$1'),
   ('live','DELETE FROM diamond_game_commits WHERE id=$1')) v(s,q) LOOP
  BEGIN
   EXECUTE change USING CASE state WHEN 'spent' THEN first_ticket ELSE second_ticket END;
   RAISE EXCEPTION 'A % ticket took: %',state,change;
  EXCEPTION WHEN integrity_constraint_violation THEN
   GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
   IF msg<>'A Sealed Game Ticket Cannot Be Rewritten' THEN RAISE EXCEPTION 'Wrong ticket refusal for %: %',change,msg; END IF;
   refused:=refused+1;
  END;
 END LOOP;

 -- 4. The maintenance escape is exactly what it was.
 PERFORM set_config('app.ledger_maintenance','crash-lock-probe',true);
 UPDATE crash_rounds SET crash_cents=crash_cents+1 WHERE id=live;
 UPDATE diamond_game_commits SET server_seed=server_seed||'x' WHERE id=second_ticket;
 PERFORM set_config('app.ledger_maintenance','',true);

 IF refused<>36 THEN RAISE EXCEPTION 'Expected 36 refusals, saw %',refused; END IF;
 RAISE NOTICE 'PASS Crash round sealed: cash-out, instant crash and time settlement through the lock with nothing sealed moved, 36 rewrites refused (21 sealed columns, 2 settlement columns on a round still open, the minimum, a smuggled crash point, a settled edit, 2 deletes, 8 ticket re-spends, un-spends, rewrites and deletes), expired ticket swept, live tickets kept, maintenance escape unchanged';
END $$;
ROLLBACK;
