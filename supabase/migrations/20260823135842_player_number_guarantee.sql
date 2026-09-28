-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260823135842 as "player_number_guarantee"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--

CREATE SEQUENCE IF NOT EXISTS public.player_number_seq AS bigint START WITH 1000000 INCREMENT BY 1;

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
AS $fn$
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
$fn$;

COMMENT ON FUNCTION public.fn_next_player_number() IS
  'Returns an unused profiles.player_number. Sequence-backed, collision-checked.';

UPDATE public.profiles
SET player_number = public.fn_next_player_number()
WHERE player_number IS NULL OR btrim(player_number) = '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_player_number
  ON public.profiles (player_number)
  WHERE player_number IS NOT NULL;

CREATE OR REPLACE FUNCTION public.trg_profiles_assign_player_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $tg$
BEGIN
  IF NEW.player_number IS NULL OR btrim(NEW.player_number) = '' THEN
    NEW.player_number := public.fn_next_player_number();
  END IF;
  RETURN NEW;
END;
$tg$;

DROP TRIGGER IF EXISTS trg_profiles_assign_player_number ON public.profiles;
CREATE TRIGGER trg_profiles_assign_player_number
  BEFORE INSERT OR UPDATE OF player_number ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_profiles_assign_player_number();

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

