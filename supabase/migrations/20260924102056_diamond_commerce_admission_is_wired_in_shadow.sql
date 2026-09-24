-- 20260924102056_diamond_commerce_admission_is_wired_in_shadow.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), sections 2.3, 4.3, 6.3 and
-- D21 / D22 / D28 / D52 / D53. fn_ca_commerce_admission (20260922143541)
-- answered whether a scope may admit a NEW discretionary operation, but no
-- door asked it, and any signed-in caller could ask it about any scope.
--
-- 1. Every prospective, owner-initiated operating action named by the
--    admission map now consults admission on the server, in the door itself:
--      approve a new club member ....... fn_review_join_request (approve only)
--      open a new table ................ fn_cash_game_create
--      offer insurance on a new table .. fn_cash_game_create (insurance option)
--      create a tournament ............. fn_create_tournament
--      create a recurring schedule ..... fn_upsert_tournament_schedule (new only)
--    Each decision is recorded durably in ca_commerce_admission_decisions
--    (scope, action, door, would_allow, enforced, allowed, reason, actor,
--    subject id, at; ids only). In SHADOW (admission_enforced_from NULL or in
--    the future) the action always proceeds. Once staff set
--    admission_enforced_from and it passes, a would-deny refuses before the
--    action writes anything, with a Title Case sentence.
-- 2. Nothing else is gated. Seating, dealing, betting, rebuys, cash-outs,
--    payouts, settlement, a player's tournament registration, members already
--    approved, tables and tournaments already open, schedules already created
--    (and their spawns), and every engine/system writer (auto-spawn, feeder
--    tables, balancing, horse floor seeding, horse club joins) never reach
--    these doors: each door requires a signed-in caller who passed the door's
--    own authorization, and the gate sits after that check. No trigger is
--    added anywhere (the D21 / D28 harness check stays true).
-- 3. fn_ca_commerce_admission (the browser read) now answers only a caller
--    who owns or administers the scope (club owner/co-owner/admin, union
--    owner/admin, the union owner/admin of a covered club, platform staff);
--    anyone else gets {"error":"access_denied"}. Service role is unrestricted.
--    The decision itself moves, unchanged except that every answer now names
--    would_allow, to fn_ca_commerce_admission_decide (internal).
--
-- How the doors are amended: the anchor-insert pattern of
-- 20260914120854. Each door is read with pg_get_functiondef at apply time,
-- the anchor must occur exactly once, the door's own authorization must occur
-- before it, the gate must not already be present; the replacement is
-- executed, read back, and must equal the original once the inserted text is
-- removed, with the ACL unchanged. A concurrent change elsewhere in a door
-- body is therefore preserved, and a change that moved the anchor stops this
-- migration instead of clobbering it.
--
-- Enforcement stays OFF: this migration refuses to apply if
-- admission_enforced_from is already set, and never sets it.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
-- The database refuses DDL inside the hourly break window (:50 to :03 UTC).
--
-- The door amendments create no object of their own, so they state their proof:
-- @live-proof: (SELECT count(*) = 4 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc LIKE '%fn_ca_commerce_admit(%' AND p.proname IN ('fn_review_join_request','fn_cash_game_create','fn_create_tournament','fn_upsert_tournament_schedule'))
-- @live-proof: (SELECT strpos(pg_get_functiondef('public.fn_ca_commerce_admission(text,uuid,text)'::regprocedure), 'access_denied') > 0)

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 0. The installed baseline, exactly.
-- ---------------------------------------------------------------------------
DO $baseline$
DECLARE
  r record;
