-- =============================================================================
--  FIXTURE: owner-operational notifications are delivered to the task only
-- =============================================================================
-- A throwaway PostgreSQL schema for scripts/dev/probe-owner-inbox-store-only.sh
-- and scripts/dev/probe-owner-inbox-cleanup.sh: production as it stands before
-- 20260927235053. It is never applied to production. Run roles.sql beside it
-- first, as the cluster's superuser; this file runs as postgres, which here as
-- in production is not a superuser and bypasses row-level security.
--
-- Every object below is one of:
--   * a production shape, read from production kuklfnapbkmacvwxktbh on
--     2026-09-27 and 2026-09-28 (UTC): the Supabase default privileges that grant every new public
--     table and function; public.notifications with its columns, constraints,
--     partial unique indexes, row-level security, policies and grants; the
--     key of public.profiles; the recorder's table and grants; the columns of
--     the tables the three readers touch;
--   * exact production source, each pinned by the probe to the md5 of
--     pg_get_functiondef that production returns: auth.uid(); the two
--     BEFORE INSERT triggers trg_notification_fill_action_url and
--     trg_sync_notification_read_state, their functions and
--     fn_notification_action_url; fn_raise_notification; the recorder from
--     World Hub supabase/migrations/20260913164000_operational_alert_inbox.sql;
--     the owner destination component from
--     supabase/migrations/20260916111614_owner_operational_notification_destination.sql
--     (without its install guard and push-mirror swap); the three reader
--     functions;
--   * a TEST DOUBLE, marked as such, for fn_ca_raise_drift_incident only.
-- Not modelled, and not read by either probe: the push-mirror triggers and
-- push_outbox (the cleanup probe adds push_outbox), the messenger content
-- policy that reads fn_messenger_notification_visible_to, the other columns
-- and the policies of profiles, the grants of the reader tables (only the
-- SECURITY DEFINER readers touch them), and the event triggers.
SET client_min_messages = warning;

-- Supabase's default privileges for what postgres creates in public, exactly
-- as production's pg_default_acl holds them: every new table is granted
-- arwdxtm to anon and authenticated and arwdDxtm to service_role, every new
-- function EXECUTE to anon, authenticated and service_role (and to PUBLIC by
-- PostgreSQL's own default). MAINTAIN (m) exists from PostgreSQL 17.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO anon, authenticated;
DO $maintain$
BEGIN
  IF current_setting('server_version_num')::integer >= 170000 THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT MAINTAIN ON TABLES TO anon, authenticated';
  END IF;
END
$maintain$;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;

-- auth.uid(), exactly as production prints it; the notification policies call it.
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

-- public.profiles, reduced to its key (and the username column
-- fn_notification_action_url reads), with production's grants.
CREATE TABLE public.profiles (
  id uuid NOT NULL,
  username text,
  CONSTRAINT profiles_pkey PRIMARY KEY (id)
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profiles FROM anon, authenticated, service_role;
GRANT INSERT, DELETE, REFERENCES, TRIGGER ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
-- Every account either probe addresses.
INSERT INTO public.profiles(id) VALUES
  ('47965354-0e56-43ef-931c-ddaab82af765'),  -- the owner account
  ('22222222-2222-4222-8222-222222222222'),  -- another account
  ('33333333-3333-4333-8333-333333333333');  -- a club owner

-- public.notifications: production columns, constraints (names included),
-- partial unique indexes, row-level security and policies. Its grants are the
-- default privileges above, which is how production's were made.
CREATE TABLE public.notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  message text,
  data jsonb DEFAULT '{}'::jsonb,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  is_read boolean DEFAULT false,
  action_url text,
  metadata jsonb DEFAULT '{}'::jsonb,
  actor_id uuid,
  link text,
  read_at timestamptz,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT fk_notifications_user_id_profiles FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT notifications_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id)
);
CREATE UNIQUE INDEX idx_notif_dedup_friend_request ON public.notifications USING btree (user_id, type, ((data ->> 'sender_id'::text))) WHERE (type = 'friend_request'::text);
CREATE UNIQUE INDEX idx_notif_dedup_group_friend ON public.notifications USING btree (user_id, type, ((data ->> 'group_id'::text)), ((data ->> 'friend_id'::text))) WHERE (type = 'home_group_friend_joined'::text);
CREATE UNIQUE INDEX notifications_daily_mission_cycle_unique ON public.notifications USING btree (user_id, ((data ->> 'cycle_date'::text))) WHERE ((type = 'daily_challenge'::text) AND ((data ->> 'source'::text) = 'club_arena_daily_missions'::text));
CREATE UNIQUE INDEX notifications_pa_leak_audit_job_unique ON public.notifications USING btree (((data ->> 'paAuditJobId'::text))) WHERE ((type = 'personal_assistant_audit_complete'::text) AND (data ? 'paAuditJobId'::text));
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role inserts" ON public.notifications
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Users can view own notifications" ON public.notifications
  FOR SELECT USING ((SELECT auth.uid() AS uid) = user_id);
CREATE POLICY "Users can update own notifications" ON public.notifications
  FOR UPDATE USING ((SELECT auth.uid() AS uid) = user_id);
CREATE POLICY "Users can delete own notifications" ON public.notifications
  FOR DELETE USING ((SELECT auth.uid() AS uid) = user_id);
CREATE POLICY messenger_no_anonymous_notification_content ON public.notifications
  AS RESTRICTIVE FOR SELECT TO anon USING (false);

