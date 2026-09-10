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

| Phase | What                                                                                                                                                               | State                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| 0     | Retire the chip ladder (`20260907232514_a_daily_bonus_pays_nothing_in_chips`), remove the wheel / Bonus page UI, `/bonuses` redirects to Promotions                | Live in prod; PR #3585                      |
| 1     | Ledger: calendar, days, claims, `fn_ca_daily_bonus_status`, `fn_ca_daily_bonus_claim`, caps, budget counter, `feature_purchases.source`                            | Live in prod; PR #3588                      |
| 2     | The sheet: tiles on the club-utility shell, week strip, countdown, per-tile Claim, entry trigger in the shell, header gift icon, Promotions card, `/bonuses` route | Live in prod; PRs #3593, #3621, #4021       |
| 3     | Lucky multiplier on the mystery tile, 24h Mission Boost (`player_boosts`), Streak Shield, the day-14 / day-30 chests carry a shield                                | Ledger live in prod 2026-09-10; this branch |
| 4     | Operator panel in the Financial Admin Hub: calendar editor (history-tracked), claims, streak distribution, retention                                               |                                             |
| 5     | Cut over the World Hub `daily_login` action to this streak; seed existing streaks; burn-in                                                                         |                                             |

## How it pays (phase 1, live)

- `ca_daily_bonus_calendar` is the ladder as data (cents). `cycle_day` 1..7
  repeats weekly; `streak_day` rows (14, 30) replace a whole day. Players
  cannot read it. Edits are history-tracked. Amounts are Dan's to set.
- `fn_ca_daily_bonus_status()` opens today's `ca_daily_bonus_days` row on
  first read (streak + tile snapshot, mystery already rolled) and returns
  tiles with claim state, the week strip, tomorrow's preview, seconds to
  reset, the streak multiplier and the player's cap position.
- `fn_ca_daily_bonus_claim(p_slot, p_request_id, p_user_id, p_bonus_date)`:
  advisory lock per player, request-id replay returns the stored result and
  pays nothing, refuses `day_rolled_over` when `p_bonus_date` (the day the
  sheet showed) is not the server's today (2026-09-09; nothing opened, nothing
  paid), refuses a claimed or missing tile and a VIP tile for a non-VIP, then
  grants:
  diamonds through `award_diamonds_v2('daily_bonus', ref ca_daily_bonus:<user>:<date>:<slot>)`,
  consumables as `feature_purchases` rows at cost 0, `source = 'daily_bonus'`,
  expiring in 7 days (`throwable`, `rabbit_hunt`, `time_bank_seconds`). Their
  consumers spend an expiring credit BEFORE the monthly allowance, soonest to
  expire first (2026-09-09; before that a bonus credit sat behind the
  allowance and lapsed). The first claim of the day is what advances the
  streak; an unclaimed day resets it to 1.
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

## The entry sheet (phase 2, live; re-audited 2026-09-09)

ONE POPUP PER DAY, on every device (Dan, 2026-09-09). `DailyBonusEntry` (hub
home and the AppLayout shell) asks `fn_ca_daily_bonus_status` once per
(account, Chicago day) and raises the modal sheet when today still has an
unclaimed tile AND the sheet has not been shown yet (`shown_today`, from
`ca_daily_bonus_days.sheet_shown_at`, set by `fn_ca_daily_bonus_mark_shown`
the moment the sheet is in front of the player, popup or /bonuses page, from
any device). Showing it spends the day; closing it is not what counts. It
asks again only for a NEW day: when the tab is looked at, focused or back
online after the server's midnight, on a timer at that midnight, on an
account change, and on a bounded retry after a failed read. A "nothing to
show" answer is kept per tab in sessionStorage until midnight. It never opens on a
table, on /multi-table, on /bonuses (the inline sheet), or over the welcome
and profile gates. See `docs/changelog/2026-09-09-the-daily-bonus-audit.md`.

## Forgive, boost, gamble (phase 3, ledger live 2026-09-10)

`20260910181625_the_daily_bonus_learns_to_forgive_boost_and_gamble`, one
transaction, applied 18:21 UTC in 558 ms with `lock_timeout = '4s'` and the
two hot foreign keys (`player_boosts -> profiles`,
`ca_daily_bonus_days.shield_consumed_id -> feature_purchases`) as its last
statements. Same rules as phase 1: one SECURITY DEFINER function owns each
move, every amount is derived from state the caller cannot write, every
diamond lands in the journal the reconcilers already watch. Nothing mints a
chip.

