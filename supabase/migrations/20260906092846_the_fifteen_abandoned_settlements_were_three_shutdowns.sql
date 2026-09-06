-- THE FIFTEEN ABANDONED SETTLEMENTS WERE THREE SHUTDOWNS.
--
-- The alert board carried fifteen criticals reading
--
--   "Table <id>: settlement for hand #N exceeded 300s; dealing resumed while
--    it ran"
--
-- and every one of them carried waitedMs: 30000.
--
-- THIRTY SECONDS, IN A MESSAGE CLAIMING THREE HUNDRED. The barrier loop in
-- ServerTableEngineDealing is
--
--   while (!settled && waited < maxWaitMs && this.running)
--
-- so at waited = 30000 against a 300000 cap its timeout condition was still
-- TRUE. It had not timed out. It exited on the third condition, `this.running`,
-- which goes false when the engine is stopping - and the branch below the loop
-- reported that as an exceeded deadline because it never asked which condition
-- ended the wait.
--
-- THE DISTRIBUTION SAYS THE SAME THING, which is the check the previous agent's
-- own method note asks for. Fifteen rows are not fifteen events:
--
--   2026-09-05 16:07   5 tables, one second apart, waitedMs 30000/60000/75000
--   2026-09-05 17:50   5 tables, one second, waitedMs 30000
--   2026-09-06 04:10   5 tables, one second, waitedMs 30000
--
-- Five tables cannot independently decide to stall in the same second. One
-- SIGTERM fanned out five ways, three times. The mixed waitedMs at 16:07 is the
-- signature: each table was at a different point in its 15-second slice loop
-- when the shutdown reached it.
--
-- AND UNDERNEATH THE WRONG MESSAGE THERE WAS A REAL HOLE. GameServer.drainHands
-- counted a table as "parked at a hand boundary" the moment its engine stopped:
--
--   return e.isWaitingForHandForHand() || e.isPausedByDesign() || !e.isRunning();
--
-- postHandTasks - the settlement, the rake record, the hand history - is a
-- promise already in flight, and `running` going false does not stop it. So the
-- drain reported a clean stop while money was still being written, and the
-- process exited on top of it. At :55. Every hour. Postgres protects the
-- settlement transaction's own atomicity; what it cannot protect is the rest of
-- postHandTasks after that commit, which is where fn_rake_repair_unbanked and
-- the board_not_recorded warnings have been finding their work.
--
-- Both are fixed in the same branch as this migration:
--   - the barrier distinguishes shutdown from abandonment, and the critical now
--     interpolates the time actually waited instead of the cap;
--   - drainHands refuses to call a table parked while hasSettlementInFlight(),
--     which is cleared by the promise rather than by the next hand, so a table
--     that stops between hands does not hold the 18s drain budget open;
--   - server/src/engine/TheDrainWaitsForTheMoney.law.test.ts pins both.
--
-- These fifteen are closed as MISREPORTED, not as fixed money: no chips moved
-- and none are owed. The thirty rows below are fifteen events - the drift
-- pipeline files a `drift_incident:financial_alerts:<source>` wrapper beside
-- each native alert, which is its own defect and Phase 2's to close.

BEGIN;

DO $do$
DECLARE
  v_native int;
  v_wrapped int;
BEGIN
  UPDATE financial_alerts
     SET resolved = true,
         resolved_at = now(),
         resolution =
           'MISREPORTED, not money. Closed 2026-09-06 with the engine fix in '
           || 'TheDrainWaitsForTheMoney.law.test.ts. The barrier loop exited on '
           || '!this.running (engine stopping), not on its 300s cap - every row '
           || 'carries waitedMs 30000 against a 300000 cap, and the fifteen rows '
           || 'are three shutdowns of five tables each, one second apart. No '
           || 'settlement was abandoned by a slow database and no chips moved. '
           || 'The real defect these hid - drainHands counting a stopped engine '
           || 'as drained while postHandTasks was still writing - is fixed in '
           || 'the same branch.'
   WHERE NOT resolved
     AND source = 'ServerTableEngine.settlement_barrier_abandoned';
  GET DIAGNOSTICS v_native = ROW_COUNT;

  UPDATE financial_alerts
     SET resolved = true,
         resolved_at = now(),
         resolution =
           'Duplicate filing of the native '
           || 'ServerTableEngine.settlement_barrier_abandoned alert, closed with '
           || 'it. The drift pipeline wraps a financial_alerts row back into '
           || 'financial_alerts, so each of these events is on the board twice. '
           || 'That double-filing is a defect in its own right and is Phase 2.'
   WHERE NOT resolved
     AND source = 'drift_incident:financial_alerts:ServerTableEngine.settlement_barrier_abandoned';
  GET DIAGNOSTICS v_wrapped = ROW_COUNT;

  IF v_native <> 15 THEN
    RAISE EXCEPTION
      'expected 15 native settlement_barrier_abandoned alerts, closed % - the board moved under this migration, re-read it before re-running',
      v_native;
  END IF;
  IF v_wrapped <> 15 THEN
    RAISE EXCEPTION
      'expected 15 wrapper alerts, closed % - the board moved under this migration',
      v_wrapped;
  END IF;

  RAISE NOTICE 'CLOSED_MISREPORTED native=% wrapper=%', v_native, v_wrapped;
END $do$;

COMMIT;
