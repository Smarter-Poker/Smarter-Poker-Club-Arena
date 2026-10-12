-- 20261012132509_only_staff_can_remove_a_member
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_remove_settled_club_member(uuid,uuid)'::regprocedure)) = '4231ca3eb326ffc7e9b2ed529b532bc6')
-- @live-proof: (SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AND p.prosrc !~* 'bypass' FROM pg_catalog.pg_proc p WHERE p.oid = 'public.fn_remove_settled_club_member(uuid,uuid)'::regprocedure)
--
-- ONLY CLUB STAFF CAN REMOVE A MEMBER (2026-10-12, launch day).
--
-- WHAT WAS WRONG (read on production 2026-10-12 13:20 UTC, read-only)
--
-- public.fn_remove_settled_club_member(uuid,uuid) is SECURITY DEFINER and any
-- signed-in player may call it. Its live body is not the reviewed one. It was
-- edited by hand on production, outside every migration, before 06:14 UTC
-- today (20261012061427 recorded it as its preimage, cd55db1f..., and changed
-- only its SQLSTATE). The edit:
--   * turned a signed-out caller into the all-zero user ("Allow system
--     bypass") instead of refusing it;
--   * dropped the caller check entirely - the reviewed body let only the
--     club owner, a co-owner or a club admin remove a member;
--   * dropped every settlement check with the comment
--     "BYPASSED SEAT CHECKS FOR BOT RETIREMENT!" - the owner, staff, a member
--     seated at a live table, one holding chips, credit, diamonds, escrow,
--     an open cashout, ticket, chip request or tournament entry, an agent
--     wallet or a downline;
--   * dropped the advisory and row locks and the audit_trail row.
-- So any signed-in player could mark any member of any club departed - the
-- club owner, a seated player, a player holding chips.
--
-- WHO NEEDED THE BYPASS: nobody. Measured before writing this file:
--   * no function in the database calls it (pg_proc: only two comments name
--     it), no engine, script or client in this repository or in World Hub
--     calls it, and the one client caller is MembershipService.removeMember,
--     a signed-in club owner or admin;
--   * pg_stat_statements has no call to it since its last reset;
--   * club_members holds no departed row at all - not one membership has
--     ever left through it, by staff or by "system";
--   * the 1903 bot (horse) memberships are all active, and horses are kept
--     out of user-created clubs by trg_club_members_human_user_club_only,
--     not by a departure.
-- A system path that nothing uses is only a hole, so none is kept: a caller
-- with no signed-in user is refused, as the reviewed body refused it.
--
-- WHAT THIS DOES
--
-- Reinstates 20260929062121_staff_can_remove_a_settled_member_again byte for
-- byte, with the one later reviewed change 20261012061427 made to it (the
-- "membership changed during departure" SQLSTATE is 55000, not 40001):
--   * signed out -> 'Authentication Required';
--   * not the club owner, co-owner or club admin -> 'Only Club Staff Can
--     Remove A Member';
--   * the owner is never removed; staff must be demoted first;
--   * a member with any balance, seat, entry, escrow, request, ticket,
--     agent wallet or downline is refused with the same words as before;
--   * the departure is audited and keeps the row (records retained).
-- Its settings return to the reviewed ones (search_path public, pg_temp;
-- lock_timeout 5s). Owner, SECURITY DEFINER, the result type and the grants
-- (authenticated and service_role EXECUTE, never anon or PUBLIC) are
-- unchanged and re-checked. The union owner guard (20261012112707,
-- trg_union_owner_membership_is_kept) is a trigger and is untouched.
--
-- An unknown preimage refuses before anything changes; the installed
-- postimage is skipped, so a replay is a no-op.
-- Qualified by scripts/ci/test-only-staff-remove-member-db-postgres.py.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $install$
DECLARE
  v_oid oid := 'public.fn_remove_settled_club_member(uuid,uuid)'::regprocedure;
  c_pre_def constant text := 'acdfe7bc5b3138c9c188cdf1e8e24f22';
  c_pre_src constant text := '081b54ee2f9dd672bc1c7deee24a8119';
  c_post constant text := '4231ca3eb326ffc7e9b2ed529b532bc6';
  v_def text;
  v_owner oid;
  v_acl aclitem[];
  v_result text;
  c_body constant text := $body$
CREATE OR REPLACE FUNCTION public.fn_remove_settled_club_member(p_club_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_owner uuid;
  v_caller_role text;
  v_target public.club_members%ROWTYPE;
  v_changed integer := 0;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication Required');
  END IF;
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Choose A Club Member');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:' || p_club_id::text, 0));

  SELECT c.owner_id INTO v_owner
    FROM public.clubs c
   WHERE c.id = p_club_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Club Not Found');
  END IF;

  -- Lock caller and target in deterministic order before reading authority.
  -- A concurrent demotion/suspension must finish before this decision, not
  -- revoke the caller one instruction after an unlocked authorization read.
  PERFORM 1 FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id IN (v_me, p_user_id)
   ORDER BY cm.user_id
   FOR UPDATE;

  SELECT cm.role INTO v_caller_role
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id
     AND cm.user_id = v_me
     AND coalesce(cm.status::text, 'active') IN ('active', 'approved');

  IF v_me IS DISTINCT FROM v_owner
     AND coalesce(v_caller_role, '') NOT IN ('owner', 'club_owner', 'co_owner', 'admin', 'club_admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only Club Staff Can Remove A Member');
  END IF;

  SELECT * INTO v_target
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id;

  -- A legacy deployment may already have physically removed the row. Staff
  -- authorization was checked before returning the idempotent result.
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', true, 'already_departed', true, 'legacy_absent', true
    );
  END IF;

  IF v_target.membership_lifecycle_status = 'departed' THEN
    RETURN jsonb_build_object(
      'success', true, 'already_departed', true, 'legacy_absent', false,
      'user_id', p_user_id, 'departed_at', v_target.departed_at
    );
  END IF;

  IF p_user_id = v_owner OR v_target.role IN ('owner', 'club_owner') THEN
    RETURN jsonb_build_object('success', false, 'error', 'The Club Owner Cannot Be Removed');
  END IF;
  IF v_target.role IN ('co_owner', 'admin', 'club_admin') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Demote Club Staff To Player Before Marking The Membership Departed'
    );
  END IF;

  IF abs(coalesce(v_target.chip_balance, 0))
       + abs(coalesce(v_target.held_chips, 0))
       + abs(coalesce(v_target.locked_chips, 0))
       + abs(coalesce(v_target.promo_balance, 0))
       + abs(coalesce(v_target.credit_used, 0))
       + abs(coalesce(v_target.diamonds, 0)) <> 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Settle Every Member Balance, Credit Line And Diamond Balance Before Removing Them'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agents a
     WHERE a.club_id = p_club_id AND a.user_id = p_user_id
     FOR UPDATE
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Demote And Settle This Agent Wallet Before Removing The Membership'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.user_id <> p_user_id
       AND cm.membership_lifecycle_status = 'active'
       AND (
         cm.agent_id = p_user_id
         OR cm.parent_agent_id = p_user_id
       )
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Reassign This Member''s Downline Before Removing Them'
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.table_seats ts
      JOIN public.tables t ON t.id = ts.table_id
     WHERE t.club_id = p_club_id
       AND ts.user_id = p_user_id
       AND ts.left_at IS NULL
     FOR UPDATE OF ts
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Remove This Member From Live Tables First');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_players tp
      JOIN public.tournaments tr ON tr.id = tp.tournament_id
     WHERE tr.club_id = p_club_id
       AND tp.user_id = p_user_id
       AND lower(coalesce(tp.status::text, '')) IN ('registered', 'playing')
     FOR UPDATE OF tp
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Settle This Member''s Tournament Entry First');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cashout_requests cr
     WHERE cr.club_id = p_club_id
       AND (cr.player_id = p_user_id OR cr.agent_id = p_user_id)
       AND cr.status IN ('pending', 'approved')
     FOR UPDATE
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Resolve This Member''s Cashout Requests First');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.chip_escrow ce
      JOIN public.cashout_requests cr ON cr.id = ce.cashout_request_id
     WHERE cr.club_id = p_club_id
       AND ce.player_id = p_user_id
       AND ce.released_at IS NULL
     FOR UPDATE OF ce
  ) OR EXISTS (
    SELECT 1 FROM public.chip_escrow_holds h
     WHERE h.club_id = p_club_id
       AND h.user_id = p_user_id
       AND h.status = 'held'
     FOR UPDATE
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Release This Member''s Escrow First');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_tickets tt
     WHERE tt.club_id = p_club_id
       AND tt.holder_id = p_user_id
       AND tt.status = 'issued'
     FOR UPDATE
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Resolve This Member''s Open Tickets First');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.chip_requests r
     WHERE r.club_id = p_club_id
       AND (r.requester_id = p_user_id OR r.approver_id = p_user_id)
       AND r.status = 'pending'
     FOR UPDATE
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Resolve This Member''s Chip Requests First');
  END IF;

  INSERT INTO public.audit_trail(
    actor_id, actor_role, action, target_type, target_id, club_id,
    before_state, after_state, reason
  ) VALUES (
    v_me,
    CASE WHEN v_me = v_owner THEN 'owner'
         WHEN v_caller_role = 'co_owner' THEN 'co_owner'
         ELSE 'host' END,
    'depart_club_member', 'membership', v_target.user_id, p_club_id,
    jsonb_build_object(
      'user_id', v_target.user_id, 'role', v_target.role,
      'status', v_target.status::text,
      'membership_lifecycle_status', v_target.membership_lifecycle_status
    ),
    jsonb_build_object(
      'departed', true, 'status', 'suspended', 'is_active', false,
      'membership_lifecycle_status', 'departed',
      'user_id', v_target.user_id
    ),
    'Settled Membership Departure'
  );

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

  RETURN jsonb_build_object(
    'success', true, 'already_departed', false, 'user_id', p_user_id,
    'records_retained', true
  );
END
$function$;
$body$;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) = c_post THEN
    RAISE NOTICE 'only_staff_remove_member: fn_remove_settled_club_member is already the reviewed body; skipping';
    RETURN;
  END IF;
  IF md5(v_def) <> c_pre_def
     OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) <> c_pre_src THEN
    RAISE EXCEPTION 'ONLY_STAFF_REMOVE_PREIMAGE_CHANGED: fn_remove_settled_club_member md5 %', md5(v_def)
      USING ERRCODE = '55000';
  END IF;
  SELECT p.proowner, p.proacl INTO v_owner, v_acl FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;

  EXECUTE c_body;

  IF md5(pg_get_functiondef(v_oid)) <> c_post THEN
    RAISE EXCEPTION 'ONLY_STAFF_REMOVE_POSTIMAGE_CHANGED: fn_remove_settled_club_member md5 %',
      md5(pg_get_functiondef(v_oid)) USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = v_oid AND p.proowner = v_owner AND p.prosecdef
                    AND p.proacl IS NOT DISTINCT FROM v_acl
                    AND pg_get_function_result(p.oid) = 'jsonb')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'ONLY_STAFF_REMOVE_METADATA_CHANGED: owner, SECURITY DEFINER, result or grants moved'
      USING ERRCODE = '55000';
  END IF;
  RAISE NOTICE 'only_staff_remove_member: fn_remove_settled_club_member reinstated (md5 %)', c_post;
END
$install$;

COMMIT;
