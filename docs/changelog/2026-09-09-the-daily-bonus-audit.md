# 2026-09-09 - the Daily Club Arena Bonus audit

Dan: "a full audit, enhancement and upgrade of the daily bonus functionality
for repeated visits daily to the club arena ... fix ANY AND ALL BUGS, GAPS,
STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES."

Every line of the sheet, the entry trigger, the service, the two RPCs, the
open-day and caps helpers, the three consumable consumers and the nine
migrations behind them was read against the live definitions in production
(`kuklfnapbkmacvwxktbh`), the 48 hours of edge and postgres logs, and the data
the feature has written so far (7 bonus days, 6 claims, 3 accounts).

## Fixed

- **The sheet did not come back on a repeated visit.** `DailyBonusEntry`
  asked once per mount, which is not once per day: a PWA or tab left open
  overnight never asked again the next morning; a sign-out and sign-in as
  another account inherited the first account's answer; one dropped request
  on entry (the 503s of the 04:40Z incident that morning) silenced the sheet
  for the whole visit. The ask is now keyed to (account, day): it re-runs when
  the tab is looked at, focused or back online after the Chicago midnight the
  server reported, on a timer at that midnight, on an account change, and on
  a bounded retry after a failure. `entryState.ts` holds the pure rules.
- **A claim across midnight paid a tile the player never saw.** The browser
  sent only a slot; the server resolved "today" itself, so a tap at 00:00 on a
  sheet opened at 23:59 paid slot N of the new day (a different tile, on a
  streak that may have reset). `fn_ca_daily_bonus_claim` now takes
  `p_bonus_date` and refuses `day_rolled_over` before opening or paying
  anything; the sheet re-reads and says so
  (`20260909203926_the_daily_bonus_claim_names_the_day_it_saw`, one body, DROP
  and CREATE).
- **Bonus consumables lapsed unused.** Throwables, rabbit hunts and time bank
  are granted as seven-day `feature_purchases` credits, but every consumer
  drew the monthly allowance first (30 throws for a member), so a bonus credit
  was reached only after the allowance was gone. Both throwable credits ever
  granted still held every use. An expiring credit is now spent before an
  allowance that renews, soonest to expire first, in all three consumers;
  purchased packs never expire so nothing else moves; lifetime VIP is
  untouched (`20260909203940_an_expiring_credit_is_spent_before_an_allowance_that_renews`).
- **The countdown drifted in a background tab** (timers throttle to once a
  minute) and its re-read at zero ran inside a state updater. It now measures
  the distance to an absolute deadline on every tick and re-reads once when it
  is crossed.
- **After a diamond claim the other diamond tiles kept a stale `capped` flag.**
  `applyClaim` (pure, tested) moves the caps by what was granted and re-flags
  every unclaimed diamond tile against the new remaining cap.
- **The week strip described the cycle-day rows on a chest day** (streak 14,
  30): "+75" over tiles that paid the chest. Today's entry now reads from the
  snapshot the day opened with, and carries `chest: true`.
- **The hub home and the shell each re-asked on every navigation between
  them.** A "nothing to show" answer is remembered per tab until the server's
  midnight; a dismissed day is recognised from the local Chicago date before
  any read.
- The header paints the ledger's `balance_after` at once
  (`DIAMOND_BALANCE_CHANGED`) rather than only after the debounced re-read;
  `bonus_streak` survives into the diamond journal (award_diamonds_v2 nulls
  `streak` for every action but daily_login); the ineligible status payload
  now carries `seconds_to_reset`; every refusal reason the ledger can return
  has player-facing copy.

## Found and left for Dan (policy, not defects in this feature)

- A non-VIP's 110 daily cap is shared with `daily_login`, whose ladder tops
  out at exactly 110 (seen live this week). On such a day every diamond tile
  on the sheet is refused `daily_cap` and the sheet says so honestly. The cap
  is Dan's ruling; the arithmetic is noted here.
- Lifetime VIPs (21 humans) have unlimited throwables, rabbit hunts and time
  bank, so a consumable tile is worth nothing to them; the calendar could pay
  them diamonds instead. Data edit, Dan's call.
- Horses have never claimed (0 rows): the engine side of 20260908134818 is not
  built. Fleet programme.
- `diamond_reward_budgets (2026-10, club_arena_daily)` has a NULL budget and
  `ca_diamond_engine_spend` holds no rows for the four bonus journals; both
  are economy reporting, neither refuses a claim (ruling 21).

## Verification

- Live probes (rolled back where they write): a claim naming yesterday is
  refused `day_rolled_over` with nothing opened or paid; status returns the
  week with `chest`; a non-VIP member with a two-throw bonus credit and an
  untouched allowance draws the credit first (`expiring: true,
credit_source: daily_bonus, pack_remaining: 1`); every lifetime path,
  grant and one-body assertion holds; players + float = register.
- `tests/unit/DailyBonusEntry.test.tsx`, `useDailyBonus.test.ts`,
  `DailyBonusService.test.ts`, `DailyBonusSheet.test.tsx`,
  `dailyBonusLedger.law.test.ts`: 43 tests.
