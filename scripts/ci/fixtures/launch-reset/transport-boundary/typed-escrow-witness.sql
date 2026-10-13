-- Run in complete actual financial bootstrap, before and after overlay.
-- No production use. Same real escrow rowtype; no stubbed authority functions.
BEGIN;
CREATE TEMP TABLE tournament_escrow (LIKE public.tournament_escrow INCLUDING ALL);
-- The real maintenance thaw updates this rowtype, which has no metadata.
CREATE TEMP TABLE tables (LIKE public.tables INCLUDING ALL);
INSERT INTO pg_temp.tables(id,name,game_type,updated_at)
VALUES('de000000-0000-4000-8000-000000000002','Native thaw table witness','cash','2026-10-13 13:55:00+00');
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
  EXECUTE 'CREATE TRIGGER typed_guard BEFORE UPDATE ON pg_temp.tables FOR EACH ROW EXECUTE FUNCTION public.'||target||'()';
  failed:=false;
  BEGIN
   UPDATE pg_temp.tables SET updated_at=updated_at+interval '5 minutes'
    WHERE id='de000000-0000-4000-8000-000000000002';
  EXCEPTION WHEN undefined_column THEN
   IF SQLERRM NOT LIKE '%metadata%' THEN RAISE; END IF;
   failed:=true;
  END;
  IF expected_before AND NOT failed THEN RAISE EXCEPTION 'EXPECTED_ORIGINAL_TABLE_UPDATE_METADATA_FAILURE: %',target; END IF;
  IF NOT expected_before AND failed THEN RAISE EXCEPTION 'CORRECTED_TYPED_TABLE_UPDATE_STILL_FAILS: %',target; END IF;
  IF NOT expected_before AND (SELECT updated_at FROM pg_temp.tables WHERE id='de000000-0000-4000-8000-000000000002')
    IS DISTINCT FROM '2026-10-13 14:00:00+00'::timestamptz THEN
   RAISE EXCEPTION 'TYPED_TABLE_UPDATE_DID_NOT_PERSIST: %',target;
  END IF;
  EXECUTE 'DROP TRIGGER typed_guard ON pg_temp.tables';
  UPDATE pg_temp.tables SET updated_at='2026-10-13 13:55:00+00'
   WHERE id='de000000-0000-4000-8000-000000000002';
 END LOOP;
END $witness$;
ROLLBACK;
