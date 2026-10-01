-- ═══════════════════════════════════════════════════════════════════════
-- owner_switches_the_fleet_engine_on
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        2 (data: one column of the single public.content_settings row; no schema change)
-- AUTHOR:      Claude (Cowork session 014itMNpU4PSxe29DNWH5kt4), Fleet Content Programme, after owner approval
-- AFFECTS:     public.content_settings.engine_enabled (and updated_at) on the single settings row; nothing else
-- IRREVERSIBLE: no (rollback block at the end switches it off again; every fleet route re-reads the
--              switch at entry and before each horse, so a rollback stops runs in flight)
--
-- WHY:
--   The master switch has been off since 2026-09-06 17:15Z (first engine_disabled run of /cron/horse-posts
--   at 18:10Z that day). Since then Phases 1 to 6 were recertified and repaired (workers #143, #152, #153;
--   World Hub #1943, #1944, #1945, #2020), the owner reviewed fresh zero-write samples of every mode and
--   replied "everything is approved" on 2026-09-29, and migration 20260929224413 recorded that approval on
--   the five previously unapproved horse_post_modes rows (nine enabled modes in total). The one remaining
--   engineering prerequisite, the same one-post-per-horse-per-slot key in the isolated video producer
--   (workers PR #154, live at d2d3e9d4eb93 since 2026-09-30 03:04:57Z), is deployed. Switching the engine on lets
--   /cron/horse-posts, /cron/horses-social-all, /cron/horses-social-friends, /cron/horses-stories and the
--   daily /cron/phase6-content route run again; horse DM replies stay held by HORSE_DM_REPLIES_ENABLED=false.
--
-- EVIDENCE: exactly one content_settings row, engine_enabled=false at pre-flight.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. PRE-FLIGHT: exactly one settings row and the switch is off.
DO $$
DECLARE n int; off int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE engine_enabled = false) INTO n, off FROM public.content_settings;
  IF n <> 1 THEN RAISE EXCEPTION 'pre-flight: expected exactly 1 content_settings row, found %', n; END IF;
  IF off <> 1 THEN RAISE EXCEPTION 'pre-flight: expected engine_enabled=false, found it already on'; END IF;
END $$;

-- 2. CHANGE
UPDATE public.content_settings
   SET engine_enabled = true,
       updated_at = now()
 WHERE engine_enabled = false;

-- 3. POST-APPLY
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.content_settings WHERE engine_enabled = true;
  IF n <> 1 THEN RAISE EXCEPTION 'post-apply: expected engine_enabled=true on the single row, found %', n; END IF;
END $$;

COMMIT;

-- ROLLBACK (manual, if ever needed; takes effect within 30 seconds on every fleet route, including runs in flight):
-- BEGIN;
-- UPDATE public.content_settings SET engine_enabled = false, updated_at = now();
-- COMMIT;
