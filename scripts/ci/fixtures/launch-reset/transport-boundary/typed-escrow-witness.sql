-- Run in complete actual financial bootstrap, before and after overlay.
-- No production use. Same real escrow rowtype; no stubbed authority functions.
BEGIN;
CREATE TEMP TABLE tournament_escrow (LIKE public.tournament_escrow INCLUDING ALL);
DO $witness$ DECLARE target text; failed boolean; expected_before boolean := current_setting('typed_witness.before',true)='on'; BEGIN
 FOREACH target IN ARRAY ARRAY['fn_cancelled_tournament_evidence_is_immutable','fn_terminal_tournament_evidence_is_immutable'] LOOP
  EXECUTE 'CREATE TRIGGER typed_guard BEFORE INSERT ON pg_temp.tournament_escrow FOR EACH ROW EXECUTE FUNCTION public.'||target||'()';
  failed:=false;
  BEGIN
   INSERT INTO pg_temp.tournament_escrow(tournament_id,opened_from) VALUES('de000000-0000-4000-8000-000000000001','Actual typed escrow trigger witness');
  EXCEPTION WHEN undefined_column THEN
   IF SQLERRM NOT LIKE '%metadata%' THEN RAISE; END IF;
   failed:=true;
  END;
  IF expected_before AND NOT failed THEN RAISE EXCEPTION 'EXPECTED_ORIGINAL_METADATA_FAILURE: %',target; END IF;
  IF NOT expected_before AND failed THEN RAISE EXCEPTION 'CORRECTED_TYPED_ESCROW_STILL_FAILS: %',target; END IF;
  EXECUTE 'DROP TRIGGER typed_guard ON pg_temp.tournament_escrow';
  DELETE FROM pg_temp.tournament_escrow;
 END LOOP;
END $witness$;
ROLLBACK;
