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
-- USE IT LIKE THIS (psql, or the Supabase MCP one statement at a time):
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
