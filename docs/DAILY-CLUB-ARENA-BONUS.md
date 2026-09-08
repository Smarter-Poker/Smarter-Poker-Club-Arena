# Daily Club Arena Bonus

A reward sheet every player sees on entering Club Arena, every day: one tile
per reward, each tile claimed by hand (PokerBros style), gone at midnight
America/Chicago. Dan, 2026-09-07. Plan: the "Daily Club Arena Bonus" artifact
in Dan's Claude gallery; rulings and live state below are the source of truth.

## Rulings (Dan, 2026-09-05 to 2026-09-07)

- Nothing ever earns chips, only diamonds. A tile pays diamonds or a consumable
  the player would otherwise buy with diamonds. Never a chip.
- 1 diamond = 1 cent, 1 chip = 1 dollar. Every calendar amount is cents.
- A single player is bounded by the existing diamond guidelines: 110 free /
  150 VIP a day, 3,300 / 4,500 a month, 3,750 a month from this family, 125 a
  claim. There is NO platform limit, only the per-user limits.
- Everything player-facing is premium: depth, 3D metallic, like the lobby.
  Use the painted shell kit (`components/club-buttons`, `assets/club-buttons`).
- Horses are players on every diamond path (Diamond Accounting Standard D22);
  certification fixtures are not.

## Phases

| Phase | What                                                                                                                                                               | State                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 0     | Retire the chip ladder (`20260907232514_a_daily_bonus_pays_nothing_in_chips`), remove the wheel / Bonus page UI, `/bonuses` redirects to Promotions                | Live in prod; PR #3585               |
| 1     | Ledger: calendar, days, claims, `fn_ca_daily_bonus_status`, `fn_ca_daily_bonus_claim`, caps, budget counter, `feature_purchases.source`                            | Live in prod; this branch mirrors it |
| 2     | The sheet: tiles on the club-utility shell, week strip, countdown, per-tile Claim, entry trigger in the shell, header gift icon, Promotions card, `/bonuses` route | Next                                 |
| 3     | Mystery reveal animation, 24h mission boost (`player_boosts`), Streak Shield, chest days                                                                           |                                      |
| 4     | Operator panel in the Financial Admin Hub: calendar editor (history-tracked), claims, streak distribution, retention                                               |                                      |
| 5     | Cut over the World Hub `daily_login` action to this streak; seed existing streaks; burn-in                                                                         |                                      |

## How it pays (phase 1, live)

- `ca_daily_bonus_calendar` is the ladder as data (cents). `cycle_day` 1..7
  repeats weekly; `streak_day` rows (14, 30) replace a whole day. Players
  cannot read it. Edits are history-tracked. Amounts are Dan's to set.
- `fn_ca_daily_bonus_status()` opens today's `ca_daily_bonus_days` row on
  first read (streak + tile snapshot, mystery already rolled) and returns
  tiles with claim state, the week strip, tomorrow's preview, seconds to
  reset, the streak multiplier and the player's cap position.
- `fn_ca_daily_bonus_claim(p_slot, p_request_id)`: advisory lock per player,
  request-id replay returns the stored result and pays nothing, refuses a
  claimed or missing tile and a VIP tile for a non-VIP, then grants:
  diamonds through `award_diamonds_v2('daily_bonus', ref ca_daily_bonus:<user>:<date>:<slot>)`,
  consumables as `feature_purchases` rows at cost 0, `source = 'daily_bonus'`,
  expiring in 7 days (`throwable`, `rabbit_hunt`, `time_bank_seconds`, which
  their consumers already spend from). The first claim of the day is what
  advances the streak; an unclaimed day resets it to 1.
- The diamond tile scales by `fn_get_streak_multiplier(streak)` (1.2 / 1.5 /
  1.8 / 2.0 at 3 / 7 / 14 / 30 days), clamped to 125.
- The earn ledger files every diamond under engine `club_arena_daily`
  (`fn_ca_diamond_engine_of`), whose budget is a counter, not a ceiling.
- `fn_guard_profile_privileged_columns` admits the claim on its call stack,
  the same way it admits the Daily Missions claim.

## Verification record (2026-09-07, rolled-back probes on production)

status, three claims (diamonds, throwables, VIP), replay idempotent, re-claim
refused, missing tile refused, non-VIP refused on the VIP tile, fixture
refused, day-7 pays 75 at 1.5x, day-14 chest and mystery reveal, journal rows
carry the reference and land on the `club_arena_daily` line, `feature_purchases`
credit at cost 0 with source, `fn_ca_daily_bonus_caps` reports 110/3300/3750
for a free player.
