-- 2026-08-31 - MTT Phase 5: the overload trap, walked into on the same day it
-- was written down.
--
-- 20260831192927 added p_position to fn_award_satellite_seat with CREATE OR
-- REPLACE. That cannot add a parameter: a different argument list is a
-- different function, so it CREATED a second one and left the four-argument
-- form standing. PostgREST resolves an RPC by ARGUMENT NAMES, and the engine
-- passes exactly the four names both overloads accept, so every satellite seat
-- award would have failed with "function is not unique".
--
-- This is the identical trap documented in
-- 20260831133423_every_prize_writes_its_own_evidence.sql for fn_credit_and_log,
-- where the DROP was deliberate. Here it was not, and that note is the only
-- reason it was caught within a minute rather than by a player failing to
-- receive a seat. 13 satellites were live at the time.
--
-- TIER: 3 (money path). ROLLBACK: none wanted. Restoring the four-argument
-- form recreates the ambiguity.

BEGIN;

DROP FUNCTION IF EXISTS public.fn_award_satellite_seat(uuid, uuid, uuid, text);

NOTIFY pgrst, 'reload schema';

COMMIT;
