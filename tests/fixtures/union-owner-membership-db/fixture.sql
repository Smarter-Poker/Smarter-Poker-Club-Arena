-- Stand-ins for the production objects 20261012112707 meets, for
-- scripts/ci/test-union-owner-membership-db-postgres.py. Nothing here reaches
-- production.
--
-- The two functions the migration REPLACES (fn_require_explicit_club_
-- membership_source and fn_enforce_four_club_limit) are NOT here: the harness
-- rebuilds them byte for byte from main's own migrations. Everything below is
-- the surrounding schema, with the trigger bodies an inserted or removed
-- membership meets copied from production's live definitions (read-only,
-- 2026-10-12) where they decide anything, and with a money stand-in that
-- records any wallet movement so the harness can prove there is none.

CREATE TABLE public.ca_money_rpc_registry (proname text PRIMARY KEY, status text NOT NULL, notes text);

CREATE SCHEMA auth;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT auth.jwt() ->> 'role' $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  username text,
  is_horse boolean DEFAULT false,
  is_admin boolean DEFAULT false,
  status text DEFAULT 'active'
);

CREATE TABLE public.clubs (
  id uuid PRIMARY KEY,
  name text,
  owner_id uuid REFERENCES public.profiles(id),
  is_union boolean DEFAULT false,
  asset text NOT NULL DEFAULT 'chips',
  lifecycle_status text NOT NULL DEFAULT 'active',
  requires_approval boolean DEFAULT false,
  union_id uuid,
  chip_treasury numeric NOT NULL DEFAULT 0,
  member_count integer NOT NULL DEFAULT 0
);

CREATE TABLE public.unions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.union_clubs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  union_id uuid NOT NULL REFERENCES public.unions(id) ON DELETE CASCADE,
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  joined_at timestamptz DEFAULT now(),
  UNIQUE (union_id, club_id)
);

CREATE TABLE public.union_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  union_id uuid NOT NULL REFERENCES public.unions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL
);

CREATE TABLE public.agents (
  club_id uuid, user_id uuid, status text
);

CREATE TABLE public.club_members (
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role text DEFAULT 'player'
    CHECK (role = ANY (ARRAY['owner','co_owner','admin','super_agent','agent','sub_agent','player'])),
  agent_id uuid,
  parent_agent_id uuid,
  joined_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  is_bot boolean DEFAULT false,
  status text DEFAULT 'active',
  chip_balance numeric NOT NULL DEFAULT 0 CHECK (chip_balance >= 0),
  is_active boolean DEFAULT true,
  credit_limit numeric DEFAULT 0,
  credit_used numeric DEFAULT 0,
  promo_balance numeric DEFAULT 0,
  locked_chips integer DEFAULT 0,
  held_chips numeric DEFAULT 0,
  membership_lifecycle_status text NOT NULL DEFAULT 'active'
    CHECK (membership_lifecycle_status = ANY (ARRAY['active','departed'])),
  departed_at timestamptz,
  departed_by uuid,
  departure_reason text,
  PRIMARY KEY (club_id, user_id)
);

CREATE TABLE public.ca_declared_money_triggers (
  table_name text NOT NULL,
  trigger_name text NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(),
  note text,
  PRIMARY KEY (table_name, trigger_name)
);

CREATE TABLE public.audit_trail (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid, actor_role text, action text, target_type text, target_id uuid,
  club_id uuid, before_state jsonb, after_state jsonb, reason text,
  created_at timestamptz DEFAULT now()
);

-- The money stand-in: production journals every club_members chip move
-- (trg_ca_autoledger_insert on a non-zero insert, trg_club_members_audit_chip_
-- movement on a balance change). Any row here is money moving.
CREATE TABLE public.chip_ledger (
  id bigserial PRIMARY KEY, club_id uuid, user_id uuid, delta numeric, source text
);
CREATE FUNCTION public.fn_stand_in_chip_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.chip_ledger(club_id, user_id, delta, source)
  VALUES (NEW.club_id, NEW.user_id,
          COALESCE(NEW.chip_balance, 0) + COALESCE(NEW.promo_balance, 0)
            - CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.chip_balance, 0) + COALESCE(OLD.promo_balance, 0) ELSE 0 END,
          TG_NAME);
  RETURN NULL;
END $$;
CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON public.club_members FOR EACH ROW
  WHEN (COALESCE(NEW.chip_balance, 0) <> 0 OR COALESCE(NEW.promo_balance, 0) <> 0)
  EXECUTE FUNCTION public.fn_stand_in_chip_journal();
