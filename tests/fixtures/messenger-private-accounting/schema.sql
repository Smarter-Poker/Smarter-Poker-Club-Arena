\set ON_ERROR_STOP on
-- Captured missing table only. UNRUN protected fixture supplement, not a migration.
-- Source: captured-catalog.json, 2026-09-15T02:37:55.2878+00:00.
-- Load after the captured full schema. Preserve its existing helpers and roles.
DO $supplement_prerequisites$
BEGIN
 IF current_user <> 'postgres' OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN
  RAISE EXCEPTION 'messenger supplement requires the protected PostgreSQL 17 postgres fixture'; END IF;
 IF to_regclass('public.notification_preferences') IS NOT NULL THEN
  RAISE EXCEPTION 'messenger supplement refuses an existing notification_preferences relation'; END IF;
 IF to_regclass('public.profiles') IS NULL
  OR to_regclass('public.social_messages') IS NULL
  OR to_regclass('public.social_conversation_participants') IS NULL
  OR to_regclass('public.accounting_conversations') IS NULL
  OR to_regclass('public.accounting_invoice_deliveries') IS NULL
  OR to_regclass('public.settlement_invoices') IS NULL
  OR to_regprocedure('auth.uid()') IS NULL
  OR to_regprocedure('auth.role()') IS NULL
  OR to_regprocedure('public.fn_caller_is_engine()') IS NULL
  OR to_regprocedure('public.fn_is_platform_admin()') IS NULL THEN
  RAISE EXCEPTION 'messenger supplement requires the existing captured full schema and authentication helpers'; END IF;
 IF to_regprocedure('public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)') IS NOT NULL
  OR to_regprocedure('public.fn_messenger_accounting_threads(uuid,uuid[])') IS NOT NULL
  OR to_regprocedure('public.fn_messenger_search_messages(uuid,uuid[],text,integer)') IS NOT NULL THEN
  RAISE EXCEPTION 'messenger supplement refuses existing reader definitions'; END IF;
END $supplement_prerequisites$;

CREATE TABLE public.notification_preferences (
 id uuid DEFAULT gen_random_uuid() NOT NULL,
 user_id uuid,
 push_enabled boolean DEFAULT true,
 email_enabled boolean DEFAULT true,
 sms_enabled boolean DEFAULT false,
 marketing_enabled boolean DEFAULT false,
 tournament_alerts boolean DEFAULT true,
 social_alerts boolean DEFAULT true,
 training_alerts boolean DEFAULT true,
 preferences jsonb DEFAULT '{}'::jsonb,
 created_at timestamp with time zone DEFAULT now(),
 updated_at timestamp with time zone DEFAULT now(),
 mute_all boolean DEFAULT false NOT NULL,
 browser_push boolean DEFAULT false NOT NULL,
 push_type_prefs jsonb DEFAULT '{}'::jsonb NOT NULL,
 quiet_hours_start smallint,
 quiet_hours_end smallint,
 quiet_hours_tz text,
 daily_push_cap integer DEFAULT 0 NOT NULL,
 CONSTRAINT notification_preferences_daily_push_cap_check CHECK ((daily_push_cap >= 0)),
 CONSTRAINT notification_preferences_pkey PRIMARY KEY (id),
 CONSTRAINT notification_preferences_quiet_hours_end_check CHECK (((quiet_hours_end IS NULL) OR ((quiet_hours_end >= 0) AND (quiet_hours_end <= 23)))),
 CONSTRAINT notification_preferences_quiet_hours_start_check CHECK (((quiet_hours_start IS NULL) OR ((quiet_hours_start >= 0) AND (quiet_hours_start <= 23)))),
 CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
 CONSTRAINT notification_preferences_user_id_key UNIQUE (user_id)
);
ALTER TABLE public.notification_preferences OWNER TO postgres;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences NO FORCE ROW LEVEL SECURITY;

-- The captured two valid/ready btree unique indexes are created by the named
-- PRIMARY KEY and UNIQUE constraints above. Do not create duplicate indexes.
CREATE POLICY notification_preferences_self_select ON public.notification_preferences
 AS PERMISSIVE FOR SELECT TO authenticated
 USING ((user_id = ( SELECT auth.uid() AS uid)) OR public.fn_is_platform_admin());
CREATE POLICY np_ins ON public.notification_preferences
 AS PERMISSIVE FOR INSERT TO PUBLIC
 WITH CHECK (( SELECT auth.uid() AS uid) = user_id);
CREATE POLICY np_upd ON public.notification_preferences
 AS PERMISSIVE FOR UPDATE TO PUBLIC
 USING (( SELECT auth.uid() AS uid) = user_id);
-- No triggers were returned by this capture. No preferences rows are seeded.
