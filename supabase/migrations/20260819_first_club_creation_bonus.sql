-- ═══════════════════════════════════════════════════════════════════════════
-- FIRST-CLUB CREATION BONUS — 10,000 club chips (2026-08-19)
-- ═══════════════════════════════════════════════════════════════════════════
-- The Create Club page (Step 2 preview) has always promised:
--   "If this is the first club that you are creating you will receive a bonus
--    of 10,000 club chips."
-- Audit 2026-08-19 found NO implementation anywhere (no RPC, no trigger, no
-- ledger). This migration makes the promise real, server-side, for every
-- create path (CreateClubPage, CreateClubModal, ClubsService.createClub).
--
-- Design:
--   * AFTER INSERT trigger on club_members, fires only for role='owner' rows.
--   * Once per user EVER, tracked in club_creation_bonuses (PK user_id).
--   * Belt+suspenders: the user must actually own the club (clubs.owner_id).
--   * Exception-safe: a bonus failure must never fail club creation.
--   * No backfill for pre-existing owners (economy decision left to Dan).
-- Tier 2 migration. Rollback: DROP TRIGGER trg_first_club_creation_bonus ON
-- club_members; DROP FUNCTION fn_grant_first_club_bonus(); DROP TABLE
-- club_creation_bonuses;
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.club_creation_bonuses (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  club_id    uuid NOT NULL,
  amount     integer NOT NULL DEFAULT 10000,
  granted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.club_creation_bonuses ENABLE ROW LEVEL SECURITY;

-- Users may read their own bonus record; only the definer function writes.
DROP POLICY IF EXISTS "Users read own creation bonus" ON public.club_creation_bonuses;
CREATE POLICY "Users read own creation bonus" ON public.club_creation_bonuses
  FOR SELECT USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "Service role manages creation bonuses" ON public.club_creation_bonuses;
CREATE POLICY "Service role manages creation bonuses" ON public.club_creation_bonuses
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.fn_grant_first_club_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_owner boolean;
  v_claimed  boolean;
BEGIN
  -- Only owner membership rows (i.e. club creation) qualify
  IF NEW.role IS DISTINCT FROM 'owner' THEN
    RETURN NEW;
  END IF;

  BEGIN
    -- The row's user must genuinely own the club
    SELECT EXISTS (
      SELECT 1 FROM clubs WHERE id = NEW.club_id AND owner_id = NEW.user_id
    ) INTO v_is_owner;
    IF NOT v_is_owner THEN
      RETURN NEW;
    END IF;

    -- Once per user ever — the marker insert is the atomic claim
    INSERT INTO club_creation_bonuses (user_id, club_id, amount)
    VALUES (NEW.user_id, NEW.club_id, 10000)
    ON CONFLICT (user_id) DO NOTHING
    RETURNING true INTO v_claimed;

    IF v_claimed THEN
      UPDATE club_members
         SET chip_balance = COALESCE(chip_balance, 0) + 10000
       WHERE club_id = NEW.club_id AND user_id = NEW.user_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Bonus must never break club creation
    RAISE WARNING 'fn_grant_first_club_bonus failed for user=% club=%: % (%)',
      NEW.user_id, NEW.club_id, SQLERRM, SQLSTATE;
  END;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_grant_first_club_bonus() FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_first_club_creation_bonus ON public.club_members;
CREATE TRIGGER trg_first_club_creation_bonus
  AFTER INSERT ON public.club_members
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_grant_first_club_bonus();

-- ── Post-apply assertions ────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='club_creation_bonuses') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: club_creation_bonuses table missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.club_members'::regclass
      AND tgname = 'trg_first_club_creation_bonus'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: trg_first_club_creation_bonus trigger missing';
  END IF;
END $$;
