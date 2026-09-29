-- 20260924045900_member_status_is_changed_only_by_the_server.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- A member's club status (active, suspended, banned) was written straight
-- from the browser. MembershipService.updateStatus did
-- `.from('club_members').update({ status })`, and the Suspend action on
-- ClubDetailPage used it. Two facts about production (read 2026-09-24) made
-- that action decorative:
--
--   * RLS policy club_members_update lets a member update their OWN row
--     (USING user_id = auth.uid()), and its WITH CHECK admits a self-update
--     whenever the row stays a plain member with no credit and no agent.
--     authenticated holds column UPDATE on status.
--   * Of the triggers on club_members, the only one that reads status on a
--     self-update is trg_approval_gate_upd (fn_membership_approval_gate), and
--     it refuses a self-activation ONLY when the club requires approval.
--
-- So a member whom staff suspended, in any club that does not require
-- approval, could send one PostgREST PATCH setting their own status back to
-- 'active', and the suspension was over. A banned member the same. Nothing
-- recorded who suspended them, why, or that they had lifted it themselves.
--
-- WHAT THIS CHANGES
--
-- 1. fn_club_set_member_status(p_club_id, p_user_id, p_status, p_reason) is
--    the one browser door for a status change. SECURITY DEFINER, EXECUTE for
--    authenticated only. It is modelled on fn_club_set_member_role:
--      * identity is auth.uid() and nothing the caller supplies;
--      * authority is club staff (is_club_admin: owner, co-owner, admin) or a
--        platform admin (profiles.is_admin), the same people the RLS policy
--        already let write another member's row;
--      * nobody changes their own status, the club owner's status is never
--        changed here, and a co-owner or admin may only act on members ranked
--        below them (fn_club_role_rank, as in fn_club_grantable_roles);
--      * the transitions are enumerated: active/approved, suspended and banned
--        may move between active, suspended and banned. A pending request is
--        reviewed through fn_review_join_request, a departure through
--        fn_remove_settled_club_member, a return through fn_join_club; this
--        refuses all three rather than becoming a second way to do them;
--      * the reason is recorded in audit_trail (action set_member_status),
--        the table fn_club_set_member_role writes, and the audit id is
--        returned as the receipt. trg_audit_club_member_update writes its own
--        row as it already does for every status change;
--      * it takes the club's cashier-hierarchy advisory lock, the clubs row
--        and both membership rows in the same order as
--        fn_remove_settled_club_member, and requires exactly one row changed.
--
-- 2. trg_club_members_status_guard (BEFORE UPDATE OF status) refuses a status
--    change unless app.club_status_change = 'on' (set transaction-locally by
--    the RPC around its own UPDATE) or current_user is postgres,
--    supabase_admin or service_role. It is the exact shape of
--    fn_club_members_role_guard, and deliberately NOT SECURITY DEFINER: the
--    point is to read who is actually writing.
--
-- EVERY EXISTING WRITER OF club_members.status, AND WHY EACH STILL WORKS
--
-- Enumerated from the newest definition of every function in
-- supabase/migrations, the 2026-09-18 production function dumps under
-- scripts/ci/fixtures and scripts/ci/probes, src/ and server/src:
--
--   fn_join_club (join, and rejoin after departure)      DEFINER, postgres
--   fn_join_club_membership_impl (INSERT only)            not an UPDATE
--   fn_review_join_request (pending -> active by staff)   DEFINER, postgres
--   fn_remove_settled_club_member (departure)             DEFINER, postgres
--   fn_redeem_club_invite_code (invite redemption)        DEFINER, postgres
--   fn_agent_attach_player (pending -> active on attach)  DEFINER, postgres
--   fn_club_owner_has_a_player_wallet (clubs trigger)     DEFINER, postgres
--   server/ (engine, jobs, HorseOnboarding INSERT)        service_role
--   MembershipService.updateStatus (browser)              now calls the RPC
--   ClubMemberManagement.toggleBan (browser, ban/unban)   REFUSED until it
--                                                         calls the RPC too
--   fn_leave_club_atomic (historical, INVOKER, no caller in src; it also
--                         zeroes chip_balance, which the browser balance
--                         guard already refuses)          refused for browsers
--
-- A SECURITY DEFINER function owned by postgres runs as postgres, so every
-- server path above passes the guard by the same rule that lets it pass
-- fn_club_members_role_guard. No function body is patched. The precondition
-- below REFUSES this migration if any of those server writers is not
-- SECURITY DEFINER owned by postgres or supabase_admin, because then the
-- guard would break it.
--
-- The new trigger is declared in public.ca_declared_money_triggers in this
-- same migration, because club_members is one of the watched money tables.
--
-- WHAT IS NOT CHANGED: no money column, no lifecycle rule
-- (fn_guard_membership_lifecycle_write), no RLS policy, no grant on
-- club_members, no existing trigger.
--
-- Proof in an owned PostgreSQL 17 cluster: scripts/ci/test-member-status-server-owned.py
--
-- ROLLBACK (reopens the defect):
--   DROP TRIGGER trg_club_members_status_guard ON public.club_members;
--   DROP FUNCTION public.fn_club_members_status_guard();
--   DROP FUNCTION public.fn_club_set_member_status(uuid, uuid, text, text);
--
-- @live-proof: to_regprocedure('public.fn_club_set_member_status(uuid,uuid,text,text)') IS NOT NULL
-- @live-proof: EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.club_members'::regclass AND tgname = 'trg_club_members_status_guard' AND tgenabled = 'O' AND tgfoid = 'public.fn_club_members_status_guard()'::regprocedure)
-- @live-proof: has_function_privilege('authenticated', 'public.fn_club_set_member_status(uuid,uuid,text,text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.fn_club_set_member_status(uuid,uuid,text,text)', 'EXECUTE')
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $pre$
DECLARE
  r record;