BEGIN
  -- The admission read this migration replaces still carries the body
  -- 20260922143541 installed (no later migration touched it).
  IF md5(pg_get_functiondef('public.fn_ca_commerce_admission(text,uuid,text)'::regprocedure)) <> '9fc091db66ee2265502e042420ddd84e' THEN
    RAISE EXCEPTION 'fn_ca_commerce_admission changed since 20260922143541; review before replacing it';
  END IF;
  -- Shadow first: wiring must never switch enforcement on by landing.
  IF (SELECT admission_enforced_from FROM public.ca_commerce_settings WHERE id = 1) IS NOT NULL THEN
    RAISE EXCEPTION 'admission_enforced_from is already set; wire admission in shadow first, then enforce by a separate recorded staff event';
  END IF;
  IF to_regclass('public.ca_commerce_admission_decisions') IS NOT NULL
     OR to_regprocedure('public.fn_ca_commerce_admit(text,uuid,text,text,uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_ca_commerce_admission_decide(text,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.fn_ca_commerce_admission_message(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'admission wiring objects already exist; this migration has run or collided';
  END IF;
  -- The helpers the decision reads, and the append-only guard it reuses.
  FOR r IN SELECT unnest(ARRAY[
      'public.fn_ca_commerce_in_trial(text,uuid,timestamp with time zone)',
      'public.fn_ca_commerce_roster_count(uuid)',
      'public.fn_ca_commerce_scope_role(text,uuid,uuid)',
      'public.fn_ca_commerce_append_only()',
      'public.fn_is_platform_admin()',
      'public.fn_cash_override_bool(jsonb,text,boolean)']) AS sig LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'admission dependency % is missing', r.sig;
    END IF;
  END LOOP;
  -- Each door exists, is a browser door (authenticated may execute, anon may
  -- not) and is not already wired.
  FOR r IN SELECT unnest(ARRAY[
      'public.fn_review_join_request(uuid,uuid,boolean)',
      'public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)',
      'public.fn_create_tournament(uuid,jsonb)',
      'public.fn_upsert_tournament_schedule(jsonb)']) AS sig LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'admission door % is missing', r.sig;
    END IF;
    IF NOT has_function_privilege('authenticated', to_regprocedure(r.sig), 'EXECUTE')
       OR has_function_privilege('anon', to_regprocedure(r.sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'admission door % no longer has the browser-door ACL', r.sig;
    END IF;
    IF strpos(pg_get_functiondef(to_regprocedure(r.sig)), 'ca-commerce-admission') > 0 THEN
      RAISE EXCEPTION 'admission door % is already wired', r.sig;
    END IF;
  END LOOP;
END $baseline$;

-- ---------------------------------------------------------------------------
-- 1. The decision record. Owner actions only (low volume), ids only, append
-- only, not browser-readable. No foreign key: a decision log must never take
-- a lock on clubs or unions (CLAUDE.md section 2, rule 7).
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_commerce_admission_decisions (
  id bigserial PRIMARY KEY,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  scope_kind text NOT NULL CHECK (scope_kind IN ('club','union')),
  scope_id uuid NOT NULL,
  action text NOT NULL,
  door text NOT NULL,
  actor_id uuid,
  subject_id uuid,
  would_allow boolean,
  enforced boolean NOT NULL,
  allowed boolean NOT NULL,
  reason text NOT NULL,
  entitlement_id uuid,
  policy_version text,
  CHECK (allowed OR (enforced AND would_allow IS FALSE))
);
CREATE INDEX ca_commerce_admission_decisions_scope ON public.ca_commerce_admission_decisions (scope_kind, scope_id, decided_at DESC);
ALTER TABLE public.ca_commerce_admission_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_commerce_admission_decisions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.ca_commerce_admission_decisions_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER ca_commerce_admission_decisions_append_only BEFORE UPDATE OR DELETE ON public.ca_commerce_admission_decisions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_commerce_append_only();

-- ---------------------------------------------------------------------------
-- 2. The decision (internal). The 20260922143541 policy, unchanged, except
-- that every answer names would_allow.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_admission_decide(p_scope_kind text, p_scope_id uuid, p_action text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_settings public.ca_commerce_settings;
  v_enforced boolean;
  v_in_trial boolean;
  v_ent public.ca_commerce_entitlements;
  v_kind text;
  v_allowed boolean;
  v_reason text;
  v_roster integer;
BEGIN
  SELECT * INTO v_settings FROM public.ca_commerce_settings WHERE id = 1;
  v_enforced := v_settings.admission_enforced_from IS NOT NULL AND v_settings.admission_enforced_from <= now();
  IF p_scope_kind = 'club' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_scope_id AND COALESCE(c.is_platform, false)) THEN
    RETURN jsonb_build_object('allowed', true, 'would_allow', true, 'enforced', v_enforced, 'reason', 'platform_scope');
  END IF;
  v_in_trial := public.fn_ca_commerce_in_trial(p_scope_kind, p_scope_id);
  v_kind := CASE p_action
    WHEN 'approve_member' THEN 'capacity'
    WHEN 'open_table' THEN 'capacity'
    WHEN 'create_tournament' THEN 'capacity'
    WHEN 'union_tools' THEN 'union_back_office'
    WHEN 'club_insurance' THEN 'club_insurance_module'
    WHEN 'union_insurance' THEN 'union_insurance_module'
    ELSE NULL END;
  IF v_kind IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'would_allow', true, 'enforced', v_enforced, 'reason', 'unpriced_action');
  END IF;
  SELECT * INTO v_ent FROM public.ca_commerce_entitlements e
   WHERE e.scope_kind = p_scope_kind AND e.scope_id = p_scope_id AND e.kind = v_kind AND e.state = 'effective'
     AND e.starts_at <= now() AND (e.ends_at IS NULL OR e.ends_at > now())
   ORDER BY e.ends_at DESC NULLS FIRST LIMIT 1;
  IF v_in_trial THEN
    v_allowed := true; v_reason := 'trial';
  ELSIF v_ent.id IS NULL THEN
    v_allowed := false; v_reason := 'no_effective_entitlement';
  ELSIF p_action = 'approve_member' THEN
    v_roster := public.fn_ca_commerce_roster_count(p_scope_id);
    v_allowed := v_roster < v_ent.capacity;
    v_reason := CASE WHEN v_allowed THEN 'within_capacity' ELSE 'capacity_reached' END;
  ELSE
    v_allowed := true; v_reason := 'entitled';
  END IF;
  RETURN jsonb_build_object('allowed', v_allowed OR NOT v_enforced, 'would_allow', v_allowed, 'enforced', v_enforced,
    'reason', v_reason, 'entitlement_id', v_ent.id, 'capacity', v_ent.capacity, 'roster_count', v_roster, 'trial', v_in_trial);
END $$;

-- ---------------------------------------------------------------------------
-- 3. The browser read: the same answer, only for a caller who owns or
-- administers the scope. Service role (and a server context with no request
-- claims at all, as fn_caller_is_engine defines it) is unrestricted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_admission(p_scope_kind text, p_scope_id uuid, p_action text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    v_uid := auth.uid();
    IF v_uid IS NULL OR p_scope_kind IS NULL OR p_scope_kind NOT IN ('club','union') OR p_scope_id IS NULL OR NOT (
         public.fn_ca_commerce_scope_role(p_scope_kind, p_scope_id, v_uid) <> 'none'
      OR (p_scope_kind = 'club' AND EXISTS (
            SELECT 1 FROM public.union_clubs uc JOIN public.unions u ON u.id = uc.union_id
             WHERE uc.club_id = p_scope_id
               AND (u.owner_id = v_uid OR EXISTS (SELECT 1 FROM public.union_admins a WHERE a.union_id = u.id AND a.user_id = v_uid))))
      OR public.fn_is_platform_admin()) THEN
      RETURN jsonb_build_object('error', 'access_denied');
    END IF;
  END IF;
  RETURN public.fn_ca_commerce_admission_decide(p_scope_kind, p_scope_id, p_action);
END $$;

-- ---------------------------------------------------------------------------
-- 4. What an owner reads when an enforced admission refuses.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_admission_message(p_action text, p_reason text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_action = 'approve_member' AND p_reason = 'capacity_reached'
      THEN 'This Club Has Reached Its Member Capacity. Upgrade Capacity To Approve New Members. Current Members Are Not Affected.'
    WHEN p_action = 'approve_member'
      THEN 'This Club Needs Active Operating Access To Approve New Members. Current Members Are Not Affected.'
    WHEN p_action = 'open_table'
      THEN 'This Club Needs Active Operating Access To Open A New Table. Running Tables Are Not Affected.'
    WHEN p_action = 'create_tournament'
      THEN 'This Club Needs Active Operating Access To Create A New Tournament. Scheduled And Running Tournaments Are Not Affected.'
    WHEN p_action = 'club_insurance'
      THEN 'This Club Needs The Insurance Module To Offer Insurance On A New Table. Existing Insurance Offers Are Not Affected.'
    WHEN p_action = 'union_insurance'
      THEN 'This Union Needs The Insurance Module To Offer Insurance On A New Table. Existing Insurance Offers Are Not Affected.'
    WHEN p_action = 'union_tools'
      THEN 'This Union Needs Back Office Access To Use This Tool. Existing Settlement And Records Are Not Affected.'
    ELSE 'Operating Access Is Required For This New Action. Existing Games And Members Are Not Affected.'
  END
$$;

-- ---------------------------------------------------------------------------
-- 5. The gate the doors call (internal). Records the decision and returns it
-- with the refusal sentence. A decision that cannot be computed or recorded
-- never blocks the owner's action (D28): it is logged as undecided and the
-- action proceeds; only a computed, enforced would-deny refuses.
-- approve_member serializes on the commerce scope lock (the same key the
-- purchase, renewal and refund paths take) so two approvals racing for the
-- last seat cannot both pass once enforced. No other path holds a membership
-- lock and then asks for this key, so the order cannot invert.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_commerce_admit(p_scope_kind text, p_scope_id uuid, p_action text, p_door text, p_subject_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_d jsonb;
  v_allowed boolean;
  v_id bigint;
  v_policy text;
BEGIN
  IF p_action = 'approve_member' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_scope:' || p_scope_kind || ':' || p_scope_id::text, 0));
  END IF;
  BEGIN
    v_d := public.fn_ca_commerce_admission_decide(p_scope_kind, p_scope_id, p_action);
  EXCEPTION WHEN OTHERS THEN
    v_d := jsonb_build_object('allowed', true, 'would_allow', NULL, 'enforced', false, 'reason', 'decision_unavailable', 'sqlstate', SQLSTATE);
  END;
  v_allowed := COALESCE((v_d->>'allowed')::boolean, true);
  BEGIN
    SELECT s.policy_version INTO v_policy FROM public.ca_commerce_settings s WHERE s.id = 1;
    INSERT INTO public.ca_commerce_admission_decisions
      (scope_kind, scope_id, action, door, actor_id, subject_id, would_allow, enforced, allowed, reason, entitlement_id, policy_version)
    VALUES
      (p_scope_kind, p_scope_id, p_action, p_door, auth.uid(), p_subject_id, (v_d->>'would_allow')::boolean,
       COALESCE((v_d->>'enforced')::boolean, false), v_allowed, COALESCE(v_d->>'reason', 'unknown'),
       NULLIF(v_d->>'entitlement_id', '')::uuid, v_policy)
    RETURNING id INTO v_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ca_commerce admission decision not recorded for % % % (%): %', p_door, p_scope_kind, p_scope_id, SQLSTATE, SQLERRM;
  END;
  RETURN v_d || jsonb_build_object('decision_id', v_id, 'door', p_door,
    'message', CASE WHEN v_allowed THEN NULL ELSE public.fn_ca_commerce_admission_message(p_action, v_d->>'reason') END);
END $$;

-- ---------------------------------------------------------------------------
-- 6. The doors. Anchor-insert, one anchor per door (see the header).
-- ---------------------------------------------------------------------------
DO $wire$
DECLARE
  r record;
  v_before text;
  v_after text;
  v_acl_before aclitem[];
  v_acl_after aclitem[];
  v_oid oid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    -- Approve a NEW member. Only a pending request is an admission; an
    -- already-approved member never reaches the gate, and a denial is never
    -- gated.
    ('public.fn_review_join_request(uuid,uuid,boolean)',
     'is_club_admin(p_club_id, v_uid)',
     $a1$  IF p_approve THEN
    UPDATE club_members
$a1$,
     $n1$  IF p_approve THEN
    -- ca-commerce-admission: approving a NEW member is a prospective owner
    -- action (R2 4.3, D22). Shadow records and proceeds; enforced refuses
    -- here, before the row changes. Existing members are never re-checked.
    IF EXISTS (SELECT 1 FROM public.club_members
                WHERE club_id = p_club_id AND user_id = p_user_id AND status = 'pending') THEN
      DECLARE
        v_ca_admission jsonb := public.fn_ca_commerce_admit('club', p_club_id, 'approve_member', 'fn_review_join_request', p_user_id);
      BEGIN
        IF NOT COALESCE((v_ca_admission->>'allowed')::boolean, true) THEN
          RETURN jsonb_build_object('success', false, 'error', v_ca_admission->>'message',
            'code', 'operating_access_required', 'reason', v_ca_admission->>'reason');
        END IF;
      END;
    END IF;
    UPDATE club_members
$n1$),
    -- Open a NEW cash game (Main 1), and offer insurance on it. The engine's
    -- own table writers (fn_cash_cluster_open_table for feeders, balancing
    -- and must-move mains) are not this door and are never gated.
    ('public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)',
     'fn_can_create_games(p_club_id, v_uid)',
     $a2$  RETURN public.fn_cash_game_create_impl_20260905(
$a2$,
     $n2$  -- ca-commerce-admission: opening a NEW table, and offering insurance on
  -- it, are prospective owner actions (R2 4.3, 6.3, D22). Shadow records and
  -- proceeds; enforced refuses here, before anything is written.
  DECLARE
    v_ca_admission jsonb;
    v_ca_insurance boolean;
  BEGIN
    v_ca_admission := public.fn_ca_commerce_admit('club', p_club_id, 'open_table', 'fn_cash_game_create', NULL);
    IF NOT COALESCE((v_ca_admission->>'allowed')::boolean, true) THEN
      RAISE EXCEPTION '%', v_ca_admission->>'message' USING ERRCODE = 'P0001', HINT = 'operating_access_required';
    END IF;
    BEGIN
      v_ca_insurance := public.fn_cash_override_bool(COALESCE(p_overrides->'options', '{}'::jsonb), 'insurance_enabled', false);
    EXCEPTION WHEN OTHERS THEN
      v_ca_insurance := false;  -- the creator below refuses a malformed option in its own words
    END;
    IF v_ca_insurance THEN
      v_ca_admission := public.fn_ca_commerce_admit('club', p_club_id, 'club_insurance', 'fn_cash_game_create', NULL);
      IF NOT COALESCE((v_ca_admission->>'allowed')::boolean, true) THEN
        RAISE EXCEPTION '%', v_ca_admission->>'message' USING ERRCODE = 'P0001', HINT = 'operating_access_required';
      END IF;
    END IF;
  END;

  RETURN public.fn_cash_game_create_impl_20260905(
$n2$),
    -- Create a NEW tournament (MTT, SNG or Spin authored by the owner). The
    -- scheduled spawner and seat-first boards do not pass this door.
    ('public.fn_create_tournament(uuid,jsonb)',
     'fn_can_create_games(p_club_id,v_uid)',
     $a3$  v_res := public.fn_create_tournament_governed_legacy(p_club_id,p_config);
$a3$,
     $n3$  -- ca-commerce-admission: creating a NEW tournament is a prospective owner
  -- action (R2 4.3, D22, D52, D53). Shadow records and proceeds; enforced
  -- refuses here, before the event is written.
  DECLARE
    v_ca_admission jsonb := public.fn_ca_commerce_admit('club', p_club_id, 'create_tournament', 'fn_create_tournament', NULL);
  BEGIN
    IF NOT COALESCE((v_ca_admission->>'allowed')::boolean, true) THEN
      RETURN jsonb_build_object('success', false, 'error', 'operating_access_required',
        'message', v_ca_admission->>'message', 'reason', v_ca_admission->>'reason');
    END IF;
  END;
  v_res := public.fn_create_tournament_governed_legacy(p_club_id,p_config);
$n3$),
    -- Create a NEW recurring schedule. Editing, pausing or re-activating an
    -- existing schedule, and every tournament it spawns, are existing
    -- obligations and are never gated.
    ('public.fn_upsert_tournament_schedule(jsonb)',
     'v_id IS NULL AND NOT public.fn_can_manage_tournament_schedule(v_union_id, v_club_id, v_uid)',
     $a4$  IF v_id IS NULL THEN
    INSERT INTO public.tournament_schedules
$a4$,
     $n4$  IF v_id IS NULL THEN
    -- ca-commerce-admission: a NEW recurring schedule is a prospective owner
    -- action (R2 4.3, D22). Shadow records and proceeds; enforced refuses
    -- here, before the schedule is written.
    DECLARE
      v_ca_admission jsonb := public.fn_ca_commerce_admit('club', v_club_id, 'create_tournament', 'fn_upsert_tournament_schedule', NULL);
    BEGIN
      IF NOT COALESCE((v_ca_admission->>'allowed')::boolean, true) THEN
        RETURN jsonb_build_object('error', 'operating_access_required',
          'message', v_ca_admission->>'message', 'reason', v_ca_admission->>'reason');
      END IF;
    END;
    INSERT INTO public.tournament_schedules
$n4$)
  ) AS t(sig, guard, anchor, replacement)
  LOOP
    v_oid := to_regprocedure(r.sig);
    SELECT pg_get_functiondef(p.oid), p.proacl INTO v_before, v_acl_before FROM pg_proc p WHERE p.oid = v_oid;
    IF (length(v_before) - length(replace(v_before, r.anchor, ''))) <> length(r.anchor) THEN
      RAISE EXCEPTION 'admission anchor must occur exactly once in % (found % times); review the live body', r.sig,
        (length(v_before) - length(replace(v_before, r.anchor, ''))) / length(r.anchor);
    END IF;
    IF strpos(v_before, r.guard) = 0 OR strpos(v_before, r.guard) > strpos(v_before, r.anchor) THEN
      RAISE EXCEPTION 'the door''s own authorization no longer precedes the admission anchor in %', r.sig;
    END IF;
    EXECUTE replace(v_before, r.anchor, r.replacement);
    SELECT pg_get_functiondef(p.oid), p.proacl INTO v_after, v_acl_after FROM pg_proc p WHERE p.oid = v_oid;
    IF replace(v_after, r.replacement, r.anchor) IS DISTINCT FROM v_before
       OR (length(v_after) - length(replace(v_after, r.replacement, ''))) <> length(r.replacement) THEN
      RAISE EXCEPTION 'wiring % changed text other than the admission anchor', r.sig;
    END IF;
    IF v_acl_after IS DISTINCT FROM v_acl_before THEN
      RAISE EXCEPTION 'wiring % changed its ACL', r.sig;
    END IF;
  END LOOP;
END $wire$;

-- ---------------------------------------------------------------------------
-- 7. Grants, restated. The browser read keeps its door; the decision, the
-- gate and the sentence are internal (the doors run as their owner). A
-- REVOKE names PUBLIC.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_ca_commerce_admission(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_commerce_admission(text, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.fn_ca_commerce_admission_decide(text, uuid, text),
  public.fn_ca_commerce_admission_message(text, text),
  public.fn_ca_commerce_admit(text, uuid, text, text, uuid)
FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Post-conditions.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_count integer;
BEGIN
  IF (SELECT admission_enforced_from FROM public.ca_commerce_settings WHERE id = 1) IS NOT NULL THEN
    RAISE EXCEPTION 'enforcement must stay off: this migration wires admission in shadow';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_commerce_admission_decisions) THEN
    RAISE EXCEPTION 'installation must not record decisions';
  END IF;
  -- Exactly the four doors call the gate, each once per wired action.
  SELECT count(*) INTO v_count FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc LIKE '%fn_ca_commerce_admit(%';
  IF v_count <> 4 OR EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc LIKE '%fn_ca_commerce_admit(%'
         AND p.oid NOT IN (to_regprocedure('public.fn_review_join_request(uuid,uuid,boolean)'),
                           to_regprocedure('public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'),
                           to_regprocedure('public.fn_create_tournament(uuid,jsonb)'),
                           to_regprocedure('public.fn_upsert_tournament_schedule(jsonb)'))) THEN
    RAISE EXCEPTION 'the admission gate must be called by exactly the four owner doors, found %', v_count;
  END IF;
  -- Never in the gameplay or seating path (spec 1143, D21, D28): no trigger on
  -- these relations runs a function that mentions commerce.
  IF EXISTS (
      SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc f ON f.oid = t.tgfoid
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('tables','table_seats','tournaments','tournament_players','club_members')
         AND NOT t.tgisinternal AND (t.tgname LIKE '%commerce%' OR f.prosrc LIKE '%ca_commerce%')) THEN
    RAISE EXCEPTION 'a commerce trigger sits in the gameplay or seating path';
  END IF;
  -- Grants.
  IF has_function_privilege('anon', 'public.fn_ca_commerce_admission(text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_ca_commerce_admission(text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_ca_commerce_admission(text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_commerce_admission must be executable by authenticated and service_role only';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_ca_commerce_admit(text,uuid,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_commerce_admit(text,uuid,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_ca_commerce_admit(text,uuid,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_commerce_admission_decide(text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_commerce_admission_decide(text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_commerce_admission_message(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the admission gate and decision must stay internal';
  END IF;
  IF has_table_privilege('authenticated', 'public.ca_commerce_admission_decisions', 'SELECT')
     OR has_table_privilege('anon', 'public.ca_commerce_admission_decisions', 'SELECT')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ca_commerce_admission_decisions'::regclass) THEN
    RAISE EXCEPTION 'admission decisions must not be browser-readable';
  END IF;
  -- The browser doors keep their browser ACL.
  IF EXISTS (
      SELECT 1 FROM unnest(ARRAY[
        'public.fn_review_join_request(uuid,uuid,boolean)',
        'public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)',
        'public.fn_create_tournament(uuid,jsonb)',
        'public.fn_upsert_tournament_schedule(jsonb)']) s(sig)
       WHERE NOT has_function_privilege('authenticated', to_regprocedure(s.sig), 'EXECUTE')
          OR has_function_privilege('anon', to_regprocedure(s.sig), 'EXECUTE')) THEN
    RAISE EXCEPTION 'a wired door lost or widened its browser ACL';
  END IF;
END $post$;

COMMIT;
