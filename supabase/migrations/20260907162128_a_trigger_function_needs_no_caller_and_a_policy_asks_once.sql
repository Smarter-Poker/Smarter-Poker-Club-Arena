-- 20260907162128_a_trigger_function_needs_no_caller_and_a_policy_asks_once.sql
--
-- Version reserved by scripts/new-migration.mjs.
--
-- TWO SMALL THINGS THE ADVISORS HAVE BEEN SAYING, BOTH READ FROM PRODUCTION.
--
-- 1. FIVE SECURITY DEFINER TRIGGER FUNCTIONS CARRY `anon` EXECUTE.
--
-- A trigger function is invoked by Postgres as part of the triggering
-- statement. It does not consult EXECUTE on the caller, so a grant here buys
-- the trigger nothing and leaves a SECURITY DEFINER entry point that a caller
-- with no account can name. Every one of these is `RETURNS trigger`, every one
-- has `prosecdef = true`, and NONE of them appears in any RLS policy
-- expression - which is the distinction that matters:
--
--     trigger function   ->  fires without EXECUTE. Safe to revoke.
--     policy helper      ->  runs AS THE QUERYING ROLE. Revoking it denies
--                            every SELECT on the tables whose policies call it.
--
-- CLAUDE.md 10.84 tells the story of `fn_home_is_group_staff`, which backs 15
-- policies; it is NOT touched here, and neither are `is_admin` (10 policies),
-- `fn_my_club_ids`, `fn_can_view_post`, the two chat-silence helpers, the three
-- video-library helpers or either `legacy_transition_eligible` overload. Those
-- are deliberate public surface and belong in the exposure baseline, not in a
-- REVOKE. Measured before writing this, per function:
--
--     fn_guard_retired_club_mutation          22 triggers, 0 policies
--     fn_guard_club_lifecycle_write            1 trigger,  0 policies
--     fn_guard_membership_lifecycle_write      1 trigger,  0 policies
--     fn_stamp_seat_horse_id                   1 trigger,  0 policies
--     fn_ca_bomb_hand_keeps_its_award_units    1 trigger,  0 policies
--
-- 2. FIVE POLICIES RE-EVALUATE auth.uid() PER ROW.
--
-- `auth.uid() = user_id` is evaluated for every row scanned; wrapping it in a
-- scalar subquery makes Postgres evaluate it once per statement and compare a
-- constant. Identical semantics, and it matters most on `chip_transactions`,
-- which is 2,008,091 rows. The union-overseer policy beside it already uses
-- this form, so this only brings the other one into line with its neighbour.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, ~28s on this database (production DDL policy).

BEGIN;

-- 1. Trigger functions answer Postgres, not a browser.
REVOKE ALL ON FUNCTION public.fn_ca_bomb_hand_keeps_its_award_units() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_club_lifecycle_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_membership_lifecycle_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_retired_club_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_stamp_seat_horse_id() FROM PUBLIC, anon, authenticated;

-- 2. Ask who is calling once per statement, not once per row.
ALTER POLICY ca_hand_notes_select_own ON public.ca_hand_notes
  USING (( SELECT auth.uid() ) = user_id);
ALTER POLICY ca_hand_notes_update_own ON public.ca_hand_notes
  USING (( SELECT auth.uid() ) = user_id)
  WITH CHECK (( SELECT auth.uid() ) = user_id);
ALTER POLICY ca_hand_notes_delete_own ON public.ca_hand_notes
  USING (( SELECT auth.uid() ) = user_id);
ALTER POLICY ca_hand_notes_insert_own ON public.ca_hand_notes
  WITH CHECK (( SELECT auth.uid() ) = user_id);
ALTER POLICY chip_transactions_select_own ON public.chip_transactions
  USING (( SELECT auth.uid() ) = from_user_id OR ( SELECT auth.uid() ) = to_user_id);

-- The migration asserts its own assumptions, so it aborts rather than landing
-- on a board that moved underneath it.
DO $assert$
DECLARE v_open int; v_perrow int;
BEGIN
  SELECT count(*) INTO v_open
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('fn_ca_bomb_hand_keeps_its_award_units','fn_guard_club_lifecycle_write',
                       'fn_guard_membership_lifecycle_write','fn_guard_retired_club_mutation',
                       'fn_stamp_seat_horse_id')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'anon can still execute % of the five trigger functions', v_open;
  END IF;

  SELECT count(*) INTO v_perrow
    FROM pg_policy
   WHERE polrelid IN ('public.ca_hand_notes'::regclass, 'public.chip_transactions'::regclass)
     AND polname IN ('ca_hand_notes_select_own','ca_hand_notes_update_own','ca_hand_notes_delete_own',
                     'ca_hand_notes_insert_own','chip_transactions_select_own')
     -- The per-row form is any auth.uid() that is NOT the one inside a scalar
     -- subquery. Strip the subquery form first, then look for survivors; a
     -- regex on the character before it matches "SELECT auth.uid()" too, which
     -- is how the first draft of this assertion failed the migration it was
     -- guarding.
     AND (replace(coalesce(pg_get_expr(polqual, polrelid), ''), 'SELECT auth.uid()', '') LIKE '%auth.uid()%'
       OR replace(coalesce(pg_get_expr(polwithcheck, polrelid), ''), 'SELECT auth.uid()', '') LIKE '%auth.uid()%');
  IF v_perrow <> 0 THEN
    RAISE EXCEPTION '% policy expression(s) still call auth.uid() per row', v_perrow;
  END IF;
END $assert$;

COMMIT;