CREATE TRIGGER trg_club_members_audit_chip_movement AFTER UPDATE OF chip_balance, promo_balance ON public.club_members
  FOR EACH ROW WHEN (OLD.chip_balance IS DISTINCT FROM NEW.chip_balance OR OLD.promo_balance IS DISTINCT FROM NEW.promo_balance)
  EXECUTE FUNCTION public.fn_stand_in_chip_journal();

-- Member count, as fn_sync_club_member_count keeps it (active members).
CREATE FUNCTION public.fn_stand_in_member_count() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE public.clubs c SET member_count = (SELECT count(*) FROM public.club_members m
     WHERE m.club_id = c.id AND m.status IN ('active','approved') AND m.membership_lifecycle_status = 'active')
   WHERE c.id IN (COALESCE(NEW.club_id, OLD.club_id), COALESCE(OLD.club_id, NEW.club_id));
  RETURN NULL;
END $$;
CREATE TRIGGER trg_sync_club_member_count AFTER INSERT OR DELETE OR UPDATE OF status, club_id, role, membership_lifecycle_status
  ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_stand_in_member_count();

-- The union mirror (fn_sync_club_union_mirror, live body).
CREATE FUNCTION public.fn_sync_club_union_mirror() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE clubs
       SET union_id = NEW.union_id
     WHERE id = NEW.club_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE clubs SET union_id = NULL
     WHERE id = OLD.club_id AND union_id = OLD.union_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END $function$;
CREATE TRIGGER trg_union_clubs_sync_mirror AFTER INSERT OR DELETE ON public.union_clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_club_union_mirror();

-- ── The membership cap helpers (live definitions, 20260922153234) ─────────
CREATE OR REPLACE FUNCTION public.fn_club_membership_cap()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$ SELECT 10 $function$;
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
CREATE OR REPLACE FUNCTION public.fn_club_membership_lock(p_user_id uuid)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT pg_advisory_xact_lock(hashtextextended(p_user_id::text, 77431))
$function$;

-- ── Live trigger bodies a membership write meets ──────────────────────────
CREATE OR REPLACE FUNCTION public.is_club_admin(p_club_id uuid, p_user_id uuid)
 RETURNS boolean LANGUAGE plpgsql STABLE SET search_path TO 'public', 'extensions'
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

CREATE OR REPLACE FUNCTION public.fn_membership_approval_gate()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid;
  v_requires boolean;
  v_owner uuid;
BEGIN
  IF NEW.status NOT IN ('active', 'approved') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('active', 'approved') THEN
    RETURN NEW;
  END IF;

  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  v_uid := auth.uid();

  IF NEW.user_id IS DISTINCT FROM v_uid THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(requires_approval, false), owner_id
    INTO v_requires, v_owner
    FROM clubs WHERE id = NEW.club_id;

  IF NOT FOUND OR NOT v_requires THEN
    RETURN NEW;
  END IF;

  IF v_owner = v_uid OR is_club_admin(NEW.club_id, v_uid) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status := 'pending';
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'This club requires owner approval. Your request is pending review.'
    USING ERRCODE = 'check_violation';
END;
$function$;
CREATE TRIGGER trg_approval_gate_ins BEFORE INSERT ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_membership_approval_gate();
CREATE TRIGGER trg_approval_gate_upd BEFORE UPDATE OF status ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_membership_approval_gate();

CREATE OR REPLACE FUNCTION public.fn_membership_starts_with_zero_chips()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.is_bot, false)
     OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = NEW.user_id AND COALESCE(p.is_horse, false))
  THEN
    RETURN NEW;
  END IF;

  NEW.chip_balance  := 0;
  NEW.held_chips    := 0;
  NEW.locked_chips  := 0;
  NEW.promo_balance := 0;
  NEW.credit_used   := 0;

  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_membership_starts_with_zero_chips BEFORE INSERT ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_membership_starts_with_zero_chips();

CREATE OR REPLACE FUNCTION public.fn_guard_membership_lifecycle_write()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_allowed boolean := coalesce(
    current_setting('app.club_membership_lifecycle_write', true), ''
  ) IN ('depart', 'rejoin');
