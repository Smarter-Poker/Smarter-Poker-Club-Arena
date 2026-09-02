-- ═══════════════════════════════════════════════════════════════════════════
-- A JOB THAT HAS NEVER SUCCEEDED, FAILING EVERY NINETY SECONDS
--
-- reconcile-tournament-denormals failed 223 times in six hours with
--
--   ERROR: record "new" has no field "tournament_id"
--   CONTEXT: SQL expression "TG_TABLE_NAME='tables' AND COALESCE(NEW.tournament_id,...
--
-- fn_emit_managed_game_row_event is attached to BOTH `tables` and
-- `tournaments`, and opened with
--
--   IF TG_TABLE_NAME='tables' AND COALESCE(NEW.tournament_id,OLD.tournament_id)
--        IS NOT NULL THEN RETURN NULL; END IF;
--
-- expecting AND to short-circuit. It does not. PL/pgSQL compiles the whole
-- condition into ONE SQL expression and plans every field reference in it, so
-- NEW.tournament_id is resolved even when the trigger fired on `tournaments`,
-- which has no such column. The guard therefore raised on every single UPDATE
-- to a tournament, and the denormal reconciler had never completed a run.
--
-- Two ways it bites, and the fix handles both:
--   * the wrong table: `tournaments` has no tournament_id at all;
--   * the wrong operation: on DELETE, NEW is unassigned, so NEW.<anything>
--     raises even on `tables`.
--
-- to_jsonb(record) ->> 'key' answers for a record that lacks the field and for
-- a record that does not exist, returning NULL either way. The sibling
-- function fn_capture_managed_game_contract already uses exactly this idiom on
-- the same column, so this is the house pattern rather than a new invention.
-- The table test is nested as well, so the field is never reached off `tables`.
--
-- Verified in a rolled-back probe: UPDATE on tournaments (the failing case),
-- UPDATE on a cash table, and fn_reconcile_tournament_denormals() all succeed.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_emit_managed_game_row_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid := COALESCE(to_jsonb(NEW) ->> 'club_id', to_jsonb(OLD) ->> 'club_id')::uuid;
  v_id   uuid := COALESCE(to_jsonb(NEW) ->> 'id',      to_jsonb(OLD) ->> 'id')::uuid;
BEGIN
  -- Tournament backing tables are represented by the tournament event itself.
  IF TG_TABLE_NAME = 'tables' THEN
    IF COALESCE(to_jsonb(NEW) ->> 'tournament_id',
                to_jsonb(OLD) ->> 'tournament_id') IS NOT NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM public.fn_emit_game_management_event(
    'game_changed', v_club, NULL, NULL,
    CASE WHEN TG_TABLE_NAME = 'tables' THEN 'table' ELSE 'tournament' END,
    v_id, NULL, jsonb_build_object('operation', lower(TG_OP)));
  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.fn_emit_managed_game_row_event() IS
  'Emits a game_changed event for tables and tournaments. Reads record fields through to_jsonb because this one function is attached to two tables with different columns and fires on DELETE as well: in PL/pgSQL, AND does NOT short-circuit a record field reference - the whole IF condition is planned as one SQL expression - which is why the original TG_TABLE_NAME=''tables'' AND NEW.tournament_id guard raised on every tournament UPDATE and kept reconcile-tournament-denormals from ever completing a run.';
