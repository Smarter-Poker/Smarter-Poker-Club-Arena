-- 20261017010023_an_unstarted_hand_permit_release_is_a_recovery_event
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 01:00:23 UTC.
--
-- WHAT WAS WRONG
--
-- #6957 (2026-10-15, "a deal attempt that ends without a hand releases its F06
-- permit") made the engine record `unstarted_hand_permit_released` in
-- public.engine_recovery_events whenever a running table's failed deal
-- attempt releases its reserved permit (ServerTableEngineDealing.ts, pinned by
-- server/src/engine/AnUnstartedHandReleasesItsPermit.test.ts). The table's
-- CHECK still allows only the five values set on 2026-08-30
-- (20260830191330), so every one of those rows was refused: 19 SQLSTATE 23514
-- "violates check constraint engine_recovery_events_event_check" in the 24
-- hours to 2026-10-17 00:30 UTC (latest 16:45:39, detail
-- "threw:f06_permit_unproven:permit=unknown"). The engine logs the refusal and
-- carries on, so the recovery itself worked and only its record was lost -
-- the exact silent-alarm shape 20260830191330 was written to end.
--
-- WHAT THIS CHANGES
--
-- The CHECK admits the sixth value. Nothing else. Every reader filters by
-- event (fn_ca_record_break_scorecard counts only watchdog_kill_rebuild;
-- fn_platform_invariants_health counts rows as a health line), so the new
-- rows change no existing count. The constraint is added NOT VALID: the table
-- holds 1.9M rows (486 MB) that all satisfy the old, narrower CHECK, and
-- validating them would hold the ACCESS EXCLUSIVE lock this ALTER takes while
-- the engine is inserting. A NOT VALID CHECK is enforced for every new and
-- updated row exactly as a valid one is.
--
-- @live-proof: (SELECT pg_get_constraintdef(c.oid) LIKE '%''unstarted_hand_permit_released''::text%' AND pg_get_constraintdef(c.oid) LIKE '%''watchdog_kill_rebuild''::text%' FROM pg_constraint c WHERE c.conrelid = 'public.engine_recovery_events'::regclass AND c.conname = 'engine_recovery_events_event_check')

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $preimage$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.engine_recovery_events'::regclass
     AND c.conname = 'engine_recovery_events_event_check';
  IF v_def IS DISTINCT FROM
     'CHECK ((event = ANY (ARRAY[''watchdog_rearm_clock''::text, ''watchdog_forced_action''::text, ''watchdog_kill_rebuild''::text, ''paused_too_long''::text, ''table_closed_under_live_tournament''::text])))'
  THEN
    RAISE EXCEPTION 'RECOVERY_EVENT_CHECK_PREIMAGE: engine_recovery_events_event_check moved: %', v_def;
  END IF;
END
$preimage$;

ALTER TABLE public.engine_recovery_events
  DROP CONSTRAINT engine_recovery_events_event_check;

ALTER TABLE public.engine_recovery_events
  ADD CONSTRAINT engine_recovery_events_event_check
  CHECK (event = ANY (ARRAY[
    'watchdog_rearm_clock'::text,
    'watchdog_forced_action'::text,
    'watchdog_kill_rebuild'::text,
    'paused_too_long'::text,
    'table_closed_under_live_tournament'::text,
    'unstarted_hand_permit_released'::text
  ])) NOT VALID;

DO $postimage$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.engine_recovery_events'::regclass
     AND c.conname = 'engine_recovery_events_event_check';
  IF v_def IS DISTINCT FROM
     'CHECK ((event = ANY (ARRAY[''watchdog_rearm_clock''::text, ''watchdog_forced_action''::text, ''watchdog_kill_rebuild''::text, ''paused_too_long''::text, ''table_closed_under_live_tournament''::text, ''unstarted_hand_permit_released''::text]))) NOT VALID'
  THEN
    RAISE EXCEPTION 'RECOVERY_EVENT_CHECK_POSTIMAGE: unexpected definition %', v_def;
  END IF;
END
$postimage$;

COMMIT;
