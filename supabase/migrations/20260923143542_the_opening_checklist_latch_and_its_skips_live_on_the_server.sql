-- 20260923143542_the_opening_checklist_latch_and_its_skips_live_on_the_server.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE OPENING CHECKLIST IS FINISHED ONCE, AND ITS SKIPS LIVE ON THE SERVER
-- (Create A Club Phase 2, 2026-09-23)
--
-- The requirement: the new-club checklist shows only for genuinely new,
-- incomplete standalone clubs; never on previously opened clubs, unions or
-- union-member clubs; it persists across navigation and reload until every
-- required task is completed or validly skipped; skipped state is persisted;
-- it disappears at 100% and never lingers as a 100% banner.
--
-- WHAT WAS WRONG. The lobby recomputes every step from live data on every
-- visit (open tables only, tournaments only while in a lobby status, more than
-- one member), so a finished checklist came BACK when, for example, the only
-- NLH table closed or the one extra member left. And skips lived only in the
-- browser's localStorage, per club and viewer, so they did not follow the
-- owner to another device and vanished with the site data.
--
-- WHAT THIS ADDS.
--   public.club_opening_checklists, one row per club that has skipped a step
--     or finished the list. skipped_task_ids holds the optional steps the
--     owner skipped; its CHECK names the ten optional steps, so the required
--     step or an unknown id can never be stored. completed_at and
--     completed_by are the latch. RLS is on with no policy, and anon and
--     authenticated hold no privilege on it: only the three functions below
--     read or write it. NO FOREIGN KEY to clubs (CLAUDE.md DDL rule 7): an
--     orphan row here is harmless, a lock on clubs is not.
--   fn_club_opening_checklist_state(club): the owner reads
--     {clubId, completedAt, skippedTaskIds}. It writes nothing.
--   fn_club_opening_checklist_skip(club, task, skipped): the owner sets or
--     clears one skip. 'opening-setup' (the one required step) and any id that
--     is not one of the ten optional steps are refused. Setting a skip twice or
--     clearing one that is not there changes nothing.
--   fn_club_opening_checklist_complete(club): the owner latches the list as
--     finished. Refused unless the club's opening setup wizard is complete (its
--     club_opening_setups row exists) and the club is a new standalone club by
--     the same rules the lobby uses (src/utils/clubOpeningEligibility.ts):
--     opening_checklist_started_at is set, is_union is not true, union_id is
--     null and no union_clubs row names it. Idempotent: a latched club answers
--     with its first latch, and two racing calls leave exactly one.
-- All three are SECURITY DEFINER, derive the caller from auth.uid() alone and
-- answer only the club's owner (clubs.owner_id). A refusal is an error with a
-- SQLSTATE (42501 not signed in or not the owner, P0002 no such club, 22023 a
-- step that cannot be skipped, 55000 a club that cannot be latched), so the
-- client can tell an answer from a failure and fall back to today's local
-- behaviour on either.
--
-- NO CHIP MOVES and no existing row changes. The table starts empty, so every
-- club reads "not latched, nothing skipped" until its owner acts. Deep Stack
-- Society, Shark Club, Club Jaqk and every other existing club have no
-- opening_checklist_started_at and never show the checklist; nothing here
-- changes that.
--
-- One transaction, lock_timeout 5s. The DDL creates one new table and three new
-- functions; nothing takes a lock on clubs, union_clubs or club_opening_setups.
-- Apply outside the :50-:03 break window (CLAUDE.md DDL rule 8).
--
-- @live-proof: (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.club_opening_checklists')) IS TRUE
-- @live-proof: to_regprocedure('public.fn_club_opening_checklist_complete(uuid)') IS NOT NULL AND NOT has_function_privilege('anon', 'public.fn_club_opening_checklist_complete(uuid)', 'EXECUTE')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. The relations the functions read, as they are live (2026-09-23).
DO $pre$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.clubs'::regclass AND NOT a.attisdropped
         AND (a.attname, format_type(a.atttypid, a.atttypmod)) IN (
           ('id', 'uuid'), ('owner_id', 'uuid'), ('is_union', 'boolean'),
           ('union_id', 'uuid'), ('opening_checklist_started_at', 'timestamp with time zone'))) <> 5 THEN
    RAISE EXCEPTION 'OPENING_CHECKLIST_PRECONDITION: clubs does not carry the five columns the latch reads';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.union_clubs'::regclass AND a.attname = 'club_id' AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.club_opening_setups'::regclass AND a.attname = 'club_id' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'OPENING_CHECKLIST_PRECONDITION: union_clubs.club_id or club_opening_setups.club_id is missing';
  END IF;
  IF to_regclass('public.club_opening_checklists') IS NOT NULL
     OR to_regprocedure('public.fn_club_opening_checklist_state(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_club_opening_checklist_skip(uuid,text,boolean)') IS NOT NULL
     OR to_regprocedure('public.fn_club_opening_checklist_complete(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'OPENING_CHECKLIST_PRECONDITION: the checklist store already exists; this file creates it once';
  END IF;
END $pre$;

-- 2. The store.
CREATE TABLE public.club_opening_checklists (
  club_id          uuid PRIMARY KEY,
  skipped_task_ids text[] NOT NULL DEFAULT '{}'::text[],
  completed_at     timestamptz,
  completed_by     uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT club_opening_checklists_skips_are_optional_steps CHECK (
    skipped_task_ids <@ ARRAY['identity', 'tagline', 'nlh', 'plo', 'limit', 'mtt', 'spin',
                              'heads-up', 'first-player', 'first-agent']::text[]),
  CONSTRAINT club_opening_checklists_latch_names_its_owner CHECK (
    (completed_at IS NULL) = (completed_by IS NULL))
);

COMMENT ON TABLE public.club_opening_checklists IS
  'The new-club opening checklist, per club: the optional steps its owner skipped and the latch that finishes the list for good. Written only by fn_club_opening_checklist_skip and fn_club_opening_checklist_complete, read by fn_club_opening_checklist_state. No foreign key to clubs by design (CLAUDE.md DDL rule 7).';
COMMENT ON COLUMN public.club_opening_checklists.skipped_task_ids IS
  'Optional steps the owner skipped. The CHECK names all ten; opening-setup is required and can never be stored here.';
COMMENT ON COLUMN public.club_opening_checklists.completed_at IS
  'The latch. Set once, by the owner, when every step was complete or validly skipped and the opening setup wizard was done. A set latch keeps the checklist gone whatever the live data says later.';

ALTER TABLE public.club_opening_checklists ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.club_opening_checklists FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.club_opening_checklists TO service_role;

-- 3. The owner reads the checklist state.
CREATE FUNCTION public.fn_club_opening_checklist_state(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_row public.club_opening_checklists%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign In To Read The Opening Checklist' USING ERRCODE = '42501';
  END IF;
  SELECT c.owner_id INTO v_owner FROM public.clubs c WHERE c.id = p_club_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
  END IF;
  IF v_owner IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only The Club Owner Can Read The Opening Checklist' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.club_opening_checklists k WHERE k.club_id = p_club_id;
  RETURN jsonb_build_object(
    'clubId', p_club_id,
    'completedAt', v_row.completed_at,
    'skippedTaskIds', to_jsonb(COALESCE(v_row.skipped_task_ids, '{}'::text[])));
END;
$function$;

COMMENT ON FUNCTION public.fn_club_opening_checklist_state(uuid) IS
  'Owner only. {clubId, completedAt, skippedTaskIds} for the new-club opening checklist. Writes nothing.';
REVOKE ALL ON FUNCTION public.fn_club_opening_checklist_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_opening_checklist_state(uuid) TO authenticated, service_role;

-- 4. The owner sets or clears one skip.
CREATE FUNCTION public.fn_club_opening_checklist_skip(p_club_id uuid, p_task_id text, p_skipped boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_task text := btrim(COALESCE(p_task_id, ''));
  v_row public.club_opening_checklists%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign In To Change The Opening Checklist' USING ERRCODE = '42501';
  END IF;
  IF p_skipped IS NULL THEN
    RAISE EXCEPTION 'Say Whether The Step Is Skipped' USING ERRCODE = '22023';
  END IF;
  /* The opening setup wizard is the one REQUIRED step. It can never be
     skipped, here or anywhere, and the CHECK on the table says so too. */
  IF v_task = 'opening-setup' THEN
    RAISE EXCEPTION 'The Opening Setup Wizard Is Required And Cannot Be Skipped' USING ERRCODE = '22023';
  END IF;
  IF NOT (v_task = ANY (ARRAY['identity', 'tagline', 'nlh', 'plo', 'limit', 'mtt', 'spin',
                              'heads-up', 'first-player', 'first-agent']::text[])) THEN
    RAISE EXCEPTION 'That Is Not An Optional Opening Checklist Step' USING ERRCODE = '22023';
  END IF;
  SELECT c.owner_id INTO v_owner FROM public.clubs c WHERE c.id = p_club_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
  END IF;
  IF v_owner IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only The Club Owner Can Change The Opening Checklist' USING ERRCODE = '42501';
  END IF;

  IF p_skipped THEN
    /* One statement, so two tabs skipping two steps at once both land: the
       second waits on the first's row and merges into what it committed. */
    INSERT INTO public.club_opening_checklists AS k (club_id, skipped_task_ids)
    VALUES (p_club_id, ARRAY[v_task])
    ON CONFLICT (club_id) DO UPDATE
       SET skipped_task_ids = ARRAY(SELECT DISTINCT s
                                      FROM unnest(k.skipped_task_ids || ARRAY[v_task]) AS s
                                     ORDER BY s),
           updated_at = now()
     WHERE NOT (v_task = ANY (k.skipped_task_ids));
  ELSE
    UPDATE public.club_opening_checklists k
       SET skipped_task_ids = array_remove(k.skipped_task_ids, v_task),
           updated_at = now()
     WHERE k.club_id = p_club_id
       AND v_task = ANY (k.skipped_task_ids);
  END IF;

  SELECT * INTO v_row FROM public.club_opening_checklists k WHERE k.club_id = p_club_id;
  RETURN jsonb_build_object(
    'clubId', p_club_id,
    'completedAt', v_row.completed_at,
    'skippedTaskIds', to_jsonb(COALESCE(v_row.skipped_task_ids, '{}'::text[])));
END;
$function$;

COMMENT ON FUNCTION public.fn_club_opening_checklist_skip(uuid, text, boolean) IS
  'Owner only. Sets or clears one skip of an OPTIONAL opening checklist step; refuses opening-setup and unknown ids. Idempotent.';
REVOKE ALL ON FUNCTION public.fn_club_opening_checklist_skip(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_opening_checklist_skip(uuid, text, boolean) TO authenticated, service_role;

-- 5. The owner latches the checklist finished.
CREATE FUNCTION public.fn_club_opening_checklist_complete(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club record;
  v_row public.club_opening_checklists%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign In To Finish The Opening Checklist' USING ERRCODE = '42501';
  END IF;
  SELECT c.owner_id, c.is_union, c.union_id, c.opening_checklist_started_at
    INTO v_club FROM public.clubs c WHERE c.id = p_club_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
  END IF;
  IF v_club.owner_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only The Club Owner Can Finish The Opening Checklist' USING ERRCODE = '42501';
  END IF;

  -- Already finished: the first latch is the answer, every time.
  SELECT * INTO v_row FROM public.club_opening_checklists k WHERE k.club_id = p_club_id;
  IF FOUND AND v_row.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'clubId', p_club_id,
      'completedAt', v_row.completed_at,
      'skippedTaskIds', to_jsonb(v_row.skipped_task_ids));
  END IF;

  /* A NEW STANDALONE CLUB, by the rules the lobby applies
     (src/utils/clubOpeningEligibility.ts hasNewClubOpeningChecklist): created
     after the checklist shipped, not a union, and in no union by either
     link. Anything else never had this checklist and cannot finish it. */
  IF v_club.opening_checklist_started_at IS NULL THEN
    RAISE EXCEPTION 'This Club Has No Opening Checklist' USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_club.is_union, false)
     OR v_club.union_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.union_clubs uc WHERE uc.club_id = p_club_id) THEN
    RAISE EXCEPTION 'A Union Club Finishes Setup From The Union Console' USING ERRCODE = '55000';
  END IF;
  -- The one required step is the opening setup wizard.
  IF NOT EXISTS (SELECT 1 FROM public.club_opening_setups s WHERE s.club_id = p_club_id) THEN
    RAISE EXCEPTION 'Complete The Opening Setup Wizard First' USING ERRCODE = '55000';
  END IF;

  /* Two racing calls leave one latch: the second waits on the first's row and
     then finds it already set, so the WHERE refuses to move it. */
  INSERT INTO public.club_opening_checklists AS k (club_id, completed_at, completed_by)
  VALUES (p_club_id, now(), v_uid)
  ON CONFLICT (club_id) DO UPDATE
     SET completed_at = now(), completed_by = v_uid, updated_at = now()
   WHERE k.completed_at IS NULL;

  SELECT * INTO v_row FROM public.club_opening_checklists k WHERE k.club_id = p_club_id;
  RETURN jsonb_build_object(
    'clubId', p_club_id,
    'completedAt', v_row.completed_at,
    'skippedTaskIds', to_jsonb(v_row.skipped_task_ids));
END;
$function$;

COMMENT ON FUNCTION public.fn_club_opening_checklist_complete(uuid) IS
  'Owner only. Latches the new-club opening checklist finished. Refused unless the opening setup wizard is complete and the club is a new standalone club. Idempotent; the first latch stands.';
REVOKE ALL ON FUNCTION public.fn_club_opening_checklist_complete(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_opening_checklist_complete(uuid) TO authenticated, service_role;

-- 6. What this file promised, checked before it commits.
DO $post$
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
           WHERE c.oid = 'public.club_opening_checklists'::regclass) THEN
    RAISE EXCEPTION 'OPENING_CHECKLIST_POSTCONDITION: RLS is not on';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
              WHERE p.polrelid = 'public.club_opening_checklists'::regclass) THEN
    RAISE EXCEPTION 'OPENING_CHECKLIST_POSTCONDITION: the store must carry no policy';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
              WHERE k.conrelid = 'public.club_opening_checklists'::regclass AND k.contype = 'f') THEN
    RAISE EXCEPTION 'OPENING_CHECKLIST_POSTCONDITION: the store must carry no foreign key (CLAUDE.md DDL rule 7)';
  END IF;
  IF has_table_privilege('anon', 'public.club_opening_checklists', 'SELECT')
     OR has_table_privilege('authenticated', 'public.club_opening_checklists', 'SELECT')
     OR has_table_privilege('authenticated', 'public.club_opening_checklists', 'INSERT')
     OR has_table_privilege('authenticated', 'public.club_opening_checklists', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.club_opening_checklists', 'DELETE') THEN
    RAISE EXCEPTION 'OPENING_CHECKLIST_POSTCONDITION: a browser role holds a privilege on the store';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.oid IN (to_regprocedure('public.fn_club_opening_checklist_state(uuid)'),
                       to_regprocedure('public.fn_club_opening_checklist_skip(uuid,text,boolean)'),
                       to_regprocedure('public.fn_club_opening_checklist_complete(uuid)'))
         AND p.prosecdef
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') <> 3 THEN
    RAISE EXCEPTION 'OPENING_CHECKLIST_POSTCONDITION: a checklist function is not an owner-only definer with the expected grants';
  END IF;
  IF (SELECT count(*) FROM public.club_opening_checklists) <> 0 THEN
    RAISE EXCEPTION 'OPENING_CHECKLIST_POSTCONDITION: the store must start empty';
  END IF;
END $post$;

COMMIT;
