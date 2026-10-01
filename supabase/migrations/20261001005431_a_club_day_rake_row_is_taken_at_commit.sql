-- ============================================================================
-- A CLUB'S DAY RAKE ROW IS TAKEN AT COMMIT
-- ============================================================================
--
-- 20261001005431_a_club_day_rake_row_is_taken_at_commit.sql
-- Changelog: docs/changelog/2026-10-01-a-club-day-rake-row-is-taken-at-commit.md
--
-- THE COST, READ FROM PRODUCTION (2026-10-01 00:40 to 00:55 UTC).
--
-- fn_ca_process_hand_post_commit_obligations and fn_project_hand_side_effects
-- are two of the three largest consumers of database time (pg_stat_statements,
-- 2.17M calls each, 131 ms mean, about 285,000 s each over 55 h). In the 24 h to
-- 2026-10-01 00:45 UTC the post-commit obligations RPC was cancelled by the 8 s
-- statement timeout 17,063 times. The line each one was cancelled on is in the
-- Postgres log (parsed.context):
--
--   11,373  INSERT INTO public.ca_club_rake_daily ... ON CONFLICT  (67%)
--    2,949  club_wallets (the 00:05-00:17 wallet-first window, since reverted)
--    1,453  vip_points_carry (per player)
--      421  profiles, the rake_attributions foreign key (the horse claims)
--      857  other
--
-- and fn_project_hand_side_effects (which runs the same obligations) 1,172 more
-- times on the same row.
--
-- WHY THAT ROW. ca_club_rake_daily has one row per (club, UTC day). Every raked
-- cash hand upserts it from the AFTER INSERT statement trigger on rake_records,
-- which fires INSIDE atomic_distribute_rake - right after the VIP award and
-- BEFORE the rake attributions (whose foreign key on profiles waits behind the
-- horse claims), the legs, the club and union wallets, the BBJ pool, the promo
-- playthrough, the insurance and add-on receipts, and the PostgREST round trip
-- to COMMIT. A union hand writes the row of every club it attributes rake to
-- (Midway Union's hands write SHARK CLUB's and Midway's). The row lock is held
-- until COMMIT, so every hand of the club, and every union hand, waited for the
-- slowest hand in front of it - including one parked behind a horse claim's
-- profile lock. That is the convoy the log shows, and it is a reporting rollup:
-- no money is in that row.
--
-- WHAT CHANGES. Only WHEN the same upsert runs. The statement trigger becomes a
-- DEFERRABLE INITIALLY DEFERRED constraint trigger, FOR EACH ROW, that calls the
-- same fn_ca_club_rake_daily_apply with that one row's id at COMMIT. The row is
-- then locked for the commit itself and nothing else.
--
--   * fn_ca_club_rake_daily_compute and fn_ca_club_rake_daily_apply are not
--     touched (md5 pinned below, before and after).
--   * The filter is the old one, as the trigger's WHEN: a cash row
--     (NOT is_tournament) that names a club.
--   * Per row instead of per statement: apply() adds each hand's terms, and
--     numeric addition is exact, so one call per row and one call per statement
--     leave identical rows. Proved on production rows, in one rolled-back
--     transaction, before this was applied (changelog, "Proof").
--   * The failure rule is the old one, word for word: a rollup that cannot be
--     written never fails the hand (WARNING, RETURN NULL).
--   * Same trigger name. The old trigger function is left in place, unused, so
--     the qualification fixtures that pin it still load.
--
-- WHAT DOES NOT CHANGE. No money table, no money function, no grant on one. No
-- rake, wallet, ledger, VIP, BBJ, promo or insurance row is written differently
-- or in a different order: atomic_distribute_rake and the post-commit
-- obligations are byte for byte what they were.
--
-- LOCKS. DROP TRIGGER takes ACCESS EXCLUSIVE on public.rake_records and CREATE
-- TRIGGER SHARE ROW EXCLUSIVE, both until COMMIT, behind any open transaction
-- that has inserted a rake row. lock_timeout is 2 s: at worst rake inserts wait
-- 2 s and this aborts having changed nothing. One transaction, so PostgREST
-- reloads its schema cache once. Not inside :50-:03 UTC.
--
-- @live-proof: (SELECT tgdeferrable AND tginitdeferred AND (tgtype & 1) = 1 FROM pg_trigger WHERE tgrelid = 'public.rake_records'::regclass AND tgname = 'trg_ca_club_rake_daily_ins' AND tgfoid = 'public.trg_ca_club_rake_daily_insert_at_commit()'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $pins$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_club_rake_daily_apply(uuid[])'::regprocedure))
       <> '9b47ac0cf0ab468e28cfef01548f25e8'
  OR md5(pg_get_functiondef('public.fn_ca_club_rake_daily_compute(timestamp with time zone,timestamp with time zone,uuid[])'::regprocedure))
       <> '8c184988b1c7b14f27d4305eb9b99456'
  OR md5(pg_get_functiondef('public.trg_ca_club_rake_daily_insert()'::regprocedure))
       <> '4bb7c4d64021796803829faacbcddbb0' THEN
    RAISE EXCEPTION 'the club day rake rollup is not the pinned text';
  END IF;
  IF (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
       WHERE t.tgrelid = 'public.rake_records'::regclass AND t.tgname = 'trg_ca_club_rake_daily_ins')
     IS DISTINCT FROM
     'CREATE TRIGGER trg_ca_club_rake_daily_ins AFTER INSERT ON public.rake_records REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_club_rake_daily_insert()' THEN
    RAISE EXCEPTION 'trg_ca_club_rake_daily_ins is not the pinned statement trigger';
  END IF;
  IF to_regprocedure('public.trg_ca_club_rake_daily_insert_at_commit()') IS NOT NULL THEN
    RAISE EXCEPTION 'trg_ca_club_rake_daily_insert_at_commit already exists';
  END IF;
  PERFORM set_config('ca.rake_records_trigger_count',
    (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.rake_records'::regclass AND NOT tgisinternal)::text, true);
END
$pins$;

CREATE FUNCTION public.trg_ca_club_rake_daily_insert_at_commit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- Fired at COMMIT (DEFERRABLE INITIALLY DEFERRED), once per cash rake row.
  -- The same rollup the statement trigger wrote, for this one row, so the
  -- club's day row is locked for the commit and not for the rest of the hand.
  PERFORM public.fn_ca_club_rake_daily_apply(ARRAY[NEW.id]);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ca_club_rake_daily insert rollup failed: %', SQLERRM;
  RETURN NULL;
END;
$fn$;

ALTER FUNCTION public.trg_ca_club_rake_daily_insert_at_commit() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_ca_club_rake_daily_insert_at_commit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_ca_club_rake_daily_insert_at_commit() TO service_role;

DROP TRIGGER trg_ca_club_rake_daily_ins ON public.rake_records;

CREATE CONSTRAINT TRIGGER trg_ca_club_rake_daily_ins
  AFTER INSERT ON public.rake_records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NOT COALESCE(NEW.is_tournament, false) AND NEW.club_id IS NOT NULL)
  EXECUTE FUNCTION public.trg_ca_club_rake_daily_insert_at_commit();

DO $after$
DECLARE v_def text;
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO v_def FROM pg_trigger t
   WHERE t.tgrelid = 'public.rake_records'::regclass AND t.tgname = 'trg_ca_club_rake_daily_ins'
     AND t.tgdeferrable AND t.tginitdeferred;
  IF v_def IS DISTINCT FROM
     'CREATE CONSTRAINT TRIGGER trg_ca_club_rake_daily_ins AFTER INSERT ON public.rake_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((NOT COALESCE(new.is_tournament, false)) AND (new.club_id IS NOT NULL))) EXECUTE FUNCTION trg_ca_club_rake_daily_insert_at_commit()' THEN
    RAISE EXCEPTION 'trg_ca_club_rake_daily_ins is not the deferred row trigger: %', v_def;
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_club_rake_daily_apply(uuid[])'::regprocedure))
       <> '9b47ac0cf0ab468e28cfef01548f25e8'
  OR md5(pg_get_functiondef('public.fn_ca_club_rake_daily_compute(timestamp with time zone,timestamp with time zone,uuid[])'::regprocedure))
       <> '8c184988b1c7b14f27d4305eb9b99456' THEN
    RAISE EXCEPTION 'the rollup functions moved';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.trg_ca_club_rake_daily_insert_at_commit()'::regprocedure)
     IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
  OR has_function_privilege('anon', 'public.trg_ca_club_rake_daily_insert_at_commit()', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.trg_ca_club_rake_daily_insert_at_commit()', 'EXECUTE') THEN
    RAISE EXCEPTION 'trg_ca_club_rake_daily_insert_at_commit grants are not the old trigger function''s';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.rake_records'::regclass AND NOT tgisinternal)::text
     IS DISTINCT FROM current_setting('ca.rake_records_trigger_count', true) THEN
    RAISE EXCEPTION 'rake_records gained or lost a trigger';
  END IF;
END
$after$;

COMMIT;
