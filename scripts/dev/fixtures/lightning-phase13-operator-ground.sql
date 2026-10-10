-- Lightning Phase 13: the operator ground, as one re-appliable file.
--
-- The Phase 12 load, stress and chaos rig (scripts/dev/test-lightning-phase12-load-chaos.sh)
-- builds the Lightning chain on the Phase 11 harness's ground, which carries
-- neither production's operator gates nor the managed cron API. The Phase 12
-- operator file (20261009144343), the Phase 11 remediation (20261009181945)
-- and the Phase 13 file (20261009235505) need both. This file is that ground,
-- column for column and body for body as PokerIQ-Production carries the parts
-- they read (2026-10-09), written so it can be applied twice: the rig applies
-- every extra file twice, so its CI step runs the production chain through
-- Phase 13 under load and chaos with
--   LIGHTNING_P12_EXTRA="<this file> 20261009144343 20261009151825 20261009181945 20261009235505".
-- It is a fixture: it moves no money and no migration reads it.

-- PRODUCTION'S TABLE AND SEQUENCE DEFAULTS (pg_default_acl for postgres in
-- public): every new table and sequence is born granted to anon,
-- authenticated and service_role, and a file that creates one must take them back.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO anon, authenticated, service_role;

-- THE GATE GROUND: profiles.role, clubs.owner_id and status, club_members
-- role, status and is_active, cash_games.closed_at.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS role text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.club_members ADD COLUMN IF NOT EXISTS is_active boolean;
ALTER TABLE public.cash_games ADD COLUMN IF NOT EXISTS closed_at timestamptz;

CREATE OR REPLACE FUNCTION public.fn_is_platform_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  RETURN v_role IN ('admin', 'superadmin', 'god');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_can_review_integrity(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_club_id IS NOT NULL
     AND auth.uid() IS NOT NULL
     AND (
       coalesce(fn_is_platform_admin(), false)
       OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid())
       OR EXISTS (
         SELECT 1 FROM club_members cm
          WHERE cm.club_id = p_club_id
            AND cm.user_id = auth.uid()
            AND cm.role IN ('owner', 'co_owner', 'admin')
            AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
       )
     );
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_is_club_control(p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.club_members m
      WHERE m.club_id = p_club_id
        AND m.user_id = p_user_id
        AND COALESCE(m.is_active, true)
        AND COALESCE(m.status, 'active') IN ('active', 'approved')
        AND m.role IN ('owner', 'co_owner', 'admin')
    )
    OR EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = p_user_id)
  );
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_is_platform_admin(), public.fn_ca_can_review_integrity(uuid),
                           public.fn_ca_is_club_control(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_is_platform_admin(), public.fn_ca_can_review_integrity(uuid),
                          public.fn_ca_is_club_control(uuid, uuid) TO authenticated, service_role;

-- THE MANAGED CRON API (pg_cron 1.6.4's signatures): cron.job is read, and
-- written through cron.schedule, cron.alter_job and cron.unschedule.
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (
  jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost', nodeport integer NOT NULL DEFAULT 5432,
  database text NOT NULL DEFAULT current_database(), username text NOT NULL DEFAULT current_user,
  active boolean NOT NULL DEFAULT true, jobname text UNIQUE);
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $c$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid;
$c$;
CREATE OR REPLACE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
                                          database text DEFAULT NULL, username text DEFAULT NULL,
                                          active boolean DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $c$
BEGIN
  UPDATE cron.job j SET schedule = coalesce(alter_job.schedule, j.schedule),
                        command = coalesce(alter_job.command, j.command),
                        database = coalesce(alter_job.database, j.database),
                        username = coalesce(alter_job.username, j.username),
                        active = coalesce(alter_job.active, j.active)
   WHERE j.jobid = job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job % does not exist or you don''t own it', job_id; END IF;
END $c$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text) RETURNS boolean
LANGUAGE sql AS $c$ DELETE FROM cron.job WHERE jobname = job_name RETURNING true $c$;
