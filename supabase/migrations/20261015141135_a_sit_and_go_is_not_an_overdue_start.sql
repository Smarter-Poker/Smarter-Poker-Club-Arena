-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_launch_health()'::regprocedure)='cebc498df2a40d8cbfdde241da836d19'
-- 20261015141135_a_sit_and_go_is_not_an_overdue_start.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- fn_ca_launch_health (20261015101222) read every tournament still
-- REGISTERING fifteen minutes after its start_time as an overdue start. A
-- Spin or a heads-up Sit and Go carries a start_time but starts when its last
-- seat is bought, so the first reading after install named 12 of them
-- (8 SPIN, 4 SNG, start_time 13:30 UTC) and turned the launch red for events
-- that were doing exactly what they should. Only a scheduled event (MTT,
-- SATELLITE) can be late to start; the predicate now says so. Nothing else in
-- the reading changes.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

DO $migration$
DECLARE
  sig constant regprocedure := 'public.fn_ca_launch_health()'::regprocedure;
  old_text constant text := $o$WHERE t.status = 'REGISTERING' AND t.start_time < now() - interval '15 minutes')$o$;
  new_text constant text := $n$WHERE t.status = 'REGISTERING' AND t.tournament_type IN ('MTT', 'SATELLITE') AND t.start_time < now() - interval '15 minutes')$n$;
  src text; meta_before text; meta_after text;
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres'
     OR NULLIF(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'launch_health_sng_operator_refused' USING ERRCODE = '42501';
  END IF;
  SELECT p.prosrc, format('%s|%s|%s|%s|%s', p.proowner::regrole, p.proacl, p.proconfig, p.prosecdef, p.provolatile)
    INTO src, meta_before FROM pg_proc p WHERE p.oid = sig;
  IF md5(src) <> 'de2ad3b6be750edf134abc93fe53f12a' THEN
    RAISE EXCEPTION 'launch_health_sng_preimage_refused';
  END IF;
  IF (length(src) - length(replace(src, old_text, ''))) / length(old_text) <> 1 THEN
    RAISE EXCEPTION 'launch_health_sng_anchor_refused';
  END IF;
  EXECUTE replace(pg_get_functiondef(sig), old_text, new_text);
  SELECT p.prosrc, format('%s|%s|%s|%s|%s', p.proowner::regrole, p.proacl, p.proconfig, p.prosecdef, p.provolatile)
    INTO src, meta_after FROM pg_proc p WHERE p.oid = sig;
  IF md5(src) <> 'cebc498df2a40d8cbfdde241da836d19' THEN
    RAISE EXCEPTION 'launch_health_sng_postimage_refused: %', md5(src);
  END IF;
  IF meta_after IS DISTINCT FROM meta_before THEN
    RAISE EXCEPTION 'launch_health_sng_security_refused';
  END IF;
END
$migration$;

COMMIT;
