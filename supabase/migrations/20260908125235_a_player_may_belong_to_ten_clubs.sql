-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908125235; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908125235   (the stamp IS the apply time, UTC: 2026-09-08 12:52:35)
--   name        a_player_may_belong_to_ten_clubs
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 10328 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908125235 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_enforce_four_club_limit, public.fn_join_club_membership_impl, public.fn_join_club, public.fn_create_club_atomic_membership_impl
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- Raise the club membership cap from 4 to 10.
--
-- The cap is enforced in FOUR places, not one. Changing only the trigger would
-- leave the two join paths and the create path still refusing at 4, so all four
-- move together or the change does not take effect.
--
--   1. fn_enforce_four_club_limit()            -- the trigger on club_members
--   2. fn_join_club_membership_impl(uuid)      -- the join path
--   3. fn_join_club(uuid)                      -- the rejoin-after-departure path
--   4. fn_create_club_atomic_membership_impl() -- the create-a-club path
--
-- Nothing else changes: same signatures, same security, same search_path, same
-- bypasses (is_horse on the trigger, owner on the join paths). The function name
-- fn_enforce_four_club_limit is deliberately NOT renamed -- two triggers
-- (trg_four_club_limit_ins, trg_four_club_limit_upd) reference it, and a rename
-- would mean dropping and recreating them for no behavioural gain. The name is
-- now a misnomer; the behaviour is the contract.

CREATE OR REPLACE FUNCTION public.fn_enforce_four_club_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_count int;
BEGIN
  IF NEW.status NOT IN ('active', 'approved') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IN ('active', 'approved') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM profiles WHERE id = NEW.user_id AND COALESCE(is_horse, false)
  ) THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_count
    FROM club_members
   WHERE user_id = NEW.user_id
     AND status IN ('active', 'approved')
     AND club_id <> NEW.club_id;

  IF v_count >= 10 THEN
    RAISE EXCEPTION
      'You can only be a member of up to 10 clubs. Leave a club to join a new one.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;


