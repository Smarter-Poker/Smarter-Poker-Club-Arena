-- The session-aware Stats hand-evidence migration changed the public RPC's
-- argument list. PostgreSQL treats that as a new overload rather than a
-- replacement. The prior door was renamed to a private base implementation,
-- so this exact-name drop is normally a no-op; it is still required as the
-- forward-only guarantee that a partially applied or historically drifted
-- database cannot retain both public signatures and trigger PGRST203.
--
-- This deliberately does not drop ca_player_stats_hand_evidence_base: the
-- single public RPC delegates non-session requests to that private function.
-- @live-proof: to_regprocedure('public.ca_player_stats_hand_evidence(uuid,uuid,text,text,text,numeric,timestamp with time zone,timestamp with time zone,text,boolean,boolean,boolean,boolean,text,boolean,text,timestamp with time zone,uuid,integer)') IS NULL
BEGIN;

DROP FUNCTION IF EXISTS public.ca_player_stats_hand_evidence(
  uuid, uuid, text, text, text, numeric,
  timestamp with time zone, timestamp with time zone,
  text, boolean, boolean, boolean, boolean, text, boolean, text,
  timestamp with time zone, uuid, integer
);

COMMIT;
