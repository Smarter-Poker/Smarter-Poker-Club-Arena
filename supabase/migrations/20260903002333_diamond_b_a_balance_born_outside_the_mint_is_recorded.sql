-- LANE B - ISSUANCE THROUGH THE MINT (diamonds), part 2 of 2.
-- Part 1 is 20260903002248_diamond_b_the_mint_issues_diamonds.sql. This half is
-- separate ONLY because it puts a trigger on public.profiles, the hottest table
-- in the schema, and a trigger creation takes SHARE ROW EXCLUSIVE on it. It ships
-- alone, in one transaction, with lock_timeout so it gives up rather than queues.
--
-- DR2: every diamond that enters supply passes through the Mint. Today none does.
-- 208,000 diamonds entered supply between 2026-09-01 and 2026-09-02 as profile
-- INSERTs already carrying 500, and nothing on the platform saw them: the audit
-- trigger zz_ca_audit_diamond_change is AFTER UPDATE OF diamonds, so an INSERT
-- with a balance is invisible to ca_diamond_balance_audit, and the journal is
-- written by handle_new_user, which took its ON CONFLICT path and stayed silent
-- (part 1 fixes that half).
--
-- THIS IS LOG-ONLY AND NEVER REFUSES. Dan's risk rule: anything that could refuse
-- a legitimate live movement ships log-only first. A profile INSERT is the first
-- thing that happens to a new player, human or horse; a trigger that can raise
-- there can lock every signup on the platform out. So this one records and
-- returns, both of its writes wrapped in their own EXCEPTION WHEN OTHERS, and the
-- refusal that DR2 will eventually make is left for Dan's word.
--
-- WHAT IT RECORDS, per INSERT with a non-zero balance:
--   1. ca_diamond_incidents via fn_ca_diamond_incident: rule
--      'DR2:balance_born_outside_the_mint', severity warning, the amount, the
--      db_role and application_name of whoever inserted it, and is_horse - which
--      is DATA, not a filter (CLAUDE.md 10.5: a horse is recorded exactly as a
--      human is).
--   2. ca_mint_ledger: a mint row, op_id 'seed:<profile id>', so the balance that
--      was born outside the Mint is at least IN the register and
--      fn_ca_mint_supply('diamonds') keeps matching SUM(profiles.diamonds).
--
-- WHY NO diamond_transactions ROW HERE. That journal has two FKs to the user
-- (auth.users and profiles) and the seeder inserts the profile about 2 ms BEFORE
-- the auth.users row exists, so an insert from this trigger would violate
-- diamond_transactions_user_id_fkey and be swallowed on every seeded horse.
-- handle_new_user writes that row a moment later, when the auth row lands
-- (part 1, class 'seeded'), and skips its own register row when it finds this
-- one's 'seed:' op_id, so the 500 is recorded exactly once in each ledger.
--
-- IT FIRES ON EVERY SIGNUP, including the profile handle_new_user inserts itself,
-- because that INSERT also carries 500 and is also, literally, a balance born
-- outside the Mint. That is the measurement DR2 wants: when the seeder and
-- ensure-profile.js are changed to insert 0 and let the grant flow through the
-- Mint (standard 3.2 Earn step 5), this rule goes quiet on its own. Until then
-- expect roughly one warning per new profile (419 in the 48 hours to 2026-09-02).
--
-- The trigger is named zz_ so it sorts last and runs after every other trigger on
-- the table, including zz_ca_audit_diamond_change.
--
-- ROLLBACK
--   DROP TRIGGER IF EXISTS zz_ca_diamond_born_with_balance ON public.profiles;
--   DROP FUNCTION IF EXISTS public.fn_ca_diamond_born_with_balance();

BEGIN;

SET LOCAL lock_timeout = '4s';

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_born_with_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  BEGIN
    PERFORM public.fn_ca_diamond_incident(
      'DR2:balance_born_outside_the_mint', 'warning', NEW.id, NEW.diamonds,
      'profiles INSERT',
      jsonb_build_object(
        'is_horse',  NEW.is_horse,
        'app_name',  COALESCE(current_setting('application_name', true), ''),
        'db_role',   CURRENT_USER,
        'username',  NEW.username,
        'diamonds',  NEW.diamonds));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_ca_diamond_born_with_balance could not record the incident for %: %',
                  NEW.id, SQLERRM;
  END;

  BEGIN
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount,
       balance_before, balance_after, supply_after, reason,
       performed_by, performed_by_label)
    VALUES
      ('seed:' || NEW.id::text, 'mint', 'diamonds', 'player', NEW.id,
       COALESCE(NULLIF(BTRIM(NEW.username), ''), NEW.id::text), NEW.diamonds,
       0, NEW.diamonds,
       public.fn_ca_mint_supply('diamonds') + NEW.diamonds,
       'balance present at profile INSERT',
       NULL, 'zz_ca_diamond_born_with_balance')
    ON CONFLICT (op_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_ca_diamond_born_with_balance could not register the seed for %: %',
                  NEW.id, SQLERRM;
  END;

  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.fn_ca_diamond_born_with_balance() IS
  'DR2, log-only. A profiles INSERT carrying a non-zero diamonds balance did not '
  'pass through the Mint: record it in ca_diamond_incidents and put the amount in '
  'ca_mint_ledger under op_id seed:<profile id> so the supply register still '
  'matches SUM(profiles.diamonds). Writes no diamond_transactions row - the '
  'seeder inserts the profile before the auth.users row exists and that journal '
  'is FK-bound to it; handle_new_user writes it a moment later. Never raises.';

DROP TRIGGER IF EXISTS zz_ca_diamond_born_with_balance ON public.profiles;
CREATE TRIGGER zz_ca_diamond_born_with_balance
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  WHEN (NEW.diamonds IS NOT NULL AND NEW.diamonds <> 0)
  EXECUTE FUNCTION public.fn_ca_diamond_born_with_balance();

DO $assert$
DECLARE v_def text; v_src text;
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO v_def FROM pg_trigger t
   WHERE t.tgrelid = 'public.profiles'::regclass
     AND t.tgname = 'zz_ca_diamond_born_with_balance';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'the born-with-balance trigger did not land on profiles';
  END IF;
  IF position('AFTER INSERT' in v_def) = 0 OR position('diamonds' in v_def) = 0 THEN
    RAISE EXCEPTION 'the born-with-balance trigger has the wrong shape: %', v_def;
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_ca_diamond_born_with_balance';
  IF position('DR2:balance_born_outside_the_mint' in v_src) = 0 THEN
    RAISE EXCEPTION 'the trigger function does not name the rule it records';
  END IF;
  IF position('EXCEPTION WHEN OTHERS' in v_src) = 0 THEN
    RAISE EXCEPTION 'the trigger function is not swallowing its own failures';
  END IF;
  IF position('diamond_transactions' in v_src) <> 0 THEN
    RAISE EXCEPTION 'the trigger must not write diamond_transactions: FK to an auth.users row that does not exist yet at seeder INSERT time';
  END IF;

  RAISE NOTICE 'lane B part 2 assertions green';
END
$assert$;

COMMIT;
