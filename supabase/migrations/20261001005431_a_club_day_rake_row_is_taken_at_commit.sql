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
-- WHAT CHANGES. Only WHEN the same upsert runs: at COMMIT. The statement
-- trigger on rake_records stays exactly as it is (same name, same definition,
-- same function, same filter). Its function, trg_ca_club_rake_daily_insert, is
-- changed by one asserted substitution: instead of calling
-- fn_ca_club_rake_daily_apply(v_ids) there and then, it writes the same v_ids
-- into smarter_private.ca_club_rake_daily_at_commit, a transaction-scratch table
-- whose DEFERRABLE INITIALLY DEFERRED row trigger calls the same
-- fn_ca_club_rake_daily_apply with each id at COMMIT and removes the row. The
-- club's day row is then locked for the commit itself and nothing else.
--
--   * fn_ca_club_rake_daily_compute and fn_ca_club_rake_daily_apply are not
--     touched (md5 pinned below, before and after).
--   * The filter is the old one, untouched: a cash row (NOT is_tournament) that
--     names a club.
--   * Per row instead of per statement: apply() adds each hand's terms, and
--     numeric addition is exact, so one call per row and one call per statement
--     leave identical rows. Proved on 4,003 production rows (2,399 of them union
--     rows split across clubs) in one rolled-back transaction before this was
--     applied (changelog, "Proof").
--   * The failure rule is the old one, word for word: a rollup that cannot be
--     written never fails the hand (WARNING, and the hand commits).
--   * The scratch table is UNLOGGED: a row lives only inside the transaction
--     that wrote it (deleted by its own commit-time trigger, discarded with an
--     aborted transaction), so it writes no WAL and has nothing to lose in a
--     crash. No foreign key to rake_records (a hot relation) and no grant.
--
-- WHAT DOES NOT CHANGE. No money table, no money function, no grant on one. No
-- rake, wallet, ledger, VIP, BBJ, promo or insurance row is written differently
-- or in a different order: atomic_distribute_rake and the post-commit
-- obligations are byte for byte what they were.
--
-- LOCKS. None on a hot relation. A first version of this file swapped the
-- trigger on rake_records itself (DROP TRIGGER takes ACCESS EXCLUSIVE); at 01:05
-- UTC it was refused by its own 2 s lock_timeout, having changed nothing, because
-- some open hand always holds rake_records for longer than that - the very
-- convoy it is for. This version creates a new table and a trigger on it, and
-- replaces one function body: nothing waits on rake_records. One transaction,
-- so PostgREST reloads its schema cache once. Not inside :50-:03 UTC.
--
-- @live-proof: (SELECT t.tgdeferrable AND t.tginitdeferred AND (t.tgtype & 1) = 1 AND c.relpersistence = 'u' AND pg_get_functiondef('public.trg_ca_club_rake_daily_insert()'::regprocedure) LIKE '%INSERT INTO smarter_private.ca_club_rake_daily_at_commit%' FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgrelid = 'smarter_private.ca_club_rake_daily_at_commit'::regclass AND t.tgname = 'ca_club_rake_daily_at_commit')

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
  IF to_regclass('smarter_private.ca_club_rake_daily_at_commit') IS NOT NULL
  OR to_regprocedure('smarter_private.fn_ca_club_rake_daily_apply_at_commit()') IS NOT NULL THEN
    RAISE EXCEPTION 'the at-commit rollup already exists';
  END IF;
END
$pins$;

-- One row per cash rake row inserted by this transaction, between the insert
-- and this transaction's COMMIT. Nothing else ever reads or writes it.
CREATE UNLOGGED TABLE smarter_private.ca_club_rake_daily_at_commit (
  rake_record_id uuid PRIMARY KEY
);
ALTER TABLE smarter_private.ca_club_rake_daily_at_commit OWNER TO postgres;
ALTER TABLE smarter_private.ca_club_rake_daily_at_commit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE smarter_private.ca_club_rake_daily_at_commit FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION smarter_private.fn_ca_club_rake_daily_apply_at_commit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- Fired at COMMIT, once per cash rake row: the rollup the statement trigger
  -- used to write in the middle of the hand, for this one row, so the club's
  -- day row is locked for the commit and not for the rest of the hand.
  DELETE FROM smarter_private.ca_club_rake_daily_at_commit
   WHERE rake_record_id = NEW.rake_record_id;
  BEGIN
    PERFORM public.fn_ca_club_rake_daily_apply(ARRAY[NEW.rake_record_id]);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ca_club_rake_daily insert rollup failed: %', SQLERRM;
  END;
  RETURN NULL;
