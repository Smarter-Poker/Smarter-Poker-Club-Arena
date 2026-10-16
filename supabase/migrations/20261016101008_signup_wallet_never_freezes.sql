-- 20261016101008_signup_wallet_never_freezes.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- SIGNUP NEVER FREEZES. The Oct 14 daily digest reported "2 signup errors".
-- Read from public.signup_errors, every signup error in the last 30 days is the
-- same row: handle_new_user_v2_create_wallet, SQLSTATE 55006,
-- "PLATFORM_FROZEN ... INSERT on wallets was refused". 79 of 79 in 30 days,
-- each one an account created between :55 and :00. The trigger swallows the
-- error, so the account is created with NO player wallet, and nothing ever
-- creates it afterwards: the message's own promise ("it will succeed when
-- play resumes") is false for a trigger that fires exactly once.
--
-- The cause is one line of the freeze guard. fn_refuse_while_frozen refuses
-- every INSERT on public.wallets while the platform is frozen. A brand-new
-- wallet row with balance 0 and locked_balance 0 moves no chips; it is
-- identity, not money, exactly like the zero-balance club_members INSERT that
-- 20260902100000_onboarding_never_freezes_and_clocks_are_measured already lets
-- through. This migration extends that same exemption, scoped as tightly as it
-- can be written: the wallets table, INSERT only, both balances zero. Every
-- UPDATE of balance, every DELETE and every nonzero INSERT is still refused.
--
-- Damage already done: none to a real player. The 79 accounts with no player
-- wallet are certification, probe and QA identities (example.invalid,
-- probe.smarter.poker, smarter-poker.invalid); the two QA ones were already
-- retired. No backfill is written (CLAUDE.md 10.12): the live path is fixed.
--
-- Everything else in the guard is carried over byte-for-byte from production
-- as read on 2026-10-16 (pg_get_functiondef), including the chip_ledger
-- journal exemption pinned by the-journal-is-never-refused-by-the-freeze.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_refuse_while_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  col  TEXT;
  changed BOOLEAN := FALSE;
  v_claims TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
        changed := TRUE;
        EXIT;
      END IF;
    END LOOP;
    IF NOT changed THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ONBOARDING NEVER FREEZES (to-do #2563 item 1). A membership row carrying
  -- no chips is identity, not money. This table, INSERT only, zero balance.
  IF TG_TABLE_NAME = 'club_members' AND TG_OP = 'INSERT'
     AND COALESCE((to_jsonb(NEW) ->> 'chip_balance')::numeric, 0) = 0 THEN
    RETURN NEW;
  END IF;

  -- SIGNUP NEVER FREEZES (2026-10-16). The signup trigger creates the player
  -- wallet once, inside the auth.users INSERT, and never again; refusing it
  -- during the break left the account with no wallet for good. A new wallet
  -- holding nothing is identity, not money. This table, INSERT only, both
  -- balances zero.
  IF TG_TABLE_NAME = 'wallets' AND TG_OP = 'INSERT'
     AND COALESCE((to_jsonb(NEW) ->> 'balance')::numeric, 0) = 0
     AND COALESCE((to_jsonb(NEW) ->> 'locked_balance')::numeric, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- CHIP STANDARD (2026-09-05): A JOURNAL ROW IS THE RECORD OF A WRITE, NOT A
  -- WRITE. When a balance write was permitted (a money table outside this
  -- guard, or a permitted role), its chip_ledger leg is written by the
  -- autoledger inside that same statement, at trigger depth 2 or more.
  -- Refusing the leg while the write stands is the one outcome the standard
  -- cannot allow: 104 BBJ bank moves (9.69 chips) lost their legs this way at :55 and
  -- :00 up to 09-05 06:58 (ca_ledger_write_failures, sqlstate 55006), each one an unexplained movement on the BBJ meter. A direct
  -- INSERT on chip_ledger from a client (depth 1) is still refused.
  IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. % on % was refused; it will succeed when play resumes.',
      TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55006',
            HINT = 'Scheduled maintenance breaks run from :55 to :00. Nothing is lost - retry after the break.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- The installed guard must carry all three exemptions and still refuse.
DO $assert$
DECLARE
  d text := pg_get_functiondef('public.fn_refuse_while_frozen()'::regprocedure);
BEGIN
  IF position($q$IF TG_TABLE_NAME = 'wallets' AND TG_OP = 'INSERT'$q$ IN d) = 0 THEN
    RAISE EXCEPTION 'the freeze guard does not carry the signup wallet exemption';
  END IF;
  IF position($q$IF TG_TABLE_NAME = 'club_members' AND TG_OP = 'INSERT'$q$ IN d) = 0 THEN
    RAISE EXCEPTION 'the freeze guard lost the onboarding exemption';
  END IF;
  IF position($q$IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth() > 1 THEN$q$ IN d) = 0 THEN
    RAISE EXCEPTION 'the freeze guard lost the journal exemption';
  END IF;
  IF position('PLATFORM_FROZEN' IN d) = 0 OR position($q$ERRCODE = '55006'$q$ IN d) = 0 THEN
    RAISE EXCEPTION 'the freeze guard no longer refuses';
  END IF;
END
$assert$;

COMMIT;
