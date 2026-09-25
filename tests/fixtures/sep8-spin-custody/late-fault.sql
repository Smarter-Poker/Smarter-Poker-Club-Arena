BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE FUNCTION pg_temp.sep8_fail_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'sep8 native late terminal fault' USING ERRCODE='P0042';
END $$;
CREATE TRIGGER sep8_native_terminal_fault AFTER INSERT ON public.tournament_terminal_settlements FOR EACH ROW EXECUTE FUNCTION pg_temp.sep8_fail_terminal();
DO $$ DECLARE c record;before jsonb;err text;BEGIN
 SELECT f.*,s.operation_id,s.expected INTO c FROM sep8_spin_fixture.cases f JOIN sep8_spin_fixture.standings_cases s USING(tournament_id) ORDER BY tournament_id LIMIT 1;
 before:=sep8_spin_fixture.snapshot();
 BEGIN PERFORM public.fn_complete_sep8_spin_original_standings(c.operation_id,c.expected);
 EXCEPTION WHEN SQLSTATE 'P0042' THEN err:=SQLERRM;END;
 PERFORM sep8_spin_fixture.assert(err='sep8 native late terminal fault' AND before=sep8_spin_fixture.snapshot()
  AND NOT EXISTS(SELECT 1 FROM smarter_private.spin_original_standings),
  'Late terminal fault rolls private authority, prize payment, custody and completion back atomically');
END $$;
DROP TRIGGER sep8_native_terminal_fault ON public.tournament_terminal_settlements;
ROLLBACK;
