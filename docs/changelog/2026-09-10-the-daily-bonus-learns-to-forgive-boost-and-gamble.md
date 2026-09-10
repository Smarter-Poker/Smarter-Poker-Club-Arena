# 2026-09-10 - the daily bonus learns to forgive, boost and gamble (phase 3)

Dan, 2026-09-07: rewards include "diamonds, throwables, rabbit hunts, other
different things, options, multipliers, etc." Phases 0-2 are live (the ledger,
the sheet, the once-a-day entry). This is phase 3 of the Daily Club Arena
Bonus plan: a Streak Shield, a lucky multiplier on the mystery tile, and a
24-hour Mission Boost. `docs/DAILY-CLUB-ARENA-BONUS.md` carries the rules and
the verification record; this is what changed and why it is shaped this way.

## The ledger (live in production, 18:21 UTC)

`20260910181625_the_daily_bonus_learns_to_forgive_boost_and_gamble`, one
transaction, 558 ms, recorded byte-exact in `schema_migrations`.

- **A shield covers exactly one missed day, and the server spends it.** The
  tile (`kind = 'shield'`) claims into `feature_purchases` as
  `feature = 'streak_shield'` (cost 0, 30 days). `fn_ca_daily_bonus_open_day`
  is where a gap resets the streak, so that is where the shield is spent: last
  claimed day exactly two days ago, a live shield in hand, `uses_remaining`
  drops by one, the streak carries on, and the day row says
  `streak_protected` with the `shield_consumed_id`. Two missed days reset and
  spend nothing. The day-14 and day-30 chests now carry a shield.
- **The lucky multiplier is rolled at the tap, on the server.** The mystery
  prize was already rolled when the day opened; it now comes from
  `fn_ca_daily_bonus_roll_mystery()` so a simulation calls the real thing. On
  claim, `fn_ca_daily_bonus_roll_lucky()` rolls 1x-5x (55/25/12/5/3), the claim
  pays prize x roll, diamonds clamped at 125 like every claim, and the result
  carries `lucky` and the revealed prize. Both functions have EXECUTE revoked
  from anon and authenticated; the browser never rolls.
- **The Mission Boost pays its extra inside the caps, not around them.** Daily
  Missions do not pay through `award_diamonds_v2`: `claim_daily_challenges_serialized_body`
  writes `profiles.diamonds` and `diamond_transactions` itself. Multiplying that
  write would have paid outside the 110/150 daily and 3,300/4,500 monthly
  caps and outside the engine classification. So the boost is a
  `player_boosts` row (one live per player, 2.00x, 24 hours, refused
  `boost_already_live` while one runs), and the EXTRA is a separate diamond
  award: the missions body, after its own diamonds, calls
  `fn_ca_daily_bonus_boost_extra(user, base, reference)`, which pays
  `round(base x (factor - 1))` through
  `award_diamonds_v2('daily_bonus_boost', ref ca_daily_bonus:boost:<user>:<reference>)`
  with `bonus_diamonds = LEAST(125, extra)`. The action has its own catalog
  row (counts toward the daily cap, `max_per_day = 24`), rides the
  `daily_bonus` metadata branch in `award_diamonds_v2`, files under
  `club_arena_daily`, and the profile guard admits it on the call stack. A
  capped player gets no extra and nothing else changes.
- **Patches are anchored, not rewritten.** `award_diamonds_v2`,
  `fn_guard_profile_privileged_columns` and `claim_daily_challenges_serialized_body`
  are patched by DO blocks that read the live definition, replace one anchored
  line each, refuse to apply twice, and refuse if the anchor is gone - so the
  migration layers on whatever those functions are the day it runs.
- **Hot locks are held for milliseconds.** `player_boosts -> profiles` and
  `ca_daily_bonus_days.shield_consumed_id -> feature_purchases` are foreign keys
  to tables the engine writes every hand; a foreign key holds a SHARE ROW
  EXCLUSIVE lock until COMMIT (production DDL policy, rule 7). They are the
  last two statements of the transaction, behind `lock_timeout = '4s'`. The
  first attempt put the table itself last and failed at creation of the
  functions that declare its row type (plpgsql resolves those at CREATE);
  the table now comes first without the reference, and the constraint comes
  last.

## Verified

Eight rolled-back probes on production before the apply (shielded miss,
status, mystery x lucky with idempotent replay, two-day reset, boost claim,
boost extra at 20 and at 5000 with journal classification, 10,000 rolls of
each function, patch presence), then after the apply: every pre-existing ACL
unchanged, `player_boosts` RLS with owner SELECT only, history row byte-exact
to the mirrored file, and `fn_ca_daily_bonus_status()` for a real player
carrying `shield`, `boost`, `streak_protected` and per-tile `revealed`.
Pinned at the file level by `tests/unit/dailyBonusPhase3.law.test.ts`.
