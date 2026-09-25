-- 20260922173914_a_live_crash_round_is_sealed_like_every_other_round
--
-- A live Crash round is sealed like every other round, and a game ticket is
-- spent once.
--
-- THE FINDING (Diamond Crash fairness audit, 2026-09-22). The game is fair:
-- sixteen of sixteen production rounds recompute from their revealed seeds
-- with no mismatch. But the database did not lock a LIVE round's sealed
-- values. trg_crash_rounds_append_only runs fn_diamond_game_append_only, and
-- its crash_rounds branch let every UPDATE through while status = 'open'
-- except one that moved minimum_payout_chips. crash_cents, roll, server_seed,
-- server_seed_hash, client_seed, nonce, started_at, cap_cents, growth_k,
-- auto_cashout_cents and bet_chips could all have been rewritten under a
-- round in play, and diamond_game_commits (the sealed tickets) had no trigger
-- at all. Donkey Cross and Mines rounds have been locked since 20260914102113
-- (diamond_choice_immutable -> fn_choice_immutable). No code path rewrites
-- these today; this makes it impossible instead of merely absent.
--
-- EVERY WRITE THE LIVE DATABASE MAKES TO THESE TABLES, read from pg_proc on
-- 2026-09-22. Nothing else writes them: no function builds their names in
-- dynamic SQL, no cron job names them, no other trigger touches them, and
-- only postgres and service_role hold UPDATE or DELETE on either.
--   crash_rounds
--     INSERT  fn_crash_start. A new round is not a rewrite; unchanged.
--     UPDATE  fn_crash_decide, the one settlement writer, reached from
--             fn_crash_settle, fn_crash_cashout and fn_crash_settle_decided
--             (itself run by fn_diamond_game_state and fn_diamond_game_admit).
--             Only while status = 'open', only to 'cashed' or 'crashed', and
--             only status, settled_at, settled_by, elapsed_ms, cashout_cents,
--             payout_chips, pool_chips_minted_after, pool_chips_paid_after and
--             member_chips_after.
--     DELETE  none.
--   diamond_game_commits
--     INSERT  fn_diamond_game_commit.
--     UPDATE  consumed_by, from NULL to the round that spends the ticket:
--             fn_crash_start, fn_plinko_drop, fn_plinko_bonus_run and
--             fn_choice_start, each after fn_diamond_game_admit found the
--             ticket unconsumed and locked it.
--     DELETE  fn_diamond_game_commit's sweep of the caller's expired, unused
--             tickets (consumed_by IS NULL AND expires_at < now(), since
--             20260921185541).
--
-- THE LOCK. fn_diamond_game_append_only keeps its app.ledger_maintenance
-- escape exactly as it was, and its minimum_payout_chips rule word for word.
-- A live crash round may change only its settlement columns, and only as it
-- settles; every other column must come out exactly as it went in, compared
-- as a whole row so a column added later is sealed by default (the way
-- fn_choice_immutable seals Donkey Cross). A settled round and every DELETE
-- stay refused. The same function now guards diamond_game_commits through a
-- new trigger: a ticket is spent once (consumed_by goes from NULL to a round
-- and nothing else moves) and is deleted only by the expired-unused sweep.
-- plinko_drops and diamond_game_config_history keep their triggers and their
-- behaviour: every UPDATE and DELETE is refused.
--
-- PROVED BEFORE IT WAS APPLIED, twice. On production, in one self-aborting
-- call, this exact function body was built in pg_temp over temporary copies of
-- the two tables holding copies of real rows: the settlement fn_crash_decide
-- writes, a ticket being spent and the expired-ticket sweep went through, and
-- every sealed-column rewrite, re-spend, live-ticket delete and settled-round
-- edit was refused. In the isolated accounting fixture
-- (scripts/dev/test-accounting-delivery.sh) the real crash start, cash-out,
-- tick, time settlement and bonus-award paths run again on top of this lock,
-- and tests/sql/diamond-crash-round-is-sealed.sql proves the refusals on the
-- real trigger. The preimage guard below aborts if the function or the
-- triggers that run it moved since they were read.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';
DO $preimages$ BEGIN
  IF md5(pg_get_functiondef('public.fn_diamond_game_append_only()'::regprocedure))
     IS DISTINCT FROM 'ddfbed658ff1b4b6395ba11bd91c51ba' THEN
    RAISE EXCEPTION 'Crash Lock Preimage Changed: fn_diamond_game_append_only()';
  END IF;
  -- Every trigger that already runs it is one of the three read on 2026-09-22
  -- (BEFORE DELETE OR UPDATE, FOR EACH ROW: tgtype 27), the crash one among
  -- them, and the ticket table has none yet.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.crash_rounds'::regclass AND t.tgname = 'trg_crash_rounds_append_only'
                    AND t.tgfoid = 'public.fn_diamond_game_append_only()'::regprocedure AND t.tgtype = 27)
     OR EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 WHERE t.tgfoid = 'public.fn_diamond_game_append_only()'::regprocedure AND NOT t.tgisinternal
                   AND (c.relnamespace <> 'public'::regnamespace OR t.tgtype <> 27
                        OR (c.relname, t.tgname) NOT IN (('crash_rounds', 'trg_crash_rounds_append_only'),
                                                         ('plinko_drops', 'trg_plinko_drops_append_only'),
                                                         ('diamond_game_config_history', 'trg_diamond_game_config_history_append_only')))) THEN
    RAISE EXCEPTION 'Crash Lock Preimage Changed: the append-only triggers';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid = 'public.diamond_game_commits'::regclass AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'Crash Lock Preimage Changed: diamond_game_commits already has a trigger';
  END IF;
