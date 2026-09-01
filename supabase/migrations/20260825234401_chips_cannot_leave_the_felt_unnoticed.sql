-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825234401; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- CHIPS CANNOT LEAVE THE FELT UNNOTICED
-- ───────────────────────────────────────────────────────────────────────────
-- On 2026-08-25 an agent (me) probing atomic_table_buyin against production
-- created seats and then DELETED the rows to clean up, skipping
-- atomicCashout. 48 chips stopped existing. NOTHING NOTICED. They were found
-- only because I went looking for them.
--
-- That is not a story about one careless cleanup. It is a gap:
-- reconcile_ledger_nightly compares chip_ledger against `wallets` and against
-- `clubs.chip_pool`, and Club Arena's money is in NEITHER of those places. It
-- lives in `club_members.chip_balance` (the club wallet every buy-in debits)
-- and in `table_seats.stack` (chips on the felt). Both pools were completely
-- unreconciled, so chips could be created or destroyed there in total silence.
--
-- WHY A DETECTOR AND NOT A CONSERVATION SUM. The obvious check -- "total chips
-- should only change by issuance minus redemption" -- needs every leak term to
-- be right: rake, BBJ contributions and payouts, tournament prize pools,
-- promotions. Get one wrong and it cries wolf every night, and a reconciler
-- nobody believes is worse than none. So this watches the one EVENT that can
-- destroy chips instead: a seat losing its stack without the stack going
-- anywhere.
--
-- The trigger is append-only and never blocks. A guard that can refuse a seat
-- exit is a guard that can strand a player mid-hand, and the failure being
-- fixed here is a silent one, not an urgent one.

CREATE TABLE IF NOT EXISTS public.ca_seat_stack_exits (
  id          bigserial PRIMARY KEY,
  seat_id     uuid,
  table_id    uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  club_id     uuid,
  seat_number integer,
  stack       numeric     NOT NULL,
  exit_kind   text        NOT NULL CHECK (exit_kind IN ('deleted', 'left')),
  -- Who did it. A destroyed stack with no credit beside it is nearly always a
  -- script or a console session, and this is what names it.
  db_role     text,
  app_name    text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ca_seat_stack_exits_at_idx
  ON public.ca_seat_stack_exits (occurred_at DESC);
CREATE INDEX IF NOT EXISTS ca_seat_stack_exits_user_idx
  ON public.ca_seat_stack_exits (user_id, occurred_at DESC);

ALTER TABLE public.ca_seat_stack_exits ENABLE ROW LEVEL SECURITY;
-- No policies: this is an audit trail. service_role bypasses RLS; nobody else
-- reads or writes it, and the trigger is SECURITY DEFINER.

CREATE OR REPLACE FUNCTION public.fn_log_seat_stack_exit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_stack numeric;
  v_kind  text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A departed seat being tidied up is not an exit: its stack left when
    -- left_at was stamped, and that is already recorded below.
    IF OLD.left_at IS NOT NULL THEN RETURN OLD; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'deleted';
  ELSE
    IF OLD.left_at IS NOT NULL OR NEW.left_at IS NULL THEN RETURN NEW; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'left';
  END IF;

  IF v_stack <= 0 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO public.ca_seat_stack_exits
    (seat_id, table_id, user_id, club_id, seat_number, stack, exit_kind, db_role, app_name)
  VALUES (OLD.id, OLD.table_id, OLD.user_id, OLD.club_id, OLD.seat_number,
          v_stack, v_kind, current_user,
          NULLIF(current_setting('application_name', true), ''));

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

DROP TRIGGER IF EXISTS trg_log_seat_stack_exit ON public.table_seats;
CREATE TRIGGER trg_log_seat_stack_exit
  BEFORE DELETE OR UPDATE OF left_at ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_log_seat_stack_exit();

-- ── THE QUESTION THE NIGHTLY RUN COULD NOT ASK ─────────────────────────────
-- Which stacks left the felt without landing anywhere?
--
-- The sanctioned cash-out (atomicCashout -> atomic_credit_wallet_and_log)
-- writes a wallet_transactions credit for the player. A 'deleted' exit can
-- never have one, because the sanctioned path stamps left_at. A 'left' exit
-- normally does. A grace window keeps an in-flight cash-out from being
-- reported as a loss.
CREATE OR REPLACE FUNCTION public.fn_unaccounted_seat_exits(
  p_since interval DEFAULT '7 days',
  p_grace interval DEFAULT '10 minutes'
)
 RETURNS TABLE(
   exit_id bigint, occurred_at timestamptz, user_id uuid, table_id uuid,
   club_id uuid, stack numeric, exit_kind text, db_role text, app_name text
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.id, e.occurred_at, e.user_id, e.table_id, e.club_id,
         e.stack, e.exit_kind, e.db_role, e.app_name
  FROM public.ca_seat_stack_exits e
  WHERE e.occurred_at >= now() - p_since
    AND e.occurred_at <= now() - p_grace
    AND NOT EXISTS (
      SELECT 1 FROM public.wallet_transactions wt
       WHERE wt.user_id = e.user_id
         AND wt.type = 'credit'
         AND wt.created_at BETWEEN e.occurred_at - interval '2 minutes'
                               AND e.occurred_at + p_grace
         AND wt.amount >= e.stack - 0.01
    )
  ORDER BY e.occurred_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.fn_unaccounted_seat_exits(interval, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_unaccounted_seat_exits(interval, interval) TO service_role;

-- ── AND THE TWO POOLS NOBODY WAS COUNTING ──────────────────────────────────
-- Not a verdict, a NUMBER. Where a club's chips actually are, right now, in
-- the two places reconcile_ledger_nightly has never looked.
CREATE OR REPLACE FUNCTION public.fn_club_chip_circulation(p_club_id uuid DEFAULT NULL)
 RETURNS TABLE(
   club_id uuid, club_name text,
   member_wallets numeric, on_the_felt numeric, treasury numeric, total numeric
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT c.id, c.name,
         COALESCE((SELECT SUM(cm.chip_balance) FROM public.club_members cm
                    WHERE cm.club_id = c.id), 0),
         COALESCE((SELECT SUM(ts.stack) FROM public.table_seats ts
                    WHERE ts.club_id = c.id AND ts.left_at IS NULL), 0),
         COALESCE(c.chip_pool, 0),
         COALESCE((SELECT SUM(cm.chip_balance) FROM public.club_members cm
                    WHERE cm.club_id = c.id), 0)
         + COALESCE((SELECT SUM(ts.stack) FROM public.table_seats ts
                      WHERE ts.club_id = c.id AND ts.left_at IS NULL), 0)
         + COALESCE(c.chip_pool, 0)
  FROM public.clubs c
  WHERE p_club_id IS NULL OR c.id = p_club_id
  ORDER BY 6 DESC;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_chip_circulation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_club_chip_circulation(uuid) TO service_role;

DO $$
DECLARE v_trg int;
BEGIN
  SELECT count(*)::int INTO v_trg FROM pg_trigger
   WHERE tgname = 'trg_log_seat_stack_exit' AND NOT tgisinternal;
  IF v_trg = 0 THEN
    RAISE EXCEPTION 'the seat-exit trigger did not attach';
  END IF;
  PERFORM public.fn_unaccounted_seat_exits();
  PERFORM public.fn_club_chip_circulation();
END $$;
