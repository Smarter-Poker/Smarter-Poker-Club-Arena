-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260904110252; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260904110252   (the stamp IS the apply time, UTC: 2026-09-04 11:02:52)
--   name        the_noop_trigger_that_broke_settlement_is_removed
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 4718 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260904110252 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        aaa_skip_noop_update
--     DROP           TRIGGER needs, TRIGGER aaa_skip_noop_update
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- ═══════════════════════════════════════════════════════════════════════════
--  A NO-OP UPDATE IS NOT A FAILED WRITE, BUT THAT IS WHAT THIS TRIGGER TOLD
--  THE SETTLEMENT FUNCTION - FOR THIRTEEN HOURS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT HAPPENED
--
--   2026-09-03 21:30:32.450934+00   aaa_skip_noop_update installed on
--                                   table_seats (no migration, straight to
--                                   production)
--   2026-09-03 21:30:33.096824+00   the first "seat write failed ... hand
--                                   write rejected whole" settlement failure
--
-- 0.65 seconds apart.
--
-- Hand settlement failure rate, by hour:
--
--     18:00  0.1%      21:00  19.1%     00:00  44.2%     06:00  36.1%
--     19:00  0.2%      22:00  38.5%     01:00  38.5%     08:00  27.4%
--     20:00  0.0%      23:00  40.2%     02:00  29.6%     10:00  25.0%
--
-- 139,153 hands did not settle. Between a quarter and nearly half of every
-- hand dealt on the platform, for thirteen hours.
--
-- THE MECHANISM, proven in a transaction that rolled itself back (CLAUDE.md
-- 11.5 - no chips were spent to learn this):
--
--     UPDATE public.table_seats SET stack = stack WHERE id = <a live seat>;
--     -> rows_affected = 0
--     -> ca_noop_update_stats.suppressed 340086 -> 340087
--
-- The trigger returns NULL when NEW IS NOT DISTINCT FROM OLD, which CANCELS
-- the update. It is named `aaa_` so that it fires before every other BEFORE
-- trigger on the table. fn_ca_settle_hand_stacks_absolute writes each seat's
-- absolute stack and checks that the write landed; a seat whose stack was
-- already correct now reports zero rows, and the function - correctly, by its
-- own contract - refuses the WHOLE hand rather than settle part of it.
--
-- So the settlement function is not the bug. Refusing a hand whose seat write
-- did not land is exactly what it should do. The trigger is what lied to it.
--
-- WHAT IT WAS FOR, AND WHY THAT DOES NOT COME CLOSE
--
-- It suppressed 340,086 genuinely redundant row versions in thirteen hours -
-- about 26k an hour of avoided WAL, which is real but small next to the
-- 20+ million writes a window this database does. It bought that by breaking
-- a third of all hand settlements. There is no version of this trade that is
-- worth making.
--
-- WHY A REVERT AND NOT A FIX
--
-- The platform ran without this trigger for its entire life until thirteen
-- hours ago. Removing it returns the database to a state known to work, which
-- is the lowest-risk action available and does not require touching a money
-- path. Making the settlement function tolerate a zero-row seat write is the
-- more interesting engineering answer and it is NOT done here: it edits the
-- function that writes player chip stacks, to fix a problem that stops
-- existing the moment this trigger is gone.
--
-- The function and its counter table are LEFT IN PLACE, deliberately:
-- ca_noop_update_stats holds the evidence, and the function is harmless while
-- attached to nothing. The COMMENT below is there so the next person to find
-- it knows what it did.
--
-- ROLLBACK (do not - read the numbers above first)
--
--   CREATE TRIGGER aaa_skip_noop_update BEFORE UPDATE ON public.table_seats
--     FOR EACH ROW EXECUTE FUNCTION fn_skip_noop_update();
-- ═══════════════════════════════════════════════════════════════════════════

-- Fail fast rather than queue behind a long transaction: table_seats is one of
-- the hottest tables here and DROP TRIGGER needs ACCESS EXCLUSIVE. Waiting for
-- that lock would block every seat write on the platform behind us.
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS aaa_skip_noop_update ON public.table_seats;

COMMENT ON FUNCTION public.fn_skip_noop_update() IS
  'DO NOT ATTACH THIS TO table_seats. It was attached there without a migration on 2026-09-03 21:30:32 and the first hand-settlement failure followed 0.65 seconds later; 139,153 hands - 25% to 44% of every hand dealt - failed to settle over the next thirteen hours. Cancelling a no-op UPDATE makes the caller see zero rows affected, and fn_ca_settle_hand_stacks_absolute treats a seat write that did not land as a failure and refuses the whole hand. It saved ~26k redundant row versions an hour and cost a third of all settlements. Detached 2026-09-04.';

DO $$
DECLARE
  v_still int;
BEGIN
  SELECT count(*) INTO v_still
  FROM pg_trigger
  WHERE tgrelid = 'public.table_seats'::regclass
    AND tgname = 'aaa_skip_noop_update'
    AND NOT tgisinternal;

  IF v_still <> 0 THEN
    RAISE EXCEPTION 'post-condition failed: aaa_skip_noop_update is still attached to table_seats';
  END IF;
END $$;
