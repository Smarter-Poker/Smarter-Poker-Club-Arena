# 2026-10-19: browser calls that could never succeed are gone

Club Arena client clean-up on launch day. Every item below called something a
player's browser is not allowed to run, so it failed every time.

- **Achievement rewards.** `AchievementService` called `add_to_promo_wallet`
  on an unlock. Players cannot execute it, and since 2026-09-03 it refuses every
  caller (the promo pool is retired: an achievement reward needs a funded
  source first). The call is removed, and so is the browser-side notification
  insert: `trg_notify_achievement_unlocked` already raises it in the database.
  The unlock toast no longer advertises chips that are not paid. Whether, and
  from what source, achievement rewards are paid is Dan's decision.
- **Recalculate Level** (club dashboard) called `recompute_club_levels`, which
  only the service role may run. The button is removed; the level is
  recomputed by the database on every rake and membership change.
- **Leaving a table** inserted a `table_activity` row; players hold no INSERT
  on that table. Removed.
- **Sign-up** read `profiles.email` and upserted `diamonds`, neither of which a
  player may touch. Removed; `handle_new_user` creates the profile.
- **Dead code with no callers**, each calling something a player cannot run:
  `WalletService.lockForBuyIn` and the store's `lockForBuyIn`,
  `ChipFlowService.resetBalance`, `PromotionService.applyDepositBonus` and
  `processReferral`, `TournamentService.checkTableMerge` and `balanceTables`,
  `CommissionService.generatePeriodPayouts`, `LeaderboardService.updateHandStats`,
  `RealtimeChannelService.streamHandReplay`.
- Two `prefer-const` lint errors in the lobby filter and view preference
  writers.

Not changed: the hourly "permission denied" on `bump_challenge_progress`,
`assign_user_challenges` and `increment_challenge_progress` comes from
`tests/e2e/production-daily-missions.spec.ts`, which proves a browser session
is refused. Those errors are the test passing.
