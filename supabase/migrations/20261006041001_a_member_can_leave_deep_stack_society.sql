-- 20261006041001_a_member_can_leave_deep_stack_society.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (launch audit 2026-10-05, leaving a club):
--
-- trg_deep_stack_members_are_protected refuses every DELETE on a Deep Stack
-- Society club_members row unless the transaction has set
-- app.deep_stack_teardown = 'on'. It exists because the whole club was once
-- deleted with no audit trail. fn_member_leave_to_treasury ends in a DELETE
-- of the leaving member's row and never set it, so a member of the one public
-- club could not leave: the delete raised, the whole call rolled back (no
-- chips moved), and the client said "Failed to leave club - please try
-- again", advice that could not work. An owner removing a member hit the
-- same wall.
--
-- One member's departure through the authorized leave door is not the
-- accident that trigger guards against. The door now declares itself for its
-- own single-row delete and puts the setting back straight after, so nothing
-- else in the transaction inherits it. The trigger is untouched and still
-- records the delete (allowed = true) in deep_stack_delete_attempts; every
-- other DELETE on those rows is refused exactly as before.
--
-- The function is rewritten FROM ITS INSTALLED DEFINITION with its DELETE
-- wrapped, and the migration refuses a definition it was not written against.
--
-- @live-proof: position('app.deep_stack_teardown' in pg_get_functiondef('public.fn_member_leave_to_treasury(uuid,uuid)'::regprocedure)) > 0

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $do$
DECLARE
  c_fn     constant regprocedure := 'public.fn_member_leave_to_treasury(uuid,uuid)'::regprocedure;
  c_anchor constant text := E'  DELETE FROM club_members WHERE club_id = p_club_id AND user_id = p_user_id;\n';
  v_def    text := pg_get_functiondef(c_fn);
  v_new    text;
BEGIN
  -- Applying this twice changes nothing the second time.
  IF position('app.deep_stack_teardown' in v_def) > 0 THEN
    RETURN;
  END IF;
  IF md5(v_def) <> 'b7d38f85200e6b248c37cbc0df25ce4c' THEN
    RAISE EXCEPTION 'fn_member_leave_to_treasury is not the definition this migration was written against (md5 %); re-read it first', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, c_anchor, ''))) <> length(c_anchor) THEN
    RAISE EXCEPTION 'the membership delete was not found exactly once';
  END IF;

  v_new := replace(v_def, c_anchor, $block$  -- A MEMBER CAN LEAVE DEEP STACK SOCIETY (launch audit 2026-10-05). The
  -- club's delete guard refuses any club_members DELETE that has not declared
  -- itself. This door is authorized above and removes exactly one row, so it
  -- declares for that one statement and restores the setting after it.
  DECLARE
    v_teardown_before text := COALESCE(current_setting('app.deep_stack_teardown', true), '');
  BEGIN
    PERFORM set_config('app.deep_stack_teardown', 'on', true);
    DELETE FROM club_members WHERE club_id = p_club_id AND user_id = p_user_id;
    PERFORM set_config('app.deep_stack_teardown', v_teardown_before, true);
  END;
$block$);

  EXECUTE v_new;

  IF position('app.deep_stack_teardown' in pg_get_functiondef(c_fn)) = 0 THEN
    RAISE EXCEPTION 'the leave door still does not declare its delete';
  END IF;
END
$do$;

COMMIT;
