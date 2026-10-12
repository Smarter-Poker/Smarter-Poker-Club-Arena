-- 20260929062121_staff_can_remove_a_settled_member_again
--
-- WHAT WAS WRONG (found 2026-09-29 while building account closure, which
-- applies this function's settlement rules to every club)
--
-- Club staff could not remove a member. fn_remove_settled_club_member read
-- `club_members.id` three times - the downline check, the audit row's
-- target_id and the departure UPDATE's WHERE - and club_members has no `id`:
-- its key is (club_id, user_id). PL/pgSQL does not check a record's fields
-- until the line runs, so the function was created cleanly and failed at run
-- time, 42703 `record "v_target" has no field "id"`, for every settled member
-- a staff member tried to remove. Measured on production in a rolled-back
-- transaction as SHARK CLUB's owner removing a zero-balance player: 42703.
-- audit_trail holds no depart_club_member row and no membership has ever been
-- departed by staff.
--
-- WHAT THIS DOES
--
-- The same function, byte for byte, with the three reads corrected:
--   * downline: a member whose agent_id or parent_agent_id is this player
--     (club_members.agent_id references profiles.id - a player, not a row;
--     an agent row for this player in this club is refused above it);
--   * the audit row names the membership by the player's id, as the account
--     closure does (target_type 'membership', club_id beside it);
--   * the departure UPDATE finds the row by (club_id, user_id).
-- Every refusal, lock, grant and the registry row are unchanged.
--
-- MEASURED FIRST, rolled back, against production: the owner removing a
-- zero-balance player now succeeds - the membership departed and audited -
-- and removing the owner, a staff member and a member holding chips is still
-- refused with the same words.

BEGIN;

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
    RAISE EXCEPTION 'membership changed during departure' USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'already_departed', false, 'user_id', p_user_id,
    'records_retained', true
  );
END
$function$;

COMMIT;
