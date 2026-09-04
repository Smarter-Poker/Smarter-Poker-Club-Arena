-- ═══════════════════════════════════════════════════════════════════════════
-- HOW TO PROBE A MONEY RPC WITHOUT SPENDING ANYTHING
-- ───────────────────────────────────────────────────────────────────────────
-- Written after an agent verified the no-rathole rule on 2026-08-25 by calling
-- atomic_table_buyin against PRODUCTION. Two buy-ins succeeded, the probe's
-- cleanup deleted the seat rows directly instead of leaving through
-- fn_leave_seat_and_refund, and 48 chips left a wallet and landed nowhere.
--
-- The rule that follows from it:
--
--   NEVER call a function that moves money outside a transaction you roll
--   back. Not "carefully". Not "on a test table". Rolled back.
--
-- Everything an agent actually wants from such a probe is the ERROR MESSAGE —
-- did the new guard fire, and did it fire for the right reason. That survives
-- a rollback perfectly well. The side effects are the part nobody wants.
--
-- READ THE NEXT SECTION BEFORE YOU COPY ANYTHING BELOW IT. Which tool you are
-- holding decides which of the two patterns is the safe one, and the wrong
-- pairing commits your probe while printing exactly what success looks like.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- 0. A TRANSACTION DOES NOT SPAN TWO MCP CALLS. THIS IS THE WHOLE TRAP.
-- ───────────────────────────────────────────────────────────────────────────
-- Until 2026-09-04 the header of this file offered psql and the Supabase MCP
-- as interchangeable ways to run the multi-statement pattern below. (The exact
-- retired sentence is not repeated here, because this file is pinned by
-- tests/a-rolled-back-probe-must-actually-roll-back.law.test.ts and quoting it
-- would trip that law; git history has it.) It was wrong in the most expensive
-- direction: it told agents a pattern was safe over a transport where it
-- silently is not. An agent following it committed a horse_job_runs row for a
-- run that never happened, and only noticed because the row said 123 hands in
-- 9ms.
--
-- MEASURED on production 2026-09-04, two consecutive Supabase MCP calls:
--
--   call 1:  begin; select pg_current_xact_id();     -> 275731009
--   call 2:  select pg_current_xact_id(),
--                   txid_status(275731009);          -> 275731249, 'aborted'
--
-- Two different transaction ids, and the first one ABORTED at the end of its
-- own call. So:
--
--   * ONE CALL IS ONE TRANSACTION. The call boundary ends it either way.
--   * A trailing BEGIN does not hold the session open for the next call.
--   * Therefore BEGIN in call 1, the probe in call 2, ROLLBACK in call 3
--     leaves the PROBE ALONE IN THE MIDDLE AS ITS OWN COMMITTED TRANSACTION.
--     The ROLLBACK in call 3 rolls back nothing. It returns success.
--
-- `Prefer: tx=rollback` does not rescue this either. PostgREST honours it only
-- when the server is configured with db-tx-end = rollback-allowed, and this
-- one is not, so the header is accepted and ignored.
--
-- The rule, then:
--
--   psql            -> section 1 (BEGIN ... ROLLBACK across statements)
--   Supabase MCP    -> section 2 (ONE call, one self-aborting DO block)
--
-- Never section 1 over MCP. If you cannot tell which you are holding, you are
-- holding the MCP, because that is what a scheduled agent gets.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. THE psql PATTERN. Requires a real session. Not for the MCP.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Anything the probe needs to exist. Fixtures are fine here; they vanish.
-- INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, left_at)
--      VALUES (:table_id, 9, :user_id, 999999, 'left', now());

DO $probe$
DECLARE
  v_msg text;
BEGIN
  BEGIN
    PERFORM public.atomic_table_buyin(
      :'user_id'::uuid, :'table_id'::uuid, :seat::int, :amount::numeric, false, NULL
    );
    RAISE NOTICE 'ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    RAISE NOTICE 'REFUSED: %', v_msg;
  END;
END
$probe$;

-- THE POINT. Never COMMIT. The notices above are already printed.
ROLLBACK;

-- ── If you need the answer as a RESULT ROW rather than a notice ────────────
-- Wrap the same body in a function, call it inside the transaction, and roll
-- back: the function definition disappears with everything else.
--
--   BEGIN;
--   CREATE FUNCTION pg_temp.probe(...) RETURNS text ... ;
--   SELECT pg_temp.probe(...);
--   ROLLBACK;
--
-- pg_temp is better than a public zz_* helper for exactly this reason — the
-- 2026-08-25 incident also left three throwaway public functions behind that
-- had to be dropped by a second migration.


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. THE SUPABASE MCP PATTERN. ONE CALL. THE BLOCK ABORTS ITSELF.
-- ───────────────────────────────────────────────────────────────────────────
-- Section 0 established that one MCP call is one transaction. Turn that from
-- a hazard into the safety mechanism: put the fixtures, the call and the
-- reporting inside a SINGLE DO block, and end the block by RAISING. The raise
-- aborts the one transaction the call has, which undoes the fixtures and the
-- RPC's writes together, and the message comes back to you as the call's
-- error text. There is no second call in which anything can be left behind.
--
-- Send EXACTLY this, as one execute_sql. Do not add BEGIN. Do not add
-- ROLLBACK. Do not split it.
-- ═══════════════════════════════════════════════════════════════════════════

DO $mcp_probe$
DECLARE
  v_msg    text;
  v_result text;
BEGIN
  -- Fixtures, if the probe needs any. They vanish with the abort below.
  -- INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, left_at)
  --      VALUES ('<table_id>'::uuid, 9, '<user_id>'::uuid, 999999, 'left', now());

  BEGIN
    PERFORM public.atomic_table_buyin(
      '<user_id>'::uuid, '<table_id>'::uuid, 9::int, 40::numeric, false, NULL
    );
    v_result := 'ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    v_result := 'REFUSED: ' || v_msg;
  END;

  -- THE POINT. This raise is what rolls the call back. It must be OUTSIDE the
  -- EXCEPTION block above, or that handler swallows it and the call COMMITS.
  RAISE EXCEPTION 'PROBE RESULT (nothing was kept): %', v_result;
END
$mcp_probe$;

-- What you get back is an MCP error whose message is your result.
-- AN ERROR IS THE SUCCESS CASE HERE.
-- If the call returns success instead, your probe COMMITTED - the raise did
-- not run, or something swallowed it. Treat that as an incident: go and look
-- at what the RPC wrote, and undo it deliberately.
--
-- Two things this pattern cannot roll back, because nothing can:
--
--   * a sequence or identity value the probe consumed (nextval is exempt from
--     rollback by design). Harmless for a probe, but do not read a gap in a
--     sequence as evidence that something committed;
--   * anything the RPC does outside the transaction — dblink, pg_net, an
--     http call, a NOTIFY that a listener already acted on. If the function
--     you are probing reaches off the database, section 2 does not contain it
--     and you need a real staging target instead.
