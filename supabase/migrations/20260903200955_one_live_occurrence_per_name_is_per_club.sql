-- ═══════════════════════════════════════════════════════════════════════════════
--  ONE LIVE OCCURRENCE PER NAME IS PER CLUB
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Found the hour Deep Stack Society's schedule was made to mirror the Midway
-- Union's (migration 20260903171313). Forty-five minutes on, not one of the 63
-- mirrored rows had spawned an event, and the engine log said why, once a
-- minute per row:
--
--     "Monday Knockout" already live pre-start - spawn <key> deferred
--
-- uq_scheduled_tournament_one_live_per_occurrence was unique on
-- (tournament_type, name, start_time) across the WHOLE PLATFORM. Two clubs
-- cannot both have a "Monday Knockout" registering for Monday 02:00 - the
-- second insert is a duplicate key, the spawner releases its claim and tries
-- again next poll, forever, and the club's copy of the programme never
-- appears. The guard was written when only the house had a schedule, and a
-- name alone was an event; it is not any more. A mirrored programme is, by
-- definition, the same names at the same times in another club.
--
-- The index now carries club_id. What it still guarantees is what it was for:
-- one schedule cannot put the same occurrence on its own board twice (the
-- spawn-key claim is the first line; this is the second). What it stops
-- guaranteeing is something it was never asked to: that no two clubs share an
-- event name. The Midway rows are unaffected; the Deep Stack rows spawn on the
-- next poll.

DROP INDEX IF EXISTS public.uq_scheduled_tournament_one_live_per_occurrence;

CREATE UNIQUE INDEX uq_scheduled_tournament_one_live_per_occurrence
  ON public.tournaments USING btree (club_id, tournament_type, name, start_time)
  WHERE status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text])
    AND tournament_type = ANY (ARRAY['MTT'::text, 'XMTT'::text]);
