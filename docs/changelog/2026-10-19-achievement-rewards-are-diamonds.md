# 2026-10-19 - Achievement rewards are diamonds, paid once on an unlock the server proves

Dan, 2026-10-19: "Pay achievement rewards as diamonds through award_diamonds_v2." and "NO, ONLY FROM NOW ON".

## What was wrong (read from production)

- Three of 23 achievements carry a reward: Royal Flush 500, Monthly Grinder (30-day login streak) 100, Centurion (100-day streak) 500. They were promised in chips through `add_to_promo_wallet` from the browser, which never paid (removed in #7424). No achievement had ever been paid.
- `fn_achievement_record_progress` took the target from the browser: sending target 1 unlocked anything. It took the progress from the browser too.
- The server's `training_achievement_definitions` already held the 23 ids, with threshold and reward 0 on every row.
- The login streak behind the two streak rewards (`profiles.login_streak`, `last_login_date`) was written by the browser.

## What changed (migration 20261019155445)

- The definitions table is the canonical list, with the same numbers the client catalog shows. A reward needs server `evidence` (CHECK); browsers cannot write the table.
- The browser door ignores its own target, refuses unknown ids and writes nothing for an evidence-backed achievement. What it can still unlock pays nothing.
- `fn_achievement_unlock_server` (owner-only) records an evidence-backed unlock and pays it once through `award_diamonds_v2` (`achievement`, reference `achievement:<id>:<user>`) on the transition to unlocked. Rows unlocked before the install are never paid. A frozen issuance leaves the achievement unearned so the next qualifying event pays it; the monthly 1,000-diamond achievement allowance in `award_diamonds_v2` still applies, as does a VIP diamond multiplier.
- Royal Flush: an AFTER INSERT trigger on `hand_history` reads the engine's own record (`daily_mission_events[*].magnitudes.strong_hands = 10`, the strongest hand that won the player a pot). Horses are paid alike (CLAUDE.md 10.5). It never fails the hand.
- Login streaks: `fn_achievement_record_login()` counts the UTC day on the server, keeps the streak columns itself (browser UPDATE revoked) and records streak 7/30/100. `AchievementTriggerService.onLogin` only calls it and announces what it reports.
- The unlock notification carries the diamonds actually credited (`data.diamonds_awarded`, "Royal Flush: +500 Diamonds"); the achievement badges, detail sheet, unlock pop-up and milestone toast show the reward with the platform diamond icon.

## Proof

`scripts/ci/test-achievement-diamonds-postgres.py` (workflow `achievement-diamonds-native-proof.yml`) installs production's pre-image bodies on a throwaway PostgreSQL 17 cluster, applies the migration byte for byte and proves every rule above. Pinned by `tests/achievement-rewards-are-diamonds-the-server-proves.law.test.ts`.

## Outside this change (found, not touched)

- About one horse-only hand in eight carries no `daily_mission_events` (all `has_human = false`, measured 2026-10-19), so a horse's Royal Flush in such a hand is not seen by this trigger, or by Daily Missions.
- `ProfileService.updateStreak` (no caller) still writes `login_streak` from the browser; with the column grant revoked it would now be refused if anything called it.
