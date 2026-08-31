-- Applied to production 2026-08-31 ~19:05 UTC via mgmt API.
-- Exposed-surface reduction, wave 1: 13 dead backup/audit relics moved to
-- zz_archive (out of the API surface and PostgREST's schema cache). Evidence:
-- zero scans/writes, zero references in any function/cron/view/policy, zero
-- FK links, zero references in any repo outside .agent/audits history.
-- Deliberately NOT moved (referenced in live function bodies):
-- _pps_backfill_state, deprecated_tables, signup_errors_archive.
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
