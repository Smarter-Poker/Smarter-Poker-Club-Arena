-- Applied to production as version 20261005174041 (match by name).
--
-- A HORSE KEEPS A HEARTBEAT LIKE A PERSON
--
-- Presence has one definition everywhere (fn_profile_presence): online while
-- profiles.is_online is set and last_seen is under five minutes old. A person's
-- browser keeps that heartbeat. A horse has no browser, so its last_seen froze
-- on 2026-09-01: every horse read offline on every surface forever, and before
-- World Hub #2130 the feed drew horses online from a schedule instead (about
-- half the day) - either way a tell. A horse now keeps the same two columns
-- the same way a person's browser would:
--
--   * online while it has posted, commented or liked in the last 10 minutes;
--   * plus 0-2 short sessions a day (4-15 minutes) inside its own local
--     08:00-23:00, chosen by a hash of its id and local date, so it is stable
--     within a day and different across days;
--   * one in five sessions ends with a clean sign-out (is_online = false), the
--     rest go stale like a closed tab.
-- Simulated over 2026-10-04: about 2% online time per horse and about 14
-- horses online at once, against the schedule's ~50%.
--
-- periodic-work: the tick is the horse's heartbeat itself, the way a person's open tab
-- beats every two minutes; nothing upstream failed or is being caught up.
--
-- One tick a minute, pg_cron, under an advisory lock, bounded by lock and
-- statement timeouts; the function is executable by no browser role.

CREATE OR REPLACE FUNCTION smarter_private.fn_horse_presence_tick()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '2s'
SET statement_timeout = '20s'
AS $fn$
DECLARE v_now timestamptz := now(); v_on integer := 0; v_off integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('horse-presence-heartbeat')) THEN RETURN -1; END IF;
  WITH zones AS (SELECT name FROM pg_timezone_names),
  horses AS (
    SELECT c.profile_id AS id, coalesce(z.name, 'America/Los_Angeles') AS zone
      FROM public.content_authors c LEFT JOIN zones z ON z.name = c.timezone
     WHERE c.is_active AND c.profile_id IS NOT NULL),
  clock AS (SELECT h.id, (v_now AT TIME ZONE h.zone) AS lt FROM horses h),
  recent AS (
    SELECT author_id AS id FROM public.social_posts WHERE created_at > v_now - interval '10 minutes'
    UNION SELECT author_id FROM public.social_comments WHERE created_at > v_now - interval '10 minutes'
    UNION SELECT user_id FROM public.social_likes WHERE created_at > v_now - interval '10 minutes'),
  want AS (
    SELECT c.id,
      ( EXISTS (SELECT 1 FROM recent r WHERE r.id = c.id)
        OR EXISTS (
          SELECT 1 FROM generate_series(0, 2) AS s(i)
          CROSS JOIN LATERAL (SELECT hashtextextended(c.id::text || ':' || to_char(c.lt, 'YYYY-MM-DD') || ':' || s.i, 0) & 2147483647 AS h) x
          WHERE s.i < (hashtextextended(c.id::text || ':' || to_char(c.lt, 'YYYY-MM-DD'), 0) & 2147483647) % 3
            AND (extract(hour FROM c.lt) * 60 + extract(minute FROM c.lt))::int
                BETWEEN 480 + x.h % 900 AND 480 + x.h % 900 + 3 + (x.h / 900) % 12) ) AS online
    FROM clock c),
  stamped AS (
    UPDATE public.profiles p SET is_online = true, last_seen = v_now
      FROM want w
     WHERE w.online AND p.id = w.id
       AND (p.is_online IS NOT TRUE OR p.last_seen IS NULL OR p.last_seen < v_now - interval '45 seconds')
    RETURNING p.id),
  signed_out AS (
    UPDATE public.profiles p SET is_online = false
      FROM want w
     WHERE NOT w.online AND p.id = w.id AND p.is_online IS TRUE
       AND p.last_seen > v_now - interval '2 minutes'
       AND (hashtextextended(p.id::text || ':' || extract(epoch FROM p.last_seen)::text, 0) & 2147483647) % 5 = 0
    RETURNING p.id)
  SELECT (SELECT count(*) FROM stamped), (SELECT count(*) FROM signed_out) INTO v_on, v_off;
  RETURN v_on;
END
$fn$;

REVOKE ALL ON FUNCTION smarter_private.fn_horse_presence_tick() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('horse-presence-heartbeat', '* * * * *', $$SELECT smarter_private.fn_horse_presence_tick()$$);

DO $post$
BEGIN
  IF has_function_privilege('anon', 'smarter_private.fn_horse_presence_tick()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'smarter_private.fn_horse_presence_tick()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can run the horse heartbeat';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'horse-presence-heartbeat' AND active) THEN
    RAISE EXCEPTION 'the heartbeat job is not scheduled';
  END IF;
  IF smarter_private.fn_horse_presence_tick() < -1 THEN
    RAISE EXCEPTION 'the heartbeat tick failed';
  END IF;
END
$post$;
