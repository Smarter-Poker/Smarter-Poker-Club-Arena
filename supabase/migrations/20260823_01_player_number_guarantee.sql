-- ============================================================================
-- 20260823_01_player_number_guarantee
--
-- Dan 2026-08-23: every member on the roster shows a player number next to
-- their role, so every profile must HAVE one -- humans and horses alike, and
-- every profile created from here on.
--
-- Before this migration: profiles.player_number was TEXT, assigned ad hoc by
-- AgentService.promoteToAgent (a random 4-6 digit value, only when someone
-- became an agent). 1020 of 1022 profiles had one; two did not; nothing stopped
-- a collision, and nothing assigned one at signup.
--
-- After: a sequence-backed generator, a uniqueness constraint, a BEFORE trigger
-- that fills the column whenever it is left blank, and a backfill for the
-- stragglers. The generator starts at 1000000 -- above the largest existing
-- value (983935) -- so it can never collide with a legacy number, and it still
-- probes for a free value before returning, because the legacy numbers were
-- handed out randomly and the sequence knows nothing about them.
-- ============================================================================

-- ── 1. The generator ────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.player_number_seq AS bigint START WITH 1000000 INCREMENT BY 1;

-- Never hand out a number below the legacy ceiling, even if the sequence was
-- created by an earlier partial run of this migration.
DO $$
BEGIN
  IF (SELECT last_value FROM public.player_number_seq) < 1000000 THEN
    PERFORM setval('public.player_number_seq', 1000000, false);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_next_player_number()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidate bigint;
  v_tries     int := 0;
BEGIN
  LOOP
    v_candidate := nextval('public.player_number_seq');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.profiles WHERE player_number = v_candidate::text
    );
    v_tries := v_tries + 1;
    IF v_tries > 1000 THEN
      RAISE EXCEPTION 'fn_next_player_number: no free player number after 1000 attempts';
    END IF;
  END LOOP;
  RETURN v_candidate::text;
END;
$$;

COMMENT ON FUNCTION public.fn_next_player_number() IS
  'Returns an unused profiles.player_number. Sequence-backed, collision-checked.';

-- ── 2. Backfill anything still missing ──────────────────────────────────────
UPDATE public.profiles
SET player_number = public.fn_next_player_number()
WHERE player_number IS NULL OR btrim(player_number) = '';

-- ── 3. Uniqueness ───────────────────────────────────────────────────────────
-- Partial, so the constraint describes the invariant we actually want: numbers
-- that exist are unique. (After step 2 none are null, and step 4 keeps it so.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_player_number
  ON public.profiles (player_number)
  WHERE player_number IS NOT NULL;

-- ── 4. Keep it true for every future profile ────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_profiles_assign_player_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.player_number IS NULL OR btrim(NEW.player_number) = '' THEN
    NEW.player_number := public.fn_next_player_number();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_assign_player_number ON public.profiles;
CREATE TRIGGER trg_profiles_assign_player_number
  BEFORE INSERT OR UPDATE OF player_number ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_profiles_assign_player_number();

-- ── 5. Assert ───────────────────────────────────────────────────────────────
DO $$
DECLARE v_missing int;
BEGIN
  SELECT count(*) INTO v_missing
  FROM public.profiles
  WHERE player_number IS NULL OR btrim(player_number) = '';
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'player_number backfill incomplete: % profiles still blank', v_missing;
  END IF;
END $$;