BEGIN
  IF to_regprocedure('public.fn_club_set_member_status(uuid,uuid,text,text)') IS NOT NULL
     OR to_regprocedure('public.fn_club_members_status_guard()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.club_members'::regclass
                   AND tgname = 'trg_club_members_status_guard') THEN
    RAISE EXCEPTION 'failed: member status guard is already installed; refusing to re-apply';
  END IF;

  IF to_regprocedure('public.is_club_admin(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_club_role_rank(text)') IS NULL
     OR to_regclass('public.audit_trail') IS NULL
     OR to_regclass('public.ca_declared_money_triggers') IS NULL THEN
    RAISE EXCEPTION 'failed: is_club_admin(uuid,uuid), fn_club_role_rank(text), audit_trail and ca_declared_money_triggers are required';
  END IF;

  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.club_members'::regclass AND NOT attisdropped
         AND attname IN ('status', 'membership_lifecycle_status', 'role')) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_attribute
                     WHERE attrelid = 'public.profiles'::regclass AND NOT attisdropped
                       AND attname = 'is_admin') THEN
    RAISE EXCEPTION 'failed: club_members.status/role/membership_lifecycle_status or profiles.is_admin missing';
  END IF;

  -- Every server writer of club_members.status must pass the guard as its
  -- owner. A writer that runs as the caller would start failing here.
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.prosecdef, pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_join_club', 'fn_review_join_request',
                         'fn_remove_settled_club_member', 'fn_redeem_club_invite_code',
                         'fn_agent_attach_player', 'fn_club_owner_has_a_player_wallet')
  LOOP
    IF NOT r.prosecdef OR r.owner NOT IN ('postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'failed: status writer % is not SECURITY DEFINER owned by postgres (definer %, owner %)',
        r.sig, r.prosecdef, r.owner;
    END IF;
  END LOOP;
END
$pre$;

CREATE FUNCTION public.fn_club_members_status_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- fn_club_set_member_status sets this for the duration of its own UPDATE.
    IF COALESCE(current_setting('app.club_status_change', true), '') <> 'on'
       -- migrations, server jobs and SECURITY DEFINER server paths run as these
       AND current_user NOT IN ('postgres', 'supabase_admin', 'service_role') THEN
      RAISE EXCEPTION
        'club_members.status must be changed through fn_club_set_member_status (attempted % -> %, as %)',
        OLD.status, NEW.status, current_user
        USING ERRCODE = '42501',
              HINT = 'Staff suspend, ban and reinstate through fn_club_set_member_status. '
                     'A direct update would let a suspended member reinstate themselves.';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_members_status_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_club_members_status_guard
BEFORE UPDATE OF status ON public.club_members
FOR EACH ROW EXECUTE FUNCTION public.fn_club_members_status_guard();

-- club_members is a money table: the trigger declares itself in the same
-- migration (scripts/ci/check-money-trigger-declared.mjs).
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('club_members', 'trg_club_members_status_guard',
        'Refuses a status change unless fn_club_set_member_status made it or the writer is postgres, supabase_admin or service_role, so a suspended or banned member cannot reinstate themselves. Reads status only; writes no balance.')
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

CREATE FUNCTION public.fn_club_set_member_status(p_club_id uuid, p_user_id uuid, p_status text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
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
  -- IDENTITY. auth.uid() only; a caller cannot name someone else as the actor.
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

  -- Same lock order as fn_remove_settled_club_member: hierarchy lock, club
  -- row, then both membership rows by user id.
  PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:' || p_club_id::text, 0));

  SELECT c.owner_id INTO v_owner FROM public.clubs c WHERE c.id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'That Club No Longer Exists');
  END IF;

  PERFORM 1 FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id IN (v_actor, p_user_id)
   ORDER BY cm.user_id
   FOR UPDATE;

  -- AUTHORITY, read after the locks so a concurrent demotion lands first.
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

  -- The owner is never suspended or banned through this path, by anyone.
  IF p_user_id = v_owner OR v_target.role = 'owner' THEN
    RETURN jsonb_build_object('success', false,
      'error', 'The Club Owner''s Membership Cannot Be Suspended Or Banned');
  END IF;

  -- A co-owner or admin acts only on members ranked below them, exactly as
  -- fn_club_grantable_roles limits their role changes.
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
    RAISE EXCEPTION 'membership changed during status change' USING ERRCODE = '40001';
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

REVOKE ALL ON FUNCTION public.fn_club_set_member_status(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_set_member_status(uuid, uuid, text, text) TO authenticated;

DO $post$
DECLARE
  v_sig constant regprocedure := 'public.fn_club_set_member_status(uuid,uuid,text,text)'::regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.club_members'::regclass
       AND t.tgname = 'trg_club_members_status_guard'
       AND t.tgenabled = 'O'
       AND t.tgfoid = 'public.fn_club_members_status_guard()'::regprocedure
       -- BEFORE (2) | ROW (1) | UPDATE (16)
       AND t.tgtype = 19
       AND t.tgattr::text = (SELECT attnum::text FROM pg_attribute
                              WHERE attrelid = 'public.club_members'::regclass
                                AND attname = 'status')) THEN
    RAISE EXCEPTION 'failed: trg_club_members_status_guard is not BEFORE UPDATE OF status FOR EACH ROW';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.fn_club_members_status_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'failed: the status guard must run as the writer, not as its owner';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_sig) THEN
    RAISE EXCEPTION 'failed: fn_club_set_member_status must be SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = v_sig AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'failed: fn_club_set_member_status must be executable by authenticated only';
  END IF;
END
$post$;

COMMIT;
