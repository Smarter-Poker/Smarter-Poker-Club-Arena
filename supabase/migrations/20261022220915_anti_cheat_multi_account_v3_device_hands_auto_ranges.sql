-- Multi-account detector v3 (Dan, 2026-10-22: "truly only flag multiple
-- accounts"; never SmarterPokerOfficial or any admin account).
--
-- 1. DEVICE. The client keeps one permanent install id per browser/app and
--    reports it once per session through ca_record_device_sighting. The
--    request IP is read from the request headers, never from the client.
--    A device ever used by a never-flag account (owner, admins, staff, smoke
--    accounts) is a staff device: admins sign into player accounts for
--    support, and that must not flag the player.
-- 2. HANDS. "Same table" now means both accounts were DEALT INTO the same
--    hands (hand_history.players via its GIN index), per candidate pair only.
-- 3. SHARED ADDRESSES. anti_cheat_shared_ip_ranges gains a source column and
--    a GiST index; the workers service replaces each published list (Apple
--    iCloud Private Relay, AWS, Google Cloud, Cloudflare, GitHub Actions,
--    Azure) weekly through fn_anti_cheat_replace_shared_ip_ranges.
-- Verdicts (detect_multi_account_v3):
--   critical  same device AND dealt into the same hands
--   high      same device, OR same household address AND the same hands
--             while both were on that address (within 3 hours)
--   medium    2+ distinct household addresses shared
--   nothing   one shared address on its own, staff, smoke accounts, exempt.
-- Horses go through every rule exactly as humans do (CLAUDE.md 10.5).

CREATE TABLE IF NOT EXISTS public.anti_cheat_device_sightings (
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_id  text        NOT NULL,
  ip         text        NOT NULL DEFAULT '',
  user_agent text,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  hits       integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, device_id, ip)
);
CREATE INDEX IF NOT EXISTS idx_anti_cheat_device_sightings_device
  ON public.anti_cheat_device_sightings (device_id);
CREATE INDEX IF NOT EXISTS idx_anti_cheat_device_sightings_last_seen
  ON public.anti_cheat_device_sightings (last_seen);
ALTER TABLE public.anti_cheat_device_sightings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.anti_cheat_device_sightings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.anti_cheat_device_sightings TO service_role;