- **Streak Shield.** A calendar tile (`kind = 'shield'`, cycle day 4, and the
  day-14 and day-30 chests). Claimed, it is a `feature_purchases` credit
  (`feature = 'streak_shield'`, cost 0, `source = 'daily_bonus'`, 30 days).
  `fn_ca_daily_bonus_open_day` spends it: when the last claimed day is exactly
  two days ago (one missed day) and a live shield is held, the shield's
  `uses_remaining` drops by one, the streak continues from the last claimed
  day, and the day row records `streak_protected = true` and
  `shield_consumed_id`. Two missed days are a reset and spend nothing. A
  shield covers one day, never a holiday.
- **Lucky multiplier.** The mystery prize is still rolled when the day opens
  (`fn_ca_daily_bonus_roll_mystery`: 10 diamonds 40%, 25 diamonds 25%,
  5 throwables 15%, 3 rabbit hunts 10%, 50 diamonds 7%, 100 diamonds 3%).
  When the tile is claimed, `fn_ca_daily_bonus_roll_lucky` rolls 1x 55%,
  2x 25%, 3x 12%, 4x 5%, 5x 3%, and the claim pays prize x roll, diamonds
  clamped at 125 like every other claim. The result carries `lucky` and the
  revealed prize; the browser learns both at the tap and never rolls anything.
  Both roll functions have EXECUTE revoked from anon and authenticated.
- **Mission Boost.** A calendar tile (`kind = 'boost'`, cycle day 7,
  `quantity` = hours). Claimed, it is one `player_boosts` row
  (`kind = 'mission_diamonds'`, `factor = 2.00`, 24 hours); a second claim
  while one runs is refused `boost_already_live`. Daily Missions do not pay
  through `award_diamonds_v2` (they write `profiles.diamonds` and
  `diamond_transactions` directly inside `claim_daily_challenges_serialized_body`),
  so the boost's EXTRA is: that body, after its own diamonds, calls
  `fn_ca_daily_bonus_boost_extra(user, base, reference)`, which finds the live
  boost `FOR UPDATE`, computes `round(base x (factor - 1))`, and pays it through
  `award_diamonds_v2('daily_bonus_boost', ref ca_daily_bonus:boost:<user>:<reference>, bonus_diamonds = LEAST(125, extra))`.
  The action's catalog row counts toward the 110/150 daily cap with
  `max_per_day = 24`; the family monthly cap and `club_arena_daily` engine
  classification apply as for every other bonus diamond. A capped player simply
  gets no extra. The guard admits the function on its call stack.
- **Read side.** `fn_ca_daily_bonus_status()` adds `shield {held, expires_at}`,
  `streak_protected`, `boost {active, factor, kind, ends_at, seconds_left, applied_diamonds}`
  and per-tile `revealed`.

### Verification record (2026-09-10, rolled-back probes on production, then the apply)

P1 a player at streak 5 who claimed two days ago and holds a shield opens
today at streak 6, protected, shield uses 0, day-row shield id matches.
P2 status as that player reports streak 6, protected, shield held 0, boost
inactive, three tiles, mystery on slot 2. P3 claiming the mystery pays the
rolled 10 diamonds x lucky 2 = 20, replay with the same request id is
idempotent. P4 a two-day gap resets to streak 1, protected false, the held
shield still has its use. P5 cycle day 7 carries the boost tile; claiming it
creates exactly one live 2.00x row and status says active. P6 boost extra on a
base of 20 pays 20; on a base of 5000 pays 125 (clamp); a player without a
boost gets null; both journal rows classify as `club_arena_daily`. P7 10,000
rolls of each function sit within 1.5 pp of the weights. P8 the missions body
calls the extra, `award_diamonds_v2` has the shared branch, 4 calendar rows,
catalog `max_per_day` 24, 3 registry rows. After the apply: every pre-existing
ACL unchanged, `player_boosts` RLS on with owner SELECT only, the history row
byte-exact to the file, and a live `fn_ca_daily_bonus_status()` for a real
player carries the new keys.
