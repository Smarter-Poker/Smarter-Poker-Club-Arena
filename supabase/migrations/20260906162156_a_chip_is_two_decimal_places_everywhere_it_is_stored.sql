-- A CHIP IS TWO DECIMAL PLACES, EVERYWHERE IT IS STORED.
--
-- Phase 3 of the chip-accounting programme (docs/CHIP-ACCOUNTING-ROADMAP.md
-- Part Two): "one definition of a chip". A 4-dp balance compared against a
-- 2-dp journal leaks by construction, and an UNCONSTRAINED numeric column is
-- worse than either - it stores whatever decimal expansion it is handed.
--
-- MEASURED FIRST, on production 2026-09-06 16:15 UTC, across every money
-- column in the conservation set (~4.7 million rows):
--
--   scale 2, already correct   11 columns  chip_ledger.amount, club_members
--                                          .chip_balance, table_seats.stack,
--                                          clubs.chip_treasury/total_rake,
--                                          wallet_transactions.amount,
--                                          hand_history pot/rake/bbj,
--                                          tournament_rake_settlements.amount,
--                                          wallets.balance
--   scale 4                     7 columns  agents.agent_wallet_balance,
--                                          club_wallets x3, rake_records x2,
--                                          tournaments.total_rake
--   UNCONSTRAINED numeric      10 columns  eight fixed here, the two
--                                          tournament pools in 20260906162705
--
-- AND THE RESIDUE IS ONE ROW. Of 4.7M rows, exactly one holds a value that is
-- not a whole cent: tournament_payouts aac184db, amount
-- 55.629999999999995, written by `backfill_2026_08_31`. That is 55.63 with
-- IEEE754 noise - a JS double serialised into a column with no scale to round
-- it. The player it belongs to was correctly credited 225.62 in their wallet;
-- nothing was mispaid, and the roadmap's "no sub-cent residue in live data"
-- is right to one row. THE TYPE CHANGE BELOW ROUNDS IT to 55.63 as a side
-- effect, which is the correct value and a 5e-15 correction to a record.
--
-- WHY THE UNCONSTRAINED COLUMNS ARE THE WHOLE JOB, and the scale-4 ones can
-- wait: a column declared numeric(18,4) ROUNDS ON WRITE, so a float artifact
-- handed to it lands as 55.6300 and can never carry sub-cent noise. It is
-- imprecise about the definition of a chip, but it cannot leak one. An
-- unconstrained numeric performs no rounding at all, which is exactly how the
-- one bad row got in. So this migration closes the door the artifact came
-- through; the scale-4 columns are a follow-up that changes no value.
--
-- WHY ALTER TYPE AND NOT A CHECK CONSTRAINT. A CHECK refuses the write. On a
-- prize credit or a rake settlement that means a player is not paid because a
-- float ended in ...9995 - trading a rounding error for an outage, which is
-- the worse failure. A column with a scale ROUNDS instead: legitimate values
-- are unchanged (every value here is already a whole cent), float noise is
-- neutralised, and no money path can ever be refused for it. That is the
-- hard-coded fix CLAUDE.md 10.11 asks for - the bad value becomes
-- unrepresentable rather than detected.
--
-- LOCKING, read before re-running. ALTER TYPE rewrites the table under
-- ACCESS EXCLUSIVE. Sizes measured before writing: tournaments 147 MB (the
-- hottest table here - every seat and every finish writes it),
-- tournament_payouts 51 MB, bomb_pot_award_units 8 MB, tournament_escrow
-- 4 MB, union_wallets 16 kB. Both `tournaments` columns are altered in ONE
-- statement so the table is rewritten once, not twice. `lock_timeout` means a
-- busy table ABORTS THE WHOLE MIGRATION CLEANLY rather than queueing behind
-- live play - nothing is half-applied, and the retry is simply to run it
-- again (the ideal window is the :55 maintenance freeze, when the platform is
-- frozen and no money moves - CLAUDE.md 13).
--
-- One transaction for all of it, per the production DDL policy: every DDL
-- statement fires a ~28 second PostgREST schema reload, and Postgres coalesces
-- them inside a single transaction into one.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ---------------------------------------------------------------------------
-- union_wallets: THE AUTO-LEDGER TRIGGER HAS TO STAND ASIDE, AND COME BACK
-- EXACTLY AS IT WAS.
--
-- The first run of this migration aborted here, correctly and with nothing
-- applied: `cannot alter type of a column used in a trigger definition`.
-- trg_ca_autoledger is declared `AFTER INSERT OR UPDATE OF chip_balance,
-- rake_wallet, bbj_wallet, ...`, and Postgres will not retype a column named
-- in a trigger's column list. It is the trigger that journals every union
-- wallet movement into chip_ledger, so it is the last thing on this platform
-- that may be lost or altered by a side effect.
--
-- So it is not re-typed by hand. Its definition is READ from the catalogue
-- with pg_get_triggerdef, dropped, and re-issued verbatim from that captured
-- string - the recreation cannot drift from the original because it IS the
-- original. All inside this transaction, which already holds ACCESS EXCLUSIVE
-- on the table, so there is no instant at which a concurrent write could slip
-- past an absent trigger.
-- ---------------------------------------------------------------------------
DO $union_wallets$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.union_wallets'::regclass
     AND t.tgname = 'trg_ca_autoledger'
     AND NOT t.tgisinternal;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ABORT: trg_ca_autoledger is not on union_wallets - do not proceed blind, read the table first';
  END IF;

  DROP TRIGGER trg_ca_autoledger ON public.union_wallets;

  ALTER TABLE public.union_wallets
    ALTER COLUMN chip_balance         TYPE numeric(20,2),
    ALTER COLUMN rake_wallet          TYPE numeric(20,2),
    ALTER COLUMN total_rake_collected TYPE numeric(20,2);

  EXECUTE v_def;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.union_wallets'::regclass
                    AND tgname = 'trg_ca_autoledger' AND NOT tgisinternal
                    AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the union auto-ledger did not come back';
  END IF;
  IF pg_get_triggerdef((SELECT oid FROM pg_trigger
                         WHERE tgrelid='public.union_wallets'::regclass
                           AND tgname='trg_ca_autoledger' AND NOT tgisinternal)) <> v_def THEN
    RAISE EXCEPTION 'VERIFY FAILED: the union auto-ledger came back DIFFERENT from how it went away';
  END IF;