CREATE OR REPLACE FUNCTION public.ca_record_device_sighting(p_device_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_headers text;
  v_h       jsonb;
  v_ip      text := '';
  v_ua      text;
BEGIN
  -- Who is asking: only a signed-in player, and only about themselves.
  IF v_uid IS NULL THEN
    RETURN;
  END IF;
  IF p_device_id IS NULL
     OR p_device_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN;
  END IF;

  -- The address and agent come from the request, never from the client.
  v_headers := current_setting('request.headers', true);
  IF v_headers IS NOT NULL AND pg_input_is_valid(v_headers, 'jsonb') THEN
    v_h := v_headers::jsonb;
    v_ip := btrim(coalesce(
      nullif(v_h ->> 'cf-connecting-ip', ''),
      nullif(v_h ->> 'x-real-ip', ''),
      nullif(split_part(v_h ->> 'x-forwarded-for', ',', 1), ''),
      ''));
    v_ua := left(v_h ->> 'user-agent', 300);
  END IF;
  IF v_ip <> '' AND NOT pg_input_is_valid(v_ip, 'inet') THEN
    v_ip := '';
  END IF;

  INSERT INTO public.anti_cheat_device_sightings AS s
    (user_id, device_id, ip, user_agent, first_seen, last_seen, hits)
  VALUES (v_uid, p_device_id, v_ip, v_ua, now(), now(), 1)
  ON CONFLICT (user_id, device_id, ip) DO UPDATE
    SET last_seen = now(),
        hits = s.hits + 1,
        user_agent = coalesce(EXCLUDED.user_agent, s.user_agent)
    WHERE s.last_seen < now() - interval '5 minutes';
END;
$$;
REVOKE ALL ON FUNCTION public.ca_record_device_sighting(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ca_record_device_sighting(text) TO authenticated, service_role;

ALTER TABLE public.anti_cheat_shared_ip_ranges
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
CREATE INDEX IF NOT EXISTS idx_anti_cheat_shared_ip_ranges_gist
  ON public.anti_cheat_shared_ip_ranges USING gist (cidr inet_ops);
REVOKE ALL ON public.anti_cheat_shared_ip_ranges FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.anti_cheat_shared_ip_ranges TO service_role;

CREATE TABLE IF NOT EXISTS public.anti_cheat_shared_ip_sources (
  source       text PRIMARY KEY,
  refreshed_at timestamptz NOT NULL,
  range_count  integer NOT NULL
);
ALTER TABLE public.anti_cheat_shared_ip_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.anti_cheat_shared_ip_sources FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.anti_cheat_shared_ip_sources TO service_role;

CREATE OR REPLACE FUNCTION public.fn_anti_cheat_replace_shared_ip_ranges(
  p_source text, p_label text, p_cidrs text[], p_first boolean)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_source IS NULL OR p_source = 'manual' OR p_source !~ '^[a-z0-9_]{2,40}$' THEN
    RAISE EXCEPTION 'invalid shared ip source %', p_source;
  END IF;
  IF p_first THEN
    DELETE FROM public.anti_cheat_shared_ip_ranges WHERE source = p_source;
  END IF;
  INSERT INTO public.anti_cheat_shared_ip_ranges (cidr, label, source)
  SELECT DISTINCT c::inet, p_label, p_source
  FROM unnest(coalesce(p_cidrs, '{}'::text[])) AS c
  WHERE CASE WHEN pg_input_is_valid(c, 'inet') THEN family(c::inet) = 4 ELSE false END
  ON CONFLICT (cidr) DO NOTHING;
  SELECT count(*) INTO v_n FROM public.anti_cheat_shared_ip_ranges WHERE source = p_source;
  INSERT INTO public.anti_cheat_shared_ip_sources (source, refreshed_at, range_count)
  VALUES (p_source, now(), v_n)
  ON CONFLICT (source) DO UPDATE SET refreshed_at = now(), range_count = v_n;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_anti_cheat_replace_shared_ip_ranges(text, text, text[], boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_anti_cheat_replace_shared_ip_ranges(text, text, text[], boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.detect_multi_account_v3(
  p_since timestamptz, p_until timestamptz DEFAULT now())
RETURNS TABLE(
  user_a uuid, user_b uuid, severity text, evidence text[],
  shared_devices integer, shared_ips integer, ips text[],
  shared_hands integer, hand_numbers bigint[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
  WITH raw AS (
    SELECT a.user_id, a.ip_address AS ip,
           floor(extract(epoch FROM a.created_at) / 10800)::bigint AS bucket
    FROM public.action_audit_logs a
    WHERE a.created_at >= p_since AND a.created_at < p_until
      AND a.ip_address IS NOT NULL
      AND a.user_id IS NOT NULL
      AND a.ip_address ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
    GROUP BY 1, 2, 3
    UNION
    SELECT s.user_id, s.ip, floor(extract(epoch FROM s.last_seen) / 10800)::bigint
    FROM public.anti_cheat_device_sightings s
    WHERE s.last_seen >= p_since AND s.last_seen < p_until
      AND s.ip ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
  ), users AS (
    SELECT user_id FROM raw
    UNION
    SELECT user_id FROM public.anti_cheat_device_sightings
    WHERE last_seen >= p_since AND last_seen < p_until
  ), eligible AS (
    SELECT u.user_id FROM users u
    WHERE NOT public.fn_anti_cheat_never_flag(u.user_id)
      AND NOT EXISTS (SELECT 1 FROM public.anti_cheat_exemptions x
                      WHERE x.player_id = u.user_id AND x.flag_type = 'multi_account')
  ), ips_ok AS (
    SELECT d.ip FROM (SELECT DISTINCT ip FROM raw WHERE pg_input_is_valid(ip, 'inet')) d
    WHERE NOT EXISTS (SELECT 1 FROM public.anti_cheat_shared_ip_ranges r
                      WHERE r.cidr >>= d.ip::inet)
  ), ev AS (
    SELECT r.* FROM raw r JOIN ips_ok USING (ip) JOIN eligible USING (user_id)
  ), ipn AS (
    SELECT ip FROM ev GROUP BY ip HAVING count(DISTINCT user_id) BETWEEN 2 AND 5
  ), ui AS (
    SELECT DISTINCT e.user_id, e.ip FROM ev e JOIN ipn USING (ip)
  ), ip_pairs AS (
    SELECT a.user_id AS ua, b.user_id AS ub, count(*)::int AS n_ips,
           array_agg(a.ip ORDER BY a.ip) AS ip_list
    FROM ui a JOIN ui b ON a.ip = b.ip AND a.user_id < b.user_id
    GROUP BY 1, 2
  ), copresent AS (
    SELECT DISTINCT a.user_id AS ua, b.user_id AS ub, a.bucket
    FROM ev a JOIN ev b
      ON a.ip = b.ip AND a.user_id < b.user_id
     AND b.bucket BETWEEN a.bucket - 1 AND a.bucket + 1
    JOIN ipn ON ipn.ip = a.ip
  ), staff_devices AS (
    SELECT DISTINCT s.device_id FROM public.anti_cheat_device_sightings s
    WHERE public.fn_anti_cheat_never_flag(s.user_id)
  ), dev AS (
    SELECT DISTINCT s.user_id, s.device_id
    FROM public.anti_cheat_device_sightings s
    JOIN eligible USING (user_id)
    WHERE s.last_seen >= p_since AND s.last_seen < p_until
      AND NOT EXISTS (SELECT 1 FROM staff_devices sd WHERE sd.device_id = s.device_id)
  ), dev_pairs AS (
    SELECT a.user_id AS ua, b.user_id AS ub, count(DISTINCT a.device_id)::int AS n_dev
    FROM dev a JOIN dev b ON a.device_id = b.device_id AND a.user_id < b.user_id
    GROUP BY 1, 2
  ), cand AS (
    SELECT coalesce(d.ua, i.ua) AS ua, coalesce(d.ub, i.ub) AS ub,
           coalesce(d.n_dev, 0) AS n_dev,
           coalesce(i.n_ips, 0) AS n_ips,
           coalesce(i.ip_list, '{}'::text[]) AS ip_list
    FROM dev_pairs d FULL JOIN ip_pairs i ON i.ua = d.ua AND i.ub = d.ub
  ), hands AS (
    SELECT c.ua, c.ub, h.hand_number,
           floor(extract(epoch FROM h.created_at) / 10800)::bigint AS bucket
    FROM cand c
    CROSS JOIN LATERAL (
      SELECT hh.hand_number, hh.created_at
      FROM public.hand_history hh
      WHERE hh.players @> jsonb_build_array(jsonb_build_object('userId', c.ua::text))
        AND hh.players @> jsonb_build_array(jsonb_build_object('userId', c.ub::text))
        AND hh.created_at >= p_since AND hh.created_at < p_until
      ORDER BY hh.created_at DESC
      LIMIT 500
    ) h
  ), hand_counts AS (
    SELECT h.ua, h.ub,
           count(*)::int AS any_hands,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM copresent cp
             WHERE cp.ua = h.ua AND cp.ub = h.ub
               AND h.bucket BETWEEN cp.bucket - 1 AND cp.bucket + 1))::int AS copresent_hands,
           (array_agg(h.hand_number ORDER BY h.hand_number DESC))[1:10] AS sample
    FROM hands h
    GROUP BY 1, 2
  ), verdict AS (
    SELECT c.*, coalesce(hc.any_hands, 0) AS any_hands,
           coalesce(hc.copresent_hands, 0) AS copresent_hands,
           coalesce(hc.sample, '{}'::bigint[]) AS sample
    FROM cand c LEFT JOIN hand_counts hc ON hc.ua = c.ua AND hc.ub = c.ub
  )
  SELECT v.ua, v.ub,
         CASE
           WHEN v.n_dev > 0 AND v.any_hands > 0 THEN 'critical'
           WHEN v.n_dev > 0 OR v.copresent_hands > 0 THEN 'high'
           ELSE 'medium'
         END,
         array_remove(ARRAY[
           CASE WHEN v.n_dev > 0 THEN 'same_device' END,
           CASE WHEN (v.n_dev > 0 AND v.any_hands > 0) OR v.copresent_hands > 0
                THEN 'same_hands' END,
           CASE WHEN v.n_ips >= 2 THEN 'shared_household_ips'
                WHEN v.n_ips = 1 THEN 'shared_household_ip' END
         ], NULL),
         v.n_dev, v.n_ips, v.ip_list,
         CASE WHEN v.n_dev > 0 THEN v.any_hands ELSE v.copresent_hands END,
         v.sample
  FROM verdict v
  WHERE v.n_dev > 0 OR v.copresent_hands > 0 OR v.n_ips >= 2;
$$;
REVOKE ALL ON FUNCTION public.detect_multi_account_v3(timestamptz, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_multi_account_v3(timestamptz, timestamptz) TO service_role;
