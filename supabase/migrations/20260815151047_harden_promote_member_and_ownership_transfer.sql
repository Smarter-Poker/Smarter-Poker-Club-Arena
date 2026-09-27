-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815151047 "harden_promote_member_and_ownership_transfer"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 eaf2bfa408c9234af09099e46894238c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Players/Admin surface: make promote_member + transfer_club_ownership
-- safely callable by the browser (they were service_role-only == dead buttons)
-- ═══════════════════════════════════════════════════════════════════════════
-- Both are converted to SECURITY DEFINER and derive the ACTOR from auth.uid()
-- rather than a caller-supplied id, so the identity cannot be spoofed. When
-- auth.uid() is NULL (a service_role/server-side caller that has already done
-- its own authorization) the previous behaviour is preserved.
--
-- transfer_club_ownership previously had NO authorization check whatsoever --
-- it would hand any club to any user. It was only safe because no role could
-- reach it. It is now owner-only and validates the recipient.

-- ── promote_member: actor from auth.uid(), keep the existing role hierarchy ──
CREATE OR REPLACE FUNCTION public.promote_member(
  p_club_id uuid,
  p_target_user_id uuid,
  p_new_role text,
  p_promoted_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_old_role TEXT;
  v_promoter_role TEXT;
  v_existing_agent_id UUID;
  v_is_agent_role BOOLEAN;
  v_was_agent_role BOOLEAN;
  v_actor UUID;
BEGIN
  -- Non-spoofable actor: a JWT caller is ALWAYS themselves. Only a service_role
  -- caller (auth.uid() IS NULL) may name the actor via p_promoted_by.
  v_actor := COALESCE(auth.uid(), p_promoted_by);
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'actor identity required');
  END IF;

  IF p_new_role NOT IN ('admin','super_agent','agent','sub_agent','manager','member') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid role: ' || p_new_role);
  END IF;

  SELECT role INTO v_old_role FROM club_members
   WHERE club_id = p_club_id AND user_id = p_target_user_id AND status IN ('active','approved');
  IF v_old_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Target member not found or inactive');
  END IF;

  SELECT role INTO v_promoter_role FROM club_members
   WHERE club_id = p_club_id AND user_id = v_actor AND status IN ('active','approved');
  IF v_promoter_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Promoter not found or inactive');
  END IF;

  IF v_promoter_role = 'owner' THEN
    NULL;
  ELSIF v_promoter_role = 'admin' THEN
    IF p_new_role NOT IN ('super_agent','agent','sub_agent','manager','member') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Admins cannot promote to ' || p_new_role);
    END IF;
  ELSIF v_promoter_role = 'super_agent' THEN
    IF p_new_role NOT IN ('agent','sub_agent','member') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Super agents can only promote to agent/sub_agent/member');
    END IF;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient permissions to promote');
  END IF;

  IF v_old_role = 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot modify club owner role');
  END IF;
  IF v_old_role = p_new_role THEN
    RETURN jsonb_build_object('success', true, 'message', 'Role unchanged');
  END IF;

  v_is_agent_role  := p_new_role IN ('super_agent','agent','sub_agent');
  v_was_agent_role := v_old_role  IN ('super_agent','agent','sub_agent');

  UPDATE club_members SET role = p_new_role, updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = p_target_user_id;

  IF v_is_agent_role THEN
    SELECT id INTO v_existing_agent_id FROM agents
     WHERE club_id = p_club_id AND user_id = p_target_user_id;
    IF v_existing_agent_id IS NOT NULL THEN
      UPDATE agents SET role = p_new_role, status = 'active', updated_at = NOW()
       WHERE id = v_existing_agent_id;
    ELSE
      INSERT INTO agents (club_id, user_id, role, status, commission_rate, player_rakeback_rate, credit_limit)
      VALUES (p_club_id, p_target_user_id, p_new_role, 'active',
              CASE WHEN p_new_role = 'super_agent' THEN 0.50 ELSE 0.30 END,
              CASE WHEN p_new_role = 'super_agent' THEN 0.30 ELSE 0.20 END, 0);
    END IF;
  ELSIF v_was_agent_role AND NOT v_is_agent_role THEN
    UPDATE agents SET status = 'suspended', updated_at = NOW()
     WHERE club_id = p_club_id AND user_id = p_target_user_id;
  END IF;

  BEGIN
    INSERT INTO role_changes (old_role, new_role, changed_by, reason)
    VALUES (v_old_role, p_new_role, v_actor, 'Promoted via Players page');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'old_role', v_old_role, 'new_role', p_new_role);
END;
$function$;

-- ── transfer_club_ownership: OWNER-ONLY (previously unauthenticated) ─────────
CREATE OR REPLACE FUNCTION public.transfer_club_ownership(
  p_club_id uuid,
  p_new_owner_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_old UUID;
  v_actor UUID;
BEGIN
  v_actor := auth.uid();

  SELECT owner_id INTO v_old FROM clubs WHERE id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club not found';
  END IF;

  -- A JWT caller must BE the current owner. service_role callers (auth.uid()
  -- NULL) are trusted to have authorized upstream.
  IF v_actor IS NOT NULL AND v_actor <> v_old THEN
    RAISE EXCEPTION 'Only the current club owner can transfer ownership';
  END IF;

  IF p_new_owner_id = v_old THEN
    RAISE EXCEPTION 'That user already owns this club';
  END IF;

  -- Recipient must be an active member of this club.
  IF NOT EXISTS (
    SELECT 1 FROM club_members
     WHERE club_id = p_club_id AND user_id = p_new_owner_id
       AND status IN ('active','approved')
  ) THEN
    RAISE EXCEPTION 'New owner must be an active member of this club';
  END IF;

  UPDATE clubs SET owner_id = p_new_owner_id, updated_at = NOW() WHERE id = p_club_id;
  UPDATE club_members SET role = 'admin', updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = v_old;
  UPDATE club_members SET role = 'owner', updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = p_new_owner_id;

  BEGIN
    INSERT INTO role_changes (old_role, new_role, changed_by, reason)
    VALUES ('owner', 'owner', COALESCE(v_actor, v_old), 'Club ownership transferred');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.promote_member(uuid, uuid, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transfer_club_ownership(uuid, uuid) TO authenticated, service_role;
