-- What the seven admission doors need to run in isolation.
--
-- PART 1 is captured EXACTLY from production project kuklfnapbkmacvwxktbh on
-- 2026-09-24 (UTC) with pg_get_functiondef, read-only: the authorization and
-- session helpers the doors call BEFORE the admission line, so the harness
-- proves admission sits behind the real authorization.
--
-- PART 2 is NOT production: minimal relations and two clearly named stand-ins
-- for the delegated creators (fn_create_tournament_governed_legacy and
-- fn_cash_game_create_impl_20260905). This migration does not change either
-- creator; the stand-ins only write the row the real one would, so "no side
-- effect" and "the action proceeds" can be observed on real rows.

-- ===== PART 1: live helpers, verbatim =====================================

CREATE OR REPLACE FUNCTION public.is_club_admin(p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id=p_club_id AND asset='diamonds') THEN RETURN false; END IF;
    RETURN EXISTS (
        SELECT 1 FROM clubs WHERE id = p_club_id AND owner_id = p_user_id
    ) OR EXISTS (
        SELECT 1 FROM club_members
        WHERE club_id = p_club_id
        AND user_id = p_user_id
        AND role IN ('owner', 'co_owner', 'admin')
        AND status = 'active'
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_union_context(p_club_id uuid)
 RETURNS TABLE(own_union_id uuid, member_union_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_union boolean;
  v_union_id uuid;
  v_own      uuid;
BEGIN
  own_union_id := NULL;
  member_union_id := NULL;

  IF p_club_id IS NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(c.is_union, false), c.union_id
    INTO v_is_union, v_union_id
    FROM clubs c
   WHERE c.id = p_club_id;

  IF NOT FOUND THEN
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_is_union OR v_union_id = p_club_id
     OR EXISTS (SELECT 1 FROM unions u WHERE u.id = p_club_id) THEN
    v_own := p_club_id;
    v_union_id := NULL;
  END IF;

  IF v_own IS NULL AND v_union_id IS NULL THEN
    SELECT uc.union_id INTO v_union_id
      FROM union_clubs uc
     WHERE uc.club_id = p_club_id
       AND uc.union_id <> p_club_id
     LIMIT 1;
  END IF;

  own_union_id := v_own;
  member_union_id := v_union_id;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_can_create_games(p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_own    uuid;
  v_member uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id=p_club_id AND asset='diamonds') THEN RETURN false; END IF;
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id) THEN
    RETURN false;
  END IF;

  SELECT own_union_id, member_union_id INTO v_own, v_member
    FROM fn_club_union_context(p_club_id);

  IF v_own IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM unions u
                    WHERE u.id = v_own AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM union_admins a
                    WHERE a.union_id = v_own AND a.user_id = p_user_id)
        OR EXISTS (SELECT 1 FROM clubs c
                    WHERE c.id = p_club_id AND c.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM club_members m
                    WHERE m.club_id = p_club_id AND m.user_id = p_user_id
                      AND m.role IN ('owner', 'co_owner', 'admin')
                      AND m.status IN ('active', 'approved'));
  END IF;

  IF v_member IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM unions u
                    WHERE u.id = v_member AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM union_admins a
                    WHERE a.union_id = v_member AND a.user_id = p_user_id);
  END IF;

  RETURN EXISTS (SELECT 1 FROM clubs c
                  WHERE c.id = p_club_id AND c.owner_id = p_user_id)
      OR EXISTS (SELECT 1 FROM club_members m
                  WHERE m.club_id = p_club_id
                    AND m.user_id = p_user_id
                    AND m.role IN ('owner', 'co_owner', 'admin')
                    AND m.status IN ('active', 'approved'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_caller_is_engine()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
  -- The engine and every server-side job authenticate as service_role. A NULL
  -- means there is no PostgREST request context at all - psql, pg_cron, a
  -- migration - which is equally trusted. A browser can never produce NULL:
  -- reaching `authenticated` requires a verified JWT and PostgREST always sets
  -- request.jwt.claims from it.
  --
  -- NOT current_user. Inside a SECURITY DEFINER body current_user is the
  -- function OWNER for the browser and the engine alike, which is what made an
  -- earlier guard on club_members a silent no-op.
  SELECT COALESCE(auth.role(), 'service_role') = 'service_role';
$function$;

CREATE OR REPLACE FUNCTION public.fn_caller_session_is_live()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
DECLARE
  v_claims jsonb;
  v_sid    uuid;
BEGIN
  IF public.fn_caller_is_engine() THEN
    RETURN true;
  END IF;

  -- Malformed or absent claims are not a crash, they are a refusal.
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;

  IF v_claims IS NULL THEN
    RETURN false;
  END IF;

  BEGIN
    v_sid := (v_claims ->> 'session_id')::uuid;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;

  IF v_sid IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM auth.sessions s
     WHERE s.id = v_sid
       AND (s.not_after IS NULL OR s.not_after > now())
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cash_override_bool(p_o jsonb, p_key text, p_default boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v text := p_o->>p_key;
BEGIN
  IF v IS NULL THEN RETURN p_default; END IF;
  IF lower(v) IN ('true', 't', '1') THEN RETURN true; END IF;
  IF lower(v) IN ('false', 'f', '0') THEN RETURN false; END IF;
  RAISE EXCEPTION 'OVERRIDE_INVALID: % must be true or false, got %', p_key, v;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_can_manage_tournament_schedule(p_union_id uuid, p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_union_id IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM public.unions u
                    WHERE u.id = p_union_id AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM public.union_admins ua
                    WHERE ua.union_id = p_union_id AND ua.user_id = p_user_id);
  END IF;
  RETURN public.is_club_admin(p_club_id, p_user_id);
END; $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_is_new_mtt(p_row jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN false
    -- A genuine satellite target has product meaning; an empty object does not.
    WHEN (jsonb_typeof(p_row->'satellite_target_id')='string'
          AND NULLIF(btrim(p_row->>'satellite_target_id'),'') IS NOT NULL)
      OR (jsonb_typeof(p_row->'satelliteTargetId')='string'
          AND NULLIF(btrim(p_row->>'satelliteTargetId'),'') IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM (VALUES(p_row->'satellite_target'),(p_row->'satelliteTarget')) s(target)
         WHERE (jsonb_typeof(target)='string'
                AND NULLIF(btrim(target#>>'{}'),'') IS NOT NULL)
            OR (jsonb_typeof(target)='object' AND (
                 (jsonb_typeof(target->'tournamentId')='string'
                  AND NULLIF(btrim(target->>'tournamentId'),'') IS NOT NULL)
                 OR (jsonb_typeof(target->'tournament_id')='string'
                  AND NULLIF(btrim(target->>'tournament_id'),'') IS NOT NULL)))
      ) THEN true
    WHEN lower(btrim(COALESCE(p_row->>'tournament_type',p_row->>'tournamentType',p_row->>'type','')))
      IN ('mtt','xmtt','satellite','freezeout','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty','rebuy','reentry','mtt_freezeout','mtt_free_buy','mtt_rebuy','mtt_reentry') THEN true
    WHEN lower(btrim(COALESCE(p_row->>'tournament_type',p_row->>'tournamentType',p_row->>'type','')))
      IN ('sng','spin','hu_sng','heads_up') THEN false
    ELSE lower(btrim(COALESCE(p_row->>'variant',''))) IN ('mtt','xmtt','satellite','freezeout','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty','rebuy','reentry','mtt_freezeout','mtt_free_buy','mtt_rebuy','mtt_reentry')
  END;
$function$;

-- The membership helpers the member doors call (captured 2026-09-24):
--   fn_club_membership_lock(uuid)            07343122ba0f2fa43bfb879184d56be9
--   fn_club_membership_count(uuid,uuid)      3e9b2104d51842cfd202bd30e0a1c9a1
--   fn_club_membership_cap()                 6511fc3913189151b46c3953033a289d
--   fn_join_club_membership_impl(uuid)       dc9908bbe4447d2a455039efd2ff0137
CREATE OR REPLACE FUNCTION public.fn_club_membership_lock(p_user_id uuid)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT pg_advisory_xact_lock(hashtextextended(p_user_id::text, 77431))
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_membership_count(p_user_id uuid, p_excluding_club uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT count(*)::integer
    FROM public.club_members cm
   WHERE cm.user_id = p_user_id
     AND cm.status::text IN ('active', 'approved')
     AND COALESCE(cm.membership_lifecycle_status::text, 'active') = 'active'
     AND (p_excluding_club IS NULL OR cm.club_id <> p_excluding_club)
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_membership_cap()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$ SELECT 10 $function$;

CREATE OR REPLACE FUNCTION public.fn_join_club_membership_impl(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
    PERFORM public.fn_club_membership_lock(v_uid);
    v_active_count := public.fn_club_membership_count(v_uid);
    IF v_active_count >= public.fn_club_membership_cap() THEN
      RAISE EXCEPTION 'You can only be a member of up to % clubs. Leave a club to join a new one.',
        public.fn_club_membership_cap();
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
$function$;
REVOKE ALL ON FUNCTION public.fn_club_membership_lock(uuid), public.fn_club_membership_count(uuid,uuid),
  public.fn_club_membership_cap(), public.fn_join_club_membership_impl(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_club_membership_lock(uuid), public.fn_club_membership_count(uuid,uuid),
  public.fn_club_membership_cap(), public.fn_join_club_membership_impl(uuid) TO service_role;

-- The schedule door's zone check (captured 2026-09-24 13:10 UTC, 20260924045822):
--   fn_schedule_time_zone_is_known(text)     0fe6c641a93674740394fd523f107faf
CREATE OR REPLACE FUNCTION public.fn_schedule_time_zone_is_known(p_zone text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT p_zone IS NULL
      OR ((p_zone IN ('UTC', 'GMT')
           OR p_zone ~ '^[A-Z][A-Za-z]+/[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)?$')
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names n WHERE n.name = p_zone))
$function$;

-- ===== PART 2: fixture relations and stand-ins (NOT production) ============

CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY, user_id uuid, not_after timestamptz);

-- The agents relation the member doors read (columns they touch only).
CREATE TABLE IF NOT EXISTS public.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  total_players integer NOT NULL DEFAULT 0,
  active_player_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.agents TO service_role;

CREATE TABLE public.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid,
  name text NOT NULL,
  game_type text NOT NULL DEFAULT 'cash',
  status text NOT NULL DEFAULT 'waiting',
  insurance_enabled boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL,
  user_id uuid NOT NULL,
  seat_number integer NOT NULL,
  stack numeric NOT NULL DEFAULT 0
);
-- The base Diamond Games fixture already carries the captured tournaments
-- relation; this minimal shape is used only when it does not.
CREATE TABLE IF NOT EXISTS public.tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid,
  name text,
  status text NOT NULL DEFAULT 'registering',
  payout_percent smallint,
  buy_in_amount numeric NOT NULL DEFAULT 0,
  buy_in_fee numeric NOT NULL DEFAULT 0,
  start_time timestamptz NOT NULL DEFAULT now(),
  max_players integer NOT NULL DEFAULT 9,
  is_mystery_bounty boolean NOT NULL DEFAULT false,
  schedule_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL,
  user_id uuid NOT NULL
);
CREATE TABLE public.tournament_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  union_id uuid,
  club_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  days_of_week integer[] NOT NULL DEFAULT '{}',
  start_times_utc text[] NOT NULL DEFAULT '{}',
  interval_minutes integer,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  time_zone text
);

-- STAND-IN for fn_tournament_config_refusal(jsonb,text) (production md5
-- c1a376cb8d9a01b4ba9db181c7ab9e50, 20260924033701): the configuration rules
-- both tournament doors check BEFORE admission. This migration does not touch
-- them and the scenarios use configurations production accepts, so the
-- stand-in accepts every configuration (NULL = no refusal).
CREATE FUNCTION public.fn_tournament_config_refusal(p_config jsonb, p_context text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::text $$;
-- STAND-IN for fn_mystery_bounty_creation_document(jsonb): only a mystery
-- bounty reaches it, and no scenario creates one.
CREATE FUNCTION public.fn_mystery_bounty_creation_document(p_config jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture: mystery bounty creation is not exercised'; END $$;

-- STAND-IN for the governed tournament creator: writes the club event the
-- real creator writes and answers with the same receipt shape.
CREATE FUNCTION public.fn_create_tournament_governed_legacy(p_club_id uuid, p_config jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.tournaments (club_id, name, payout_percent, buy_in_amount, buy_in_fee, start_time, max_players)
  VALUES (p_club_id, COALESCE(p_config->>'name', 'Fixture Event'), 10, 0, 0, now() + interval '1 hour', 9) RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'tournament_id', v_id);
END $$;

-- STAND-IN for the cash creator: writes Main 1 with the resolved insurance
-- option the real creator snapshots.
CREATE FUNCTION public.fn_cash_game_create_impl_20260905(p_club_id uuid, p_template text, p_variant text, p_sb numeric, p_bb numeric, p_handedness integer, p_overrides jsonb, p_name text, p_must_move boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.tables (club_id, name, insurance_enabled, created_by)
  VALUES (p_club_id, COALESCE(p_name, 'Fixture Main 1'),
          public.fn_cash_override_bool(COALESCE(p_overrides->'options', '{}'::jsonb), 'insurance_enabled', false), auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'game_id', NULL, 'table_id', v_id);
END $$;

REVOKE ALL ON FUNCTION public.fn_create_tournament_governed_legacy(uuid, jsonb),
  public.fn_cash_game_create_impl_20260905(uuid, text, text, numeric, numeric, integer, jsonb, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_club_admin(uuid, uuid), public.fn_can_create_games(uuid, uuid), public.fn_caller_session_is_live(),
  public.fn_can_manage_tournament_schedule(uuid, uuid, uuid), public.fn_club_union_context(uuid) TO authenticated, service_role;
GRANT SELECT ON public.tables, public.tournaments, public.tournament_schedules TO authenticated;
GRANT ALL ON public.tables, public.table_seats, public.tournaments, public.tournament_players, public.tournament_schedules TO service_role;
GRANT SELECT ON auth.sessions TO authenticated, service_role;
