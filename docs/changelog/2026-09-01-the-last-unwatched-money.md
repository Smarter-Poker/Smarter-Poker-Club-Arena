# The last unwatched money

2026-09-01, the closing pass of the payout audit. Three findings, all of them
things nothing on the platform was looking at.

## 1. A payout structure that shallows after a place has been paid

**This is a live overpay and it fired twice on the day it was found.**

`fitPayoutStructureToField` replaces the stored payout structure with one whose
depth matches the field that turned up. Its docblock reasons entirely about
WIDENING and warns, correctly, that guessing a field too small "promotes an
earlier place to residual holder and overpays it". The condition it actually
uses is `current.length !== wanted`, so it narrows as well — and narrowing after
a place has already been paid is a straight overpay. The places that remain
renormalise over the WHOLE pool as though nothing had gone out, and whatever the
dropped places received is on top of it.

The arithmetic is exact both times, and the excess is precisely the sum of the
dropped places:

| event                                |   pool | what happened                                                                                    | disbursed | excess |
| ------------------------------------ | -----: | ------------------------------------------------------------------------------------------------ | --------: | -----: |
| Late Night Grind (PLO4) `38a107f4`   |  50.00 | 02:40:57 place 5 paid 3.21; structure fitted to three places; 02:47–02:50 places 1..3 paid 50.00 |     53.21 |   3.21 |
| Brunch Special PKO (PLO8) `c27630fe` | 180.00 | places 4 and 5 paid 4.00 and 2.80; places 1..3 then paid 180.00                                  |    186.80 |   6.80 |

Over the 30 days to 2026-09-01 this class is **39 MTTs and 21 Spins**.

**The rule now: a structure may deepen at any time; it may shallow only while
nothing has been paid.** When narrowing would drop a place that already has
money against it, the advertised structure stands — the conservative branch this
function already takes on every other failure, and the one that conserves: the
places already paid keep their money and the reconciler pays the rest of the
ladder out of what is left. An unreadable paid-place list is UNKNOWN and stands
the structure down rather than guessing.

## 2. An alert that repeats hourly buries the ones that do not

`fn_raise_server_financial_alert` inserted unconditionally, so every hourly check
that found the same unfixed thing filed it again. The alert table had stopped
being a list of problems and become a list of minutes:

| source                                 | open rows | subjects | repeats each |
| -------------------------------------- | --------: | -------: | -----------: |
| `fn_close_settlement_period`           |       244 |        1 |          244 |
| `drift_incident:fn_ca_money_rpc_drift` |        10 |        1 |           10 |
| `FeeReconciler.prize_disbursement`     |        18 |        2 |            9 |
| `FeeReconciler.bbj_unlinkable`         |        94 |       33 |          2.8 |

Two sources accounted for more open rows than every genuinely distinct finding
on the platform put together.

**One optional parameter fixes it for every caller.** `p_dedupe_key`: when an
unresolved alert from the same source already carries that key, its id comes
back and no second row is written. Callers that pass nothing behave exactly as
before, so it cannot break anything that already works. It deliberately does NOT
return NULL for a duplicate — NULL is the throttle signal and the wrapper
escalates a throttled CRITICAL to Sentry on the grounds that it was never
recorded. A deduped alert _was_ recorded.

`prize_disbursement` now files one alert per tournament keyed on the tournament
id; the two BBJ conditions carry a stable key each. The backlog is resolved
where it only repeated: **244 → 1** and **18 → 2**, open alerts platform-wide
**~723 → 464**.

