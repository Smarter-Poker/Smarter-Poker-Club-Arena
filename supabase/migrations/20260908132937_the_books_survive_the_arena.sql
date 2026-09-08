-- 20260908132937_the_books_survive_the_arena.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--

-- THE BOOKS MUST NOT BREAK WHEN THE ARENA IS TORN OUT.
-- (CLAUDE.md 10.86; docs/changelog/2026-09-08-the-books-survive-the-arena.md)
--
-- The Diamond Arena is being rebuilt from scratch by another agent, and everything that
-- previously existed is going. That is the right call and this migration does not touch any of it.
-- It removes the reason their teardown would take the diamond books down with it.
--
-- THREE CORE ACCOUNTING SURFACES CALL AN ARENA FUNCTION:
--
--   fn_ca_diamond_trial_balance   the books - proves players + house + arena = the register
--   fn_ca_diamond_snapshot        the hourly deploy gate
--   fn_ca_diamond_economy         the economy report
--
-- all three call `fn_ca_arena_diamonds()`. Drop that function - which any honest teardown of the
-- old arena would - and all three fail. The snapshot runs every hour and is what tells anybody the
-- supply is sound, so the platform would lose its accounting the moment the arena lost its code,
-- and the first symptom would be silence rather than an error anybody reads.
--
-- The accounting side now owns its own reader. `fn_ca_diamond_offledger_float()` answers one
-- question: HOW MANY DIAMONDS DOES A PLAYER OWN THAT ARE NOT IN `profiles.diamonds`? Today that is
-- the arena float and nothing else. Tomorrow it is whatever the new arena parks.
--
-- THE TWO ANSWERS ARE KEPT APART, WHICH IS THE WHOLE POINT (10.86):
--
--   * NO ARENA EXISTS  -> 0, and 0 is the truth. Nothing is parked anywhere, so the books balance
--     on players + house alone, exactly as they did before the arena was built.
--   * AN ARENA EXISTS BUT CANNOT BE READ -> the call RAISES. It does NOT return 0. A float that
--     cannot be measured is not a float of zero, and the books must refuse to publish a balance
--     they could not compute rather than publish a wrong one that looks right.
--
-- That distinction is the difference between "the arena is gone" and "I could not tell", and
-- folding the second into the first is the estate's most expensive habit.
--
-- THE CONTRACT FOR THE NEW ARENA, stated here because this is the file that reads it: if diamonds
-- can sit anywhere other than `profiles.diamonds`, provide `public.fn_ca_arena_diamonds()`
-- returning that total, and the books pick it up with no further change. If the new arena parks
-- nothing outside the player wallet, provide nothing and the books read 0 correctly.
--
-- One transaction. No money moves, and no arena object is created, altered or dropped.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_offledger_float()
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v numeric;
BEGIN
  -- No arena at all: nothing is parked outside the player wallet, and 0 is the true answer.
  IF to_regprocedure('public.fn_ca_arena_diamonds()') IS NULL THEN
    RETURN 0;
  END IF;

  -- An arena exists, so its float is part of the supply and the books need the real number.
  -- If it cannot be read, RAISE. Returning 0 here would report a balanced set of books that had
  -- simply stopped counting one of the accounts (CLAUDE.md 10.86).
  EXECUTE 'SELECT public.fn_ca_arena_diamonds()' INTO v;
  IF v IS NULL THEN
    RAISE EXCEPTION 'the arena float is unreadable: fn_ca_arena_diamonds() exists and returned NULL. The books will not publish a balance they could not compute.';
  END IF;
  RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_offledger_float() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_offledger_float() TO service_role;

COMMENT ON FUNCTION public.fn_ca_diamond_offledger_float() IS
  'Diamonds a player owns that are not in profiles.diamonds - today the arena float. Returns 0 when no arena exists (the true answer) and RAISES when one exists but cannot be read (never 0, which would be a wrong balance that looks right). THE CONTRACT: whatever parks diamonds outside the player wallet provides public.fn_ca_arena_diamonds(); the books need no other change.';

-- ---------------------------------------------------------------------------
-- Point the three accounting surfaces at it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record; v_def text; v_n integer;
  c_from constant text := 'public.fn_ca_arena_diamonds()';
  c_to   constant text := 'public.fn_ca_diamond_offledger_float()';
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_ca_diamond_trial_balance', 'fn_ca_diamond_snapshot', 'fn_ca_diamond_economy')
       AND p.prosrc LIKE '%' || c_from || '%'
  LOOP
    SELECT pg_get_functiondef(r.oid) INTO v_def;
    v_n := (length(v_def) - length(replace(v_def, c_from, ''))) / length(c_from);
    IF v_n < 1 THEN RAISE EXCEPTION 'no arena call found in %', r.proname; END IF;
    EXECUTE replace(v_def, c_from, c_to);
    RAISE NOTICE 'repointed % (% call(s))', r.proname, v_n;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_left integer; v_float numeric; v_arena numeric; v_diff numeric; v_body text;
BEGIN
  -- nothing in the accounting surfaces reaches for the arena directly any more
  SELECT count(*) INTO v_left FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_ca_diamond_trial_balance', 'fn_ca_diamond_snapshot', 'fn_ca_diamond_economy')
     AND regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g') LIKE '%fn_ca_arena_diamonds%';
  IF v_left <> 0 THEN
    RAISE EXCEPTION '% accounting surface(s) still call the arena directly', v_left;
  END IF;
  SELECT count(*) INTO v_left FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_ca_diamond_trial_balance', 'fn_ca_diamond_snapshot', 'fn_ca_diamond_economy')
     AND p.prosrc LIKE '%fn_ca_diamond_offledger_float%';
  IF v_left <> 3 THEN
    RAISE EXCEPTION 'only % of 3 accounting surfaces read the float through the books own reader', v_left;
  END IF;

  -- and it still returns the same number it did before
  v_float := public.fn_ca_diamond_offledger_float();
  EXECUTE 'SELECT public.fn_ca_arena_diamonds()' INTO v_arena;
  IF v_float IS DISTINCT FROM v_arena THEN
    RAISE EXCEPTION 'the books read % and the arena holds %', v_float, v_arena;
  END IF;

  -- "I could not tell" is a raise, not a zero
  SELECT prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_diamond_offledger_float';
  IF v_body NOT LIKE '%RAISE EXCEPTION%' THEN
    RAISE EXCEPTION 'an unreadable float would be reported as zero';
  END IF;

  -- the books still balance, read through the new path
  SELECT difference INTO v_diff FROM public.fn_ca_diamond_trial_balance(now() - interval '75 minutes')
   WHERE account = 'register';
  IF v_diff <> 0 THEN RAISE EXCEPTION 'the register identity is off by % after repointing', v_diff; END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register';
  END IF;
END $$;

COMMIT;