END $union_wallets$;

ALTER TABLE public.tournament_escrow
  ALTER COLUMN prize_balance  TYPE numeric(15,2),
  ALTER COLUMN fee_balance    TYPE numeric(15,2),
  ALTER COLUMN bounty_balance TYPE numeric(15,2);

ALTER TABLE public.bomb_pot_award_units
  ALTER COLUMN amount TYPE numeric(15,2);

ALTER TABLE public.tournament_payouts
  ALTER COLUMN amount TYPE numeric(15,2);

-- `tournaments.prize_pool` and `.bounty_pool` are NOT here. They were, and the
-- first attempt deadlocked on them at 16:25:18 - `AccessExclusiveLock on
-- relation tournaments, blocked by` a live session holding auth.users. That
-- is the 147 MB table every seat and every finish writes, and the deadlock is
-- the honest answer to whether a rewrite of it can be slipped in beside live
-- play: it cannot. Nothing was applied; the transaction rolled back whole.
-- They move in 20260906162705, which is the same change against the same two
-- columns, applied inside the :55 maintenance freeze when the platform is
-- stopped and no money is moving (CLAUDE.md 13). Splitting them out is what
-- lets these eight land now instead of waiting with them.

-- ---------------------------------------------------------------------------
-- PROVE IT: all ten now carry scale 2, the artifact is gone, and no value in
-- the conservation set is anything but a whole cent.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_unconstrained int;
  v_bad           int;
  v_artifact      numeric;
BEGIN
  SELECT count(*) INTO v_unconstrained
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND (c.table_name, c.column_name) IN (
           ('bomb_pot_award_units','amount'),
           ('tournament_escrow','prize_balance'),
           ('tournament_escrow','fee_balance'),
           ('tournament_escrow','bounty_balance'),
           ('tournament_payouts','amount'),
           ('union_wallets','chip_balance'),
           ('union_wallets','rake_wallet'),
           ('union_wallets','total_rake_collected'))
     AND c.numeric_scale IS DISTINCT FROM 2;
  IF v_unconstrained <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % of the eight columns is/are still not scale 2', v_unconstrained;
  END IF;

  /* The artifact row, by id, is now the value it always meant. */
  SELECT amount INTO v_artifact FROM public.tournament_payouts
   WHERE id = 'aac184db-963d-4d6d-a58d-3719b07fc45b';
  IF v_artifact IS NOT NULL AND v_artifact <> 55.63 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the float artifact row reads %, expected 55.63', v_artifact;
  END IF;

  /* And nothing anywhere in these ten holds a sub-cent value. */
  SELECT (SELECT count(*) FROM public.bomb_pot_award_units WHERE amount <> round(amount,2))
       + (SELECT count(*) FROM public.tournament_escrow
           WHERE prize_balance <> round(prize_balance,2)
              OR fee_balance <> round(fee_balance,2)
              OR bounty_balance <> round(bounty_balance,2))
       + (SELECT count(*) FROM public.tournament_payouts WHERE amount <> round(amount,2))
       + (SELECT count(*) FROM public.union_wallets
           WHERE chip_balance <> round(chip_balance,2)
              OR rake_wallet <> round(rake_wallet,2)
              OR total_rake_collected <> round(total_rake_collected,2))
    INTO v_bad;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % sub-cent value(s) survive in the eight columns', v_bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.union_wallets'::regclass
                    AND tgname = 'trg_ca_autoledger' AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'VERIFY FAILED: union_wallets lost its auto-ledger trigger';
  END IF;

  RAISE NOTICE 'CHIP_SCALE_TWO eight columns carry scale 2; the one float artifact is 55.63; no sub-cent value remains';
END $verify$;

COMMIT;