> **CORRECTION, 2026-09-02, written while verifying Phase 2 — the paragraph
> above measured a backlog I had just resolved, not a condition I had stopped.**
> The dedupe key is passed from the ENGINE, and the engine has not restarted
> onto this code (it restarts on the 7am/7pm window; PR #2551 is still open).
> So the noise came straight back: `FeeReconciler.bbj_unlinkable` is at **102
> open rows for ONE subject** again, `bbj_drift` at 30, `prize_disbursement` at
> 11, and open alerts platform-wide are back to **648**.
>
> The mechanism itself is proven, and the evidence is a clean natural
> experiment. `fn_money_check_health` raises its alerts from INSIDE the
> database, so it already passes the key: **7 open rows, 7 distinct keys, 7
> carrying a key.** Every engine-driven source: **0 carrying a key.** Same
> function, same database, different caller — the only difference is which
> code is running.
>
> Nothing here needs fixing. What needed fixing was the sentence, which said
> "the backlog is resolved" in a tone that reads as "the condition is over".
> Resolving rows is housekeeping; the condition ends when the engine restarts.
> The money-check heartbeat shipped the next day exists precisely so this
> distinction is visible without anybody having to notice it by hand.

`fn_close_settlement_period` is NOT fixed at source and this says so rather than
pretending. It INSERTs into `financial_alerts` directly instead of going through
the RPC, so it does not pick up the key, and it is a treasury function in another
workstream. Its newest row is dated 2026-08-29, so the condition is over. The
one-line fix is written into the migration for its owner; rewriting a treasury
function to change a log line is not a trade this audit was willing to make
blind.

## 3. The cash side of "did everyone get paid"

Chips leaving the FELT were already watched — the 2026-08-25 seat-exit trigger,
and `fn_unaccounted_seat_exits()` reads **zero**. Chips leaving a POT were
watched by nothing.

`fn_cash_pot_conservation_check` asks the invariant of every completed cash hand:

```
pot_size = rake_amount + bbj_amount + sum(winners[].amount)
```

Over the seven days to 2026-09-01, **463,506 cash hands: 0 mismatches, 0 chips
undistributed.** Healthy — and healthy unobserved, which is exactly where the
vacant finishing places sat for ten weeks.

It earned two corrections by being run, and the second is the more useful one.
That seven-day sweep returned once and then **hit the statement timeout on the
very next call an hour later**, when the database was busier. Cash hands arrive
at roughly 59,000 a day; 24 hours reads 58,932 rows comfortably, 168 hours reads
463,506 and is a coin flip. That is the shape of every check on this platform
that quietly stopped working — `fn_spin_unpaid_check` learned it the same way on
2026-08-31. The window is capped at 48 hours now: double what the engine asks
for, half of what has been seen to fail, and a request for more is capped rather
than refused, so asking for 720 returns 48 hours of answer (97,833 hands, all
clean) instead of an error.

It was corrected on its own first live run. It flagged two hands with no winner
recorded; both had their entire pot after rake go to the Bad Beat Jackpot (pot
0.30, rake 0.03, bbj 0.27), owed nobody, and were fine. It counts only a
no-winner hand that is still HOLDING chips now. Its return field is
`conditions_alerted`, not `alerts_raised`, because the dedupe path returns an
existing row and a standing condition reports itself without writing anything.

## 4. Twenty-one laws the registry could not see

`tests/law-registry.law.test.ts` exists because two contradictory artwork laws
coexisted in different worktrees and started a two-day revert war. It scanned
`tests/` only. **Twenty-one `*.law.test.ts` files live under `server/src`** —
`payoutExactness`, `aTournamentPayoutIsARecord`,
`theReconcilerTrustsWhatItCanProve`, `aGuaranteeIsAPromise` and most of the rest
of the money laws among them — and every one was invisible to the registry that
exists to keep laws from fighting. A law nobody can see from the registry is a
law the next agent cannot check against before writing its opposite.

The scan covers both trees now and all twenty-one are registered. The registry
test went from 39 assertions to 60.

## 5. What completing the record made visible, and why it stays open

The ledger backfill of the day before gave `fn_tournament_payout_reconcile` the
full picture of what had already been paid — and the full picture shows
**historical OVERpayments the incomplete record had been hiding.** Twelve
criticals appeared for it within hours of the backfill, and they are all true.
Late Night Grind `7ddd516f` is typical: the holder of place 3 received 29 chips
against a place worth 9, and the event disbursed 70 against a 50 pool.

Measured against the wallet across 120 days and 50,025 events with a pool:
**65 events overpaid by 19,665.23 chips.** Nobody is short — this is the other
direction, and it is a club cost.

Sixty of the recent ones are the structure-narrowing defect in section 1, so the
fix above stops the largest ongoing contributor at the next engine restart. The
twelve alerts are deliberately **left open**: under Dan's ruling of 2026-08-28
there is no clawback from players, so what to do about a settled overpay is his
decision, and the agent whose backfill surfaced them is the last one who should
quietly resolve them.

Stale findings that ARE closed, and only because the check that raised them now
returns clean: the four `fn_detect_results_without_a_hand` criticals (those
events were unwound by another agent's `20260901130906`, and the detector now
returns `flagged 0`), and the `prize_disbursement` repeats raised in the window
between the dedupe key landing and the backlog being cut.

## Evidence

- Server suite and client suite green, `tsc --noEmit` clean in both.
- New pins: 13 in `AlertsDoNotRepeat.law.test.ts`, 3 more in
  `EveryEarnerIsPaid.law.test.ts` for the structure-narrowing rule.
- `fn_cash_pot_conservation_check` run twice against production, idempotent
  (one alert row after two runs, before the false positive was corrected away).
- Every function shipped here moves no money.

## Where the platform stands

```
fn_payout_guarantee_check(150 days)
  vacant_paid_place_events    0
  earners_not_paid            0
  paid_but_unrecorded_events  0

fn_cash_pot_conservation_check(48 hours, 97,833 hands)
  pot_not_distributed         0
  no_winner_recorded          0

fn_unaccounted_seat_exits()   0
fn_pay_backed_payout_shortfalls (dry run)  0 owed, 0 withheld, 0 refused
```
