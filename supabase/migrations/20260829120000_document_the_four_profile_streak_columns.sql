-- ═══════════════════════════════════════════════════════════════════════════
--  profiles has FOUR streak-ish columns. Two are live, one is dead, one is
--  adjacent. Say which is which, on the columns themselves.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY
--
-- `login_streak`, `streak_days`, `last_login` and `last_login_date` sit beside
-- each other with names that do not distinguish them. The 2026-08-29 audit
-- measured all four against production:
--
--   login_streak      4 of 1,023 profiles non-zero, max 1   <- LIVE, just revived
--   streak_days       0 of 1,023 non-zero, max 0            <- DEAD, never written
--   last_login        1,023 of 1,023 set                    <- LIVE
--   last_login_date   1,023 of 1,023 set                    <- LIVE
--
-- The reason `login_streak` reads so low is that it had been dead too until
-- 2026-08-29: `onLogin` looped three streak achievements on EVERY Supabase auth
-- event (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED) with no day guard, so
-- reloading the page advanced "Log in 7 days in a row" — and `streak_30` pays
-- 100 chips, `streak_100` pays 500. Fixed by claiming the day against
-- `last_login_date` before writing anything. The counts above are that fix
-- starting from a clean slate.
--
-- `streak_days` is the trap. It is not merely unused: BonusPage USED to read it
-- and render a hardcoded `day * 10` chips ladder from it, which was a third
-- independent idea of what the daily bonus pays, disagreeing with both
-- BonusService's schedule and the claim RPC. That reader is gone. SettingsPage
-- still SELECTed it into a data export and never read the value; removed in the
-- same commit as this migration.
--
-- WHY A COMMENT AND NOT A DROP
--
-- A DROP on a live 1,023-row table that four surfaces read from is a Tier 3
-- change needing a rollback plan, and it buys nothing here: the column is
-- already all zeroes and costs nothing to carry. What actually caused the harm
-- was AMBIGUITY — somebody grepping, finding a name that sounds right, and
-- wiring a bonus ladder to it. A comment is where a schema reader looks, and it
-- travels with the column.
--
-- Tier 1 (comments only). No data is read or written. Nothing to roll back
-- beyond re-issuing a COMMENT.

COMMENT ON COLUMN public.profiles.login_streak IS
  'LIVE. Consecutive-day login count. Maintained by AchievementTriggerService.onLogin, '
  'which claims the day against last_login_date BEFORE writing, so a page reload cannot '
  'advance it. This is the streak column - not streak_days.';

COMMENT ON COLUMN public.profiles.streak_days IS
  'DEAD as of 2026-08-29. Zero across all 1,023 profiles and never written by any code '
  'in this estate. DO NOT WIRE ANYTHING TO IT: BonusPage once read it and rendered a '
  'hardcoded day*10 chips ladder that disagreed with both BonusService and the claim RPC. '
  'The live streak is profiles.login_streak.';

COMMENT ON COLUMN public.profiles.last_login IS
  'LIVE. Full timestamptz of the last sign-in, written by AuthPage. Used for dormancy '
  'display on the club roster. For streak arithmetic use last_login_date, which is the '
  'UTC DAY and is what onLogin compares against.';

COMMENT ON COLUMN public.profiles.last_login_date IS
  'LIVE. The UTC DAY of the last sign-in. The day guard for login_streak: onLogin returns '
  'immediately when this already equals today, so the streak advances at most once per '
  'day no matter how many auth events fire.';
