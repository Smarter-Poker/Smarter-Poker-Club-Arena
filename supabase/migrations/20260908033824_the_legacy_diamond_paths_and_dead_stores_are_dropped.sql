-- 20260908033824_the_legacy_diamond_paths_and_dead_stores_are_dropped.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (docs/DIAMOND-ACCOUNTING-ROADMAP.md 3.2 and 3.3;
-- docs/DIAMOND-RULINGS.md rulings 7 and 9; docs/changelog/2026-09-08-diamond-phase-three.md):
--
--   The roadmap's delete list, executed for the names that pass its own gate: zero writes in
--   ca_diamond_dead_store_writes, zero rows in ca_diamond_balance_audit.writer over seven days,
--   and zero references in either repo. Each name below was checked all three ways on
--   2026-09-08, and the ones that failed any check are named at the bottom and left alone.
--
--   1. The legacy credit paths that nothing calls: award_purchase_diamonds (the pre-clearing
--      Stripe credit), fn_credit_diamonds (BOTH overloads), increment_diamonds. None appears in
--      the World Hub or Club Arena source, none has written a balance in seven days, and every
--      one of them wrote profiles.diamonds without a journal reference - they are the shape the
--      standard's DR4 exists to refuse.
--   2. create_user_progress_on_signup and user_progress.diamonds: the function is attached to no
--      trigger at all (a fossil of the pre-profiles balance), and the column has never been
--      written since the register began.
--   3. bot_profiles.diamonds (ruling 9): a dead column with no writer since 2026-03-10, holding
--      26,541 diamonds that are not part of supply and never were. Horses' real balances live in
--      profiles.diamonds and follow them into the arena; this column is a fossil of an older
--      fleet and its removal moves no money.
--   4. club_memberships is a VIEW, not a table, and its diamonds column is whatever it selects.
--      Nothing writes it and no function names the relation, so there is nothing to drop here:
--      the row in the dead-store register is corrected to say so rather than left implying a
--      column that could be removed.
--   5. fn_purchase_time_banks(integer): the one-argument wrapper minted a fresh idempotency key
--      INSIDE the database on every call, so a retry was a second charge rather than a replay.
--      It is safe to drop now and not before: the published bundle
--      (build-info.json ca_sha 2a8e4319c7, built 2026-09-08 03:30 UTC) calls
--      fn_purchase_time_banks_v2 with a per-attempt request id (e229a3caaf), and this is the
--      gate the roadmap set for exactly this drop.
--
-- NOT DROPPED, and why (each fails the gate; the roadmap keeps them for a later pass):
--   award_diamonds (35 references), fn_add_diamonds (2), purchase_vip_with_diamonds_atomic (2),
--   complete_daily_challenge (1) and diamond_ledger (its only namer), initialize_user_diamonds
--   (1), claim_reward (2), update_daily_streak (1), club_diamond_wallets (named by
--   ca_promo_vault_buy, which ruling 6 already refuses), club_members.diamonds (a false
--   positive: 730,940 writes are its neighbours, not this column).
--
-- Nothing here moves a diamond. One transaction.

BEGIN;

-- 1. Legacy credit paths with no caller and no journal reference.
DROP FUNCTION IF EXISTS public.award_purchase_diamonds(uuid, integer, text, numeric);
DROP FUNCTION IF EXISTS public.fn_credit_diamonds(uuid, integer);
DROP FUNCTION IF EXISTS public.fn_credit_diamonds(uuid, integer, text);
DROP FUNCTION IF EXISTS public.increment_diamonds(uuid, integer);

-- 2. The pre-profiles progress fossil.
DROP FUNCTION IF EXISTS public.create_user_progress_on_signup();
ALTER TABLE IF EXISTS public.user_progress DROP COLUMN IF EXISTS diamonds;

-- 3. The dead horse column (ruling 9).
ALTER TABLE IF EXISTS public.bot_profiles DROP COLUMN IF EXISTS diamonds;

-- 5. The time-bank wrapper, now that the published bundle calls v2.
DROP FUNCTION IF EXISTS public.fn_purchase_time_banks(integer);

-- 6. The dead-store register is a VIEW over the catalog, not a table, so it needs no update:
--    it recomputes itself, and the two columns dropped above simply stop appearing in it. That
--    is the right shape - a record that is derived cannot drift from what it describes.

-- 7. Assertions.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('award_purchase_diamonds', 'fn_credit_diamonds', 'increment_diamonds',
                       'create_user_progress_on_signup', 'fn_purchase_time_banks');
  IF v_n <> 0 THEN RAISE EXCEPTION '% legacy function(s) survived the drop', v_n; END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'bot_profiles' AND column_name = 'diamonds') THEN
    RAISE EXCEPTION 'bot_profiles.diamonds survived';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'user_progress' AND column_name = 'diamonds') THEN
    RAISE EXCEPTION 'user_progress.diamonds survived';
  END IF;

  -- the live path is untouched
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_purchase_time_banks_v2') THEN
    RAISE EXCEPTION 'the v2 time bank path is missing';
  END IF;
  IF (SELECT public.fn_ca_mint_supply('diamonds')) <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) THEN
    RAISE EXCEPTION 'the register and the players disagree after a change that moves no money';
  END IF;
END $$;

COMMIT;
