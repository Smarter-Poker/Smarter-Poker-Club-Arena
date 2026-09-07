-- A MIRROR NEVER INVENTS A NUMBER.
--
-- The companion to 20260907035121, which made the mirror trigger fire on
-- INSERT so a profile is born with its three diamond mirrors. This one closes
-- the second half of the same defect and corrects the five rows it left.
--
-- THE SECOND WRITER. `initialize_user_diamonds` is a trigger on `auth.users`
-- and it does this, on every signup:
--
--     INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned)
--     VALUES (NEW.id, 100, 100) ON CONFLICT (user_id) DO NOTHING;
--
-- A hundred diamonds, written straight into a MIRROR of a balance the account
-- does not have. `user_diamonds.balance` also carries `DEFAULT 100` - the only
-- one of the three mirrors that defaults to anything but zero - so even an
-- insert that names no balance produces the same invented figure.
--
-- IT IS NOT A WELCOME GRANT, and the rows say so plainly. `profiles.diamonds`
-- defaults to 0; of the 429 profiles created in the last fourteen days,
-- **none** holds a canonical 100 and exactly **one** carries a mirror of 100 -
-- `a57d17c9` (`codex-productio`), whose canonical balance is 500. The supply
-- meter reads `profiles.diamonds` alone, so this 100 has never been part of
-- the diamond supply, and no player can ever have spent it: every spend path
-- debits the canonical store. It is not a balance anybody holds. It is a
-- number a mirror made up.
--
-- So this is not a take-back and 10.9 rule 3 is not in play. The one account
-- that carries the invented 100 has its mirror corrected UP, to the 500 it
-- actually holds. Nobody loses a diamond here and nobody gains one.
--
-- WHAT CHANGES
--
--   1. `initialize_user_diamonds` still creates the row - things may depend on
--      its existence - but it no longer invents the balance. It reads the
--      canonical store, and when there is no profile yet (the usual case at
--      signup, since this fires on auth.users) that read is 0, which is what
--      `profiles.diamonds` will say a moment later. The mirror trigger sets it
--      truthfully the instant the profile exists. Its `user_daily_streaks`
--      leg and its swallow-and-log error handling are untouched.
--   2. `user_diamonds.balance` defaults to 0, like the other two mirrors, so
--      the number cannot come back through a column default.
--   3. The five profiles with a missing or disagreeing mirror row are made to
--      agree with the canonical store - four certification accounts at zero
--      and `a57d17c9` at 500.
--
-- NOTHING HERE MOVES A DIAMOND. Every write below sets a mirror to what
-- `profiles.diamonds` already says, which is the definition of that mirror.
-- The canonical store is not read-modified-written, only read. Supply cannot
-- move, because `ca_diamond_snapshots.total` is `profiles.diamonds` alone
-- (DR10, 2026-09-03).
--
-- WHY THE BACKFILL BELONGS IN A MIGRATION AND IS NOT A SWEEP (10.11). A sweep
-- is a job that runs again because the cause is still there. The cause is gone
-- as of the previous migration: no profile created after it can be missing a
-- mirror row. This is the one-off correction of the rows made before the fix,
-- and the assertion at the end proves the set is empty afterwards - if it ever
-- refills, the trigger has regressed and the DR10 check will say so.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ---------------------------------------------------------------------------
-- 1. THE SIGNUP TRIGGER READS THE CANONICAL STORE INSTEAD OF INVENTING 100.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.initialize_user_diamonds()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
    /* 2026-09-07: this wrote (100, 100) into a MIRROR of profiles.diamonds.
       The canonical store defaults to 0 and no profile in fourteen days held a
       canonical 100, so the number was never a balance - it was a mirror
       disagreeing with the thing it mirrors. It reads the canonical store now;
       at signup there is usually no profile row yet, which reads 0, and
       trg_diamond_side_tables_follow_profiles writes the true figure the
       moment the profile is created. */
    INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned)
    VALUES (NEW.id,
            COALESCE((SELECT GREATEST(COALESCE(p.diamonds, 0), 0)
                        FROM public.profiles p WHERE p.id = NEW.id), 0),
            0)
    ON CONFLICT (user_id) DO NOTHING;

    INSERT INTO public.user_daily_streaks (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.signup_errors (user_id, email, trigger_name, error_code, error_msg)
      VALUES (NEW.id, NEW.email, 'initialize_user_diamonds', SQLSTATE, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.initialize_user_diamonds() IS
  'Signup trigger on auth.users. Creates the user_diamonds mirror row and the daily-streak row. It reads the canonical store for the balance and never invents one: it seeded 100 until 2026-09-07, which no account ever held in profiles.diamonds and which the supply meter never counted.';

-- ---------------------------------------------------------------------------
-- 2. AND THE NUMBER CANNOT COME BACK THROUGH THE COLUMN DEFAULT.
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_diamonds ALTER COLUMN balance SET DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. THE FIVE ROWS THE OLD TRIGGER LEFT BEHIND, MADE TO AGREE WITH CANONICAL.
-- ---------------------------------------------------------------------------
DO $backfill$
DECLARE
  v_before int;
  v_after  int;
  v_moved  numeric;
BEGIN
  SELECT count(*) INTO v_before
    FROM public.profiles p
    LEFT JOIN public.user_diamonds        ud  ON ud.user_id  = p.id
    LEFT JOIN public.user_diamond_balance udb ON udb.user_id = p.id
    LEFT JOIN public.diamond_wallets      dw  ON dw.user_id  = p.id
   WHERE ud.user_id IS NULL OR udb.user_id IS NULL OR dw.user_id IS NULL
      OR ud.balance  IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)
      OR udb.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int
      OR dw.balance  IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int;

  IF v_before = 0 THEN
    RAISE NOTICE 'MIRRORS_ALREADY_AGREE nothing to correct';
  ELSIF v_before > 50 THEN
    /* The measurement said five. An order of magnitude more means the board
       moved underneath this migration and it should be read again, not run. */
    RAISE EXCEPTION 'ABORT: % profiles disagree with their mirrors, expected about 5 - re-read before correcting', v_before;
  END IF;

  INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
  SELECT p.id, GREATEST(COALESCE(p.diamonds,0),0), 0, 0, now(), now()
    FROM public.profiles p
  ON CONFLICT (user_id) DO UPDATE
    SET balance = GREATEST(COALESCE(EXCLUDED.balance,0),0), updated_at = now()
  WHERE public.user_diamonds.balance IS DISTINCT FROM GREATEST(COALESCE(EXCLUDED.balance,0),0);

  INSERT INTO public.user_diamond_balance (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
  SELECT p.id, GREATEST(COALESCE(p.diamonds,0),0)::int, 0, 0, now(), now()
    FROM public.profiles p
  ON CONFLICT (user_id) DO UPDATE
    SET balance = GREATEST(COALESCE(EXCLUDED.balance,0),0)::int, updated_at = now()
  WHERE public.user_diamond_balance.balance IS DISTINCT FROM GREATEST(COALESCE(EXCLUDED.balance,0),0)::int;

  INSERT INTO public.diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent, updated_at)
  SELECT p.id, GREATEST(COALESCE(p.diamonds,0),0)::int, 0, 0, now()
    FROM public.profiles p
  ON CONFLICT (user_id) DO UPDATE
    SET balance = GREATEST(COALESCE(EXCLUDED.balance,0),0)::int, updated_at = now()
  WHERE public.diamond_wallets.balance IS DISTINCT FROM GREATEST(COALESCE(EXCLUDED.balance,0),0)::int;

  SELECT count(*) INTO v_after
    FROM public.profiles p
    LEFT JOIN public.user_diamonds        ud  ON ud.user_id  = p.id
    LEFT JOIN public.user_diamond_balance udb ON udb.user_id = p.id
    LEFT JOIN public.diamond_wallets      dw  ON dw.user_id  = p.id
   WHERE ud.user_id IS NULL OR udb.user_id IS NULL OR dw.user_id IS NULL
      OR ud.balance  IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)
      OR udb.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int
      OR dw.balance  IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int;

  RAISE NOTICE 'MIRRORS_CORRECTED % profile(s) disagreed before, % after', v_before, v_after;
