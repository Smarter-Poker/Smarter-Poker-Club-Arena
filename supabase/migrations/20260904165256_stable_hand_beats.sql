-- OPERATION STABLE HAND - the controller's own heartbeat.
-- Applied to production via Supabase MCP as `stable_hand_beats`.
-- This file is the auditable copy.
--
-- WHY A ROW RATHER THAN A COUNTER. GET /stable-hand answers "what is the floor
-- doing right now" and cannot answer "is it being HELD" - the question that
-- actually matters once a curve is being enforced. It also cannot answer "is
-- the controller running at all", and this estate has already paid for that
-- blind spot once: the Open Claw fleet returned 401 for every job after a
-- secret rotation and nothing noticed, because a job that stops does not fill
-- a log with errors, it stops filling one. Silence is the only observable, so
-- silence is what gets measured.
--
-- One row per host per executor cycle: 2 rows every 30 seconds, ~5,760 a day,
-- pruned to seven days by the writer itself. No scheduled job - see the note
-- on the counters in StableHandTags for why this estate does not add one.
BEGIN;

CREATE TABLE IF NOT EXISTS public.stable_hand_beats (
  id                  bigserial PRIMARY KEY,
  beat_at             timestamptz NOT NULL DEFAULT now(),
  host_id             uuid        NOT NULL,
  chicago_hour        smallint    NOT NULL,
  -- what the floor IS
  eligible_bodies     integer     NOT NULL,
  unique_live         integer     NOT NULL,
  live_seats          integer     NOT NULL,
  tables_open         integer     NOT NULL,
  full_tables         integer     NOT NULL,
  one_open_tables     integer     NOT NULL,
  joinable_tables     integer     NOT NULL,
  humans_waiting      integer     NOT NULL DEFAULT 0,
  -- what the curve WANTS
  target              integer     NOT NULL,
  cap_max             integer     NOT NULL,
  -- what the controller decided, and what it managed to do
  yields_planned      integer     NOT NULL DEFAULT 0,
  yields_executed     integer     NOT NULL DEFAULT 0,
  winddowns_planned   integer     NOT NULL DEFAULT 0,
  winddowns_executed  integer     NOT NULL DEFAULT 0,
  close_pending       integer     NOT NULL DEFAULT 0,
  park_pending        integer     NOT NULL DEFAULT 0,
  alerts              text[]      NOT NULL DEFAULT '{}'::text[],
  CONSTRAINT stable_hand_beats_counts_sane CHECK (
    eligible_bodies >= 0 AND unique_live >= 0 AND live_seats >= 0 AND tables_open >= 0
  )
);

COMMENT ON TABLE public.stable_hand_beats IS
  'One row per host per Stable Hand executor cycle. Answers "is the curve being held" and "is the controller running at all". Pruned to 7 days by the writer.';

CREATE INDEX IF NOT EXISTS stable_hand_beats_at_idx
  ON public.stable_hand_beats (beat_at DESC);
CREATE INDEX IF NOT EXISTS stable_hand_beats_host_at_idx
  ON public.stable_hand_beats (host_id, beat_at DESC);

ALTER TABLE public.stable_hand_beats ENABLE ROW LEVEL SECURITY;
-- service_role only, like the other two Stable Hand tables. No player reads a
-- controller heartbeat.
REVOKE ALL ON public.stable_hand_beats FROM anon, authenticated;

COMMIT;
