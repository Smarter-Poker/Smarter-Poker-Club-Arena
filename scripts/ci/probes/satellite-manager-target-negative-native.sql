-- Native-only adversarial calls while the real M2 publisher's source capability is open.
SET LOCAL session_replication_role=replica;
INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)
 VALUES('d5000000-0000-4000-8000-000000000002','Satellite target scope negative table',
 'd3000000-0000-4000-8000-000000000002','running','live',0,'tournament',
 'd2000000-0000-4000-8000-000000000002');
SET LOCAL session_replication_role=origin;
CREATE TEMP TABLE satellite_target_scope_denials(label text PRIMARY KEY) ON COMMIT DROP;
CREATE FUNCTION pg_temp.test_active_satellite_target_scope() RETURNS trigger
LANGUAGE plpgsql AS $active_scope$
DECLARE r record; refused boolean; original_generation text;
BEGIN
 IF NEW.tournament_id<>'d3000000-0000-4000-8000-000000000001' THEN RETURN NEW; END IF;
 PERFORM pg_temp.satellite_full_assert(public.fn_ca_satellite_terminal_scope(NEW.tournament_id),
  'target plan is published inside the real source transaction capability');
 FOR r IN SELECT * FROM (VALUES
  ('unrelated tournament', $q$UPDATE public.tournaments SET name=name WHERE id='30000000-0000-0000-0000-000000000001'$q$),
  ('forged target recount before registration', $q$UPDATE public.tournaments SET current_players=current_players+1 WHERE id='d3000000-0000-4000-8000-000000000002'$q$),
  ('target unrelated column', $q$UPDATE public.tournaments SET name=name WHERE id='d3000000-0000-4000-8000-000000000002'$q$),
  ('target unplanned player', $q$INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id) VALUES('d3000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000001','wrong user',0,'registered',true,'d3000000-0000-4000-8000-000000000001')$q$),
  ('target wrong source', $q$INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id) SELECT 'd3000000-0000-4000-8000-000000000002',user_id,username,0,'registered',true,'d3000000-0000-4000-8000-000000000002' FROM public.tournament_players WHERE tournament_id='d3000000-0000-4000-8000-000000000001'$q$),
  ('target nonzero stack', $q$INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id) SELECT 'd3000000-0000-4000-8000-000000000002',user_id,username,1,'registered',true,tournament_id FROM public.tournament_players WHERE tournament_id='d3000000-0000-4000-8000-000000000001'$q$),
  ('target altered status', $q$INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id) SELECT 'd3000000-0000-4000-8000-000000000002',user_id,username,0,'playing',true,tournament_id FROM public.tournament_players WHERE tournament_id='d3000000-0000-4000-8000-000000000001'$q$),
  ('target unlisted field', $q$INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id,current_bounty) SELECT 'd3000000-0000-4000-8000-000000000002',user_id,username,0,'registered',true,tournament_id,1 FROM public.tournament_players WHERE tournament_id='d3000000-0000-4000-8000-000000000001'$q$),
  ('target roster update', $q$UPDATE public.tournament_players SET username=username WHERE tournament_id='d3000000-0000-4000-8000-000000000002'$q$),
  ('target roster delete', $q$DELETE FROM public.tournament_players WHERE tournament_id='d3000000-0000-4000-8000-000000000002'$q$),
  ('target table update', $q$UPDATE public.tables SET name=name WHERE id='d5000000-0000-4000-8000-000000000002'$q$),
  ('target table delete', $q$DELETE FROM public.tables WHERE id='d5000000-0000-4000-8000-000000000002'$q$),
  ('target seat insert', $q$INSERT INTO public.table_seats(table_id,seat_number,user_id,stack,status) VALUES('d5000000-0000-4000-8000-000000000002',1,'d1000000-0000-4000-8000-000000000002',0,'active')$q$),
  ('published plan update', $q$UPDATE public.tournament_satellite_manager_targets SET planned_seats=planned_seats WHERE tournament_id='d3000000-0000-4000-8000-000000000001'$q$),
  ('published plan delete', $q$DELETE FROM public.tournament_satellite_manager_targets WHERE tournament_id='d3000000-0000-4000-8000-000000000001'$q$)
 ) checks(label,command) LOOP
  refused:=false;
  BEGIN EXECUTE r.command;
  EXCEPTION WHEN insufficient_privilege THEN
   IF position('TOURNAMENT_MANAGER_SCOPE' IN SQLERRM)=0 THEN RAISE; END IF;
   refused:=true;
  END;
  PERFORM pg_temp.satellite_full_assert(refused,'active exact target authority refuses '||r.label);
  INSERT INTO satellite_target_scope_denials VALUES(r.label);
 END LOOP;
 original_generation:=current_setting('app.smarter_tournament_lease_generation',true);
 refused:=false;
 BEGIN
  PERFORM set_config('app.smarter_tournament_lease_generation','d7000000-0000-4000-8000-000000000099',true);
  INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id)
   SELECT NEW.target_id,user_id,username,0,'registered',true,tournament_id FROM public.tournament_players
   WHERE tournament_id=NEW.tournament_id;
 EXCEPTION WHEN insufficient_privilege THEN
  IF position('TOURNAMENT_MANAGER_SCOPE' IN SQLERRM)=0 THEN RAISE; END IF;
  refused:=true;
 END;
 PERFORM set_config('app.smarter_tournament_lease_generation',original_generation,true);
 PERFORM pg_temp.satellite_full_assert(refused,'active exact target authority refuses a different lease generation');
 INSERT INTO satellite_target_scope_denials VALUES('different lease generation');
 RETURN NEW;
END $active_scope$;
CREATE TRIGGER native_active_satellite_target_scope AFTER INSERT ON public.tournament_satellite_manager_targets
 FOR EACH ROW EXECUTE FUNCTION pg_temp.test_active_satellite_target_scope();


-- Observe the two real target writes, including their actual nesting and money.
CREATE TEMP TABLE satellite_target_counter_events(
 before_count integer,after_count integer,before_prize numeric,after_prize numeric,
 before_fee numeric,after_fee numeric,award_count integer,depth integer) ON COMMIT DROP;
CREATE FUNCTION pg_temp.observe_real_satellite_target_count() RETURNS trigger LANGUAGE plpgsql AS $observe_count$
BEGIN
 IF NEW.id='d3000000-0000-4000-8000-000000000002'
  AND EXISTS(SELECT 1 FROM public.tournament_satellite_manager_targets WHERE target_id=NEW.id) THEN
  INSERT INTO satellite_target_counter_events
   SELECT OLD.current_players,NEW.current_players,OLD.prize_pool,NEW.prize_pool,
    OLD.total_rake,NEW.total_rake,(SELECT count(*) FROM public.tournament_satellite_awards
     WHERE tournament_id='d3000000-0000-4000-8000-000000000001' AND delivery_kind='seat'),pg_trigger_depth();
 END IF;
 RETURN NEW;
END $observe_count$;
CREATE TRIGGER native_real_satellite_target_count AFTER UPDATE OF current_players ON public.tournaments
 FOR EACH ROW EXECUTE FUNCTION pg_temp.observe_real_satellite_target_count();
