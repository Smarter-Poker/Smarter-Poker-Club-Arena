-- 20260927221335_push_prompt_events_record_the_enrolment_funnel.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Push enrolment has no funnel. Measured 2026-09-27: 4 active
-- push_subscriptions against 234 human profiles, and nothing records whether a
-- player was ever shown the enable prompt, tapped it, refused the browser
-- permission, hit a technical failure, or was on a browser that cannot do web
-- push at all (iOS Safari outside an installed Home Screen app). Without that
-- we cannot tell "nobody is asked" from "everybody says no" from "it breaks".
--
-- public.push_prompt_events is that funnel: one row per prompt outcome, per
-- surface. Written by the client (FirstRunPushPrompt, PushEnableBanner and
-- pushClient.enablePush), read only through fn_push_prompt_funnel by an
-- admin/god, or by service_role.
--
--   * INSERT: authenticated, own rows only (RLS WITH CHECK user_id=auth.uid()),
--     and only the four descriptive columns are grantable. user_id and
--     created_at are stamped by the BEFORE INSERT trigger from auth.uid() and
--     now(), so neither can be forged. A per-user cap (200 rows per rolling
--     24 hours) makes a looping client harmless; over the cap the row is
--     dropped silently (RETURN NULL), because telemetry must never surface an
--     error to a player.
--   * SELECT: no client policy at all. Players never read the table.
--   * No foreign key to auth.users or profiles (CLAUDE.md section 2 rule 7: a
--     log table never takes a lock on a hot relation).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='45s';

DO $guard$ BEGIN
 IF to_regclass('public.push_prompt_events') IS NOT NULL
  OR to_regprocedure('public.fn_push_prompt_funnel(integer)') IS NOT NULL
  OR to_regprocedure('public.fn_push_prompt_events_stamp()') IS NOT NULL
 THEN RAISE EXCEPTION 'push prompt telemetry already exists; review before replacing'; END IF;
 IF to_regprocedure('public.fn_caller_is_engine()') IS NULL
 THEN RAISE EXCEPTION 'fn_caller_is_engine is required by the funnel reader'; END IF;
END $guard$;

CREATE TABLE public.push_prompt_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid NOT NULL,
 surface text NOT NULL CHECK (surface IN('first_run','notifications_page','cashier','cashier_receipt','tournament_registration','settings','unknown')),
 event text NOT NULL CHECK (event IN('shown','accepted','declined','failed','unsupported')),
 platform text NOT NULL CHECK (platform IN('ios_browser','ios_pwa','android_web','desktop_web','native_ios','native_android','unknown')),
 detail text CHECK (detail IS NULL OR (char_length(detail)<=64 AND detail ~ '^[a-z0-9:_-]+$')),
 created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.push_prompt_events IS
 'Push enrolment funnel: one row per prompt outcome per surface. Players insert their own rows only (user_id and created_at stamped server-side, 200 per user per 24h). No client SELECT; admins read fn_push_prompt_funnel.';
CREATE INDEX push_prompt_events_created_idx ON public.push_prompt_events(created_at);
CREATE INDEX push_prompt_events_user_created_idx ON public.push_prompt_events(user_id,created_at);

CREATE FUNCTION public.fn_push_prompt_events_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 -- Identity and time come from the server, never from the browser.
 NEW.user_id:=COALESCE(auth.uid(),NEW.user_id);
 NEW.created_at:=now();
 IF NEW.user_id IS NULL THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM public.push_prompt_events e
     WHERE e.user_id=NEW.user_id AND e.created_at>now()-interval '24 hours')>=200 THEN
  RETURN NULL;
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER push_prompt_events_stamp BEFORE INSERT ON public.push_prompt_events
 FOR EACH ROW EXECUTE FUNCTION public.fn_push_prompt_events_stamp();

ALTER TABLE public.push_prompt_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY push_prompt_events_insert_own ON public.push_prompt_events
 FOR INSERT TO authenticated WITH CHECK (user_id=auth.uid());

