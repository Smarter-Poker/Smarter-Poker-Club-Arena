-- 2026-09-01. The seat-exit alarm could see a stack leave the felt with no
-- wallet credit. It could not put it back.
--
-- At 11:00:37 UTC a single pooler session vacated 12 live cash seats across two
-- Deep Stack Society tables in one statement, 1,216.54 chips, three minutes
-- before the same operator deleted all 416 club_members rows for that club (see
-- 20260901110603_deep_stack_society_cannot_be_deleted_by_accident). The members
-- were restored. The chips on the felt were not, because vacating a seat by
-- setting left_at credits nobody, and every previous repair of this exact shape
-- was hand-written as its own one-off migration.
--
-- fn_repay_unaccounted_seat_exits is that repair written once. It pays exactly
-- what fn_unaccounted_seat_exits still reports at the instant it runs, so a
-- stack some other process has already returned is never paid twice, and a
-- second run over a clean sweep is a no-op. Each payment writes the
-- "Correction: seat exit <id>" wallet row that the alarm reads as settled, so
-- the detector and the repair agree by construction rather than by convention.
--
-- It is deliberately NOT scheduled. An alarm that quietly repays itself is an
-- alarm nobody reads, and a leak that funds itself back is a leak nobody finds.
-- Detection stays loud. The repair stays a decision.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5): nothing below reads is_horse. A horse
-- whose stack was destroyed is repaid on exactly the same terms as a human.

CREATE OR REPLACE FUNCTION public.fn_repay_unaccounted_seat_exits(
  p_since     interval DEFAULT '2 days'::interval,
  p_max_total numeric  DEFAULT 25000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  r         record;
  v_balance numeric;
  v_paid    numeric := 0;
  v_repaid  int     := 0;
  v_skipped int     := 0;
  v_ids     bigint[] := '{}';
BEGIN
  IF p_max_total IS NULL OR p_max_total <= 0 THEN
    RAISE EXCEPTION 'fn_repay_unaccounted_seat_exits: p_max_total must be positive';
  END IF;

  -- The chips are coming back off the felt, which is exactly where they went.
  -- Without this the ledger trigger would invent a counterparty.
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_category', 'correction', true);

  FOR r IN
    SELECT e.exit_id, e.user_id, e.table_id, e.club_id, e.stack, e.occurred_at
      FROM public.fn_unaccounted_seat_exits(p_since) e
     WHERE e.stack > 0
     ORDER BY e.occurred_at
  LOOP
    -- A cap, not a filter: the caller states the most money this run may move,
    -- and the run stops rather than silently paying out an unbounded sweep.
    IF v_paid + r.stack > p_max_total THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    UPDATE public.club_members
       SET chip_balance = chip_balance + r.stack
     WHERE club_id = r.club_id
       AND user_id = r.user_id
    RETURNING chip_balance INTO v_balance;

    IF NOT FOUND THEN
      -- The membership is gone. Paying a wallet that does not exist would
      -- mint chips into nothing, so this one stays visible in the alarm.
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.wallet_transactions
      (user_id, wallet_type, amount, type, category, description, table_id, balance_after)
    VALUES
      (r.user_id, 'PLAYER', r.stack, 'credit', 'cashout',
       'Correction: seat exit ' || r.exit_id
         || ' - stack left the felt with no cash-out',
       r.table_id, v_balance);

    v_paid   := v_paid + r.stack;
    v_repaid := v_repaid + 1;
    v_ids    := v_ids || r.exit_id;
  END LOOP;

  RETURN jsonb_build_object(
    'repaid',   v_repaid,
    'chips',    round(v_paid, 2),
    'skipped',  v_skipped,
    'exit_ids', to_jsonb(v_ids)
  );
END;
$fn$;

-- CREATE OR REPLACE does not reset a live ACL, so this REVOKE is restated in
-- the file itself. check-definer-authorization.mjs models grants from the file
-- alone and is right to: a definer function reachable by anon is a grenade.
REVOKE ALL ON FUNCTION public.fn_repay_unaccounted_seat_exits(interval, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_repay_unaccounted_seat_exits(interval, numeric)
  TO service_role;

COMMENT ON FUNCTION public.fn_repay_unaccounted_seat_exits(interval, numeric) IS
  'Returns stacks that left the felt with no wallet credit, reading fn_unaccounted_seat_exits live so nothing is paid twice. Not scheduled on purpose.';


-- Second half of the same problem. ca_ledger_write_failures is append-only, so
-- once a swallowed journal row is compensated the row still sits there and the
-- raw count only ever climbs. Failure 6 was compensated at 00:42:51 UTC by
-- fn_ca_repair_write_failure, which keys its entry 'correction:lwf:<id>', and
-- the health check still read 1. A number that can never return to zero stops
-- being read. This asks the question the count was trying to ask.

CREATE OR REPLACE FUNCTION public.fn_ca_unresolved_write_failures()
RETURNS TABLE(
  id          bigint,
  occurred_at timestamptz,
  club_id     uuid,
  user_id     uuid,
  delta       numeric,
  sql_state   text,
  message     text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT f.id, f.occurred_at, f.club_id, f.user_id, f.delta, f.sqlstate, f.message
    FROM public.ca_ledger_write_failures f
   WHERE NOT EXISTS (
           SELECT 1
             FROM public.chip_ledger l
            WHERE l.idempotency_key = 'correction:lwf:' || f.id
         )
   ORDER BY f.occurred_at DESC;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_unresolved_write_failures()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_unresolved_write_failures()
  TO service_role;

COMMENT ON FUNCTION public.fn_ca_unresolved_write_failures() IS
  'Swallowed ledger writes with no compensating correction:lwf:<id> entry. The number that can return to zero.';