END;
$fn$;
ALTER FUNCTION smarter_private.fn_ca_club_rake_daily_apply_at_commit() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_club_rake_daily_apply_at_commit() FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER ca_club_rake_daily_at_commit
  AFTER INSERT ON smarter_private.ca_club_rake_daily_at_commit
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION smarter_private.fn_ca_club_rake_daily_apply_at_commit();

DO $subs$
DECLARE v_def text; v_old text; v_new text; v_n integer; v_acl text; v_after text;
BEGIN
  v_def := pg_get_functiondef('public.trg_ca_club_rake_daily_insert()'::regprocedure);
  v_old := E'  IF v_ids IS NOT NULL THEN\n'
        || E'    PERFORM public.fn_ca_club_rake_daily_apply(v_ids);\n'
        || E'  END IF;\n';
  v_new := E'  IF v_ids IS NOT NULL THEN\n'
        || E'    -- Applied at COMMIT, one row at a time, by the deferred trigger on\n'
        || E'    -- this scratch table: the club''s day row is no longer held for the\n'
        || E'    -- rest of the hand (20261001005431).\n'
        || E'    INSERT INTO smarter_private.ca_club_rake_daily_at_commit (rake_record_id)\n'
        || E'    SELECT unnest(v_ids);\n'
        || E'  END IF;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the apply clause occurs % times in trg_ca_club_rake_daily_insert, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = 'public.trg_ca_club_rake_daily_insert()'::regprocedure;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef('public.trg_ca_club_rake_daily_insert()'::regprocedure);
  IF md5(v_after) <> '7c89337da7ff645a74fd4471be9170a5' THEN
    RAISE EXCEPTION 'trg_ca_club_rake_daily_insert is not the expected text (md5 %)', md5(v_after);
  END IF;
  IF md5(replace(v_after, v_new, v_old)) <> '4bb7c4d64021796803829faacbcddbb0' THEN
    RAISE EXCEPTION 'trg_ca_club_rake_daily_insert: the reverse substitution does not reproduce the pinned text';
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = 'public.trg_ca_club_rake_daily_insert()'::regprocedure)
     IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'trg_ca_club_rake_daily_insert grants moved';
  END IF;
END
$subs$;

DO $after$
BEGIN
  IF (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
       WHERE t.tgrelid = 'public.rake_records'::regclass AND t.tgname = 'trg_ca_club_rake_daily_ins')
     IS DISTINCT FROM
     'CREATE TRIGGER trg_ca_club_rake_daily_ins AFTER INSERT ON public.rake_records REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_club_rake_daily_insert()' THEN
    RAISE EXCEPTION 'the rake_records trigger moved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE t.tgrelid = 'smarter_private.ca_club_rake_daily_at_commit'::regclass
                    AND t.tgname = 'ca_club_rake_daily_at_commit'
                    AND t.tgdeferrable AND t.tginitdeferred AND (t.tgtype & 1) = 1
                    AND t.tgfoid = 'smarter_private.fn_ca_club_rake_daily_apply_at_commit()'::regprocedure
                    AND c.relpersistence = 'u') THEN
    RAISE EXCEPTION 'the at-commit trigger is not deferred, per row, on the unlogged scratch table';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_club_rake_daily_apply(uuid[])'::regprocedure))
       <> '9b47ac0cf0ab468e28cfef01548f25e8'
  OR md5(pg_get_functiondef('public.fn_ca_club_rake_daily_compute(timestamp with time zone,timestamp with time zone,uuid[])'::regprocedure))
       <> '8c184988b1c7b14f27d4305eb9b99456' THEN
    RAISE EXCEPTION 'the rollup functions moved';
  END IF;
  IF has_table_privilege('anon', 'smarter_private.ca_club_rake_daily_at_commit', 'SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('authenticated', 'smarter_private.ca_club_rake_daily_at_commit', 'SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('service_role', 'smarter_private.ca_club_rake_daily_at_commit', 'SELECT,INSERT,UPDATE,DELETE')
  OR has_function_privilege('anon', 'smarter_private.fn_ca_club_rake_daily_apply_at_commit()', 'EXECUTE')
  OR has_function_privilege('authenticated', 'smarter_private.fn_ca_club_rake_daily_apply_at_commit()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the at-commit scratch table or function is reachable from a client role';
  END IF;
END
$after$;

COMMIT;
