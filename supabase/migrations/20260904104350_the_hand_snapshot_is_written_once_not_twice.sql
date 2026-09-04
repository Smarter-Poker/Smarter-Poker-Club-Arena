-- ═══════════════════════════════════════════════════════════════════════════
--  THE HAND SNAPSHOT IS WRITTEN ONCE, NOT TWICE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (measured 2026-09-04)
--
-- `hand_state_snapshots` is the largest table on the instance (7,357 MB) and
-- the largest single producer of WAL. In one stats window it took
--
--     1,209,476 inserts      2,419,902 updates      297,279 deletes
--
-- Two updates per insert. Neither of them is action churn, and neither is an
-- upsert landing on an existing row. From pg_stat_statements:
--
--     save_hand_state_snapshot   (the upsert)             1,210,799 calls
--     UPDATE ... pending_deadlines, disconnect_states     1,210,782 calls
--     complete_hand_snapshot     (settlement)             1,209,663 calls
--
-- 1,210,782 + 1,209,663 = 2,420,445. The arithmetic closes exactly. The upsert
-- is effectively insert-only: of 1,210,799 calls only ~1,300 took the DO UPDATE
-- branch, because settlement flips is_complete before the next hand begins.
--
-- THE FIRST OF THOSE TWO UPDATES IS PURE WASTE. `saveSnapshot()` in
-- ServerTableEngineBase inserts the row and then, four lines later in the same
-- function body, issues a second statement against the row it has just
-- inserted, to fill in two columns it already had in hand.
--
-- Postgres does not care that the second statement names only two columns. MVCC
-- writes a whole new ~1.7 KB heap tuple either way, and only 16.5% of these
-- updates are HOT, so ~83% also write new entries in all three indexes. That is
-- roughly 1.2 million unnecessary row versions per window.
--
-- WHAT THIS DOES
--
-- Folds the second statement into the first: `save_hand_state_snapshot` now
-- accepts the deadlines and the disconnect states and writes them in the same
-- INSERT. The row that lands is BYTE-IDENTICAL to the row that lands today.
--
-- WHY IT IS SAFE, SPECIFICALLY
--
--   * The resulting row is the same. Same columns, same values, one statement
--     instead of two.
--   * The only reader of these two columns is getActiveHandSnapshotFull, called
--     at engine start for crash recovery (~48k calls). Today it can observe the
--     row in the microseconds between the INSERT and the UPDATE and read the
--     empty defaults; after this it cannot. It strictly gains information.
--   * TournamentManager.waitForHandComplete reads only `id` where
--     is_complete = false. Untouched.
--   * A snapshot cannot rebuild a hand in flight and is not meant to.
--     checkCrashRecovery restores the disconnect FSM and then ABANDONS the hand
--     (ServerTableEngineBase.ts:4138 calls completeHandSnapshot), the deck is
--     stripped before the row is written, and RestartFidelity.test.ts pins that
--     as deliberate. Hands in flight are protected by GameServer.drainHands(),
--     which parks every table at a hand boundary - not by this table.
--   * No test anywhere asserts that these are two separate statements.
--
-- DEPLOY ORDER IS HANDLED. The two new parameters are DEFAULTed, and the body
-- COALESCEs them to the column defaults ('[]' and '{}'). So the CURRENT engine,
-- which passes seven arguments and then issues its own UPDATE, keeps working
-- unchanged against this function - it writes the empty defaults and then fills
-- them in exactly as it does today. The saving arrives when the engine ships at
-- the next :55 break. Neither order breaks.
--
-- The old seven-argument signature is DROPPED rather than left in place,
-- because CREATE OR REPLACE with a different argument list creates an OVERLOAD,
-- and PostgREST refuses an ambiguous overload with
-- "Could not choose the best candidate function". Both statements are in one
-- transaction. A snapshot write that lands in the gap is caught, warned and
-- discarded by the caller (snapshots.ts) and cannot fail a hand.
--
-- ROLLBACK
--
--   DROP FUNCTION public.save_hand_state_snapshot(uuid,integer,jsonb,jsonb,integer,jsonb,text,jsonb,jsonb);
--   -- then re-create the seven-argument version from
--   -- supabase/migrations/20260719_hand_state_snapshots_rls.sql
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.save_hand_state_snapshot(
  uuid, integer, jsonb, jsonb, integer, jsonb, text
);

CREATE OR REPLACE FUNCTION public.save_hand_state_snapshot(
  p_table_id          uuid,
  p_hand_number       integer,
  p_state_json        jsonb,
  p_config_json       jsonb,
  p_dealer_seat       integer,
  p_players_json      jsonb,
  p_stage             text,
  p_pending_deadlines jsonb DEFAULT NULL,
  p_disconnect_states jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO hand_state_snapshots (
    table_id, hand_number, state_json, config_json, dealer_seat, players_json,
    stage, pending_deadlines, disconnect_states, updated_at
  ) VALUES (
    p_table_id, p_hand_number, p_state_json, p_config_json, p_dealer_seat,
    p_players_json, p_stage,
    COALESCE(p_pending_deadlines, '[]'::jsonb),
    COALESCE(p_disconnect_states, '{}'::jsonb),
    NOW()
  )
  ON CONFLICT (table_id) WHERE is_complete = FALSE
  DO UPDATE SET
    hand_number       = EXCLUDED.hand_number,
    state_json        = EXCLUDED.state_json,
    config_json       = EXCLUDED.config_json,
    dealer_seat       = EXCLUDED.dealer_seat,
    players_json      = EXCLUDED.players_json,
    stage             = EXCLUDED.stage,
    pending_deadlines = EXCLUDED.pending_deadlines,
    disconnect_states = EXCLUDED.disconnect_states,
    updated_at        = NOW();
END;
$function$;

COMMENT ON FUNCTION public.save_hand_state_snapshot(
  uuid, integer, jsonb, jsonb, integer, jsonb, text, jsonb, jsonb
) IS
  'Writes the one live snapshot row for a table. The two trailing arguments were folded in on 2026-09-04: the engine used to INSERT and then immediately UPDATE the row it had just inserted, which cost ~1.2M extra row versions per stats window on the largest table in the database. They default to NULL so an engine that has not shipped yet keeps working unchanged.';

REVOKE ALL ON FUNCTION public.save_hand_state_snapshot(
  uuid, integer, jsonb, jsonb, integer, jsonb, text, jsonb, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_hand_state_snapshot(
  uuid, integer, jsonb, jsonb, integer, jsonb, text, jsonb, jsonb
) FROM anon;
REVOKE ALL ON FUNCTION public.save_hand_state_snapshot(
  uuid, integer, jsonb, jsonb, integer, jsonb, text, jsonb, jsonb
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.save_hand_state_snapshot(
  uuid, integer, jsonb, jsonb, integer, jsonb, text, jsonb, jsonb
) TO service_role;

DO $$
DECLARE
  v_overloads int;
BEGIN
  SELECT count(*) INTO v_overloads
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'save_hand_state_snapshot';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION
      'post-condition failed: % overloads of save_hand_state_snapshot exist. PostgREST refuses an ambiguous overload, which would stop every snapshot write on the platform.',
      v_overloads;
  END IF;
END $$;
