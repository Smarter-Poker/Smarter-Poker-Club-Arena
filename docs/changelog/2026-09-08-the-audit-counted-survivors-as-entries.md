# The daily horse audit counted survivors as entries

2026-09-08, from the daily horse audit analysis of 2026-09-07.

## What was wrong

`tournaments.current_players` is a LIVE counter. It is decremented as players
bust, so on a COMPLETED event it reads 1-3: whoever was still sitting when the
tournament ended. Two audit detectors read it as if it were the field size.

`fn_audit_overlays` computed `guarantee - current_players * buy_in`.
`fn_audit_empty_freerolls` compared `current_players` against `max_players`.

## What it cost

**Eleven of the twenty-four CRITICAL findings on 2026-09-07 were this one bug,
and not one real overlay existed.** Every guarantee that day was beaten:

| Event | Reported | Real |
| --- | --- | --- |
| Sunday Funday Main Event | "4820.00 overlay", 2 entries | 165 entries x 90.00 = 14850.00 funded vs 5000.00 gtd - beaten by 9850.00 |
| Sunday Funday High Roller PKO | "3432.50 overlay", 1 entry | 66 entries x 67.50 = 4455.00 vs 3500.00 gtd |
| Sunday Funday Mystery | "2455.00 overlay", 1 entry | 94 entries x 45.00 = 4230.00 vs 2500.00 gtd |
| Morning Free Buy (NLH) | "started with 1 of 200 players" | 200 of 200 - a full house |
| Prime Time Free Buy (NLH) | "started with 1 of 300 players" | 300 of 300 |

Every one of those findings ended with a recommendation sending the reader to
`HorseOverlayGuard`, which was working correctly the whole time. A detector
that cries wolf about the guard that is doing its job is worse than no
detector, because the next agent spends the day in the wrong file.

## The fix

`fn_tournament_entry_funding(uuid)` counts entries from `tournament_players`
(one row per entrant) and adds the money rebuys and add-ons put into the pool -
Prime Time Main Event on 2026-09-07 was 69 entries + 16 rebuys + 62 add-ons =
3502.50 funded against a 1000.00 guarantee. Both detectors call it.

**Fixing the count arms the detector rather than blunting it.** Re-run
read-only against 2026-09-07:

- overlay: 11 criticals -> **0**, which is correct.
- empty freeroll: the 8 it reported were mostly full houses. It now reports
  genuinely thin fields - Midnight Free Buy 12 of 200 (6.0%), Prime Time Free
  Buy 12 of 300 (4.0%), `$100 Freeroll 6:00 PM` 23 of 500 (4.6%). The broken
  version could not tell those apart from the 200-of-200 ones.

## Third fix, same class: the audit was racing the tuner

`fn_audit_tuner_health` resolved its run as `p_day + 1` and warned
`tuner_no_rows` when that date was empty. Measured 2026-09-05..08: the audit
generates at about 06:35 UTC, `HorseSelfTuner` writes between 08:06 and 09:38.
The audit was asking for a run that had not happened yet.

That branch **returned early**, so `tuner_regressed_the_fleet` and
`tuner_tightened_the_fleet` - two CRITICAL detectors written for the
2026-09-04 and 2026-09-06 incidents - could not fire on any day the race was
lost. It has been lost on 2 of 14 audit days.

Nothing was missed this time: on 2026-09-08 the tuner was healthy - 106/624
regressed (17.0%) and 120/624 tightened (19.2%), both well under the 0.40 bar,
and 624/624 studied from `horse_daily_play`. The point is that nothing would
have been reported if it had not been.

The fix reads the newest run in `[p_day, p_day + 1]` and emits an `info`
finding (`tuner_run_lagging`) naming which run it read, so a lagging tuner is
visible instead of silencing the checks below it. `tuner_no_rows` now means
what it says: no tuner run for two days.

## The shape to remember

All three defects are one shape: **the detector read a field that answers a
different question than the one being asked.** `current_players` answers "who
is still in", not "who entered". `p_day + 1` answers "what will the tuner say",
not "what has it said". Neither was a wrong threshold or a bad heuristic - the
arithmetic was right and the input was not, which is why both went unnoticed:
the output looked like a real number.
