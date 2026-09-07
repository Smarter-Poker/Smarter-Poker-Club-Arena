-- A PROFILE IS BORN WITH ITS DIAMOND MIRRORS, NOT WHEN SOMEBODY FIRST SPENDS.
--
-- Phase 4 of the chip-accounting programme, item one: "the 619,829 diamonds".
--
-- THE HEADLINE NUMBER IS CLOSED AND THIS MIGRATION IS NOT ABOUT IT. The
-- 619,829 was a snapshot-identity defect - `ca_diamond_snapshots.total` added
-- the `diamond_wallets` mirror to `profiles.diamonds` and counted every diamond
-- twice - and it was fixed on 2026-09-03 by the DR10 change that made
-- `v_total := v_prof`. Measured tonight across the last twelve hourly
-- snapshots: `total = profile_diamonds` on every one and `unexplained = 0` on
-- every one. That item is done.
--
-- WHAT IS NOT DONE is the thing the same check has been shouting about ever
-- since. `fn_ca_diamond_snapshot` also carries a DR10 mirror-equality test -
-- every profile must have a row in `user_diamonds`, `user_diamond_balance` and
-- `diamond_wallets` carrying exactly its balance - and it has raised
-- `DR10:mirror_mismatch` **94 times**, most recently at 03:10 today. A
-- detector that has fired ninety-four times for one cause is a cause nobody
-- fixed (CLAUDE.md 10.11).
--
-- MEASURED, 2026-09-07 03:2x UTC, 1,192 profiles:
--
--   profiles.diamonds        1,022,982      the canonical store
--   diamond_wallets          1,022,482      500 short
--   profiles with no diamond_wallets row          5
--   profiles with no user_diamond_balance row     5
--   profiles with no user_diamonds row            4
--   profiles whose EXISTING mirror row disagrees  1 (user_diamonds)
--
-- and the whole 500 is one account: `a57d17c9` (`codex-productio`, created
-- 2026-09-06 00:37) holds 500 in the canonical store, has no `diamond_wallets`
-- row and no `user_diamond_balance` row, and its `user_diamonds` row says
-- **100**. The other four are certification accounts holding 0 - no value at
-- stake, but they are four of the five profiles the check counts every hour.
--
-- THE CAUSE, read from the catalogue rather than guessed.
-- `fn_diamond_side_tables_follow_profiles` is a correct three-way upsert and it
-- has been correct since 2026-09-03. Its TRIGGER is
--
--     AFTER UPDATE OF diamonds ON public.profiles
--
-- with no INSERT. So a profile does not get its mirror rows when it is created;
-- it gets them the first time somebody changes its balance. A profile born
-- with a balance and never touched again has none, for ever - which is exactly
-- `a57d17c9` - and a profile born at zero has none either, which is the four
-- cert accounts. The function's own `IF v_delta = 0 THEN RETURN NEW` seals it:
-- even a later no-op write cannot create the missing rows.
--
-- THE FIX IS THE TRIGGER, and only the trigger. The function body changes only
-- to teach it what an INSERT is - `OLD` does not exist there, so the delta is
-- read from `TG_OP` - and every UPDATE behaves exactly as it does today. On
-- INSERT it always writes the three rows, including at zero, because a mirror
-- that exists and reads zero is the truth and an absent row is a hole this
-- check has to keep reporting.
--
-- WHAT THIS DOES NOT DO. It does not touch a canonical balance: every write
-- below sets a MIRROR to what `profiles.diamonds` already says, which is the
-- definition of that mirror. No diamond is minted, moved or destroyed, and
-- `ca_diamond_snapshots.total` reads `profiles.diamonds` alone, so the supply
-- figure cannot move either. The five existing profiles are corrected in the
-- companion migration together with the signup path that invented the 100;
-- this one is the trigger alone, because `profiles` is the hottest table on the
-- platform and a trigger change on it takes ACCESS EXCLUSIVE.
--
-- THE LOCK IS TAKEN FIRST AND THE TIMEOUT IS SHORT, for the reason 00:02:28
-- taught tonight: a transaction that does its row work and THEN reaches for a
-- table lock can deadlock against the writers it is about to interrupt. This
-- one asks for the table first, so it can only ever wait. If it aborts on
-- lock_timeout nothing is applied and it is simply run again.

BEGIN;

SET LOCAL lock_timeout = '4s';

LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.fn_diamond_side_tables_follow_profiles()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  /* On INSERT there is no OLD row, so the whole balance is the delta. This is
     the only difference between the two paths; an UPDATE behaves exactly as it
     did before 2026-09-07. */
  v_delta bigint := CASE WHEN TG_OP = 'INSERT'
                         THEN COALESCE(NEW.diamonds, 0)
                         ELSE COALESCE(NEW.diamonds, 0) - COALESCE(OLD.diamonds, 0) END;