CREATE OR REPLACE FUNCTION public.fn_join_club_membership_impl(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_requires_approval boolean;
  v_active_count int;
  v_role text;
  v_status text;
  v_row club_members%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT owner_id, COALESCE(requires_approval, false)
    INTO v_owner, v_requires_approval
    FROM clubs
    WHERE id = p_club_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club not found';
  END IF;

  SELECT * INTO v_row FROM club_members
    WHERE club_id = p_club_id AND user_id = v_uid;
  IF FOUND THEN
    RETURN to_jsonb(v_row);
  END IF;

  IF v_uid = v_owner THEN
    v_role := 'owner';
    v_status := 'active';
  ELSE
    SELECT count(*) INTO v_active_count
      FROM club_members
      WHERE user_id = v_uid AND status IN ('active', 'approved');
    IF v_active_count >= 10 THEN
      RAISE EXCEPTION 'You can only be a member of up to 10 clubs. Leave a club to join a new one.';
    END IF;

    v_role := 'player';
    v_status := CASE WHEN v_requires_approval THEN 'pending' ELSE 'active' END;
  END IF;

  -- chip_balance = 0 written EXPLICITLY: the default was 1000 until 2026-08-26.
  INSERT INTO club_members (club_id, user_id, role, status, tier, rank_level, orange_ball_status, chip_balance)
  VALUES (p_club_id, v_uid, v_role, v_status, 'bronze', 0, 'cold', 0)
  ON CONFLICT (club_id, user_id) DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    SELECT * INTO v_row FROM club_members
      WHERE club_id = p_club_id AND user_id = v_uid;
  END IF;

  RETURN to_jsonb(v_row);
END;
$fn$;


CREATE OR REPLACE FUNCTION public.fn_join_club(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET lock_timeout TO '5s'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_row public.club_members%ROWTYPE;
  v_owner uuid;
  v_requires_approval boolean;
  v_lifecycle text;
  v_active_count integer;
  v_previous_source text := coalesce(current_setting('app.club_membership_source', true), '');
  v_previous_lifecycle text := coalesce(current_setting('app.club_membership_lifecycle_write', true), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('app.club_membership_source', 'join_club', true);
  BEGIN
    v_result := public.fn_join_club_membership_impl(p_club_id);

    IF coalesce(v_result ->> 'membership_lifecycle_status', 'active') = 'departed' THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('cashier-hierarchy:' || p_club_id::text, 0)
      );
      SELECT c.owner_id, coalesce(c.requires_approval, false),
             coalesce(to_jsonb(c) ->> 'lifecycle_status', 'active')
        INTO v_owner, v_requires_approval, v_lifecycle
        FROM public.clubs c
       WHERE c.id = p_club_id
       FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Club not found'; END IF;
      IF v_lifecycle = 'retired' THEN
        RAISE EXCEPTION 'This Club Is Retired And Cannot Accept Members' USING ERRCODE = '55000';
      END IF;

      SELECT count(*) INTO v_active_count
        FROM public.club_members cm
       WHERE cm.user_id = v_uid
         AND cm.club_id <> p_club_id
         AND cm.membership_lifecycle_status = 'active'
         AND cm.status::text IN ('active', 'approved');
      IF v_uid <> v_owner AND v_active_count >= 10 THEN
        RAISE EXCEPTION 'You can only be a member of up to 10 clubs. Leave a club to join a new one.';
      END IF;

      PERFORM set_config('app.club_membership_lifecycle_write', 'rejoin', true);
      UPDATE public.club_members cm
         SET membership_lifecycle_status = 'active',
             status = CASE
               WHEN v_uid = v_owner OR NOT v_requires_approval THEN 'active'
               ELSE 'pending'
             END,
             is_active = true,
             departed_at = NULL,
             departed_by = NULL,
             departure_reason = NULL,
             updated_at = clock_timestamp()
       WHERE cm.club_id = p_club_id
         AND cm.user_id = v_uid
         AND cm.membership_lifecycle_status = 'departed'
       RETURNING * INTO v_row;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'membership lifecycle changed during rejoin' USING ERRCODE = '40001';
      END IF;
      v_result := to_jsonb(v_row);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.club_membership_source', v_previous_source, true);
    PERFORM set_config('app.club_membership_lifecycle_write', v_previous_lifecycle, true);
    RAISE;
  END;

  PERFORM set_config('app.club_membership_source', v_previous_source, true);
  PERFORM set_config('app.club_membership_lifecycle_write', v_previous_lifecycle, true);
  RETURN v_result;
END
$fn$;


CREATE OR REPLACE FUNCTION public.fn_create_club_atomic_membership_impl(p_request_id uuid, p_name text, p_description text DEFAULT NULL::text, p_color_theme text DEFAULT 'royal-blue'::text, p_is_public boolean DEFAULT true, p_requires_approval boolean DEFAULT false, p_logo_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := btrim(COALESCE(p_name, ''));
  v_description text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_existing uuid;
  v_club public.clubs%ROWTYPE;
  v_code integer;
  v_slug_root text;
  v_memberships integer;
  v_attempt integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A creation request ID is required' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_entry_feature_flags f WHERE f.key = 'create_club'
      AND (NOT f.enabled OR ((hashtextextended(v_uid::text || ':' || f.key, 44119)
          & 9223372036854775807) % 100) >= f.rollout_percent)
  ) THEN
    RAISE EXCEPTION 'Club creation is temporarily unavailable.' USING ERRCODE = 'P0001';
  END IF;
  IF length(v_name) < 3 OR length(v_name) > 30 THEN
    RAISE EXCEPTION 'Club name must be between 3 and 30 characters' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 77431));
  PERFORM pg_advisory_xact_lock(77432);

  SELECT club_id INTO v_existing
    FROM public.club_creation_requests
   WHERE user_id = v_uid AND request_id = p_request_id;
  IF FOUND THEN
    SELECT * INTO v_club FROM public.clubs WHERE id = v_existing;
    RETURN to_jsonb(v_club);
  END IF;

  IF EXISTS (SELECT 1 FROM public.clubs WHERE lower(name) = lower(v_name)) THEN
    RAISE EXCEPTION 'A club with this name already exists' USING ERRCODE = '23505';
  END IF;

  SELECT count(*) INTO v_memberships
    FROM public.club_members
   WHERE user_id = v_uid AND status IN ('active', 'approved');
  IF v_memberships >= 10 THEN
    RAISE EXCEPTION 'You can only be a member of up to 10 clubs. Leave a club to create a new one.'
      USING ERRCODE = '23514';
  END IF;

  v_slug_root := trim(both '-' FROM regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  IF v_slug_root = '' THEN v_slug_root := 'club'; END IF;

  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 25 THEN
      RAISE EXCEPTION 'Could not allocate a unique club code. Please try again.';
    END IF;
    v_code := 10000 + floor(random() * 90000)::integer;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.clubs WHERE club_id = v_code);
  END LOOP;

  INSERT INTO public.clubs (
    club_id, name, slug, description, color_theme, is_public,
    requires_approval, owner_id, level, logo_url, avatar_url
  ) VALUES (
    v_code, v_name, left(v_slug_root, 42) || '-' || v_code::text,
    v_description, COALESCE(NULLIF(btrim(p_color_theme), ''), 'royal-blue'),
    COALESCE(p_is_public, true), COALESCE(p_requires_approval, false),
    v_uid, 1, NULLIF(p_logo_url, ''), NULLIF(p_logo_url, '')
  ) RETURNING * INTO v_club;

  INSERT INTO public.club_members (club_id, user_id, role, status, chip_balance)
  VALUES (v_club.id, v_uid, 'owner', 'active', 0);

  INSERT INTO public.club_creation_requests (user_id, request_id, club_id)
  VALUES (v_uid, p_request_id, v_club.id);

  RETURN to_jsonb(v_club);
END;
$fn$;
