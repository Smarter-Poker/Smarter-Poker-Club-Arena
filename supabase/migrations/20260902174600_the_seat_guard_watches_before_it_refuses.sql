-- ═══════════════════════════════════════════════════════════════════════════════
--  THE SEAT GUARD WATCHES BEFORE IT REFUSES (2026-09-02, Lane D / C2)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Companion to 20260902174500_cash_one_cashout_path_one_seat_creator.sql, which
-- defined fn_ca_guard_seat_creation() and patched the five sanctioned seat
-- creators (atomic_table_buyin, fn_take_seat_and_buy_in,
-- fn_seat_horse_in_seat_first_game, fn_seat_late_registrant,
-- fn_horse_seat_from_treasury) to declare app.money_path. That file did NOT
-- attach the trigger, for the deadlock reason recorded in its header; this one
-- takes the single table_seats lock alone.
--
-- DAN'S RULING, 2026-09-02: anything HIGH RISK for breaking live play is not
-- enforced. A BEFORE trigger that RAISES on table_seats INSERT can refuse a
-- seat mid-buy-in on a path nobody has enumerated yet (there are ~2,700
-- functions in this database). So the guard is attached in DRY-RUN form: the
-- body this file installs never raises. Every insert or resurrection it WOULD
-- have refused is written to ca_seat_guard_dryrun with the DB role, the
-- application name, the money path (if any) and the stack, and the row is
-- allowed through unchanged. Enabling the refusal is a follow-up after 24
-- hours of the dry-run table staying empty (or naming only paths that are
-- then added to the sanctioned list).
--
-- What it watches: a seat created (INSERT with left_at NULL) or resurrected
-- (left_at NOT NULL -> NULL) with stack > 0 by anything that is neither the
-- engine (fn_caller_is_engine: service_role, or no JWT at all - psql,
-- pg_cron, a migration) nor a sanctioned money RPC that has declared
-- app.money_path.
--
-- ONE TRANSACTION. The only hot lock is CREATE TRIGGER's AccessExclusiveLock
-- on table_seats, taken last, bounded by lock_timeout so a queued exclusive
-- lock can never stall the fleet's readers behind it. If it times out nothing
-- changed: apply once more at a quieter moment.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The dry-run log. Service-role only; the browser never reads or writes it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_seat_guard_dryrun (
  id            bigserial PRIMARY KEY,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  op            text        NOT NULL,             -- INSERT | UPDATE
  table_id      uuid,
  seat_number   integer,
  user_id       uuid,
  stack         numeric(15,2),
  db_role       text,                             -- session_user (authenticator = PostgREST, postgres = direct)
  jwt_role      text,                             -- auth.role(), NULL when no JWT
  jwt_sub       uuid,                             -- auth.uid(), NULL when no JWT
  app_name      text,                             -- application_name
  money_path    text,                             -- app.money_path GUC, NULL when undeclared
  would_refuse  boolean     NOT NULL DEFAULT true
);

COMMENT ON TABLE public.ca_seat_guard_dryrun IS
  'CHIP STANDARD C2 dry run (2026-09-02): every table_seats INSERT / resurrection with stack > 0 that fn_ca_guard_seat_creation WOULD refuse once enforced. Empty for 24h = safe to enforce. Rows here name a seat creator that is not on the sanctioned list; add it there or fix it before flipping the guard to RAISE.';

CREATE INDEX IF NOT EXISTS ca_seat_guard_dryrun_observed_at_idx
  ON public.ca_seat_guard_dryrun (observed_at DESC);

ALTER TABLE public.ca_seat_guard_dryrun ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_seat_guard_dryrun FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.ca_seat_guard_dryrun TO service_role;
REVOKE ALL ON SEQUENCE public.ca_seat_guard_dryrun_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.ca_seat_guard_dryrun_id_seq TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The guard body: same decision as the 17:45 version, but it LOGS instead
--    of raising. SECURITY DEFINER so the insert into the log works under an
--    authenticated caller's row; the guard itself never blocks.
-- ─────────────────────────────────────────────────────────────────────────────
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
     app.money_path. Anything else is, on the evidence so far, a mint.

     DRY RUN (Dan 2026-09-02: nothing high-risk for live play is enforced).
     This body records what it would refuse and lets the row through. The
     enforcing body is the one in 20260902174500_...; swap it back in only
     after ca_seat_guard_dryrun has stayed empty for 24 hours. */
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

  BEGIN
    INSERT INTO public.ca_seat_guard_dryrun
      (op, table_id, seat_number, user_id, stack, db_role, jwt_role, jwt_sub, app_name, money_path)
    VALUES
      (TG_OP, NEW.table_id, NEW.seat_number, NEW.user_id, NEW.stack,
       -- session_user, not current_user: inside this SECURITY DEFINER body
       -- current_user is the owner for everyone. session_user is the login
       -- role of the connection (authenticator for PostgREST, postgres for a
       -- direct/Supavisor session), which is the fact a reviewer needs.
       session_user::text,
       auth.role(),
       auth.uid(),
       NULLIF(current_setting('application_name', true), ''),
       NULLIF(v_path, ''));
  EXCEPTION WHEN OTHERS THEN
    -- The log must never be the reason a seat fails to land.
    RAISE WARNING 'fn_ca_guard_seat_creation: dry-run log insert failed (%): %', SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_guard_seat_creation() FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Attach. The one hot lock, taken last, while this transaction holds only
--    the new table and the function.
-- ─────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_ca_guard_seat_creation ON public.table_seats;
CREATE TRIGGER trg_ca_guard_seat_creation
  BEFORE INSERT OR UPDATE OF left_at ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_seat_creation();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Post-apply assertions
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.table_seats'::regclass
                    AND tgname = 'trg_ca_guard_seat_creation') THEN
    RAISE EXCEPTION 'post-apply: trg_ca_guard_seat_creation missing';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_ca_guard_seat_creation';
  IF v_src !~ 'ca_seat_guard_dryrun' THEN
    RAISE EXCEPTION 'post-apply: fn_ca_guard_seat_creation is not the dry-run body';
  END IF;
  -- The dry-run body must not RAISE EXCEPTION anywhere: it logs, it never refuses.
  IF v_src ~* 'RAISE\s+EXCEPTION' THEN
    RAISE EXCEPTION 'post-apply: the dry-run guard still raises';
  END IF;
  IF has_table_privilege('authenticated', 'public.ca_seat_guard_dryrun', 'SELECT')
     OR has_table_privilege('anon', 'public.ca_seat_guard_dryrun', 'SELECT') THEN
    RAISE EXCEPTION 'post-apply: ca_seat_guard_dryrun is readable by the browser';
  END IF;
  RAISE NOTICE 'the_seat_guard_watches_before_it_refuses: dry-run trigger attached';
END $$;

COMMIT;

-- ROLLBACK (not run by this file):
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_ca_guard_seat_creation ON public.table_seats;
-- DROP TABLE IF EXISTS public.ca_seat_guard_dryrun;
-- -- fn_ca_guard_seat_creation may stay (unattached, it does nothing) or be
-- -- dropped: DROP FUNCTION IF EXISTS public.fn_ca_guard_seat_creation();
-- COMMIT;
