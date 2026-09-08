# Reading a report changed the thing it reported on

2026-09-08. Migration `20260908161327_reading_a_report_changed_it.sql`.

A third adversarial review, this time of the same afternoon's work. Thirteen
items. **The most expensive one is not a defect**, and establishing that came
first.

## The 159,275 diamonds that are not owed

The review reported 4,674 horse rewards worth 159,275 diamonds expired
unclaimed, against 29 rows and 772 diamonds for humans — a 206x disparity that
looks exactly like the 10.5 failure settled hours earlier, and recommended
settling it.

**It is Ruling 3, already applied.** Dan's ruling: _"The 897,095 completed before
the standard expire under the same 7-day rule: no clawback, no retroactive mint
into idle wallets, humans and horses treated alike."_ Amendment 2 records the
backlog expiring at apply time as **4,703 rows**. The review's own counts are
4,674 + 29 = **4,703 exactly**. Same rows, same sweep, one written decision
covering both. Paying them would violate a ruling.

The 206x figure is not evidence of unequal treatment here either: it is 972
horses against 5 humans holding stale rows when one rule expired both.

What _was_ missing is that the decision lived in a markdown file. Somebody
querying the database found 159,275 diamonds gone with nothing beside them
saying why. It is now an incident row, `DR0:ruling_3_backlog_expired`, carrying
the counts, the ruling, and the sentence "Do not pay them."

## The five that were mine, from three hours earlier

**Reading the health report wrote to the database.** `fn_ca_diamond_health()` was
declared `STABLE` and called `fn_ca_diamond_snapshot()`, which is `VOLATILE` and
INSERTs. Its own `deploy gate` area reports "unexplained since the last
snapshot" — so reading the report advanced the baseline it was about to measure
against. Measured: 25 snapshots in eight hours where 8 belonged to the hourly
cron, and one timestamp appearing seven times (this migration's predecessor
calling health seven times in one transaction). **The instrument destroyed the
series it existed to read**, and `STABLE` was a lie. It reads the stored row now,
and says so when that row is stale rather than reporting it as current.

**The claim sweep moved money every minute with no maintenance freeze gate** —
CLAUDE.md 13 rule 5, explicitly. And the Postgres backstop does not cover it:
`zz_freeze_guard` sits on the chip and seat tables, and neither `profiles` nor
`diamond_transactions` is among them. It would have fired five more times inside
every `:55`–`:00` break. Latent only because `engine_maintenance_break` is empty
today, which is the worst kind of safe.

**A capped horse reward would have died silently, and the health row would have
turned green as it died.** After DR7 arms on 2026-09-14, a capped claim fails
with no incident (correct — a thousand horses meet the cap daily), and the
`horse claims` area counts only `expired_at IS NULL`, so a row leaves the count
the moment it expires. Seven days of amber, then green at the instant the
diamonds are lost. **The number that must never be non-zero is rewards that
expired unclaimed**, and nothing watched it. It is an area now, and the sweep
returns `(claimed, capped, failed, ran)` instead of a bare count.

**The "fourth gate" was inert.** `since_config` resets whenever any column of the
config row is touched — and for DR7 the epoch was the newest of all fourteen cap
rows, so touching the `wheel` cap erased DR7's evidence. Live: `would_refuse`
4,553 over seven days, `since_config` 0, on a 43-minute window, gate passing. It
gates on `would_refuse` now, and a window younger than the evidence period
returns `unknown` rather than a clean zero.

**The advisory lock could leak and silence meant success.** `EXCEPTION WHEN
OTHERS` does not trap `query_canceled`, so a statement timeout skipped the
unlock — harmless under pg_cron, a permanent leak from a pooled `service_role`
backend. `pg_try_advisory_xact_lock` has no unlock path to miss. And `RETURN 0`
for "could not get the lock" was byte-identical to "nothing was owed".

## Six smaller ones

Per-area failure isolation and an `unknown` status (one raise anywhere returned
_zero rows_ rather than thirteen answers and one unknown); cron liveness read
from `job_run_details` instead of `active` alone; `OVERDUE` ordered above
"probably fixed already"; the stale comment the earlier regex surgery left
behind; `fn_ca_normalise_claim_loop` revoked from anon and authenticated; the
append-only trigger extended to `TRUNCATE`, which a row trigger never sees; and
the `DR0:` beacon namespace excluded from the retired-rule report, where the
liveness signal was appearing as "RETIRED RULE… nothing acts on them".

## One thing this migration got wrong, and caught

The new `rewards lost to expiry` area used a plain 36-hour window — and Ruling
3's backlog expired 13 hours earlier, so the area flagged **Dan's own decision as
a critical defect** on the day it was written. That is how a new alarm teaches
people to ignore it on day one. It now excludes the backlog _by reference to the
recorded write-off's own timestamp_, so there is no magic date and the bound
retires itself once the window moves past it.

## Verified live

Reading the report three times wrote **zero** snapshots and **zero** beacons.

```
rule arming             ok    scheduled and has succeeded in the last 25 hours
horse claim button      ok    has succeeded 2 time(s) in ten minutes
rewards lost to expiry  ok    no horse reward expired unclaimed in 36 hours
horse claims            ok    none owed; 19 human, which is not a defect
money identity          ok    players + float = register, exactly
deploy gate             ok    reads the stored snapshot at 16:10
trial balance           ok    every reconciling account balances
per-user caps           ok    VIP caps ok, horses are players ok
unreachable money       ok    nothing stranded
budget plans            attention  3 lines are fiction (Dan's to set)
evaluation coverage     attention  5,861 in 24h, none for 03:38; appears fixed
```

`horse claim button` correctly read **critical** for the first two minutes after
the job was rescheduled — a new job id has no successful run, and the check is
built to say so rather than trust `active`.
