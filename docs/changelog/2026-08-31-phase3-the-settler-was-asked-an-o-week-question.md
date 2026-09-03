# 2026-08-31 — Phase 3: the rakeback settler was not slow, it was asked an O(week) question every page

Agent: Claude (Cowork). Phase 3 of the completion plan. Migration
`rakeback_recompute_reads_a_daily_rollup` applied via Supabase MCP; repo copy
in `supabase/migrations/`.

## The symptom, and why the daemon was innocent

`fn_union_treasury_selftest` had been reporting `rakeback_settler_lagging` for
a day: cursor stuck at 2026-08-30 05:37, backlog 22,611 rows at diagnosis and
**32,674 by the time this shipped**, ~574 arriving an hour. Every cycle logged
the same thing:

```
[RakebackSettler.period_recompute] fn_rakeback_recompute_periods failed
  for fade0000… 2026-08-24: Error: supabase_timeout
[RakebackSettler] Settled 0/221 period rows from 999 hand records
  in 67838ms (failures: 221)
[RakebackSettler.period_recompute_failures_hold_cursor] holding the watermark…
```

The settler was doing exactly the right thing. It refuses to advance past
records it could not settle, because `rake_generated` selects the rakeback tier
(5/10/15/20/30%) and a period computed from partial data can pay a player a
whole band low. **That refusal is correct and is untouched.** The bug was that
the question could not be answered in time.

## What the question actually cost

`fn_rakeback_recompute_periods` rebuilds a `(club, week)` **from source** —
the right design, and itself the fix for an older bug where incrementing
`rake_generated` double-counted on every engine restart. But the settler calls
it once per `(club, week)` **per page** of 1,000 `rake_records`, and one week of
the busy club is **274,783 records**.

Measured: **28.4 seconds for a single club-DAY** through the old path, so the
week ran ~400s. The engine's client deadline is 60s — and 15s before the outage
widened it. It could never have succeeded.

The old body called `fn_rake_shares_for_record` once per record through a
LATERAL, and that wrapper reads `rake_attributions` **twice per hand** (once to
read it, once for its own `NOT EXISTS`).

## Two changes, in order of size

**1. Set-based shares.** Read the attribution ledger as ONE grouped join, and
fall back to `fn_allocate_rake_credits` only for hands the ledger does not
cover — the same precedence the wrapper applies, and still the single source of
the share math, never re-derived. ~400s → **54s**.

Proven identical before shipping, not assumed:

| window           | users | old cents | new cents | users differing  |
| ---------------- | ----- | --------- | --------- | ---------------- |
| 6 hours          | 406   | 595,843   | 595,843   | **0**            |
| full day (08-24) | 564   | 6,089,636 | 6,089,636 | — (totals equal) |

**2. A daily rollup — this is what made it fit.** 54s is still most of a 60s
deadline and all of a 15s one. A week is now the sum of its days:
`rakeback_daily_user` holds integer cents per `(club, day, user)`, a day is
recomputed from source only when its record count has changed
(`rakeback_daily_state.rows_seen`), and the weekly figure is a trivial
aggregate over seven small rows.

Cents are integers and addition is associative, so summing days then the week
is **exactly** summing the week. The rollup is derived data with no authority —
drop it and the next call rebuilds it from `rake_records`.

Measured after:

| operation      | before | after                     |
| -------------- | ------ | ------------------------- |
| one club-day   | 28.4s  | **4.6s**                  |
| full club-week | ~400s  | **7.5s** (all days fresh) |

Cross-check after building: the rollup's 2026-08-24 totals are **564 users and
6,089,636 cents** — the same numbers the old path produced.

## Live without a deploy

Both functions are DB-side and the settler calls them by name, so the fix took
effect immediately rather than waiting on the engine's drain gate.

## Found while watching it drain: the horse fleet had lost its bankroll awareness

The first healthy settler cycle put this next to it in the log:

```
[HorseFleet.bankrolls.missing_cursor_key] row is missing the keyset column "id"
  — the select must include it or paging cannot advance. Returning a partial result.
```

`fetchAllRows` takes its cursor from `opts.idKey`, **which defaults to `'id'`**.
The bankroll load pages `club_members` and selects only
`(user_id, club_id, chip_balance)` — so every run past the first page read
`row['id']`, found undefined, bailed with `complete: false`, and
`bankrollsLoaded` stayed **false**. The fleet was choosing games with no idea
what any horse could afford.

