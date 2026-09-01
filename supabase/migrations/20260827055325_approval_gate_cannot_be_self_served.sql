-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827055325; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- THE APPROVAL GATE CANNOT BE SELF-SERVED (2026-08-27)
-- Full rationale: supabase/migrations/20260827_approval_gate_cannot_be_self_served.sql
-- in club-arena. Closes two doors around clubs.requires_approval: a direct
-- authenticated INSERT landing status='active' (column default) into an
-- approval-gated club, and a pending member PATCHing their own row to active.
-- NOT SECURITY DEFINER and gated on current_user: DML inside definer
-- functions (fn_join_club, fn_redeem_club_invite_code) runs as their owner
-- and passes; raw PostgREST runs as authenticated and is gated.

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
$$;

DROP TRIGGER IF EXISTS trg_approval_gate_ins ON public.club_members;
CREATE TRIGGER trg_approval_gate_ins
  BEFORE INSERT ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_membership_approval_gate();

DROP TRIGGER IF EXISTS trg_approval_gate_upd ON public.club_members;
CREATE TRIGGER trg_approval_gate_upd
  BEFORE UPDATE OF status ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_membership_approval_gate();

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'club_members'
         AND t.tgname IN ('trg_approval_gate_ins', 'trg_approval_gate_upd')) <> 2 THEN
    RAISE EXCEPTION 'approval-gate triggers did not install';
  END IF;
END;
$$;
