-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831190926; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Exposed-surface reduction, wave 1: dead backup/audit relics (2026-08-31).
--
-- PostgREST's schema cache loads every relation in the exposed schema; on this
-- database the load takes ~28s and every DDL statement triggers it (see the
-- pgrst_reload_watchdog migration). These 13 tables are one-off backups and
-- audit scratch from past incidents. Evidence, checked today:
--   - zero scans and zero writes in pg_stat_user_tables
--   - zero references in any function body, cron command, view, matview or
--     RLS policy
--   - zero FK links in or out
--   - zero references in any repo on the dev machine outside .agent/audits
--     history write-ups (Club Arena, World Hub, and every other
--     Smarter-Poker-* product repo)
-- They keep their data, unchanged, in zz_archive - out of the API surface and
-- the schema cache. Restore path: ALTER TABLE zz_archive.<t> SET SCHEMA public.
--
-- Deliberately NOT moved (referenced in live function bodies):
--   _pps_backfill_state, deprecated_tables, signup_errors_archive.
-- Function-surface reduction is a separate program: with 14+ product repos
-- calling this database, code greps cannot prove a function unused - do not
-- move or drop public functions on grep evidence alone.

CREATE SCHEMA IF NOT EXISTS zz_archive;
REVOKE ALL ON SCHEMA zz_archive FROM PUBLIC, anon, authenticated;

ALTER TABLE public._audit_horse_avatar_restore_20260815 SET SCHEMA zz_archive;
ALTER TABLE public._audit_phase40_results SET SCHEMA zz_archive;
ALTER TABLE public.avatar_photo_migration_backup SET SCHEMA zz_archive;
ALTER TABLE public.club_member_daily_stats_profit_backup_20260826 SET SCHEMA zz_archive;
ALTER TABLE public.commander_blind_structure_backup_20260822 SET SCHEMA zz_archive;
ALTER TABLE public.commander_finish_position_backup_20260820 SET SCHEMA zz_archive;
ALTER TABLE public.horse_avatar_swap_backup SET SCHEMA zz_archive;
ALTER TABLE public.social_posts_thumbnail_backup_20260815 SET SCHEMA zz_archive;
ALTER TABLE public.vip_backfill_20260812_backup SET SCHEMA zz_archive;
ALTER TABLE public.wallet_transactions_phantom_archive SET SCHEMA zz_archive;
ALTER TABLE public.zz_reopen_20260830_backup SET SCHEMA zz_archive;
ALTER TABLE public.zz_reopen2_20260830_backup SET SCHEMA zz_archive;
ALTER TABLE public.zz_reopen3_20260830_backup SET SCHEMA zz_archive;
