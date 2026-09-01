-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829142014; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

COMMENT ON COLUMN public.profiles.login_streak IS
  'LIVE. Consecutive-day login count. Maintained by AchievementTriggerService.onLogin, which claims the day against last_login_date BEFORE writing, so a page reload cannot advance it. This is the streak column - not streak_days.';

COMMENT ON COLUMN public.profiles.streak_days IS
  'DEAD as of 2026-08-29. Zero across all 1,023 profiles and never written by any code in this estate. DO NOT WIRE ANYTHING TO IT: BonusPage once read it and rendered a hardcoded day*10 chips ladder that disagreed with both BonusService and the claim RPC. The live streak is profiles.login_streak.';

COMMENT ON COLUMN public.profiles.last_login IS
  'LIVE. Full timestamptz of the last sign-in, written by AuthPage. Used for dormancy display on the club roster. For streak arithmetic use last_login_date, which is the UTC DAY and is what onLogin compares against.';

COMMENT ON COLUMN public.profiles.last_login_date IS
  'LIVE. The UTC DAY of the last sign-in. The day guard for login_streak: onLogin returns immediately when this already equals today, so the streak advances at most once per day no matter how many auth events fire.';