END $preimages$;

CREATE OR REPLACE FUNCTION public.fn_diamond_game_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NULLIF(current_setting('app.ledger_maintenance', true), '') IS NOT NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'crash_rounds' THEN
    IF TG_OP = 'UPDATE' AND OLD.status = 'open' THEN
      IF NEW.minimum_payout_chips IS DISTINCT FROM OLD.minimum_payout_chips THEN
        RAISE EXCEPTION 'The Bonus Minimum Is Fixed When The Round Starts' USING ERRCODE='integrity_constraint_violation';
      END IF;
      -- A live round settles once, through fn_crash_decide, and nothing it sealed moves.
      IF NEW.status IN ('cashed', 'crashed')
         AND (to_jsonb(NEW) - ARRAY['status', 'settled_at', 'settled_by', 'elapsed_ms', 'cashout_cents', 'payout_chips',
                                    'pool_chips_minted_after', 'pool_chips_paid_after', 'member_chips_after'])
           = (to_jsonb(OLD) - ARRAY['status', 'settled_at', 'settled_by', 'elapsed_ms', 'cashout_cents', 'payout_chips',
                                    'pool_chips_minted_after', 'pool_chips_paid_after', 'member_chips_after']) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'A Sealed Crash Round Cannot Be Rewritten' USING ERRCODE='integrity_constraint_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'diamond_game_commits' THEN
    IF TG_OP = 'UPDATE' THEN
      -- A ticket is spent once: consumed_by goes from nothing to its round, and nothing else moves.
      IF OLD.consumed_by IS NULL AND NEW.consumed_by IS NOT NULL
         AND (to_jsonb(NEW) - 'consumed_by') = (to_jsonb(OLD) - 'consumed_by') THEN
        RETURN NEW;
      END IF;
    ELSIF OLD.consumed_by IS NULL AND OLD.expires_at < now() THEN
      -- The one sweep fn_diamond_game_commit runs: a ticket nobody used, after it expired.
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A Sealed Game Ticket Cannot Be Rewritten' USING ERRCODE='integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION '% is append-only: a settled round is a fact and is never edited or deleted', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $function$;

CREATE TRIGGER trg_diamond_game_commits_sealed BEFORE DELETE OR UPDATE ON public.diamond_game_commits
  FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_game_append_only();
COMMIT;
