# Three classes of incident that were never money

2026-09-08. Branch `fix/a-club-without-a-baseline-is-not-a-club-at-zero`.

Dan: _"GO THROUGH THESE ONE AT A TIME, FIX ANY AND ALL OPEN INCIDENTS ONE BY
ONE ... RECONCILE EACH AND EVERY TRANSACTION ... AND THEN YOU FIX THE ROOT
CAUSE OF EVERY SINGLE INCIDENT, NO BAND AIDS, NO WATHERS, NO RECONILLERS."_

244 incidents were open on the board. They are not 244 problems — they are about
sixty groups, and each group is one defect repeated. This takes the three
largest, by amount, by count and by noise.

**37 are closed at the root. 32 are reconciled and left open on purpose.**

All 69 were reconciled against the actual rows first, and **nobody is owed
anything in any of the three.** In the first two the detector was wrong and the
money was right — CLAUDE.md 10.86's shape, a guard answering confidently about a
scope nobody stated. The third looked identical, had a fix written for it, and
turned out not to be that at all. The account of how it was caught is in the
class 3 section, and it is the most useful thing in this file.

---

## Class 1 — the 9,981,739.70 that was never missing

The worst single number on the board. Two incidents, both
`fn_ca_quick_reconcile`.

**Reconciled.** Deep Stack Society (`2a1132b9…`) was created **2026-08-31
19:02:21**. The `ca_treasury_baseline` cutover ran that morning at **10:45:50**
and wrote a row for each club that existed then. Eight hours later this club was
created and nobody wrote it one.

`reconcile_ledger_nightly` reads `COALESCE(b.opening_balance, 0)`. With no
baseline row, a club that has been trading for a week is measured **from zero**,
so its entire ledger history is reported as drift. The number is not a
discrepancy at all — it is the club's opening balance, reported as a loss.

Measured twice, twenty minutes apart, against a moving balance:

| read  | derived opening |
| ----- | --------------- |
| 12:03 | 9,981,739.70    |
| 12:23 | 9,981,739.70    |

Difference **0.00**. The ledger and the stored balance move together exactly;
only the origin was wrong.

**Then it was proved the other way, on the clubs that do have a baseline.**
`opening + post-cutover credits − post-cutover debits` against
`clubs.chip_treasury`:

| club         | reconstructed | stored     |
| ------------ | ------------- | ---------- |
| Club JAQK    | 948,969.06    | 948,969.06 |
| SHARK CLUB   | 894,721.67    | 894,721.67 |
| Midway Union | 0.50          | 0.50       |

Exact, to the cent, on all three. So the method is not approximate, and the one
club it cannot do this for is the one club missing its opening row. **No chips
are missing.** The migration now asserts this as a **post-condition**: after the
backfill every club must reconstruct exactly, or nothing is written.

Diamond Arena, created this morning at 11:28, has the same missing row. It has
raised nothing yet only because it holds 0.00 and has no ledger legs — it would
have started the moment it took its first chip.

### A witness that was wrong, and nearly went in the changelog

`chip_ledger` also carries `pre_`/`post_balance` snapshot columns. Reconstructing
from the newest of those suggested a **-48,811.17** gap on SHARK CLUB and
**-120.28** on Deep Stack — five-figure findings, on clubs the exact method says
are clean to the cent.

Those columns are populated on **421 of Deep Stack's 329,425 legs (0.13%)**, and
their values do not agree with the complete reconstruction. The sparse witness
was wrong and the complete one was right. It is written into the migration so
the next reader does not spend an afternoon on it: **do not audit a treasury
from `pre_`/`post_balance`.**

**Root cause, fixed.** `COALESCE(…, 0)` is the defect: it turns _"I do not know
this club's opening position"_ into _"this club opened at zero"_, which is a
confident answer to a question nobody asked.

1. The two clubs get the baseline they should have been born with, asserted
   against the derived figure so the migration aborts if the board has moved.
2. `reconcile_ledger_nightly` stops guessing. The `ledger` CTE propagates NULL,
   `merged` carries it, and a club with no baseline is filed **`warn`** with
   `unbaselined: true` and a note naming the fix — not a critical for its whole
   history. `ledger_balance` is `NOT NULL` and `severity` is constrained to
   ok/warn/critical, so this is the honest shape those constraints allow: it
   records **no drift** and says why. The note matters — a `warn` whose drift
   reads 0.00 is unreadable without one. Three asserted text substitutions on
   the live definition, not a retyped body.

   Probed rolled-back against the live board: **4 club_treasury rows, 0
   criticals, 1 unbaselined warn, max drift on it 0.00.** The 9,981,739.70
   critical is gone and nothing replaced it.