-- The two production BEFORE INSERT triggers that normalize a row before
-- anything captures it, with their functions verbatim.
CREATE OR REPLACE FUNCTION public.fn_notification_action_url(p_type text, p_data jsonb, p_metadata jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
    d          jsonb := COALESCE(p_metadata, '{}'::jsonb) || COALESCE(p_data, '{}'::jsonb);
    t          text  := COALESCE(btrim(p_type), '');
    ca         text  := '/hub/club-arena';
    v_table    text  := COALESCE(d->>'table_id',      d->>'tableId');
    v_union    text  := COALESCE(d->>'union_id',      d->>'unionId');
    v_club     text  := COALESCE(d->>'club_id',       d->>'clubId');
    v_post     text  := COALESCE(d->>'post_id',       d->>'postId');
    v_tourn    text  := COALESCE(d->>'tournament_id', d->>'tournamentId');
    v_convo    text  := COALESCE(d->>'conversation_id', d->>'conversationId');
    v_pagetype text  := COALESCE(d->>'page_type',     d->>'pageType');
    v_pageid   text  := COALESCE(d->>'page_id',       d->>'pageId');
    v_sender   text  := COALESCE(d->>'sender_id',     d->>'actor_id', d->>'senderId');
    v_username text;
    v_is_reel  boolean := (d->>'is_reel') = 'true' OR (d->>'post_type') = 'reel';
BEGIN
    IF t IN ('waitlist_seat_open','seat_available','waitlist_ready','table_ready') THEN
        RETURN CASE WHEN v_table IS NOT NULL THEN ca || '/table/' || v_table ELSE ca || '/waitlist' END;
    END IF;
    IF t IN ('table_invite','your_turn','your_turn_reminder','time_bank_active','hand_won') THEN
        RETURN CASE WHEN v_table IS NOT NULL THEN ca || '/table/' || v_table ELSE NULL END;
    END IF;
    IF t IN ('tournament_starting','tournament_start','tournament_registered') THEN
        RETURN CASE WHEN v_tourn IS NOT NULL THEN ca || '/tournaments/' || v_tourn ELSE ca || '/tournaments' END;
    END IF;
    IF t = 'union_invoice' THEN
        RETURN CASE WHEN v_union IS NOT NULL THEN ca || '/unions/' || v_union || '/statements' ELSE ca || '/unions' END;
    END IF;
    IF t IN ('settlement','settlement_failed') THEN
        IF v_union IS NOT NULL THEN RETURN ca || '/unions/' || v_union || '/settlement'; END IF;
        IF v_club  IS NOT NULL THEN RETURN ca || '/clubs/'  || v_club  || '/settlement'; END IF;
        RETURN ca || '/settlement-dashboard';
    END IF;
    IF t IN ('cashout_request','cashout_approved','cashout_denied') THEN
        RETURN CASE WHEN v_club IS NOT NULL THEN ca || '/clubs/' || v_club || '/financials' ELSE ca || '/wallet' END;
    END IF;
    IF t IN ('club_announcement','club_invite') THEN
        RETURN CASE WHEN v_club IS NOT NULL THEN ca || '/clubs/' || v_club ELSE NULL END;
    END IF;
    IF t IN ('bonus','promotion','rakeback') THEN
        RETURN CASE WHEN v_club IS NOT NULL THEN ca || '/clubs/' || v_club || '/promotions' ELSE ca || '/bonuses' END;
    END IF;
    IF t IN ('achievement','achievement_unlocked') THEN
        RETURN ca || '/achievements';
    END IF;
    IF t IN ('like','comment','mention','post_like','post_comment','reply','tag') THEN
        IF v_post IS NOT NULL THEN
            RETURN CASE WHEN v_is_reel THEN '/hub/reels?id=' || v_post ELSE '/hub/social-media?post=' || v_post END;
        END IF;
        RETURN '/hub/social-media';
    END IF;
    IF t IN ('friend_request','friend_accept','friend_accepted','new_follow','follow','follow_request') THEN
        IF v_sender IS NOT NULL THEN
            BEGIN
                SELECT username INTO v_username FROM public.profiles WHERE id = v_sender::uuid LIMIT 1;
            EXCEPTION WHEN OTHERS THEN
                v_username := NULL;
            END;
        END IF;
        RETURN CASE WHEN v_username IS NOT NULL AND btrim(v_username) <> ''
                    THEN '/hub/user/' || public.fn_url_encode_segment(v_username)
                    ELSE '/hub/friends' END;
    END IF;
    IF t IN ('message','direct_message','new_message') THEN
        RETURN CASE WHEN v_convo IS NOT NULL THEN '/hub/messenger?conversation=' || v_convo ELSE '/hub/messenger' END;
    END IF;
    IF v_pagetype IS NOT NULL AND v_pageid IS NOT NULL THEN
        IF v_pagetype = 'venue'  THEN RETURN '/hub/venues/' || v_pageid; END IF;
        IF v_pagetype = 'tour'   THEN RETURN '/hub/tours/'  || v_pageid; END IF;
        IF v_pagetype = 'series' THEN RETURN '/hub/series/' || v_pageid; END IF;
        RETURN '/club/' || v_pageid;
    END IF;
    IF v_club   IS NOT NULL THEN RETURN '/club/' || v_club; END IF;
    IF v_pageid IS NOT NULL THEN RETURN '/hub/social-pages/' || v_pageid; END IF;
    IF v_post   IS NOT NULL THEN
        RETURN CASE WHEN v_is_reel THEN '/hub/reels?id=' || v_post ELSE '/hub/social-media?post=' || v_post END;
    END IF;
    IF v_tourn  IS NOT NULL THEN RETURN ca || '/tournaments/' || v_tourn; END IF;
    IF v_table  IS NOT NULL THEN RETURN ca || '/table/' || v_table; END IF;
    RETURN NULL;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_notification_fill_action_url()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NULLIF(btrim(COALESCE(NEW.link, '')), '') IS NULL
       AND NULLIF(btrim(COALESCE(NEW.action_url, '')), '') IS NULL THEN
        BEGIN
            NEW.action_url := public.fn_notification_action_url(NEW.type, NEW.data, NEW.metadata);
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'fn_notification_fill_action_url failed for type %: %', NEW.type, SQLERRM;
        END;
    END IF;
    RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.sync_notification_read_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_read boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_read := COALESCE(NEW.read_at IS NOT NULL, false) OR COALESCE(NEW.is_read, false) OR COALESCE(NEW.read, false);
  ELSE
    IF (NEW.read_at IS DISTINCT FROM OLD.read_at) THEN v_read := NEW.read_at IS NOT NULL;
    ELSIF (NEW.is_read IS DISTINCT FROM OLD.is_read) THEN v_read := COALESCE(NEW.is_read, false);
    ELSIF (NEW.read IS DISTINCT FROM OLD.read) THEN v_read := COALESCE(NEW.read, false);
    ELSE v_read := COALESCE(NEW.read_at IS NOT NULL, false) OR COALESCE(NEW.is_read, false) OR COALESCE(NEW.read, false);
    END IF;
  END IF;
  NEW.is_read := v_read; NEW.read := v_read;
  IF v_read THEN NEW.read_at := COALESCE(NEW.read_at, now()); ELSE NEW.read_at := NULL; END IF;
  RETURN NEW;
END; $function$;
REVOKE ALL ON FUNCTION public.fn_notification_fill_action_url() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_notification_read_state() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_notification_fill_action_url BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION fn_notification_fill_action_url();
CREATE TRIGGER trg_sync_notification_read_state BEFORE INSERT OR UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION sync_notification_read_state();

-- production columns, constraints and grants of public.operational_alert_events
CREATE TABLE public.operational_alert_events (
  id bigserial PRIMARY KEY,
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 120),
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 512),
  alertname text NOT NULL CHECK (length(alertname) BETWEEN 1 AND 240),
  status text NOT NULL CHECK (status IN ('firing','resolved','info')),
  severity text NOT NULL CHECK (length(severity) BETWEEN 1 AND 40),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text) <= 262144),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivery_count bigint NOT NULL DEFAULT 1,
  investigation_status text NOT NULL DEFAULT 'new'
    CHECK (investigation_status IN ('new','investigating','blocked','verified_fixed','historical','test')),
  investigation jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source, event_key)
);
ALTER TABLE public.operational_alert_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operational_alert_events FROM anon, authenticated;