BEGIN
  IF OLD.membership_lifecycle_status = 'departed' AND NOT v_allowed THEN
    RAISE EXCEPTION 'MEMBERSHIP_DEPARTED: use the Join Club workflow to return'
      USING ERRCODE = '42501';
  END IF;

  IF (NEW.membership_lifecycle_status, NEW.departed_at, NEW.departed_by, NEW.departure_reason)
       IS DISTINCT FROM
     (OLD.membership_lifecycle_status, OLD.departed_at, OLD.departed_by, OLD.departure_reason)
     AND NOT v_allowed THEN
    RAISE EXCEPTION 'MEMBERSHIP_LIFECYCLE_REQUIRES_RPC'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_club_members_guard_lifecycle_write BEFORE UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_guard_membership_lifecycle_write();

CREATE OR REPLACE FUNCTION public.fn_club_members_status_guard()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF COALESCE(current_setting('app.club_status_change', true), '') <> 'on'
       AND current_user NOT IN ('postgres', 'supabase_admin', 'service_role') THEN
      RAISE EXCEPTION
        'club_members.status must be changed through fn_club_set_member_status (attempted % -> %, as %)',
        OLD.status, NEW.status, current_user
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_club_members_status_guard BEFORE UPDATE OF status ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_club_members_status_guard();

CREATE OR REPLACE FUNCTION public.fn_club_members_role_guard()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF COALESCE(current_setting('app.club_role_change', true), '') <> 'on'
       AND current_user NOT IN ('postgres', 'supabase_admin', 'service_role') THEN
      RAISE EXCEPTION
        'club_members.role must be changed through fn_club_set_member_role (attempted % -> %, as %)',
        OLD.role, NEW.role, current_user
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_club_members_role_guard BEFORE UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_club_members_role_guard();

CREATE OR REPLACE FUNCTION public.fn_audit_club_entry_mutation()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_action text; v_club uuid; v_target uuid; v_actor uuid; v_details jsonb;
BEGIN
  v_club:=NEW.club_id; v_target:=NEW.user_id;
  v_actor:=COALESCE(auth.uid(),NEW.user_id);
  v_action:=CASE WHEN TG_OP='INSERT' THEN 'club_join_'||NEW.status ELSE 'club_join_status_changed' END;
  v_details:=jsonb_build_object('status',NEW.status,'previous_status',CASE WHEN TG_OP='UPDATE' THEN OLD.status ELSE NULL END);
  INSERT INTO public.audit_trail(
    club_id,actor_id,actor_role,action,target_type,target_id,after_state
  ) VALUES(
    v_club,v_actor,'system',v_action,TG_TABLE_NAME,v_target,jsonb_strip_nulls(v_details)
  );
  RETURN NEW;
END $function$;
CREATE TRIGGER trg_audit_club_join AFTER INSERT OR UPDATE OF status ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_audit_club_entry_mutation();

-- ── The removal doors (live definitions, read-only 2026-10-12) ─────────────
CREATE OR REPLACE FUNCTION public.fn_club_role_rank(p_role text)
 RETURNS integer LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'extensions'
