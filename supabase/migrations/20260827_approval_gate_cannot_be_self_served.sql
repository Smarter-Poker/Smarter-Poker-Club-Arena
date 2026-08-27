-- ═══════════════════════════════════════════════════════════════════════════
-- THE APPROVAL GATE CANNOT BE SELF-SERVED (2026-08-27)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS OPEN
-- clubs.requires_approval was enforced in exactly one place: inside
-- fn_join_club, which writes status='pending' for approval-gated clubs. But
-- the club_members RLS policies never mention status, and the column DEFAULT
-- is 'active'. Two doors around the gate, both reachable with nothing but an
-- authenticated PostgREST call:
--
--   1. INSERT: POST /rest/v1/club_members {club_id, user_id: <self>} —
--      the "Users can join clubs" policy admits it (own user_id, member/player
--      role, no credit, no agent), the status default lands 'active', and the
--      caller walks straight into an approval-required club.
--   2. UPDATE: a pending requester PATCHes their own row to status='active' —
--      "club_members_update"'s self branch checks role and credit fields but
--      not status. Self-approval.
--
-- WHY A TRIGGER AND NOT TIGHTER RLS
-- The UPDATE hole cannot be closed in RLS at all: a WITH CHECK expression
-- sees only the NEW row, so it cannot tell "pending -> active" (the attack)
-- from "active -> active" (every legitimate self-update). A trigger sees both
-- sides. And a single trigger also covers any future policy someone adds.
--
-- WHO PASSES UNTOUCHED
--   - fn_join_club and every SECURITY DEFINER function (execute as their
--     owner, not `authenticated` — the role gate below skips them);
--   - the engine and all service_role writes;
--   - club owners bootstrapping their own club;
--   - club staff approving SOMEONE ELSE's request (that is what approval is);
--   - any write whose status is not active/approved, and any update that
--     does not cross into active/approved.
--
-- WHAT CHANGES FOR THE TWO ATTACKS
--   - the direct INSERT still lands — as status='pending', which is exactly
--     what fn_join_club would have written. Nothing breaks; the gate holds.
--   - the self-approving UPDATE is refused loudly (23514).
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_approval_gate_ins ON public.club_members;
--   DROP TRIGGER IF EXISTS trg_approval_gate_upd ON public.club_members;
--   DROP FUNCTION IF EXISTS public.fn_membership_approval_gate();

-- Deliberately NOT SECURITY DEFINER, and deliberately gating on current_user
-- rather than the `role` GUC. Both choices carry the same load: DML executed
-- INSIDE a SECURITY DEFINER function (fn_join_club, and critically
-- fn_redeem_club_invite_code, which admits an invited player by flipping
-- their own row pending -> active) runs this trigger as the function's owner,
-- so `current_user` is that owner and the gate steps aside. A raw PostgREST
-- PATCH runs it as `authenticated`, and the gate holds. The `role` GUC cannot
-- make that distinction — it stays 'authenticated' straight through a
-- SECURITY DEFINER call, which would have made this trigger break invite
-- redemption for every invited player.
CREATE OR REPLACE FUNCTION public.fn_membership_approval_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid;
  v_requires boolean;
  v_owner uuid;
BEGIN
  -- Only writes that would place the row in a counting/admitted state.
  IF NEW.status NOT IN ('active', 'approved') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('active', 'approved') THEN
    RETURN NEW;
  END IF;

  -- Only the end-user API roles are gated (see header): definer functions
  -- and service_role/postgres pass.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  v_uid := auth.uid();

  -- Staff acting on someone else's row is approval — the legitimate path.
  -- (RLS already restricts WHO may touch someone else's row.)
  IF NEW.user_id IS DISTINCT FROM v_uid THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(requires_approval, false), owner_id
    INTO v_requires, v_owner
    FROM clubs WHERE id = NEW.club_id;

  IF NOT FOUND OR NOT v_requires THEN
    RETURN NEW; -- open club: active self-join is the designed behavior
  END IF;

  IF v_owner = v_uid OR is_club_admin(NEW.club_id, v_uid) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The request still lands, as the request it actually is.
    NEW.status := 'pending';
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'This club requires owner approval. Your request is pending review.'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_approval_gate_ins ON public.club_members;
CREATE TRIGGER trg_approval_gate_ins
  BEFORE INSERT ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_membership_approval_gate();

DROP TRIGGER IF EXISTS trg_approval_gate_upd ON public.club_members;
CREATE TRIGGER trg_approval_gate_upd
  BEFORE UPDATE OF status ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_membership_approval_gate();

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'club_members'
         AND t.tgname IN ('trg_approval_gate_ins', 'trg_approval_gate_upd')) <> 2 THEN
    RAISE EXCEPTION 'approval-gate triggers did not install';
  END IF;
END;
$$;
