BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE FUNCTION pg_temp.sep8_fail_recognition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.settled_at IS NOT NULL THEN RAISE EXCEPTION 'sep8 native late recognition fault' USING ERRCODE='P0042';END IF;RETURN NEW;
END $$;
CREATE TRIGGER sep8_native_recognition_fault AFTER UPDATE ON public.tournament_rake_settlements FOR EACH ROW EXECUTE FUNCTION pg_temp.sep8_fail_recognition();
DO $$ DECLARE c record;before jsonb;err text;BEGIN
 FOR c IN SELECT * FROM sep8_spin_fixture.cases WHERE tournament_id IN('199a71a9-f364-4e90-a3ba-3cdcfb7755bc','b60c7add-6b38-4549-b091-601f64d118a0') ORDER BY tournament_id LOOP
  before:=sep8_spin_fixture.snapshot();err:=NULL;
  BEGIN PERFORM public.fn_settle_tournament_rake(c.tournament_id,'sep8-late-recognition-fault');
  EXCEPTION WHEN SQLSTATE 'P0042' THEN err:=SQLERRM;END;
  PERFORM sep8_spin_fixture.assert(err='sep8 native late recognition fault' AND before=sep8_spin_fixture.snapshot(),
   'Late fee recognition fault atomically rolls original capture and bank back '||c.tournament_id);
 END LOOP;
END $$;
DROP TRIGGER sep8_native_recognition_fault ON public.tournament_rake_settlements;
ROLLBACK;
