-- Applied to production as version 20261005230329 (match by name).
--
-- THE CLUB'S "ONLINE" IS THE ONE DEFINITION
--
-- ca_club_members (the Club Dashboard members tab), ca_club_dashboard_stats
-- .online_now and ca_club_operations_overview.online_now decided online from
-- club_members.last_active within 15 minutes. A horse never has that (0 of
-- 1,903 horse memberships on 2026-10-05, 1 human), so anyone shown online
-- there who was not seated was a person. Every other surface uses the one
-- presence definition - profiles.is_online with last_seen under five minutes
-- - which people now keep from the arena (#6182, live 22:41 UTC) and horses
-- keep from 20261005174041. This swaps that one condition in each of the three
-- functions, each pinned by md5 so it refuses to run on a definition changed
-- since it was read; CREATE OR REPLACE keeps owner and grants.
--
-- It also adds fn_union_online_count: the union page's "Online Now" counted
-- people who had the union page open on a Realtime channel only people can
-- join, and #6182 replaced it with "Unavailable". This is the database count
-- under the same definition (or a live seat), returned as a number only.

DO $do$
DECLARE r record; v_def text;
  v_old text := $o$cm.last_active > now() - interval '15 minutes'$o$;
  v_new text := $n$EXISTS (SELECT 1 FROM public.profiles pp WHERE pp.id = cm.user_id AND coalesce(pp.is_online, false) AND pp.last_seen > now() - interval '5 minutes')$n$;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.ca_club_members(uuid,text,timestamp with time zone,integer,integer,text,text)', 'afe48d734122d1513f7c547e2511773c'),
    ('public.ca_club_dashboard_stats(uuid)', '654e65c84922fd7f3f83e0237cb4e125'),
    ('public.ca_club_operations_overview(uuid)', '89ee7baab58f8881674efe56469498ee')
  ) t(sig, pin) LOOP
    v_def := pg_get_functiondef(r.sig::regprocedure);
    IF md5(v_def) <> r.pin THEN RAISE EXCEPTION '% changed since 2026-10-05; re-read before applying', r.sig; END IF;
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION '% must contain the last_active rule exactly once', r.sig; END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END LOOP;
END $do$;

CREATE OR REPLACE FUNCTION public.fn_union_online_count(p_union_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT count(DISTINCT cm.user_id)
    FROM public.union_clubs uc
    JOIN public.club_members cm ON cm.club_id = uc.club_id
    LEFT JOIN public.profiles pr ON pr.id = cm.user_id
   WHERE auth.uid() IS NOT NULL
     AND uc.union_id = p_union_id
     AND coalesce(cm.status, 'active') IN ('active', 'approved', 'automatic')
     AND ((coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes')
       OR EXISTS (SELECT 1 FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
                   WHERE ts.user_id = cm.user_id AND ts.left_at IS NULL
                     AND t.status IN ('running', 'waiting', 'active')));
$fn$;
REVOKE ALL ON FUNCTION public.fn_union_online_count(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_online_count(uuid) TO authenticated, service_role;

DO $post$
DECLARE v text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('ca_club_members', 'ca_club_dashboard_stats', 'ca_club_operations_overview')
     AND (p.prosrc LIKE '%last_active > now() - interval ''15 minutes''%'
          OR p.prosrc NOT LIKE '%pp.last_seen > now() - interval ''5 minutes''%');
  IF v IS NOT NULL THEN RAISE EXCEPTION 'still on the last_active rule: %', v; END IF;
  IF has_function_privilege('anon', 'public.fn_union_online_count(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_union_online_count(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_union_online_count grants are wrong';
  END IF;
END $post$;
