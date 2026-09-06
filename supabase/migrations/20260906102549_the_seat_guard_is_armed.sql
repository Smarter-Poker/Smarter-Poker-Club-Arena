-- THE SEAT GUARD IS ARMED (2026-09-06)
--
-- `fn_ca_guard_seat_creation` has run in DRY RUN since 2026-09-02. Its own
-- comment states the condition for arming it: "swap it back in only after
-- ca_seat_guard_dryrun has stayed empty for 24 hours."
--
-- THE CONDITION IS MET, BY FOUR ORDERS OF MAGNITUDE. Read 2026-09-06:
--   trg_ca_guard_seat_creation      enabled ('O'), BEFORE INSERT OR UPDATE OF left_at
--   seats created since the dry run  170,942
--   seats created in the last 24h    41,696, of which 14,542 carried chips
--   rows in ca_seat_guard_dryrun     0
--
-- An empty log proves nothing on its own - a dead trigger writes nothing
-- either - so the trigger was checked as enabled and the traffic through it
-- counted. It is live, it fires on tens of thousands of chip-carrying seat
-- creations a day, and in four days it has not seen one creator outside the
-- sanctioned list. That is the evidence the dry run existed to collect.
--
-- DAN'S 2026-09-02 INSTRUCTION ("nothing high-risk for live play is
-- enforced") was the reason for the dry run; on 2026-09-06 he returned the
-- decision: "THIS IS ON YOU TO DECIDE". Decided: arm it.
--
-- WHAT IT REFUSES. A `table_seats` row that APPEARS (INSERT) or COMES BACK TO
-- LIFE (left_at NOT NULL -> NULL) carrying stack > 0, when the caller is
-- neither the engine (`fn_caller_is_engine`: service_role, or no JWT at all -
-- psql, pg_cron, a migration) nor a money RPC that has debited a wallet or a
-- treasury and says so through `app.money_path`. Anything else put chips on
-- the felt without taking them from anywhere, which is a mint.
-- It does NOT touch top-ups or add-ons: `v_creating` is deliberately scoped to
-- a seat arriving, and chips added to a seat already seated are a different
-- control (the exit side is `ca_seat_stack_exits` and
-- `fn_unaccounted_seat_exits`, CLAUDE.md 11.5).
--
-- A REFUSAL CANNOT LOG ITSELF TO A TABLE, AND THIS BODY NO LONGER PRETENDS TO.
-- The first draft logged the refusal into `ca_seat_guard_dryrun` and then
-- raised. Probed rolled back, the log count went 0 -> 0: a RAISE inside a
-- BEFORE trigger aborts the statement, and the trigger's own INSERT is part of
-- that statement, so the row never survives. Persisting it would need an
-- autonomous transaction (dblink or pg_background), which is a lot of new
-- machinery in a money path for a record we already have. So the refusal
-- carries its evidence in the ERROR ITSELF - the declared path, the JWT role
-- and the application name - which reaches the caller AND the Postgres error
-- log, where it is countable. That log is exactly where the FOUR TABLE LIMIT
-- refusals were measured on 2026-09-06, so it is a proven surface.
--
-- `ca_seat_guard_dryrun` stays as it is: the dry run's evidence, and the table
-- to re-point the guard at if it is ever put back into observation mode.
--
-- HOW TO UNDO IT IN ONE STATEMENT, if a real path turns out to be missing:
--   re-apply the dry-run body from 20260902184321 (it is quoted in that
--   migration's `statements`), or simply add the missing path to the
--   allowlist below, which is the correct fix in almost every case.
--
-- WHAT TO WATCH for the next 24 hours:
--   the Postgres error log, filtered to 'SEAT_NOT_FUNDED'. Any hit is a
--   refused seat and names its own caller. Silence is the guard working.
--
-- Function replacement only. One transaction, no table lock, no trigger DDL -
-- the trigger keeps its current definition and is not touched, so this cannot
-- deadlock against the cluster tick the way a `public.tables` trigger change
-- did on 2026-09-05.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE v_rows bigint; v_enabled text;
BEGIN
  SELECT count(*) INTO v_rows FROM public.ca_seat_guard_dryrun;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'ca_seat_guard_dryrun holds % row(s) - the dry run found a seat creator outside the allowlist. Read them and either allowlist the path or fix the caller BEFORE arming.', v_rows;
  END IF;
  SELECT tgenabled::text INTO v_enabled FROM pg_trigger WHERE tgname = 'trg_ca_guard_seat_creation';
  IF v_enabled IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'trg_ca_guard_seat_creation is % (expected O) - an empty dry-run log from a disabled trigger is not evidence', coalesce(v_enabled, 'absent');
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_creating boolean;
BEGIN
  /* A seat that appears (INSERT) or comes back to life (left_at NOT NULL ->
     NULL) carrying chips is money arriving on the felt. Only two things may
     put it there: the engine (service_role, or a session with no JWT at all -
     psql, pg_cron, a migration; see fn_caller_is_engine), or a money RPC that
     has debited a wallet or a treasury for it and says so through
     app.money_path. Anything else is a mint.

     ARMED 2026-09-06, after the dry run stayed empty across 170,942 seat
     creations. It LOGS the refusal before raising it, so a refused seat names
     its own caller and the allowlist can be corrected in minutes. */
  v_creating := (TG_OP = 'INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP = 'UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL);
  IF NOT v_creating OR COALESCE(NEW.stack, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;

  v_path := current_setting('app.money_path', true);
  IF v_path IN ('atomic_table_buyin', 'fn_take_seat_and_buy_in',
                'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  /* No table write here: a RAISE in a BEFORE trigger aborts the statement and
     would take the row with it (measured). The evidence travels in the error. */
  RAISE EXCEPTION 'SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a declared money path (path=%, jwt_role=%, app=%, table=%, seat=%, stack=%)',
    COALESCE(NULLIF(v_path, ''), 'none'),
    COALESCE(auth.role(), 'none'),
    COALESCE(NULLIF(current_setting('application_name', true), ''), 'none'),
    NEW.table_id, NEW.seat_number, NEW.stack
    USING ERRCODE = 'check_violation',
          HINT = 'The caller must debit a wallet or a treasury and declare itself with app.money_path, or be the engine. Add the path to fn_ca_guard_seat_creation only after confirming it moved money.';
END;
$function$;

DO $post$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_ca_guard_seat_creation';
  IF position('SEAT_NOT_FUNDED' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the seat guard is still not armed';
  END IF;
  IF position('DRY RUN' IN v_src) > 0 THEN
    RAISE EXCEPTION 'the dry-run body is still installed';
  END IF;
  IF position('INSERT INTO public.ca_seat_guard_dryrun' IN v_src) > 0 THEN
    RAISE EXCEPTION 'the armed body still tries to log a refusal it cannot persist';
  END IF;
  -- The five sanctioned paths must all survive the swap, or a legitimate
  -- buy-in starts failing the moment this commits.
  IF position('atomic_table_buyin' IN v_src) = 0
     OR position('fn_take_seat_and_buy_in' IN v_src) = 0
     OR position('fn_seat_horse_in_seat_first_game' IN v_src) = 0
     OR position('fn_seat_late_registrant' IN v_src) = 0
     OR position('fn_horse_seat_from_treasury' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the armed body lost one of the five sanctioned money paths';
  END IF;
END
$post$;

COMMIT;
