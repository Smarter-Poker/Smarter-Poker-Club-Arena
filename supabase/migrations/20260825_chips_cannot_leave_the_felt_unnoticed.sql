-- ═══════════════════════════════════════════════════════════════════════════
-- CHIPS CANNOT LEAVE THE FELT UNNOTICED
-- ───────────────────────────────────────────────────────────────────────────
-- APPLIED TO PRODUCTION 2026-08-25 as migrations
--   chips_cannot_leave_the_felt_unnoticed
--   the_nightly_run_reports_unaccounted_seat_exits   (the reporting half)
--
-- On 2026-08-25 an agent probing atomic_table_buyin against production created
-- seats and then DELETED the rows to clean up, skipping atomicCashout. 48
-- chips stopped existing. NOTHING NOTICED. They were found only because the
-- agent went looking for them.
--
-- That is not a story about one careless cleanup. It is a gap:
-- reconcile_ledger_nightly compares chip_ledger against `wallets` and against
-- `clubs.chip_pool`, and Club Arena's money is in NEITHER of those places. It
-- lives in `club_members.chip_balance` (the club wallet every buy-in debits)
-- and in `table_seats.stack` (chips on the felt -- 1,139,873 of them platform
-- wide as this was written). Both pools were completely unreconciled, so chips
-- could be created or destroyed there in total silence.
--
-- WHY A DETECTOR AND NOT A CONSERVATION SUM. The obvious check -- "total chips
-- should only change by issuance minus redemption" -- needs every leak term to
-- be right: rake, BBJ contributions and payouts, tournament prize pools,
-- promotions. Get one wrong and it cries wolf every night, and a reconciler
-- nobody believes is worse than none. So this watches the one EVENT that can
-- destroy chips instead: a seat losing its stack without the stack going
-- anywhere.
--
-- THE TRIGGER NEVER BLOCKS. A guard that can refuse a seat exit is a guard
-- that can strand a player mid-hand, and the failure being fixed here is a
-- silent one, not an urgent one. It appends and gets out of the way.
--
-- VERIFIED against production inside a rolled-back transaction (CLAUDE.md 11.5)
-- by reproducing the exact mistake:
--   a 48-chip seat DELETEd outright        -> logged, and reported unaccounted
--   a normal departure carrying 77 chips   -> logged (so a cash-out that fails
--                                             to credit is visible too)
--   an EMPTY seat leaving                  -> not logged, because a log full of
--                                             noise is a log nobody reads
--   fn_club_chip_circulation for that club -> wallets 48,812,140.51
--                                             + felt 640,200.26 + treasury 0
-- ═══════════════════════════════════════════════════════════════════════════

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

-- ── AND IT REPORTS ITSELF ──────────────────────────────────────────────────
-- A detector nobody runs is a detector that does not exist.
-- reconcile_ledger_nightly already writes into ledger_reconcile_log and is
-- already read by whoever reads that table, so the seat-exit check reports
-- THERE rather than in a new place with a new audience of nobody.
--
-- One row per unaccounted exit, at 'critical': chips that stopped existing is
-- not a rounding warning. `ledger_balance` carries the stack that vanished and
-- `stored_balance` is 0 -- the ledger says these chips were on the felt and
-- nothing says where they went.
DO $$
DECLARE
  v_def text;
  v_anchor CONSTANT text := '  -- Recompute the summary counts from what we just inserted today';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reconcile_ledger_nightly';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly does not exist - refusing to guess';
  END IF;
  IF position('seat_stack_exit' in v_def) > 0 THEN
    RAISE NOTICE 'the nightly run already reports seat exits';
    RETURN;
  END IF;
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly is not the shape this patch expects';
  END IF;

  EXECUTE replace(v_def, v_anchor,
    E'  -- ── Chips that left the felt and landed nowhere (added 2026-08-25) ──\n'
    || E'  -- The two pools above are chip_ledger vs `wallets` and vs\n'
    || E'  -- `clubs.chip_pool`. Club Arena''s money is in NEITHER: it is in\n'
    || E'  -- club_members.chip_balance and table_seats.stack. Both were wholly\n'
    || E'  -- unreconciled, which is how 48 chips were destroyed on 2026-08-25\n'
    || E'  -- with nothing noticing. See fn_unaccounted_seat_exits.\n'
    || E'  INSERT INTO public.ledger_reconcile_log\n'
    || E'    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)\n'
    || E'  SELECT ''seat_stack_exit'', x.user_id, x.stack, 0, ''critical'',\n'
    || E'         jsonb_build_object(\n'
    || E'           ''source'', ''fn_unaccounted_seat_exits'',\n'
    || E'           ''exit_id'', x.exit_id, ''table_id'', x.table_id,\n'
    || E'           ''club_id'', x.club_id, ''exit_kind'', x.exit_kind,\n'
    || E'           ''db_role'', x.db_role, ''app_name'', x.app_name,\n'
    || E'           ''occurred_at'', x.occurred_at)\n'
    || E'  FROM public.fn_unaccounted_seat_exits(''1 day''::interval) x;\n\n'
    || v_anchor);
END $$;

DO $$
DECLARE v_trg int; v_def text;
BEGIN
  SELECT count(*)::int INTO v_trg FROM pg_trigger
   WHERE tgname = 'trg_log_seat_stack_exit' AND NOT tgisinternal;
  IF v_trg = 0 THEN
    RAISE EXCEPTION 'the seat-exit trigger did not attach';
  END IF;
  PERFORM public.fn_unaccounted_seat_exits();
  PERFORM public.fn_club_chip_circulation();

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly';
  IF position('seat_stack_exit' in v_def) = 0 THEN
    RAISE EXCEPTION 'the seat-exit check did not reach the nightly run';
  END IF;
  IF position('player_wallet' in v_def) = 0 OR position('club_treasury' in v_def) = 0 THEN
    RAISE EXCEPTION 'an existing reconciliation was dropped by this patch';
  END IF;
END $$;
