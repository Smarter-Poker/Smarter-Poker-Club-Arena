-- ═══════════════════════════════════════════════════════════════════════════
-- FOUR-CLUB LIMIT, ENFORCED WHERE IT CANNOT BE SKIPPED (2026-08-27)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY
-- The product rule is "a player can be a member of at most 4 clubs". Where it
-- was actually enforced before this migration:
--
--   join path    fn_join_club, non-owner branch only      -> server-side, real
--   create path  ClubsService.createClub, client-side     -> the ONLY check
--   Add Player / invite redemption / any direct insert    -> nothing at all
--
-- fn_join_club's owner branch (the one club creation lands in) never counts
-- memberships, so the create path's limit lives entirely in browser JS. The
-- 2026-08-26 lobby audit already caught that client check failing open once;
-- a check that only exists client-side will eventually be skipped by a path
-- nobody audited. This trigger is the backstop for every insert path at once.
--
-- HORSES ARE EXEMPT. The fleet seats horses (profiles.is_horse) into every
-- fleet club it manages; production currently has 580 horses holding 2-3
-- memberships each. The 4-club rule is a rule about people.
--
-- DATA CHECK BEFORE APPLY (2026-08-27, production):
--   non-horse users by active/approved membership count: 4 users at 3,
--   3 users at 1 — nobody at or over the limit, so no existing row can
--   violate this and no backfill is needed.
--
-- COUNTING TRANSITIONS TOO: a 'pending' request that gets approved, or is
-- admitted by invite-code redemption, also becomes a counting membership —
-- the UPDATE trigger covers that door as well.
--
-- ROLLBACK (Tier 3 requirement):
--   DROP TRIGGER IF EXISTS trg_four_club_limit_ins ON public.club_members;
--   DROP TRIGGER IF EXISTS trg_four_club_limit_upd ON public.club_members;
--   DROP FUNCTION IF EXISTS public.fn_enforce_four_club_limit();

CREATE OR REPLACE FUNCTION public.fn_enforce_four_club_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count int;
BEGIN
  -- Only membership states that count toward the limit are gated.
  IF NEW.status NOT IN ('active', 'approved') THEN
    RETURN NEW;
  END IF;

  -- On UPDATE, only the transition INTO a counting state is gated — editing
  -- an already-active row (role change, chip movement) must never trip this.
  IF TG_OP = 'UPDATE' AND OLD.status IN ('active', 'approved') THEN
    RETURN NEW;
  END IF;

  -- The rule is about people. Horses are seated by the fleet wherever it
  -- needs them.
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

  IF v_count >= 4 THEN
    RAISE EXCEPTION
      'You can only be a member of up to 4 clubs. Leave a club to join a new one.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_four_club_limit_ins ON public.club_members;
CREATE TRIGGER trg_four_club_limit_ins
  BEFORE INSERT ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_four_club_limit();

DROP TRIGGER IF EXISTS trg_four_club_limit_upd ON public.club_members;
CREATE TRIGGER trg_four_club_limit_upd
  BEFORE UPDATE OF status ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_four_club_limit();

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'club_members'
         AND t.tgname IN ('trg_four_club_limit_ins', 'trg_four_club_limit_upd')) <> 2 THEN
    RAISE EXCEPTION 'four-club-limit triggers did not install';
  END IF;

  -- No existing non-horse user may already violate the rule this enforces.
  IF EXISTS (
    SELECT cm.user_id
      FROM club_members cm
      LEFT JOIN profiles p ON p.id = cm.user_id
     WHERE cm.status IN ('active', 'approved')
       AND NOT COALESCE(p.is_horse, false)
     GROUP BY cm.user_id
    HAVING count(*) > 4
  ) THEN
    RAISE EXCEPTION 'a non-horse user already exceeds 4 memberships - investigate before enforcing';
  END IF;
END;
$$;