REVOKE ALL ON TABLE public.push_prompt_events FROM PUBLIC, anon, authenticated;
GRANT INSERT(surface,event,platform,detail) ON public.push_prompt_events TO authenticated;
GRANT ALL ON TABLE public.push_prompt_events TO service_role;

-- The admin read: counts by surface/event/platform over a bounded window,
-- computed in PostgreSQL. Same admin rule as fn_push_health_snapshot.
CREATE FUNCTION public.fn_push_prompt_funnel(p_days integer DEFAULT 7) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public SET statement_timeout='10s' AS $function$
DECLARE stamp timestamptz:=statement_timestamp(); days int:=LEAST(GREATEST(COALESCE(p_days,7),1),90); result jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine()
  AND NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role IN('admin','god'))
 THEN RAISE EXCEPTION 'admin_required' USING ERRCODE='42501'; END IF;
 WITH recent AS MATERIALIZED (
  SELECT user_id,surface,event,platform FROM public.push_prompt_events
   WHERE created_at>=stamp-make_interval(days=>days) AND created_at<=stamp
 )
 SELECT jsonb_build_object('schemaVersion',1,'observedAt',stamp,'windowDays',days,
  'totals',COALESCE((SELECT jsonb_object_agg(event,n) FROM (SELECT event,count(*) n FROM recent GROUP BY event) t),'{}'::jsonb),
  'people',COALESCE((SELECT jsonb_object_agg(event,n) FROM (SELECT event,count(DISTINCT user_id) n FROM recent GROUP BY event) t),'{}'::jsonb),
  'bySurface',COALESCE((SELECT jsonb_agg(jsonb_build_object('surface',surface,'event',event,'count',n,'people',p) ORDER BY surface,event)
    FROM (SELECT surface,event,count(*) n,count(DISTINCT user_id) p FROM recent GROUP BY surface,event) t),'[]'::jsonb),
  'byPlatform',COALESCE((SELECT jsonb_agg(jsonb_build_object('platform',platform,'event',event,'count',n) ORDER BY platform,event)
    FROM (SELECT platform,event,count(*) n FROM recent GROUP BY platform,event) t),'[]'::jsonb))
 INTO result;
 RETURN result;
END $function$;

REVOKE ALL ON FUNCTION public.fn_push_prompt_events_stamp() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_push_prompt_funnel(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_push_prompt_funnel(integer) TO authenticated, service_role;

DO $post$ BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.push_prompt_events'::regclass)
 THEN RAISE EXCEPTION 'push_prompt_events must have RLS enabled'; END IF;
 IF has_table_privilege('anon','public.push_prompt_events','SELECT')
  OR has_table_privilege('anon','public.push_prompt_events','INSERT')
  OR has_table_privilege('authenticated','public.push_prompt_events','SELECT')
  OR has_table_privilege('authenticated','public.push_prompt_events','UPDATE')
  OR has_table_privilege('authenticated','public.push_prompt_events','DELETE')
  OR has_column_privilege('authenticated','public.push_prompt_events','user_id','INSERT')
  OR has_column_privilege('authenticated','public.push_prompt_events','created_at','INSERT')
 THEN RAISE EXCEPTION 'push_prompt_events grants are wider than insert-own'; END IF;
 IF NOT has_column_privilege('authenticated','public.push_prompt_events','surface','INSERT')
 THEN RAISE EXCEPTION 'authenticated cannot record a prompt event'; END IF;
 IF (SELECT count(*) FROM pg_policy WHERE polrelid='public.push_prompt_events'::regclass)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.push_prompt_events'::regclass
     AND polname='push_prompt_events_insert_own' AND polcmd='a')
 THEN RAISE EXCEPTION 'push_prompt_events must carry exactly the insert-own policy'; END IF;
 IF has_function_privilege('anon','public.fn_push_prompt_funnel(integer)','EXECUTE')
  OR has_function_privilege('anon','public.fn_push_prompt_events_stamp()','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_push_prompt_events_stamp()','EXECUTE')
 THEN RAISE EXCEPTION 'push prompt functions are executable by a role that must not'; END IF;
END $post$;

COMMIT;
