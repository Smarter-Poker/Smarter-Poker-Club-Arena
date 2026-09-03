-- ═══════════════════════════════════════════════════════════════════════════
-- THE SEAT-EXIT DETECTOR WAS CRYING WOLF, AND THE LOG COULD NOT STORE IT
-- ───────────────────────────────────────────────────────────────────────────
-- APPLIED TO PRODUCTION 2026-08-25 as migrations
--   the_nightly_run_records_chip_circulation
--   seat_exit_detector_ignores_tournament_stacks
--
-- Three defects in what shipped forty minutes earlier, every one of them found
-- by running the nightly job against REAL TRAFFIC instead of against an empty
-- table. The original verification ran when there were no exits to report, so
-- the new INSERT never executed. A check that passes because its subject is
-- absent has proved nothing.
--
-- 1. TOURNAMENT STACKS ARE NOT WALLET CHIPS. The trigger logged every seat exit
--    on every table. In its first forty minutes that was 1,980 tournament exits
--    carrying 11.2 MILLION chips -- every elimination and hand-off in every
--    running event. A tournament stack is play money inside the event: the
--    buy-in went to the prize pool and the stack credits no wallet when the
--    seat ends, so it CANNOT be the thing this detector exists to catch.
--    Filing those as critical would have buried the one real signal under
--    thousands of false ones every night -- precisely the "cries wolf, and a
--    reconciler nobody believes is worse than none" failure the original
--    migration's own header warned about.
--
--    Measured over the same window the CASH side is clean: 769 'deleted' and
--    530 'left' exits, 473,901 chips, and EVERY ONE has a matching wallet
--    credit. Zero unaccounted. The cash path is healthy and the detector
--    agrees with it.
--
-- 2. THE LOG REFUSED THE ROW. `ledger_reconcile_log.entity_type` carries a
--    CHECK constraint allowing only player_wallet / club_treasury /
--    agent_wallet. Both new row kinds are added to it here.
--
-- 3. fn_club_chip_circulation WAS DEAD CODE -- added to print the two pools
--    reconciliation never looked at, then called by nothing. It gets the
--    caller it should have had: one row per club per night at severity 'ok'.
--    These are OBSERVATIONS, never findings. The seat-exit check catches a
--    stack that vanishes in ONE event; it cannot see a slow leak of a few
--    chips a day. A nightly circulation figure is a trend line, and a trend is
--    the only way a slow leak is ever visible.
--
-- VERIFIED after applying, against production:
--   reconcile_ledger_nightly()  -> 588 checked, ran end to end, no constraint
--                                  violation
--   chip_circulation rows       -> 3, severity 'ok', 122,196,919.97 chips
--   seat_stack_exit rows        -> 0, and proved to be a REAL zero:
--                                  1,307 cash exits watched,
--                                  fn_unaccounted_seat_exits('7 days','0 min')
--                                  returns 0 with the grace window removed.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. THE TRIGGER STOPS WATCHING TOURNAMENT TABLES ────────────────────────
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

  -- CASH ONLY. A tournament stack is play money inside the event -- it credits
  -- no wallet when the seat ends, so it cannot be lost in the sense this table
  -- exists to detect. Filtering HERE rather than in the report keeps ~2,000
  -- meaningless rows an hour out of the audit trail entirely.
  IF EXISTS (SELECT 1 FROM public.tables t
              WHERE t.id = OLD.table_id AND t.tournament_id IS NOT NULL) THEN
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

-- Belt and braces: the REPORT excludes them too, so a row already in the table
-- (or one written by some future path) still cannot raise a false alarm.
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
      SELECT 1 FROM public.tables t
       WHERE t.id = e.table_id AND t.tournament_id IS NOT NULL
    )
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

-- Clear the tournament noise already collected. These are not findings and
-- never were; keeping them would leave the table looking alarming for a week.
DELETE FROM public.ca_seat_stack_exits e
 USING public.tables t
 WHERE t.id = e.table_id AND t.tournament_id IS NOT NULL;

-- ── 2. THE LOG ACCEPTS THE TWO NEW ROW KINDS ───────────────────────────────
ALTER TABLE public.ledger_reconcile_log
  DROP CONSTRAINT IF EXISTS ledger_reconcile_log_entity_type_check;
ALTER TABLE public.ledger_reconcile_log
  ADD CONSTRAINT ledger_reconcile_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'player_wallet'::text,
    'club_treasury'::text,
    'agent_wallet'::text,
    -- 2026-08-25: a cash stack that left a seat and landed nowhere.
    'seat_stack_exit'::text,
    -- 2026-08-25: nightly observation of where a club's chips are.
    'chip_circulation'::text
  ]));

-- ── 3. THE DEAD DIAGNOSTIC GETS ITS CALLER ─────────────────────────────────
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
  IF position('chip_circulation' in v_def) > 0 THEN
    RAISE NOTICE 'the nightly run already records circulation';
    RETURN;
  END IF;
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly is not the shape this patch expects';
  END IF;

  EXECUTE replace(v_def, v_anchor,
    E'  -- ── Where the chips actually are (added 2026-08-25) ─────────────────\n'
    || E'  -- OBSERVATIONS, not findings: severity ''ok'' always. The seat-exit\n'
    || E'  -- check above catches a stack that vanishes in one event; this is the\n'
    || E'  -- trend line that makes a SLOW leak visible.\n'
    || E'  INSERT INTO public.ledger_reconcile_log\n'
    || E'    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)\n'
    || E'  SELECT ''chip_circulation'', c.club_id, c.on_the_felt, c.total, ''ok'',\n'
    || E'         jsonb_build_object(\n'
    || E'           ''source'', ''fn_club_chip_circulation'',\n'
    || E'           ''club_name'', c.club_name,\n'
    || E'           ''member_wallets'', c.member_wallets,\n'
    || E'           ''on_the_felt'', c.on_the_felt,\n'
    || E'           ''treasury'', c.treasury)\n'
    || E'  FROM public.fn_club_chip_circulation() c\n'
    || E'  WHERE c.total <> 0;\n\n'
    || v_anchor);
END $$;

DO $$
DECLARE v_trig text; v_rep text; v_nightly text; v_tourn int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_trig FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_log_seat_stack_exit';
  SELECT pg_get_functiondef(p.oid) INTO v_rep FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_unaccounted_seat_exits';
  SELECT pg_get_functiondef(p.oid) INTO v_nightly FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly';

  IF position('tournament_id IS NOT NULL' in v_trig) = 0 THEN
    RAISE EXCEPTION 'the trigger still watches tournament tables';
  END IF;
  IF position('tournament_id IS NOT NULL' in v_rep) = 0 THEN
    RAISE EXCEPTION 'the report still counts tournament stacks';
  END IF;
  IF position('fn_club_chip_circulation' in v_nightly) = 0 THEN
    RAISE EXCEPTION 'the circulation record did not reach the nightly run';
  END IF;
  IF position('seat_stack_exit' in v_nightly) = 0
     OR position('player_wallet' in v_nightly) = 0
     OR position('club_treasury' in v_nightly) = 0 THEN
    RAISE EXCEPTION 'an existing reconciliation was dropped by this patch';
  END IF;

  SELECT count(*)::int INTO v_tourn
    FROM public.ca_seat_stack_exits e JOIN public.tables t ON t.id = e.table_id
   WHERE t.tournament_id IS NOT NULL;
  IF v_tourn > 0 THEN
    RAISE EXCEPTION 'tournament noise was not cleared: % rows remain', v_tourn;
  END IF;
END $$;
