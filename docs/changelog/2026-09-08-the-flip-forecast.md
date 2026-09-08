# Nobody arms a rule blind again

2026-09-08. `supabase/migrations/20260908134715_the_flip_forecast.sql`.

Every diamond rule is written in `log` mode with a date on which it starts
refusing. Between those two moments nobody could ask the only question that
matters: on the day this arms itself, what will it actually stop?

That gap nearly cost real money twice in one week, and both were found by hand:

- `DR7:engine_over_budget` was six days from refusing **every daily-mission award
  for the rest of September**, because the engine sat at 4.2x a line nobody had
  revisited. Retired under ruling 21.
- `DR7:user_over_daily_cap` arms on 2026-09-14 against a daily limit of 2,000
  while a normal day is 2,148.

Neither was subtle. Both were plainly visible the moment somebody counted. Nobody
counted, because counting took an afternoon of hand-written SQL per rule.

## The forecast is general, not per-rule

Every one of these rules already files an incident on **exactly** the condition it
would refuse on - the refusal and the incident sit in the same `IF`. So "what
would it refuse" is answered by "what has it been filing", with no second
implementation to drift from the first. A per-rule forecast would be a copy of the
rule, and a copy of a rule is a lie waiting to happen.

`fn_ca_diamond_flip_forecast(hours)` reports, per rule: the mode, the date it
arms, how many refusals it would have made, how many distinct players those hit,
how many diamonds, and a verdict in words.

## What it says today

| Rule                                  | Would refuse                 | Players | Arms        |
| ------------------------------------- | ---------------------------- | ------- | ----------- |
| `DR7:user_over_daily_cap`             | **4,540** (240,471 diamonds) | **800** | 2026-09-14  |
| `DR6:balance_changed_without_journal` | 161 (64,352)                 | 105     | 2026-09-14  |
| `DR2:balance_born_outside_the_mint`   | 124 (62,000)                 | 124     | 2026-09-14  |
| `DR13:concentration_or_velocity`      | 6                            | 0       | 2026-10-08  |
| DR4, DR8, DR7:test_mode, DR15, DR16   | 0                            | 0       | SAFE TO ARM |

## It reports its own blind spot

A rule can only be forecast from what it filed, so a window in which the ledger
could not write is a window in which every count is a **floor** rather than a
total. That was real until this morning - 5,860 awards were evaluated by nothing
at all - so the forecast carries a final `(forecast confidence)` row saying
whether the window is complete. Saying so is the difference between a forecast and
a guess (CLAUDE.md 10.86).

## Read it before any flip date

That is the whole point of it.