**Credit where it is due: another agent found this in parallel and fixed it
better.** My change was a one-line `idKey: 'user_id'`; theirs pages **per
club**, because `club_members` has no `id` column at all (its key is
`(club_id, user_id)`) and `user_id` is unique only _within_ a club. A
cross-club keyset on `user_id` is therefore unsound — a page boundary landing
mid-user would silently skip that user's remaining memberships. Their version
won the rebase; mine was discarded on the merits.

What survives from this branch is the part that was still missing: a guard that
pins the invariant rather than the one bug. `paginationCursorKey.guard.test.ts`
walks every `fetchAllRows` call in the server and fails if the `.order(...)`
column is not the effective `idKey`. Verified it actually catches the defect —
run against the pre-fix source it reports exactly one offender
(`HorseFleet.bankrolls: orders user_id cursors id`); against the fixed source,
none. This was the only mismatched call site.

## Verification pass: two sweeps that could never finish, and one was mine

Checking phase 1-3 end to end before phase 4 turned up two more, both the same
shape — PostgREST cancels at ~8s unless a function raises its own ceiling, and
neither of these did.

**Mine, shipped broken hours earlier.** `fn_requeue_unbanked_cash_rake` went
into the reconciler cycle in phase 2. Its very first production run logged
`[FeeReconciler.requeue_unbanked_query_failed] 57014 canceling statement due to
statement timeout`. Measured: the 48-hour scan takes **12.9s** — the index hands
back 380,864 rows for the window, 325,039 are thrown away as tournament or
zero-rake hands, and 55,825 anti-join probes remain to find a handful. **The
self-healing sweep had never once healed anything.** Fixed with a 120s ceiling
and a window that matches the cadence: 6 hours, **3.3s**, and at a 5-minute
cycle that is ~72 chances to catch an orphaned hand instead of one. 48h stays
available by argument for an outage catch-up.

**Pre-existing, and its own comment called it.** The note above
`runTournamentPayoutSweep` reads _"ten seconds is close enough to that edge to
be a coin flip"_. It had been losing that flip on **both** passes, not just the
deep one — measured, the 2-day "narrow" pass takes **15.6s** and the 30-day deep
pass about two minutes. The sweep that exists to catch under-paid tournaments
had been completely dead, which is why the ~169 stale events it was widened to
reach were never reached.

With a 600s ceiling it completes: a 7-day dry run scans **32,531 events in
53.6s, `truncated: false`**, and finds six events with findings — every one an
**overpayment**, which the function reports and deliberately never claws back,
with `total_top_up: 0`. **Nobody is owed money.** Two of the six are the already
acknowledged ones; the rest are 0.01 rounding and one 3.50.

### And then the fix made noise, which is also a bug

Turning the payout sweep on for the first time had a consequence: the two
accepted overpayments started re-raising a critical **every cycle**.

`fn_tournament_payout_reconcile` already knows how not to nag — it suppresses a
re-raise when the findings are only `overpaid`/`no_finisher_recorded`, nothing
is owed, and a resolved alert for that tournament carries a `resolution` key.
When I resolved those alerts earlier today I set `resolved`/`resolved_at` and
nothing else, so `context ? 'resolution'` was false and the suppressor could
never engage. It did not matter while the sweep was dying on its ceiling —
nothing was calling the reconciler. **A fix that produces a permanent alert loop
is not finished.**

Handshake stamped. Verified: an APPLY sweep over 2 days reports 3 findings and
raises **zero** new alerts (0 open before, 0 after). The suppressor stays
narrow — any underpayment or outstanding top-up re-raises regardless of what
was accepted before. The 142 historical resolved alerts for events outside the
sweep window were left alone; nothing re-scans them, and rewriting them to
satisfy an assertion would be tidying, not fixing.

### Dan's ruling, recorded

Both double-payment backlogs were filed with `decision_owner: Dan`. His answer,
verbatim: _"IM NOT WORRIED ABOUT ANY DOUBLE PAYMENTS OR ACCURACY WE ARE BETA
TESTING, AS LONG AS THE LEAK OR BUG IS FIXED."_ No clawback. Both closed as
**decided** rather than left open as undecided — the amounts and their causes
stay on the resolved rows and in `tournament_conservation_baseline`. Recording
a decision is not erasing a number.

## What was deliberately NOT changed

- The watermark-holding behaviour on failure. It is the reason no player was
  paid a wrong tier while this was broken.
- The recompute-from-source design. Incremental accumulation is what caused the
  double-count bug this replaced; the rollup keeps "rebuild from source",
  it just rebuilds a day instead of a week.
- `fn_player_rakeback_rate` still runs per user (589 calls ≈ most of the
  remaining 7.5s). Inlining it would duplicate rate policy across two places;
  at an 8x margin on the deadline that trade is not worth making yet.