AS $function$
  SELECT CASE p_role
    WHEN 'owner'       THEN 100
    WHEN 'co_owner'    THEN 90
    WHEN 'admin'       THEN 80
    WHEN 'super_agent' THEN 60
    WHEN 'agent'       THEN 40
    WHEN 'sub_agent'   THEN 20
    WHEN 'player'      THEN 0
    ELSE -1
  END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_remove_settled_club_member(p_club_id uuid, p_user_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role text; v_target record; v_changed int;
  v_me uuid := auth.uid(); v_owner uuid;
BEGIN
  IF v_me IS NULL THEN
    v_me := '00000000-0000-0000-0000-000000000000'::uuid; -- Allow system bypass
  END IF;

  SELECT c.owner_id INTO v_owner FROM public.clubs c WHERE c.id = p_club_id;
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Club Not Found');
  END IF;

  SELECT cm.role, cm.user_id, cm.status, cm.membership_lifecycle_status
    INTO v_target
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id FOR UPDATE;

  IF v_target.user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Member Not Found');
  END IF;
  IF v_target.membership_lifecycle_status = 'departed' THEN
    RETURN jsonb_build_object('success', true, 'already_departed', true, 'user_id', p_user_id, 'records_retained', true);
  END IF;

  -- BYPASSED SEAT CHECKS FOR BOT RETIREMENT!

  PERFORM set_config('app.club_membership_lifecycle_write', 'depart', true);
  UPDATE public.club_members cm
     SET status = 'suspended',
         is_active = false,
         membership_lifecycle_status = 'departed',
         departed_at = clock_timestamp(),
         departed_by = v_me,
         departure_reason = 'Removed By Club Staff',
         updated_at = clock_timestamp()
   WHERE cm.club_id = p_club_id
     AND cm.user_id = p_user_id
     AND cm.membership_lifecycle_status = 'active';
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  PERFORM set_config('app.club_membership_lifecycle_write', '', true);

  IF v_changed <> 1 THEN
    RAISE EXCEPTION 'membership changed during departure' USING ERRCODE = '55000';
  END IF;

  RETURN jsonb_build_object('success', true, 'already_departed', false, 'user_id', p_user_id, 'records_retained', true);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_remove_settled_club_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_remove_settled_club_member(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_club_set_member_status(p_club_id uuid, p_user_id uuid, p_status text, p_reason text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_status         text := lower(btrim(COALESCE(p_status, '')));
  v_reason         text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_owner          uuid;
  v_platform_admin boolean := false;
  v_staff          boolean := false;
  v_actor_role     text;
  v_target         public.club_members%ROWTYPE;
  v_old            text;
  v_changed        integer := 0;
  v_audit_id       uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sign In To Change A Member''s Status');
  END IF;
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Choose A Club Member');
  END IF;
  IF v_status NOT IN ('active', 'suspended', 'banned') THEN
    RETURN jsonb_build_object('success', false,
      'error', 'A Member Can Only Be Set Active, Suspended Or Banned');
  END IF;
  IF length(v_reason) > 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Keep The Reason Under 500 Characters');
  END IF;
  IF p_user_id = v_actor THEN
    RETURN jsonb_build_object('success', false,
      'error', 'You Cannot Change Your Own Membership Status');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:' || p_club_id::text, 0));

  SELECT c.owner_id INTO v_owner FROM public.clubs c WHERE c.id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'That Club No Longer Exists');
  END IF;

  PERFORM 1 FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id IN (v_actor, p_user_id)
   ORDER BY cm.user_id
   FOR UPDATE;

  SELECT COALESCE(p.is_admin, false) INTO v_platform_admin
    FROM public.profiles p WHERE p.id = v_actor;
  v_platform_admin := COALESCE(v_platform_admin, false);
  v_staff := COALESCE(public.is_club_admin(p_club_id, v_actor), false);

  SELECT cm.role INTO v_actor_role
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_actor
     AND cm.status::text IN ('active', 'approved');
  IF v_actor = v_owner THEN
    v_actor_role := 'owner';
  END IF;

  IF NOT v_staff AND NOT v_platform_admin THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Only Club Staff Can Suspend, Ban Or Reinstate A Member');
  END IF;

  SELECT * INTO v_target
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'That Person Is Not A Member Of This Club');
  END IF;
  IF v_target.membership_lifecycle_status = 'departed' THEN
    RETURN jsonb_build_object('success', false,
      'error', 'This Member Has Left The Club And Must Rejoin First');
  END IF;

  IF p_user_id = v_owner OR v_target.role = 'owner' THEN
    RETURN jsonb_build_object('success', false,
      'error', 'The Club Owner''s Membership Cannot Be Suspended Or Banned');
  END IF;

  IF NOT v_platform_admin AND v_actor_role IS DISTINCT FROM 'owner'
     AND public.fn_club_role_rank(v_target.role) >= public.fn_club_role_rank(v_actor_role) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Staff Can Only Change The Status Of Members Ranked Below Them');
  END IF;

  v_old := COALESCE(v_target.status::text, 'active');

  IF v_old = 'pending' THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Approve Or Deny This Join Request Instead');
  END IF;
  IF v_old NOT IN ('active', 'approved', 'suspended', 'banned') THEN
    RETURN jsonb_build_object('success', false,
      'error', 'This Membership Cannot Be Changed From Its Current State');
  END IF;

  IF v_old = v_status OR (v_status = 'active' AND v_old = 'approved') THEN
    RETURN jsonb_build_object('success', true, 'unchanged', true, 'user_id', p_user_id,
      'old_status', v_old, 'new_status', v_old);
  END IF;

  PERFORM set_config('app.club_status_change', 'on', true);
  UPDATE public.club_members cm
     SET status = v_status,
         updated_at = now()
   WHERE cm.club_id = p_club_id
     AND cm.user_id = p_user_id
     AND cm.status IS NOT DISTINCT FROM v_target.status;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  PERFORM set_config('app.club_status_change', '', true);

  IF v_changed <> 1 THEN
    RAISE EXCEPTION 'membership changed during status change' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.audit_trail (actor_id, actor_role, action, target_type, target_id,
                                  club_id, before_state, after_state, reason)
  VALUES (v_actor,
          CASE WHEN v_staff AND v_actor_role IN ('owner', 'co_owner', 'admin') THEN v_actor_role
               ELSE 'platform_admin' END,
          'set_member_status', 'club_member', p_user_id, p_club_id,
          jsonb_build_object('status', v_old, 'role', v_target.role),
          jsonb_build_object('status', v_status),
          COALESCE(v_reason, 'No Reason Given'))
  RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object('success', true, 'unchanged', false, 'user_id', p_user_id,
    'old_status', v_old, 'new_status', v_status, 'audit_id', v_audit_id,
    'reason', COALESCE(v_reason, 'No Reason Given'));
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_club_set_member_status(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_club_set_member_status(uuid, uuid, text, text) TO authenticated;

-- Self-leave: fn_member_leave_to_treasury's last statement for a member who
-- holds no chips (its treasury leg needs the ledger machinery and moves
-- nothing at zero). Stand-in: the same authorization, owner refusal and DELETE.
CREATE OR REPLACE FUNCTION public.fn_member_leave_to_treasury(p_club_id uuid, p_user_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_role text; v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NOT NULL AND v_caller <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to remove another member from this club');
  END IF;
  SELECT role INTO v_role FROM club_members WHERE club_id = p_club_id AND user_id = p_user_id FOR UPDATE;
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not a member');
  END IF;
  IF v_role = 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'owner must transfer ownership first');
  END IF;
  DELETE FROM club_members WHERE club_id = p_club_id AND user_id = p_user_id;
  RETURN jsonb_build_object('success', true, 'chips_returned', 0);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_member_leave_to_treasury(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_member_leave_to_treasury(uuid, uuid) TO authenticated, service_role;

-- ── Staff gates (live definitions): what the union owner's membership grants ─
CREATE OR REPLACE FUNCTION public.fn_cashier_member_is_active(p_club uuid, p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT EXISTS (
  SELECT 1 FROM public.club_members m WHERE m.club_id=p_club AND m.user_id=p_user
   AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=m.user_id AND p.status='deleted')
   AND coalesce(m.status,'active') IN ('active','approved')
   AND (coalesce(m.role,'player') NOT IN ('super_agent','agent','sub_agent')
    OR EXISTS (SELECT 1 FROM public.agents a WHERE a.club_id=m.club_id
     AND a.user_id=m.user_id AND a.status='active'))
 )
$function$;

CREATE OR REPLACE FUNCTION public.ca_can_view_club_finances(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    session_user IN ('postgres', 'supabase_admin')
    OR coalesce(auth.role(), '') = 'service_role'
    OR (
      auth.uid() IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM club_members cm
           WHERE cm.club_id = p_club_id
             AND cm.user_id = auth.uid()
             AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
             AND cm.role IN ('owner', 'co_owner', 'admin', 'super_agent')
             AND public.fn_cashier_member_is_active(cm.club_id, cm.user_id)
        )
        OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid())
        OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = auth.uid() AND coalesce(pr.is_admin, false))
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_bank_role(p_club_id uuid, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_club_id IS NULL THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id = p_club_id
         AND c.owner_id = coalesce(p_user_id, auth.uid())
    ) THEN 'owner'
    ELSE (
      SELECT m.role
        FROM public.club_members m
       WHERE m.club_id = p_club_id
         AND m.user_id = coalesce(p_user_id, auth.uid())
         AND public.fn_cashier_member_is_active(m.club_id, m.user_id)
       LIMIT 1
    )
  END
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_is_staff(p_club_id uuid, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id = p_club_id
       AND c.owner_id = COALESCE(p_user_id, auth.uid())
  ) OR EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.user_id = COALESCE(p_user_id, auth.uid())
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND COALESCE(cm.status, 'active') IN ('active', 'approved')
  );
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
  v_own uuid;
  v_member uuid;
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id = p_club_id AND c.lifecycle_status = 'active'
  ) THEN RETURN false; END IF;

  SELECT own_union_id, member_union_id INTO v_own, v_member
    FROM public.fn_club_union_context(p_club_id);
  IF v_own IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM public.unions u WHERE u.id = v_own AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id = v_own AND a.user_id = p_user_id)
        OR public.fn_club_is_staff(p_club_id,p_user_id);
  END IF;
  IF v_member IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM public.unions u WHERE u.id = v_member AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id = v_member AND a.user_id = p_user_id);
  END IF;
  RETURN public.fn_club_is_staff(p_club_id,p_user_id);
END
$function$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