3. **`trg_ca_club_gets_a_baseline`** — an `AFTER INSERT` trigger on
   `public.clubs`. A club is now born with a baseline row. That is the actual
   root cause: the cutover was a one-off backfill with nothing behind it, so
   every club created after it inherited the same hole.

---

## Class 2 — 35 criticals that all mean "I did not get a turn"

The largest class by count. All `fn_spin_book_entry`, one per spin, since
09-02.

**Reconciled, all 35:**

| check                                              | result       |
| -------------------------------------------------- | ------------ |
| entry booked in `spin_reserve_ledger` contribution | **35 of 35** |
| never booked                                       | 0            |
| total contributed                                  | 2,558.52     |
| escrows at 0.00 on prize, fee AND bounty           | 34 of 34     |
| tournaments COMPLETED                              | 35 of 35     |

The money landed every time. All 35 were noise.

**Root cause.** `fn_sync_seat_first_player_count` books the spin entry when the
last seat fills, inside `BEGIN … EXCEPTION WHEN OTHERS`. On **any** exception it
files a CRITICAL and swallows the error. The exceptions were:

- 26 × `55P03` canceling statement due to lock timeout (newest today, 08:36)
- 9 × `40P01` deadlock detected (none since 09-06)

Neither is a settlement error. Both mean the booking did not get a turn. The
booking is **idempotent by construction** — `fn_spin_book_entry` returns
`already_booked` when a contribution row exists — so a contention failure is
safe to repeat, and something did repeat it, which is why all 35 are booked.

The deadlocks stopped on 09-06 because of a lock-ordering fix on 09-05. The
lock timeouts did not, because ordering locks stops two orders meeting head-on;
it does not remove contention.

**Fixed at the call site**, not with a watcher: up to four attempts on
`lock_not_available`, `deadlock_detected` and `serialization_failure` with a
25 ms × attempt backoff. A turn lost four times files **`info`**
(`spin_entry_contended:`), because the evidence is 35 of 35 eventually booked
and a critical that is always noise is how a real one gets ignored. A booking
the database **refuses** (`ok = false`) is still critical, and so is any other
exception — those are judgements about the money and this changes neither.

---

## Class 3 — reconciled, and the obvious diagnosis was wrong

**RECONCILED, NOT FIXED. The fix is deliberately not in this PR**, and the
reason is worth more than the fix would have been.

`financial_alerts:ServerTableEngine.settlement_barrier_abandoned`, 32 open
incidents across 31 tables.

**The money is fine.** For every one of the 32, the same table settled hands
either side of the alert — between 5 and 26 `succeeded` idempotency keys within
the window, and **zero `failed`, on all 32**. Nothing was lost and nothing was
double-paid.

### The diagnosis I nearly shipped

Every alert carries `waitedMs: 300000` and `capMs: 300000` — the cap exactly, on
all 32, never a partial. The barrier's budget is five minutes and the hourly
maintenance freeze is five minutes, so the story writes itself: a settlement
meets a break, cannot write for the whole window, burns its budget, files a
critical about a hand that was never in trouble. That is CLAUDE.md 13 rule 4
("deadlines are thawed, not burned") and it is a tidy, plausible, well-supported
account.

The engine fix for it was written, and the law test, and the changelog entry.

**Then the timestamps were read.** The alerts are not spread across hours at
:55. They are one burst:

| when                | alerts |
| ------------------- | ------ |
| 05:09, 05:18, 05:54 | 4      |
| **06:07 – 06:22**   | **27** |
| 07:13               | 1      |

Firing at :07–:22 past the hour, in a single two-hour window, on a day the
platform had been running for weeks. The freeze is :53–:00. **The one thing the
theory predicted — clustering at the break — is the one thing the data does not
show.**

What the data does show, in `supabase_migrations.schema_migrations`: **29
migrations applied between 04:01 and 06:07**, by several agents at once, fourteen
of them between 05:00 and 06:07. Each DDL statement fires `pgrst_ddl_watch` and
a PostgREST schema-cache reload takes **~28 seconds on this database**
(CLAUDE.md section 2). An alert at 06:07–06:22 means a settlement that began at
06:02–06:17 — on top of `one_definition_of_a_chip` at 05:56 and two more at
06:06 and 06:07.

So the barrier most likely waited five minutes of genuinely blocked time. **The
alerts are probably TRUE**, and the cause is the one phase 8 already named: our
own concurrent DDL.

### Why nothing ships here

Shipping the freeze fix today would have meant a changelog claiming it closed 32
incidents it had nothing to do with — a diagnosis fabricated to fit a fix, which
is precisely the `is_horse` mistake CLAUDE.md 10.5 exists to prevent, and worse
than a plain bug because it reads as a decision.