BEGIN
  /* An UPDATE that moved nothing has nothing to mirror. An INSERT always does,
     even at zero: an absent mirror row is a hole the DR10 check has to report
     every hour, and a row reading zero is the truth. */
  IF TG_OP <> 'INSERT' AND v_delta = 0 THEN RETURN NEW; END IF;

  INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
  VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0), GREATEST(v_delta, 0), GREATEST(-v_delta, 0), now(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance         = GREATEST(COALESCE(NEW.diamonds, 0), 0),
        lifetime_earned = public.user_diamonds.lifetime_earned + GREATEST(v_delta, 0),
        lifetime_spent  = public.user_diamonds.lifetime_spent  + GREATEST(-v_delta, 0),
        updated_at      = now();

  INSERT INTO public.user_diamond_balance (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
  VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, GREATEST(v_delta, 0)::int, GREATEST(-v_delta, 0)::int, now(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance         = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int,
        lifetime_earned = public.user_diamond_balance.lifetime_earned + GREATEST(v_delta, 0)::int,
        lifetime_spent  = public.user_diamond_balance.lifetime_spent  + GREATEST(-v_delta, 0)::int,
        updated_at      = now();

  -- 2026-09-03: this leg was a bare UPDATE, so a profile with no diamond_wallets row could
  -- never gain one and its balance was permanently absent from this mirror (892 of 1,308
  -- profiles, 410,213 diamonds). It upserts now, exactly like the two legs above.
  -- diamond_wallets has no created_at column; the unique key is diamond_wallets_user_id_key.
  INSERT INTO public.diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent, updated_at)
  VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, GREATEST(v_delta, 0)::int, GREATEST(-v_delta, 0)::int, now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance         = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int,
        lifetime_earned = COALESCE(public.diamond_wallets.lifetime_earned, 0) + GREATEST(v_delta, 0)::int,
        lifetime_spent  = COALESCE(public.diamond_wallets.lifetime_spent, 0)  + GREATEST(-v_delta, 0)::int,
        updated_at      = now();

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_diamond_side_tables_follow_profiles() IS
  'Keeps user_diamonds, user_diamond_balance and diamond_wallets equal to profiles.diamonds. Fires on INSERT as well as UPDATE since 2026-09-07: before that a profile only got its mirror rows the first time its balance changed, so one born with 500 and never touched had none at all and the DR10 mirror check reported it every hour for 94 hours.';

DROP TRIGGER IF EXISTS trg_diamond_side_tables_follow_profiles ON public.profiles;
CREATE TRIGGER trg_diamond_side_tables_follow_profiles
  AFTER INSERT OR UPDATE OF diamonds ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_side_tables_follow_profiles();

-- ---------------------------------------------------------------------------
-- PROVE IT, in this transaction, and roll the proof back.
--
-- The probe inserts a profile with a balance and reads the three mirrors back.
-- `profiles.id` is a foreign key into `auth.users`, so the fixture borrows the
-- id of an existing auth user that has no profile row; if there is none, the
-- probe says so out loud rather than passing quietly (CLAUDE.md 10.86). The
-- RAISE at the end is the success case (11.5) and it undoes the fixture: no
-- diamond is minted, because the canonical store the fixture writes is rolled
-- back with everything else.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_uid    uuid;
  v_ud     bigint;
  v_udb    int;
  v_dw     int;
  v_ran    boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.profiles'::regclass
       AND t.tgname = 'trg_diamond_side_tables_follow_profiles'
       AND NOT t.tgisinternal
       AND (t.tgtype::int & 4) > 0        -- INSERT
       AND (t.tgtype::int & 16) > 0       -- UPDATE
       AND t.tgenabled <> 'D') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the mirror trigger does not fire on INSERT and UPDATE';
  END IF;

  SELECT u.id INTO v_uid
    FROM auth.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
   LIMIT 1;

  IF v_uid IS NULL THEN
    RAISE NOTICE 'MIRROR_PROBE_NOT_RUN every auth user already has a profile, so the INSERT path could not be exercised here; the trigger shape is asserted above';
  ELSE
    BEGIN
      INSERT INTO public.profiles (id, diamonds) VALUES (v_uid, 777);

      SELECT balance INTO v_ud  FROM public.user_diamonds        WHERE user_id = v_uid;
      SELECT balance INTO v_udb FROM public.user_diamond_balance WHERE user_id = v_uid;
      SELECT balance INTO v_dw  FROM public.diamond_wallets      WHERE user_id = v_uid;
      v_ran := true;

      RAISE EXCEPTION 'zz_rollback_the_probe';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'zz_rollback_the_probe' THEN RAISE; END IF;
    END;

    IF NOT v_ran THEN
      RAISE EXCEPTION 'VERIFY FAILED: the probe insert did not complete';
    END IF;
    IF v_ud IS DISTINCT FROM 777 OR v_udb IS DISTINCT FROM 777 OR v_dw IS DISTINCT FROM 777 THEN
      RAISE EXCEPTION 'VERIFY FAILED: a profile born with 777 got mirrors %/%/% instead of 777 each',
        COALESCE(v_ud::text,'none'), COALESCE(v_udb::text,'none'), COALESCE(v_dw::text,'none');
    END IF;
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid) THEN
      RAISE EXCEPTION 'VERIFY FAILED: the probe profile survived its own rollback';
    END IF;
  END IF;

  RAISE NOTICE 'A_PROFILE_IS_BORN_WITH_ITS_MIRRORS the trigger fires on INSERT and UPDATE; a profile born with a balance carries all three mirrors immediately';
END $verify$;

COMMIT;
