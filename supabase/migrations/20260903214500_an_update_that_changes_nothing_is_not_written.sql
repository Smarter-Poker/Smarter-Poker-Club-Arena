-- ═══════════════════════════════════════════════════════════════════════════
-- AN UPDATE THAT CHANGES NOTHING IS NOT WRITTEN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-03: "REAL TIME CONNECTION TO THE CLUB ARENA LOBBY IS BROKEN."
--
-- MEASURED, not guessed. Supabase Realtime's replication slot was falling
-- behind at roughly 20 MB every 18 seconds (435 -> 456 -> 476 -> 694 -> 879 MB
-- between 21:28 and 21:34 UTC). The reason, measured over a 25-second window:
--
--     WAL generated      1,638 kB/s
--     Realtime consumed    517 kB/s
--
-- The database produces about three times more write-ahead log than Realtime
-- can decode, so postgres_changes events arrive minutes late or not at all.
-- That is a capacity problem and this migration does not pretend to solve it -
-- see the note at the bottom for what actually will.
--
-- What it DOES fix is the part that is pure waste. An UPDATE that sets a row
-- to the values it already holds still writes a new row version, still costs
-- WAL, and still becomes a postgres_changes event - and a subscriber learns
-- NOTHING from it, because nothing changed. The engine writes
-- table_seats.time_bank_remaining unconditionally on a timer, which is exactly
-- this shape. Measured live after applying: 3,687 such updates suppressed in
-- 452 seconds, about 8 per second that will never again reach WAL, Realtime,
-- or any subscriber.
--
-- WHY THIS IS SAFE. Cancelling a no-op update cannot lose data: by definition
-- the row already holds the values being written. No subscriber can miss an
-- event, because an event carrying no change carries no information. The
-- trigger name sorts first on purpose - triggers fire in alphabetical order,
-- and this must compare the INCOMING row before any sibling BEFORE trigger
-- stamps a timestamp onto it and makes a no-op look like a change.
--
-- DELIBERATELY table_seats ONLY. `tables` carries tables_updated_at, which
-- stamps updated_at on every write; suppressing those would also stop that
-- heartbeat, and anything using it to judge a table live would be misled.
-- That needs its own look, not a blanket rollout.
--
-- ROLLBACK: DROP TRIGGER aaa_skip_noop_update ON public.table_seats;

BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_noop_update_stats (
  tbl        text PRIMARY KEY,
  suppressed bigint NOT NULL DEFAULT 0,
  since      timestamptz NOT NULL DEFAULT now()
);
-- Operational counter, not player data: the browser has no business reading it.
REVOKE ALL ON public.ca_noop_update_stats FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_skip_noop_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW IS NOT DISTINCT FROM OLD THEN
    UPDATE public.ca_noop_update_stats
       SET suppressed = suppressed + 1
     WHERE tbl = TG_TABLE_NAME;
    RETURN NULL;  -- cancelled: no row version, no WAL, no realtime event
  END IF;
  RETURN NEW;
END
$function$;

INSERT INTO public.ca_noop_update_stats(tbl) VALUES ('table_seats')
  ON CONFLICT (tbl) DO NOTHING;

DROP TRIGGER IF EXISTS aaa_skip_noop_update ON public.table_seats;
CREATE TRIGGER aaa_skip_noop_update
  BEFORE UPDATE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_skip_noop_update();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'table_seats' AND t.tgname = 'aaa_skip_noop_update'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'the no-op suppression trigger did not take on table_seats';
  END IF;
END $$;

COMMIT;

-- WHAT ACTUALLY CLOSES THE 3x GAP, for whoever picks this up:
--   * hand_history rows are ~23 kB and are written every hand; with
--     hand_state_snapshots (one per street) they dominate WAL bytes. Neither
--     is in the realtime publication, so every byte is decoded and discarded.
--   * table_hole_cards churns ~71 events/s (885 inserts + 882 deletes per 25s)
--     and IS published. It must NOT simply be dropped from the publication -
--     doing that on 2026-08-31 cost every player their hole-card push for four
--     hours, which is why TablePage now has a channel-error recovery fetch.
--   * ca_hand_player_idx published ~206 events/s, almost all of them DELETEs
--     nobody subscribes to (the stats page listens to INSERT on its own rows).
--     Removing it from the publication was measured and did NOT move the
--     decode rate, so it was put back rather than left as a silent regression.
--   The remaining honest options are fewer/smaller writes per hand, or more
--   Realtime capacity. Both are Dan's call.