Dan's order is reconcile first, then root-cause. The reconciliation is done and
says nobody is owed anything. The root cause is not established, so no engine
change is justified yet. The 32 stay **open**, which is honest, rather than
resolved against a story.

Two things are now known that were not this morning, and both are worth having:

- `settlement_idempotency_keys.status` is `succeeded` / `failed`. It is **never
  `completed`**, on any of 4,063,638 rows. A reconciliation filtered on
  `'completed'` returns zero and reads as "nothing settled" — it was the first
  answer this investigation got, and it was wrong in the alarming direction.
- The freeze-credit defect in the barrier is real and latent even so. It is a
  separate piece of work with a separate justification, not a rider on this one.

<details>
<summary>The original (wrong) class-3 section, kept for the record</summary>

## Class 3 — 32 alerts about the freeze we scheduled ourselves

`ServerTableEngine.settlement_barrier_abandoned`, 32 open incidents covering
**47 alerts**.

**Reconciled: 47 of 47 hands settled successfully. 0 with no idempotency key.**
Nothing was lost, nothing double-paid.

**The tell was in the numbers.** Every alert carried `waitedMs: 300000` and
`capMs: 300000` — the cap, exactly, on all 47, never a partial. A real timeout
distribution has partials in it. A distribution with only the cap in it is
something hitting a wall, not a tail.

**Root cause.** The hourly maintenance break freezes every money write for
**five minutes**, and the settlement barrier's budget was **five minutes**. A
settlement caught by a break _cannot_ finish inside its budget: the freeze guard
refuses its writes for the whole window. So the barrier spent its entire budget
waiting for the platform to come back, then filed a critical money alert about a
hand that was never in trouble.

CLAUDE.md 13 rule 4 already forbids exactly this:

> **Deadlines are thawed, not burned.** If you add a wall-clock deadline a
> player can lose to, add it to `fn_thaw_platform` in the same PR, or a
> five-minute break silently eats it.

The rule was written about player-facing deadlines. This one is an engine
deadline, so nobody thought to apply it — and it ate itself on the hour, every
hour.

**Fixed in `ServerTableEngineDealing.ts`.** A slice that touched the freeze at
either end is credited to `frozenMs` instead of charged to `waited`. Sampling
once per slice would charge the half-slice the break began in, so it samples at
both ends.

Three properties deliberately kept:

- **The engine still proves it is alive** — `markProgress()` still runs every
  slice, so the idle watchdog does not kill a table that is correctly waiting
  out a break.
- **It still refuses to deal the next hand.** Nothing about the barrier's
  purpose changed; only what counts against it.
- **A genuine stall is still loud.** Five minutes of _running_ time raises
  exactly as before, and the message now says how much freeze it did not count.

**The credit is capped at eight minutes** (`maxFrozenCreditMs`), and that cap is
the point. `isMaintenanceFrozen()` is a module-level boolean set at the :53
announcement and cleared at the :00 resume — seven minutes at the very most. If
a bug ever leaves it true, an uncapped credit would park the table **forever**,
which is a worse failure than the alert this replaces. Past the ceiling, frozen
time counts as ordinary waiting and the barrier behaves exactly as it did
yesterday.

_(End of the retracted section. The code it describes was written and then
reverted; none of it is in this PR.)_

</details>

---

## What this closes, and what it does not

**Closed: 37 incidents** — 2 treasury baseline, 35 spin contention. Both fixed at
the root, both with the trap disarmed so they cannot recur: a club is now born
with a baseline, and a lost lock is now retried rather than reported.

**Reconciled but open: 32** settlement-barrier alerts. Nobody is owed anything;
the cause is not yet established.

**Untouched: 175** across ~57 groups, largest first:
`fn_ca_settlement_correctness_check:rakeback_chain` (20),
`fn_ca_guard_defs_watch` (15), `fn_spin_unpaid_check` (11),
`fn_settle_tournament_obligation` (10), `fn_bbj_reconcile` (10),
`fn_ca_money_rpc_drift` (9), `fn_ca_trial_balance_watch` (7). Each gets the same
treatment: read the rows first, fix the cause second, and — as class 3 turned
out to require — stop if the two do not agree.

## One thing this session should leave behind

Three classes were examined. **Two had a defect where the detector was, not
where the money was.** The third looked like a third example of the same thing
and was not.

The pattern is not "alerts are usually noise" — that conclusion, drawn one class
too early, is what nearly shipped a fabricated fix. The pattern is that **a
plausible cause and a measured cause are different things**, and the only
reliable way to tell them apart is to check whether the evidence predicts
something the theory does not: a number that stays identical while the board
moves, a timestamp that lands at :07 instead of :55.
