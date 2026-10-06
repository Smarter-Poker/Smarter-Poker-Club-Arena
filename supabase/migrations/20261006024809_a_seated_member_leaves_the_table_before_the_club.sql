-- 20261006024809_a_seated_member_leaves_the_table_before_the_club.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (launch audit 2026-10-05, leaving a club):
--
-- fn_member_leave_to_treasury empties the member's club wallet into the club
-- treasury and deletes the club_members row. It never looked at the felt. A
-- member with a live seat funded from that club (table_seats.club_id is the
-- sitter's club; read on production: 1,314 live seats, every one with a
-- matching club_members row) could leave the club mid-session, and the stack
-- on the table then had no member wallet to be cashed out into.
--
-- The leave is now refused, in the function every door calls, while the
-- member holds a live seat funded from this club. The member leaves the table
-- first, through the ordinary cash-out, and then leaves the club. Nothing is
-- swept afterwards and nothing is repaired: the stranded stack cannot be
-- created.
--
-- The function is rewritten FROM ITS INSTALLED DEFINITION with one block
-- added, so nothing else about it can drift, and the migration refuses to run
-- against a definition it was not written for.
--
-- @live-proof: position('Leave Your Seat At The Table First' in pg_get_functiondef('public.fn_member_leave_to_treasury(uuid,uuid)'::regprocedure)) > 0

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $do$
DECLARE
  c_fn     constant regprocedure := 'public.fn_member_leave_to_treasury(uuid,uuid)'::regprocedure;
  c_anchor constant text := E'  IF v_chips > 0 THEN\n';
  v_def    text := pg_get_functiondef(c_fn);
  v_new    text;
BEGIN
  -- Applying this twice changes nothing the second time.
  IF position('Leave Your Seat At The Table First' in v_def) > 0 THEN
    RETURN;
  END IF;
  IF md5(v_def) <> '0fb993c0459d542d262d7fa8a8e857db' THEN
    RAISE EXCEPTION 'fn_member_leave_to_treasury is not the definition this migration was written against (md5 %); re-read it first', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, c_anchor, ''))) <> length(c_anchor) THEN
    RAISE EXCEPTION 'the chip return block was not found exactly once';
  END IF;

  v_new := replace(v_def, c_anchor, $block$  -- A SEATED MEMBER LEAVES THE TABLE BEFORE THE CLUB (launch audit
  -- 2026-10-05). table_seats.club_id is the club the seat was funded from. A
  -- membership deleted under a live seat leaves that stack with no wallet to
  -- cash out into, so the leave is refused here, for every caller.
  IF EXISTS (
    SELECT 1
      FROM public.table_seats ts
     WHERE ts.user_id = p_user_id
       AND ts.club_id = p_club_id
       AND ts.left_at IS NULL
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Leave Your Seat At The Table First');
  END IF;

$block$ || c_anchor);

  EXECUTE v_new;

  IF position('Leave Your Seat At The Table First' in pg_get_functiondef(c_fn)) = 0 THEN
    RAISE EXCEPTION 'a seated member can still leave the club';
  END IF;
END
$do$;

COMMIT;
