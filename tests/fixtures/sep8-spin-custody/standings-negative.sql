BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE c record;before jsonb;err text;mode text;BEGIN
 FOR c IN SELECT f.*,s.operation_id,s.expected FROM sep8_spin_fixture.cases f JOIN sep8_spin_fixture.standings_cases s USING(tournament_id) LOOP
  before:=sep8_spin_fixture.snapshot();err:=NULL;
  BEGIN PERFORM public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN err:=SQLERRM;END;
  PERFORM sep8_spin_fixture.assert(err='tournament '||c.tournament_id||' has no complete durable elimination sequence (1/1 of 2)'
   AND before=sep8_spin_fixture.snapshot(),'Original terminal refuses absent original authority without writes '||c.tournament_id);
 END LOOP;
 SELECT f.*,s.operation_id,s.expected INTO c FROM sep8_spin_fixture.cases f JOIN sep8_spin_fixture.standings_cases s USING(tournament_id) ORDER BY tournament_id LIMIT 1;
 before:=sep8_spin_fixture.snapshot();err:=NULL;
 BEGIN PERFORM public.fn_complete_sep8_spin_original_standings(c.operation_id,jsonb_set(c.expected,'{tournament_id}','"00000000-0000-4000-8000-000000000001"'));
 EXCEPTION WHEN SQLSTATE '22023' THEN err:=SQLERRM;END;
 PERFORM sep8_spin_fixture.assert(err='SPIN_ORIGINAL_EVENT_NOT_NAMED' AND before=sep8_spin_fixture.snapshot(),'Unlisted standings cohort cannot be admitted');
 FOREACH mode IN ARRAY ARRAY['rank','candidate','manager','later_authority'] LOOP
  err:=NULL;
  BEGIN
   SET LOCAL session_replication_role=replica;
   CASE mode
    WHEN 'rank' THEN UPDATE public.tournament_players SET position=4 WHERE tournament_id=c.tournament_id AND position=3;
    WHEN 'candidate' THEN DELETE FROM public.tournament_knockout_candidates WHERE tournament_id=c.tournament_id;
    WHEN 'manager' THEN UPDATE public.engine_tournament_leases SET lease_generation=gen_random_uuid() WHERE tournament_id=c.tournament_id;
    WHEN 'later_authority' THEN INSERT INTO public.engine_table_leases(table_id,instance_id,engine_version) VALUES(c.table_id,'isolated-refusal','isolated');
   END CASE;
   SET LOCAL session_replication_role=origin;
   PERFORM public.fn_complete_sep8_spin_original_standings(c.operation_id,c.expected);
  EXCEPTION WHEN SQLSTATE '40001' THEN err:=SQLERRM;END;
  PERFORM sep8_spin_fixture.assert(err=CASE mode WHEN 'manager' THEN 'SPIN_ORIGINAL_EXPECTED_OR_MANAGER_CHANGED' WHEN 'later_authority' THEN 'SPIN_ORIGINAL_LATER_AUTHORITY' ELSE 'SPIN_ORIGINAL_PREIMAGE_CHANGED' END
   AND before=sep8_spin_fixture.snapshot(),'Changed '||mode||' refuses before original standings admission');
 END LOOP;
END $$;
DO $$ DECLARE role_name text;err text;BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  err:=NULL;
  BEGIN
   EXECUTE 'SET LOCAL ROLE '||quote_ident(role_name);
   PERFORM public.fn_complete_sep8_spin_original_standings(gen_random_uuid(),'{}');
  EXCEPTION WHEN insufficient_privilege THEN err:=SQLSTATE;END;
  PERFORM sep8_spin_fixture.assert(err='42501','Original standings wrapper refuses API role '||role_name);
 END LOOP;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  err:=NULL;
  BEGIN
   EXECUTE 'SET LOCAL ROLE '||quote_ident(role_name);
   DELETE FROM smarter_private.spin_original_standings;
  EXCEPTION WHEN insufficient_privilege THEN err:=SQLSTATE;END;
  PERFORM sep8_spin_fixture.assert(err='42501','Original standings authority has no direct API mutation '||role_name);
 END LOOP;
 PERFORM sep8_spin_fixture.assert(has_function_privilege('service_role','public.fn_complete_sep8_spin_original_standings(uuid,jsonb)','execute'),
 'Original standings wrapper grants only service execution');
END $$;
ROLLBACK;