-- recorder, verbatim from World Hub 20260913164000_operational_alert_inbox.sql
CREATE FUNCTION public.fn_record_operational_alert(
  p_source text, p_event_key text, p_alertname text, p_status text,
  p_severity text, p_payload jsonb
) RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload)
  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)
  ON CONFLICT (source,event_key) DO UPDATE
  SET last_received_at=clock_timestamp(), delivery_count=operational_alert_events.delivery_count+1
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
CREATE FUNCTION public.fn_record_operational_alerts(p_events jsonb)
RETURNS bigint[] LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE v_event jsonb; v_ids bigint[] := '{}';
BEGIN
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'expected 1 to 200 alert events';
  END IF;
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    v_ids := array_append(v_ids, public.fn_record_operational_alert(
      v_event->>'source',v_event->>'event_key',v_event->>'alertname',
      v_event->>'status',v_event->>'severity',v_event->'payload'));
  END LOOP;
  RETURN v_ids;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_record_operational_alerts(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_record_operational_alerts(jsonb) TO service_role;

-- fn_raise_notification, verbatim as production prints it, with its grants
CREATE OR REPLACE FUNCTION public.fn_raise_notification(p_user_id uuid, p_type text, p_title text, p_message text, p_link text DEFAULT NULL::text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_user_id IS NULL OR p_title IS NULL OR btrim(p_title) = '' THEN RETURN; END IF;
  INSERT INTO public.notifications (user_id, type, title, message, link, data)
  VALUES (p_user_id, p_type, p_title, p_message, p_link, COALESCE(p_data, '{}'::jsonb));
END; $function$;
REVOKE ALL ON FUNCTION public.fn_raise_notification(uuid,text,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;

-- owner destination component, verbatim from 20260916111614 (install guard and
-- push-mirror trigger swap omitted: this fixture has no push mirror)
-- Routing is a destination decision, independent of read state and push
-- preferences. Ordinary financial messages and account-security notices are
-- deliberately absent. NULL input must never become an unknown decision.
CREATE FUNCTION public.fn_is_owner_operational_notification(
  p_user uuid, p_type text, p_title text, p_data jsonb
) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public AS $body$
  SELECT COALESCE(p_user='47965354-0e56-43ef-931c-ddaab82af765'::uuid AND (
    p_type IN ('financial_incident','financial_incident_resolved','financial_attestation',
      'engine_break_failed','engine_break_recovered','guarantee_bank_short',
      'guarantee_bank_recovered','estate_digest')
    OR (p_type='system' AND (
      p_title IN ('Push Health Alert','Notifications May Not Be Reaching This Device')
      OR p_title ~ '^Horse Fleet (Alert|Recovered): '
      OR (jsonb_typeof(p_data)='object' AND p_data->>'component'='club-arena-engine'
        AND jsonb_typeof(p_data->'alertname')='string' AND NULLIF(p_data->>'alertname','') IS NOT NULL)
    ))
  ),false);
$body$;
REVOKE ALL ON FUNCTION public.fn_is_owner_operational_notification(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_is_owner_operational_notification(uuid,text,text,jsonb) TO anon,authenticated,service_role;

-- This durable destination outbox keeps the complete pre-routing original.
-- A recorder error cannot force a personal delivery or erase the alert. There
-- is no notification FK: deleting the producer row must not erase its evidence.
CREATE TABLE public.operational_notification_destinations (
  notification_id uuid PRIMARY KEY,
  recipient_user_id uuid NOT NULL CHECK (recipient_user_id='47965354-0e56-43ef-931c-ddaab82af765'::uuid),
  target_task_id uuid NOT NULL DEFAULT '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid
    CHECK (target_task_id='01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid),
  original_notification jsonb NOT NULL CHECK (jsonb_typeof(original_notification)='object'),
  inbox_event_id bigint REFERENCES public.operational_alert_events(id),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_attempt_at timestamptz,
  last_error text
);
ALTER TABLE public.operational_notification_destinations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operational_notification_destinations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.operational_notification_destinations TO service_role;
CREATE INDEX operational_notification_destinations_pending_idx
  ON public.operational_notification_destinations(captured_at,notification_id)
  WHERE inbox_event_id IS NULL;

-- Caller must already hold this destination row's transaction lock. The local
-- exception block rolls back a failed recorder attempt but retains the original
-- durable destination. It does not catch failures to persist the original.
CREATE FUNCTION public.fn_try_record_owner_notification(p_id uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $body$
DECLARE d public.operational_notification_destinations%ROWTYPE; n jsonb; v_id bigint;
  v_name text; v_status text; v_severity text;
BEGIN
  SELECT * INTO STRICT d FROM public.operational_notification_destinations
    WHERE notification_id=p_id FOR UPDATE;
  n := d.original_notification;
  BEGIN
    IF n->>'id' IS DISTINCT FROM p_id::text OR n->>'user_id' IS DISTINCT FROM d.recipient_user_id::text
      OR NOT public.fn_is_owner_operational_notification(d.recipient_user_id,n->>'type',n->>'title',n->'data') THEN
      RAISE EXCEPTION 'operational destination original identity mismatch';
    END IF;
    v_name := left(COALESCE(NULLIF(n->'data'->>'alertname',''),(n->>'type')||':'||(n->>'title')),240);
    v_status := CASE WHEN n->'data'->>'green'='true' OR (n->>'type') ~ '(_resolved|_recovered)$'
        OR (n->>'type'='system' AND (n->>'title') ~ '^Horse Fleet Recovered: ')
        THEN 'resolved' ELSE 'firing' END;
    v_severity := CASE WHEN n->'data'->>'severity' IN ('critical','warning','info')
        THEN n->'data'->>'severity' ELSE 'warning' END;
    v_id := d.inbox_event_id;
    IF v_id IS NULL THEN
      v_id := public.fn_record_operational_alert('owner-operational-notifications',p_id::text,
        v_name,v_status,v_severity,
        jsonb_build_object('original_notification',n,'captured_at',d.captured_at,
          'target_task_id',d.target_task_id));
    END IF;
    IF v_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.operational_alert_events e
      WHERE e.id=v_id AND e.source='owner-operational-notifications'
        AND e.event_key=p_id::text AND e.payload->>'target_task_id'=d.target_task_id::text
        AND e.alertname=v_name AND e.status=v_status AND e.severity=v_severity
        -- Existing intake preserves an earlier snapshot. Only acknowledgement
        -- state/timestamps may differ; content, identity and all other fields
        -- must match. The complete current original remains in the destination.
        AND ((e.payload->'original_notification')-ARRAY['read','is_read','read_at','updated_at'])
          =(n-ARRAY['read','is_read','read_at','updated_at'])
    ) THEN RAISE EXCEPTION 'operational destination receipt mismatch'; END IF;
    UPDATE public.operational_notification_destinations SET inbox_event_id=v_id,
      last_attempt_at=clock_timestamp(),last_error=NULL WHERE notification_id=p_id;
    RETURN v_id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.operational_notification_destinations SET inbox_event_id=NULL,last_attempt_at=clock_timestamp(),
      last_error=SQLSTATE||':'||left(SQLERRM,1000) WHERE notification_id=p_id;
    RETURN NULL;
  END;
END;
$body$;
REVOKE ALL ON FUNCTION public.fn_try_record_owner_notification(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_retry_owner_notification_destination(p_notification_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET statement_timeout = '8s' AS $body$
DECLARE v_id bigint;
BEGIN
  v_id := public.fn_try_record_owner_notification(p_notification_id);
  RETURN jsonb_build_object('notification_id',p_notification_id,
    'target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca', 'inbox_event_id',v_id);
END;
$body$;
REVOKE ALL ON FUNCTION public.fn_retry_owner_notification_destination(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_retry_owner_notification_destination(uuid) TO service_role;

CREATE FUNCTION public.fn_capture_owner_notification_destination()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $body$
BEGIN
  IF public.fn_is_owner_operational_notification(NEW.user_id,NEW.type,NEW.title,NEW.data) THEN
    INSERT INTO public.operational_notification_destinations(notification_id,recipient_user_id,original_notification)
      VALUES(NEW.id,NEW.user_id,to_jsonb(NEW));
    PERFORM public.fn_try_record_owner_notification(NEW.id);
    -- Preserve the original row byte-for-byte, including _push. The DB mirror
    -- predicate below and gateway destination branch suppress personal sends.
    -- This also lets the existing administrative reader recover the same exact
    -- original if the first recorder attempt failed.
  END IF;
  RETURN NEW;
END;
$body$;
REVOKE ALL ON FUNCTION public.fn_capture_owner_notification_destination() FROM PUBLIC,anon,authenticated,service_role;
-- Existing BEFORE INSERT route/read-state normalization runs first. The
-- destination and original notification commit or roll back together.
CREATE TRIGGER zz_capture_owner_notification_destination
  BEFORE INSERT ON public.notifications FOR EACH ROW
  EXECUTE FUNCTION public.fn_capture_owner_notification_destination();

CREATE FUNCTION public.fn_notification_has_personal_destination(p_id uuid,p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $body$
  SELECT p_user IS DISTINCT FROM '47965354-0e56-43ef-931c-ddaab82af765'::uuid
    OR NOT EXISTS (SELECT 1 FROM public.operational_notification_destinations d
      WHERE d.notification_id=p_id AND d.recipient_user_id=p_user
        AND d.target_task_id='01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid);
$body$;
REVOKE ALL ON FUNCTION public.fn_notification_has_personal_destination(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_notification_has_personal_destination(uuid,uuid) TO anon,authenticated,service_role;
-- Retains every existing permissive owner policy and adds a destination check.
-- Applies to authenticated direct reads and Realtime visibility, not just CSS.
CREATE POLICY personal_notification_destination ON public.notifications
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.fn_notification_has_personal_destination(id,user_id));
CREATE VIEW public.personal_notifications WITH (security_invoker=true) AS
  SELECT n.* FROM public.notifications n
  WHERE public.fn_notification_has_personal_destination(n.id,n.user_id);
REVOKE ALL ON public.personal_notifications FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.personal_notifications TO authenticated,service_role;

-- Explicit bounded historical intake, not a background repair or release watcher.
-- It also admits historical originals oldest-first at the tail of the existing
-- inbox. Repeated calls preserve old ids, payloads and investigation state.
CREATE FUNCTION public.fn_capture_owner_notification_history(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET statement_timeout = '8s' AS $body$
DECLARE n public.notifications%ROWTYPE; d record; added integer:=0; recorded integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'expected bounded limit 1..200';
  END IF;
  FOR n IN SELECT x.* FROM public.notifications x
    WHERE x.user_id='47965354-0e56-43ef-931c-ddaab82af765'::uuid
      AND public.fn_is_owner_operational_notification(x.user_id,x.type,x.title,x.data)
      AND NOT EXISTS (SELECT 1 FROM public.operational_notification_destinations y WHERE y.notification_id=x.id)
    ORDER BY x.created_at,x.id LIMIT p_limit
  LOOP
    INSERT INTO public.operational_notification_destinations(notification_id,recipient_user_id,original_notification)
      VALUES(n.id,n.user_id,to_jsonb(n)) ON CONFLICT(notification_id) DO NOTHING;
    added:=added+1;
  END LOOP;
  FOR d IN SELECT notification_id FROM public.operational_notification_destinations
    WHERE inbox_event_id IS NULL
    ORDER BY last_attempt_at NULLS FIRST,captured_at,notification_id LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF public.fn_try_record_owner_notification(d.notification_id) IS NOT NULL THEN recorded:=recorded+1; END IF;
  END LOOP;
  RETURN jsonb_build_object('candidates_seen',added,'inbox_receipts_recorded',recorded,
    'pending',EXISTS(SELECT 1 FROM public.operational_notification_destinations WHERE inbox_event_id IS NULL),
    'uncaptured',EXISTS(SELECT 1 FROM public.notifications x
      WHERE x.user_id='47965354-0e56-43ef-931c-ddaab82af765'::uuid
        AND public.fn_is_owner_operational_notification(x.user_id,x.type,x.title,x.data)
        AND NOT EXISTS(SELECT 1 FROM public.operational_notification_destinations captured WHERE captured.notification_id=x.id)));
END;
$body$;
REVOKE ALL ON FUNCTION public.fn_capture_owner_notification_history(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_capture_owner_notification_history(integer) TO service_role;
-- production has since withdrawn this grant from anon
REVOKE EXECUTE ON FUNCTION public.fn_notification_has_personal_destination(uuid,uuid) FROM anon;

-- Club Arena tables the three readers touch (production columns they use)
CREATE TABLE public.ca_incident_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL DEFAULT 'platform',
  scope_id uuid,
  user_id uuid NOT NULL,
  min_severity text NOT NULL DEFAULT 'warning',
  senior boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ca_break_scorecards (
  break_ended_at timestamptz NOT NULL,
  break_started_at timestamptz NOT NULL,
  hands_in_window integer,
  tables_dealing_in_window integer,
  thaw_ran boolean,
  thaw_frozen_seconds numeric,
  kill_rebuilds_after integer,
  recovery_seconds integer,
  pre_break_tables integer,
  shipped_sha text,
  shipped boolean,
  freeze_conserved boolean,
  freeze_delta numeric,
  verdict text NOT NULL DEFAULT 'unknown',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  unparked_at_countdown integer,
  peak_unparked integer,
  ready_for_restart_at timestamptz,
  gate_opened boolean
);
CREATE TABLE public.unions (id uuid PRIMARY KEY, name text, owner_id uuid);
CREATE TABLE public.union_wallets (union_id uuid PRIMARY KEY, chip_balance numeric NOT NULL DEFAULT 0);
CREATE TABLE public.clubs (id uuid PRIMARY KEY, union_id uuid, name text, chip_treasury numeric DEFAULT 0, owner_id uuid);
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, guaranteed_prize numeric,
  prize_pool numeric, prize_pool_finalized boolean DEFAULT false, status text);
CREATE TABLE public.ca_drift_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at timestamptz NOT NULL DEFAULT now(),
  severity text NOT NULL DEFAULT 'critical',
  status text NOT NULL DEFAULT 'open',
  source text NOT NULL,
  dedupe_key text NOT NULL,
  club_id uuid
);
CREATE TABLE public.ca_alarm_drills (
  id bigserial PRIMARY KEY, run_at timestamptz NOT NULL DEFAULT now(),
  pass boolean NOT NULL, failing text[], results jsonb NOT NULL);

-- TEST DOUBLE (not production source). fn_ca_raise_drift_incident with the
-- production signature and grants. It files a critical incident unless the
-- club is the drill's out-of-scope club, and notifies every active recipient
-- the way the production path does (fn_ca_incident_notify -> fn_raise_notification).
CREATE FUNCTION public.fn_ca_raise_drift_incident(p_source text, p_classification text, p_severity text,
  p_dedupe_key text, p_discrepancy numeric DEFAULT NULL::numeric, p_expected numeric DEFAULT NULL::numeric,
  p_actual numeric DEFAULT NULL::numeric, p_layer text DEFAULT NULL::text, p_entity_type text DEFAULT NULL::text,
  p_entity_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_union_id uuid DEFAULT NULL::uuid,
  p_table_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid,
  p_settlement_id text DEFAULT NULL::text, p_wallet_ids uuid[] DEFAULT NULL::uuid[],
  p_transaction_ids uuid[] DEFAULT NULL::uuid[], p_suspected_cause text DEFAULT NULL::text,
  p_ledger_balanced boolean DEFAULT NULL::boolean, p_metadata jsonb DEFAULT NULL::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $double$
DECLARE v_id uuid; r record;
BEGIN
  IF p_club_id = 'd08cf7f1-d50b-4e44-851c-8369ebbb706f'::uuid THEN RETURN NULL; END IF;
  INSERT INTO public.ca_drift_incidents(severity, source, dedupe_key, club_id)
  VALUES (p_severity, p_source, p_dedupe_key, p_club_id) RETURNING id INTO v_id;
  IF p_severity = 'critical' THEN
    FOR r IN SELECT user_id FROM public.ca_incident_recipients WHERE active LOOP
      PERFORM public.fn_raise_notification(r.user_id, 'financial_incident', left(p_dedupe_key, 110),
        'drill', '/hub/club-arena/financial-incidents', jsonb_build_object('incident_id', v_id, 'severity', 'critical'));
    END LOOP;
  END IF;
  RETURN v_id;
END $double$;
REVOKE ALL ON FUNCTION public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb) FROM PUBLIC, anon, authenticated;

-- the three production readers, verbatim as pg_get_functiondef printed them
CREATE OR REPLACE FUNCTION public.fn_ca_break_scorecard_push(p_row ca_break_scorecards)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_key TEXT; v_msg TEXT; v_why TEXT; r RECORD;
  v_reasons TEXT[];
  -- What a break that never started carries in detail. A row scored before
  -- 20260910132747 has no never_started key and reads as a break that ran.
  v_never_started BOOLEAN := COALESCE((p_row.detail->>'never_started')::boolean, false);
  v_fault_stage   TEXT    := p_row.detail->>'fault_stage';
  -- Capped so a long engine message cannot push the measurements off the end
  -- of the 500-character notification. The whole text stays in detail and in
  -- engine_maintenance_break_faults.
  v_fault_error   TEXT    := COALESCE(left(p_row.detail->>'fault_error', 200), 'No Error Recorded');
  v_never_text    TEXT;
BEGIN
  v_key := 'break-failed:' || to_char(p_row.break_ended_at, 'YYYYMMDD"T"HH24MI');
  IF EXISTS (SELECT 1 FROM public.notifications
              WHERE type = 'engine_break_failed' AND data->>'key' = v_key) THEN RETURN; END IF;

  SELECT array_agg(t.x) INTO v_reasons
    FROM jsonb_array_elements_text(COALESCE(p_row.detail->'reasons', '[]'::jsonb)) AS t(x);

  -- WHY THE BREAK NEVER STARTED, in the engine's own terms: the stage it
  -- failed at decides the sentence, and its error text goes in brackets.
  v_never_text := CASE
    WHEN v_fault_stage IS NULL THEN
      'The Break Never Started, And The Engine Recorded No Reason'
    WHEN v_fault_stage = 'announcement' THEN
      'The Break Never Started: The :53 Announcement Could Not Be Saved (' || v_fault_error || ')'
    WHEN v_fault_stage = 'boot' THEN
      'The Break Never Started: A Restarted Engine Could Not Declare It (' || v_fault_error || ')'
    ELSE
      'The Break Never Started (' || COALESCE(v_fault_stage, 'Unknown Stage') || ': ' || v_fault_error || ')'
  END;

  -- NEVER A BARE QUESTION MARK. "Recovery ?s" reads as a broken template
  -- rather than as an absent number, and the law
  -- `tests/the-break-clocks-agree.law.test.ts` pins that. Say the words.
  v_why := CASE
    WHEN v_reasons IS NULL OR array_length(v_reasons, 1) IS NULL THEN 'Unclassified'
    ELSE array_to_string(
      ARRAY(SELECT CASE x
              WHEN 'break_never_started' THEN v_never_text
              WHEN 'dealt_inside_break' THEN 'It Dealt '
                                             || COALESCE(p_row.hands_in_window::text, 'An Unmeasured Number Of')
                                             || ' Hands Inside The Break'
              WHEN 'thaw_did_not_run' THEN 'The Thaw Did Not Run'
              WHEN 'break_missed_its_window' THEN 'The Break Missed Its Window, Resuming '
                                             || COALESCE(round((p_row.detail->>'resumed_early_seconds')::numeric)::text || 's',
                                                         'An Unmeasured Time')
                                             || ' Early'
              ELSE x END
            FROM unnest(v_reasons) AS x), '. ')
  END;

  -- COALESCE every interpolated value. One NULL anywhere in a `||` chain makes
  -- the WHOLE message NULL, which is how an alert becomes a blank push nobody
  -- can act on. A break that never started has no recovery to measure, so it
  -- says so rather than printing a number measured across a break that did
  -- not happen.
  v_msg := 'Maintenance Break At ' || to_char(p_row.break_ended_at, 'HH24:MI')
    || ' Did Not Pass. ' || COALESCE(v_why, 'Unclassified')
    || '. Measured '
    || COALESCE(to_char((p_row.detail->>'measured_from')::timestamptz, 'HH24:MI:SS'), 'Not Recorded')
    || ' To '
    || COALESCE(to_char((p_row.detail->>'measured_to')::timestamptz, 'HH24:MI:SS'), 'Not Recorded')
    || ', Recovery '
    || CASE WHEN v_never_started THEN 'Not Applicable'
            ELSE COALESCE(p_row.recovery_seconds::text || 's', 'Not Measured') END
    || ', Shipped ' || CASE WHEN p_row.shipped THEN 'Yes' ELSE 'No' END;

  FOR r IN SELECT user_id FROM public.ca_incident_recipients WHERE active LOOP
    INSERT INTO public.notifications (user_id, type, title, message, data)
    VALUES (r.user_id, 'engine_break_failed', 'Engine Break Needs A Look', left(v_msg, 500),
            jsonb_build_object('key', v_key, 'break_ended_at', p_row.break_ended_at,
                               'reasons', COALESCE(p_row.detail->'reasons', '[]'::jsonb)));
  END LOOP;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_notify_guarantee_bank_short(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_union uuid; v_club_name text; v_union_name text;
  v_bank numeric; v_bank_label text; v_exposure numeric;
  v_recipients uuid[]; v_uid uuid; v_inserted integer := 0;
  v_title text; v_message text;
begin
  select c.union_id, c.name into v_union, v_club_name
    from public.clubs c where c.id = p_club_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'club_not_found');
  end if;

  if v_union is not null then
    select coalesce(uw.chip_balance, 0), u.name
      into v_bank, v_union_name
      from public.unions u
      left join public.union_wallets uw on uw.union_id = u.id
     where u.id = v_union;
    v_bank_label := 'union bank';

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t join public.clubs c2 on c2.id = t.club_id
     where c2.union_id = v_union
       and coalesce(t.guaranteed_prize,0) > 0
       and coalesce(t.prize_pool_finalized,false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');

    select array_agg(distinct uid) into v_recipients from (
      select u.owner_id as uid from public.unions u where u.id = v_union and u.owner_id is not null
      union
      select c.owner_id from public.clubs c where c.id = p_club_id and c.owner_id is not null
    ) o;
  else
    select coalesce(c.chip_treasury, 0) into v_bank
      from public.clubs c where c.id = p_club_id;
    v_bank_label := 'club bank';

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t
     where t.club_id = p_club_id
       and coalesce(t.guaranteed_prize,0) > 0
       and coalesce(t.prize_pool_finalized,false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');

    select array_agg(c.owner_id) into v_recipients
      from public.clubs c where c.id = p_club_id and c.owner_id is not null;
  end if;

  v_title := 'More Chips Needed To Cover Guarantees';
  v_message := 'The ' || v_bank_label || ' for '
            || coalesce(case when v_union is not null then v_union_name end, v_club_name, 'your club')
            || ' holds ' || round(v_bank, 2)
            || ' chips against ' || round(v_exposure, 2)
            || ' promised in live guarantees. New guaranteed tournaments cannot start until more chips are added to the bank.';

  foreach v_uid in array coalesce(v_recipients, '{}'::uuid[]) loop
    if not exists (
      select 1 from public.notifications n
       where n.user_id = v_uid
         and n.type = 'guarantee_bank_short'
         and coalesce(n.is_read, false) = false
         and n.data->>'bank_entity_id' = coalesce(v_union, p_club_id)::text
    ) then
      insert into public.notifications (user_id, type, title, message, data, is_read)
      values (v_uid, 'guarantee_bank_short', v_title, v_message,
              jsonb_build_object(
                'bank_type', case when v_union is not null then 'union' else 'club' end,
                'bank_entity_id', coalesce(v_union, p_club_id),
                'club_id', p_club_id, 'union_id', v_union,
                'bank_balance', v_bank, 'live_exposure', v_exposure,
                'short_by', round(greatest(v_exposure - v_bank, 0), 2)),
              false);
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'notified', v_inserted,
    'bank', v_bank, 'exposure', v_exposure,
    'recipients', coalesce(array_length(v_recipients, 1), 0));
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_alarm_drill()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_results jsonb := '[]'::jsonb;
  v_failing text[] := '{}';
  v_ok boolean; v_note text; v_n int; v_sev text;
  v_unarmed text[] := '{}'; v_silent text[] := '{}';
  c_midway_club constant uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  c_cert_user  constant uuid := '00000000-0000-0000-0000-000000000017';
  c_other_club constant uuid := 'd08cf7f1-d50b-4e44-851c-8369ebbb706f';
BEGIN
  SET LOCAL statement_timeout = '110s';
  SET LOCAL lock_timeout = '4s';
  -- THE DRILL ARMS ITSELF EVEN DURING THE MAINTENANCE BREAK. Transaction
  -- local, and every arm below unwinds; nothing outside this transaction
  -- can see it.
  PERFORM set_config('app.freeze_bypass', 'on', true);

  -- 1. negative balance fires
  v_ok := false; v_note := '';
  BEGIN
    PERFORM set_config('app.ledger_autoskip_club_members','1',true);
    BEGIN
      UPDATE club_members SET chip_balance = -3
       WHERE club_id = c_midway_club AND user_id = c_cert_user;
      -- the write stood, so the watcher is the only guard there is
      v_ok := public.fn_ca_negative_balance_watch() > 0;
    EXCEPTION WHEN check_violation THEN
      -- the store cannot go below zero at all, which is more than a
      -- detector could ever promise
      v_ok := true;
      v_note := 'refused by a check constraint before any detector was asked';
    END;
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','negative_balance','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := array_append(v_failing, 'negative_balance'); END IF;

  -- 2. suspense regression fires
  v_ok := false; v_note := '';
  BEGIN
    INSERT INTO chip_ledger (performed_by, from_type, to_type, amount, category, description)
    VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','settlement_suspense','club_treasury',
            60.00,'adjustment','alarm drill synthetic suspense');
    -- the check returns what it filed; an incident that was already open
    -- must not be able to make this arm pass
    v_ok := public.fn_ca_suspense_regression_check() > 0;
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','suspense_regression','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := array_append(v_failing, 'suspense_regression'); END IF;

  -- 3. mint velocity fires
  v_ok := false; v_note := '';
  BEGIN
    PERFORM set_config('app.ledger_category','mint',true);
    INSERT INTO chip_ledger (performed_by, from_type, to_type, to_entity_id, amount, category, description)
    VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','issuance_reserve','club_treasury',
            c_other_club, 300000.00, 'mint', 'alarm drill synthetic mint');
    PERFORM public.fn_ca_mint_velocity_watch();
    SELECT count(*) INTO v_n FROM ca_drift_incidents
     WHERE dedupe_key LIKE 'mint-velocity:%' AND status <> 'resolved';
    v_ok := v_n > 0;
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','mint_velocity','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := array_append(v_failing, 'mint_velocity'); END IF;

  -- 4. a raise in Midway scope files critical AND notifies; out of scope stays out
  v_ok := false; v_note := '';
  BEGIN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_alarm_drill','unknown','critical','alarm-drill-raise-probe', 1.00,
      NULL, NULL, 'ledger', 'drill', NULL, c_midway_club);
    SELECT count(*) INTO v_n FROM ca_drift_incidents
     WHERE dedupe_key = 'alarm-drill-raise-probe' AND severity = 'critical' AND status <> 'resolved';
    IF v_n = 1 THEN
      SELECT count(*) INTO v_n FROM notifications
       WHERE type='financial_incident' AND created_at > now() - interval '5 seconds';
      IF v_n > 0 THEN
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_alarm_drill','unknown','critical','alarm-drill-scope-probe', 1.00,
          NULL, NULL, 'ledger', 'drill', NULL, c_other_club);
        SELECT count(*) INTO v_n FROM ca_drift_incidents
         WHERE dedupe_key = 'alarm-drill-scope-probe';
        v_ok := v_n = 0;  -- the other-club raise must be filtered
        IF NOT v_ok THEN v_note := 'scope filter did not filter'; END IF;
      ELSE v_note := 'raise did not notify'; END IF;
    ELSE v_note := 'raise did not file critical'; END IF;
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','raise_scope_and_notify','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := array_append(v_failing, 'raise_scope_and_notify'); END IF;

  -- 5. conservation alerts map to info (quarantine intact)
  v_ok := false; v_note := '';
  BEGIN
    INSERT INTO financial_alerts (source, severity, message, context)
    VALUES ('fn_spin_chip_conservation_check','critical',
            'alarm drill conservation probe ' || clock_timestamp()::text, '{"minted_games":1}'::jsonb);
    SELECT severity INTO v_sev FROM ca_drift_incidents
     WHERE source = 'financial_alerts:fn_spin_chip_conservation_check'
     ORDER BY detected_at DESC LIMIT 1;
    v_ok := v_sev = 'info';
    IF NOT v_ok THEN v_note := 'mapped severity=' || COALESCE(v_sev,'NONE'); END IF;
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','conservation_quarantine','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := array_append(v_failing, 'conservation_quarantine'); END IF;

  -- 6. journals are append-only (chip + diamond)
  v_ok := false; v_note := '';
  BEGIN
    UPDATE chip_ledger SET amount = amount + 1
     WHERE id = (SELECT id FROM chip_ledger ORDER BY created_at DESC LIMIT 1);
    v_note := 'chip_ledger accepted a rewrite';
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%append-only%' THEN
      BEGIN
        DELETE FROM diamond_transactions
         WHERE id = (SELECT id FROM diamond_transactions LIMIT 1);
        v_note := 'diamond_transactions accepted a delete';
        RAISE EXCEPTION 'CA_DRILL_UNWIND';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM ILIKE '%append-only%' THEN v_ok := true;
        ELSIF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_note := left(SQLERRM, 120); END IF;
      END;
    ELSIF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','journals_append_only','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := array_append(v_failing, 'journals_append_only'); END IF;

  -- 7. deleting a balance-holding row journals its burn
  v_ok := false; v_note := '';
  BEGIN
    DELETE FROM club_members WHERE club_id = c_midway_club AND user_id = c_cert_user;
    SELECT count(*) INTO v_n FROM chip_ledger
     WHERE created_at > now() - interval '5 seconds'
       AND to_type = 'chip_retirement' AND category = 'burn' AND from_type = 'player_wallet';
    v_ok := v_n > 0;
    IF NOT v_ok THEN v_note := 'delete journaled no burn'; END IF;
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','delete_journals_burn','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := array_append(v_failing, 'delete_journals_burn'); END IF;

  -- 8. settlement state machine refuses an illegal jump
  v_ok := false; v_note := '';
  BEGIN
    INSERT INTO ca_settlements (id, settlement_type, external_ref, state, totals)
    VALUES (gen_random_uuid(), 'union_rakeback_close',
            'alarm-drill:' || clock_timestamp()::text, 'open', '{}'::jsonb);
    UPDATE ca_settlements SET state = 'final'
     WHERE external_ref LIKE 'alarm-drill:%' AND state = 'open';
    v_note := 'an illegal open to final jump was accepted';
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%invalid settlement transition%' THEN v_ok := true;
    ELSIF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','settlement_guard','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := array_append(v_failing, 'settlement_guard'); END IF;

  -- 9. corrections refuse to post without linkage
  v_ok := false; v_note := '';
  BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    v_ok := (public.fn_ca_post_correction('club_treasury', NULL, 'player_wallet', NULL,
             1.00, 'alarm drill probing the linkage requirement') ->> 'reason')
            = 'linkage_required_incident_or_write_failure';
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','correction_linkage','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := array_append(v_failing, 'correction_linkage'); END IF;

  -- record; page ONLY if an alarm stayed silent
  INSERT INTO public.ca_alarm_drills (pass, failing, results)
  VALUES (cardinality(v_failing) = 0, NULLIF(v_failing, '{}'), v_results);

  /* A DRILL THAT COULD NOT ARM IS NOT A SILENT DETECTOR. An arm that
     threw carries the error in its note and never reached its assertion;
     an arm that ran and found nothing has an empty note. Those are two
     different findings and only the second one is about a detector. */
  SELECT COALESCE(array_agg(r->>'check' ORDER BY r->>'check'), '{}')
    INTO v_unarmed
    FROM jsonb_array_elements(v_results) r
   WHERE COALESCE((r->>'pass')::boolean, false) IS NOT TRUE
     AND COALESCE(r->>'note', '') <> '';

  SELECT COALESCE(array_agg(r->>'check' ORDER BY r->>'check'), '{}')
    INTO v_silent
    FROM jsonb_array_elements(v_results) r
   WHERE COALESCE((r->>'pass')::boolean, false) IS NOT TRUE
     AND COALESCE(r->>'note', '') = '';

  IF cardinality(v_silent) > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_alarm_drill', 'unknown', 'critical',
      'alarm-drill-failed:' || to_char(now(), 'YYYY-MM-DD'),
      cardinality(v_silent), NULL, NULL, 'reporting', 'ca_alarm_drills',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'THE ALARM DRILL FAILED: ' || array_to_string(v_silent, ', ')
        || ' stayed silent when their drift condition was created. The detectors need repair before anything else.',
      true, jsonb_build_object('failing', v_silent, 'results', v_results));
  END IF;

  IF cardinality(v_unarmed) > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_alarm_drill', 'unknown', 'warning',
      'alarm-drill-unarmed:' || to_char(now(), 'YYYY-MM-DD'),
      cardinality(v_unarmed), NULL, NULL, 'reporting', 'ca_alarm_drills',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'THE ALARM DRILL COULD NOT ARM: ' || array_to_string(v_unarmed, ', ')
        || ' threw before their drift condition existed, so their detectors were never called and nothing was proven either way. Read the note on each arm in ca_alarm_drills. This is a defect in the drill, not evidence about the detectors.',
      true, jsonb_build_object('unarmed', v_unarmed, 'results', v_results));
  END IF;

  RETURN jsonb_build_object('pass', cardinality(v_failing) = 0,
                            'failing', v_failing, 'results', v_results);
END $function$;

-- production ownership and ACLs of the replaced functions
REVOKE ALL ON FUNCTION public.fn_ca_break_scorecard_push(public.ca_break_scorecards) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_break_scorecard_push(public.ca_break_scorecards) TO service_role;
REVOKE ALL ON FUNCTION public.fn_notify_guarantee_bank_short(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_notify_guarantee_bank_short(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_alarm_drill() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_alarm_drill() TO service_role;

-- MAINTAIN, where production grants it outside the defaults (PostgreSQL 17+)
DO $maintain$
BEGIN
  IF current_setting('server_version_num')::integer >= 170000 THEN
    EXECUTE 'GRANT MAINTAIN ON public.profiles TO authenticated';
  END IF;
END
$maintain$;
