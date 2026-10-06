-- Applied to production as version 20261006040328 (match by name).
--
-- A SEATED PLAYER IS ONLINE, AND THE HORSE HEARTBEAT NEVER WAITS ON A BUSY ROW
--
-- 1. fn_profile_presence counted a heartbeat only. A seated person's open tab
--    keeps their heartbeat, a seated horse has none, so the friends list,
--    FriendListPanel, FriendSuggestions and SuperAgentDashboard showed a
--    seated person online and a seated horse offline (2026-10-06: 495 horses
--    seated, about 10 reading online). The rosters, the union count and the
--    arena counts already say "seated OR fresh heartbeat"; this makes the one
--    presence door say the same. idx_table_seats_user_live serves the lookup.
--
-- 2. smarter_private.fn_horse_presence_tick failed about 1 tick in 50 with
--    "lock timeout while locking tuple in relation profiles": the engine holds
--    a seated horse's profile row. The tick now locks only rows it can take
--    (FOR UPDATE SKIP LOCKED) and leaves a busy row for the next minute, so a
--    tick never fails and never waits.
--
-- @live-proof: (position('table_seats' in (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_profile_presence(uuid[])'::regprocedure)) > 0 AND position('SKIP LOCKED' in (SELECT prosrc FROM pg_proc WHERE oid = 'smarter_private.fn_horse_presence_tick()'::regprocedure)) > 0)

DO $pin$
BEGIN
  IF md5(pg_get_functiondef('public.fn_profile_presence(uuid[])'::regprocedure)) <> 'c0d66ed8f122599614b7f1015df2668c' THEN
    RAISE EXCEPTION 'fn_profile_presence changed since 2026-10-05; re-read before applying';
  END IF;
END
$pin$;

CREATE OR REPLACE FUNCTION public.fn_profile_presence(p_user_ids uuid[])
 RETURNS TABLE(user_id uuid, is_online boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Online now, and nothing else: a heartbeat under five minutes old, or a
  -- live seat at an open table - the same rule for a person and a horse. The
  -- heartbeat (last_seen) is never returned; it is its owner's.
  SELECT p.id,
         (COALESCE(p.is_online, false) AND p.last_seen > now() - interval '5 minutes')
         OR EXISTS (SELECT 1
                      FROM public.table_seats ts
                      JOIN public.tables t ON t.id = ts.table_id
                     WHERE ts.user_id = p.id
                       AND ts.left_at IS NULL
                       AND t.status IN ('running', 'waiting', 'active'))
    FROM public.profiles p
   WHERE auth.uid() IS NOT NULL
     AND p.id = ANY (COALESCE(p_user_ids, ARRAY[]::uuid[]))
   LIMIT 1000;
$function$;

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
  to_stamp AS (
    SELECT pr.id FROM public.profiles pr JOIN want w ON w.id = pr.id
     WHERE w.online
       AND (pr.is_online IS NOT TRUE OR pr.last_seen IS NULL OR pr.last_seen < v_now - interval '45 seconds')
       FOR UPDATE OF pr SKIP LOCKED),
  stamped AS (
    UPDATE public.profiles p SET is_online = true, last_seen = v_now
      FROM to_stamp l WHERE p.id = l.id
    RETURNING p.id),
  to_sign_out AS (
    SELECT pr.id FROM public.profiles pr JOIN want w ON w.id = pr.id
     WHERE NOT w.online AND pr.is_online IS TRUE
       AND pr.last_seen > v_now - interval '2 minutes'
       AND (hashtextextended(pr.id::text || ':' || extract(epoch FROM pr.last_seen)::text, 0) & 2147483647) % 5 = 0
       FOR UPDATE OF pr SKIP LOCKED),
  signed_out AS (
    UPDATE public.profiles p SET is_online = false
      FROM to_sign_out l WHERE p.id = l.id
    RETURNING p.id)
  SELECT (SELECT count(*) FROM stamped), (SELECT count(*) FROM signed_out) INTO v_on, v_off;
  RETURN v_on;
END
$fn$;

REVOKE ALL ON FUNCTION smarter_private.fn_horse_presence_tick() FROM PUBLIC, anon, authenticated;

DO $post$
BEGIN
  IF position('table_seats' in (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_profile_presence(uuid[])'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_profile_presence does not count a seat';
  END IF;
  IF has_function_privilege('anon', 'public.fn_profile_presence(uuid[])', 'EXECUTE') IS NULL THEN
    RAISE EXCEPTION 'fn_profile_presence is missing';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_profile_presence(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'signed-in players lost fn_profile_presence';
  END IF;
  IF has_function_privilege('authenticated', 'smarter_private.fn_horse_presence_tick()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can run the horse heartbeat';
  END IF;
  IF smarter_private.fn_horse_presence_tick() < -1 THEN
    RAISE EXCEPTION 'the heartbeat tick failed';
  END IF;
END
$post$;