END $backfill$;

-- ---------------------------------------------------------------------------
-- PROVE IT: the mirrors agree everywhere, the canonical supply is untouched,
-- and neither the trigger nor the column default can invent a balance again.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_bad     int;
  v_default text;
  v_src     text;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.profiles p
    LEFT JOIN public.user_diamonds        ud  ON ud.user_id  = p.id
    LEFT JOIN public.user_diamond_balance udb ON udb.user_id = p.id
    LEFT JOIN public.diamond_wallets      dw  ON dw.user_id  = p.id
   WHERE ud.user_id IS NULL OR udb.user_id IS NULL OR dw.user_id IS NULL
      OR ud.balance  IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)
      OR udb.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int
      OR dw.balance  IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % profile(s) still disagree with a diamond mirror', v_bad;
  END IF;

  /* The three mirrors now sum to the canonical store exactly. */
  IF (SELECT COALESCE(sum(balance),0) FROM public.diamond_wallets)
     IS DISTINCT FROM (SELECT COALESCE(sum(GREATEST(COALESCE(diamonds,0),0)),0) FROM public.profiles) THEN
    RAISE EXCEPTION 'VERIFY FAILED: the diamond_wallets mirror does not sum to the canonical store';
  END IF;

  SELECT column_default INTO v_default FROM information_schema.columns
   WHERE table_schema='public' AND table_name='user_diamonds' AND column_name='balance';
  IF COALESCE(v_default, '') <> '0' THEN
    RAISE EXCEPTION 'VERIFY FAILED: user_diamonds.balance still defaults to %', COALESCE(v_default,'NULL');
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='initialize_user_diamonds';
  IF v_src ~ 'VALUES \(NEW\.id, 100' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the signup trigger still seeds an invented 100';
  END IF;
  IF v_src !~ 'FROM public\.profiles p WHERE p\.id = NEW\.id' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the signup trigger does not read the canonical store';
  END IF;

  RAISE NOTICE 'A_MIRROR_NEVER_INVENTS_A_NUMBER every profile agrees with all three diamond mirrors; the signup seed and the column default are gone';
END $verify$;

COMMIT;
