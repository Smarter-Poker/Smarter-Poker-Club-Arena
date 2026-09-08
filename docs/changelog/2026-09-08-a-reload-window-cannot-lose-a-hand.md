# A schema-cache reload cannot lose a hand

2026-09-08. Found during the phase 8 deep dive, and caused by phase 8 itself.
Branch `fix/the-reload-window-cannot-lose-a-hand`.

## What happened

The deep dive opened on a number that did not belong to phase 8: 38 critical
drift incidents in thirty minutes. Thirty-four of them were two sources that
had never both spoken on the same day before, and both had fired in exactly two
windows - 02:17 and 03:08. Those are the minutes either side of the two phase 8
migrations.

The alerts carried the cause verbatim: `"Could not query the database for the
schema cache. Retrying."` That is PGRST002. CLAUDE.md section 2 has described
this since the 2026-08-31 outage: every DDL statement fires Supabase's
`pgrst_ddl_watch`, PostgREST reloads its entire schema cache, and on this
database - ~970 relations, ~2,700 functions - **one reload takes about
twenty-eight seconds**, during which every call is refused before it executes.

Two retry ladders stood in that window, and both had been written expressly to
survive it:

| caller             | ladder                            | wall clock |
| ------------------ | --------------------------------- | ---------- |
| `syncStacks`       | 5 attempts, 200 ms doubling       | ~11.5 s    |
| `queueUnbankedFee` | 4 attempts, 300 ms tripling       | ~10.7 s    |
| **a reload**       | **measured, CLAUDE.md section 2** | **~28 s**  |

Each is less than half of the event it exists for. The fee ladder's own comment
states the intent - _"buys the reload time to finish"_ - directly above a number
that never could.

**This is CLAUDE.md 10.86's shape for the fifth time in this programme: a guard
that answers confidently about a scope nobody stated.** Both authors reasoned
about the right thing. Neither wrote down how long a reload takes, so neither
number could be checked against it, and the ladders have been too short in every
migration since.

## What it cost

**Eighteen hands' stack writes were dropped.** Twenty were alerted; two landed
on a later attempt. The other eighteen have no `settlement_idempotency_keys` row
at all - the call never reached the database. Between them they carried
**155,335 chips of seat movement** across 111 seat rows; 67.97 of it on cash
tables, the rest tournament play chips. Every payload conserves exactly
(`sum(delta) = -(rake + bbj)` on all eighteen), so the arithmetic was right and
only the transport failed.

**Twenty-three critical rake alarms fired, and every one was false.** All 23
fees were banked - 58.27 rake, 7.90 BBJ, nothing ever at risk. They fired
because `feeIsAccountedFor`, the check that exists to ask "are these chips
actually missing before we alarm", reads through the same PostgREST that was
down. It discarded every error (`const { data } = await ...` never looked at
`error`; the catch returned `false`), so during the reload it answered "no, not
accounted for" for every hand. `FeeReconciler.queue_failed` has fired on exactly
two days in its life: 2026-08-31, and today.

Dan, binding: _"HAVE THE PUSH NOTIFICATIONS STOP UPDATING ME FOR 0.00 OR FIXES,
ONLY CRITICAL ERRORS THAT NEED MY ATTENTION."_ Twenty-three criticals for 0.00
is precisely that.

## The fix, and why it is not simply a longer ladder

**The inline ladder cannot be lengthened.** `syncStacks` is awaited by the
dealing loop before the next hand (`postHandTasksPromise`), under a 20-second
`DEAL_STEP_BUDGET_MS`. A ladder long enough to span a reload would park every
table for the length of the reload - trading lost chips for frozen felt, which
is not a trade.

**So the patience moves off the dealing path.**
`server/src/services/supabase/pendingWrites.ts` holds a write the dealing path
could not land and retries it on its own timer, with a budget **derived from the
reload it has to outlast** - `SCHEMA_RELOAD_MEASURED_MS` (28 s) × 6, because
2026-09-08 was two migrations three minutes apart and section 2 warns that ten
statements outside a transaction cost ten consecutive reloads. Capped 5 s
backoff, so the budget buys thirty-odd attempts. Bounded at 500 entries, oldest
given up first, so an outage cannot grow it without limit. The timer is
`unref`'d and disappears when the queue empties.

Three properties make this safe, and all three are load-bearing:

1. **Every registered write is idempotent by construction.**
   `fn_ca_settle_hand_stacks_absolute` claims `settlement_idempotency_keys` on
   (table, hand) and replays its stored result; the fee queue's partial unique
   index on (hand_id, kind) makes a duplicate insert a no-op. A retry arriving
   after a silent commit writes nothing.
2. **The write applies differences, not absolutes.** Delta mode means landing
   late still lands right: the seat gets `row + (stack - stack_before)` whatever
   the row holds by then, and deltas commute.
3. **A refusal is final and is not retried.** The verdict is now a three-way -
   landed, refused, unreachable - so the off-path retry keeps trying an
   unreachable database and stops dead on a conservation refusal.

**The next write for a table drains that table's owed hands first**
(`drainPendingWrites('stack:<id>:')`), because reaching there proves the database
is answering again. **The alarm moved to the give-up handler**: it fires only
when the whole budget is spent, and it now carries how many off-path attempts
were made and over how long.

**And "I could not ask" stopped being reported as "the chips are gone."**
`feeIsAccountedFor` returns `yes | no | unknown`; only a definite `no` raises the
critical. `unknown` logs and reports to Sentry as `queue_unverifiable`, and
leaves the genuine shortfall to nightly reconciliation, which reads the tables
directly.

This is not a monitor or a sweep - Dan's standing order rules those out as
band-aids. It is the original write, still held by the process that made it,
still being attempted, with the payload already in hand.

## Pinned

`tests/a-reload-window-cannot-lose-a-hand.law.test.ts`, 16 pins: the budget is
derived from the measurement rather than re-typed, it outlasts several reloads,
the inline ladder stays inside the dealing budget, `DEAL_STEP_BUDGET_MS` is
pinned as the ceiling that number is measured against, both callers hand off
rather than alarm, the alarm sits in the give-up handler, a table's owed hands
are drained on its next write, and `unknown` can never reach the critical.

## The money from those eighteen hands - settled

Two migrations, both **DML only and deliberately so**: DDL is what starts a
reload, and a reload is what lost the hands, so nothing here may add another one
while the engine is not yet carrying the fix above.

- `20260908040302_re_drive_the_hands_the_schema_reload_dropped`
- `20260908040542_the_two_hands_a_lock_timeout_and_a_deadlock_kept`

Probed first in a transaction that was rolled back (11.5), then applied with an
assertion that aborts the whole re-drive if the club wallets move by anything
other than the departed-seat deltas the settlements themselves report.

Every hand went back through `fn_ca_settle_hand_stacks_absolute` - the
platform's own idempotent path, never a hand-written wallet row (10.9 rule 2).
It runs in delta mode, so it applied each hand's _difference_ to the seats as
they stand now; landing forty minutes late still lands right, because deltas
commute.

**Outcome: 6 of 20 settled, 14 refused whole, 0 left in an unresolved state.**
The twelve tournament hands and two cash hands that refused did so with the
database's own verdict - `seat missing or left` - because their seats have
busted, been moved by a table balance, or left a club whose wallet no longer
resolves. That refusal is the platform protecting itself and is left standing;
there is no idempotent path to settle a hand whose seats are gone, and inventing
one would mean writing wallet rows by hand. All 20 alerts are resolved and carry
a note saying which of the two things happened to their hand and why.

Real-chip exposure across all eighteen was 27.73 owed and 40.24 overpaid, every
affected account a horse - which under 10.5 changes nothing about who is paid.

**The first pass taught the same lesson twice.** Re-driving eighteen hands
across eighteen tables inside ONE transaction accumulates row locks on every
named seat and holds them to the end, in an order the live engine knows nothing
about: 7903228 died on a lock timeout and 7903411 on a deadlock. That is exactly
the mistake the phase-8 migration made at 02:19 and had to be split to avoid.
The second migration retries only hands whose recorded error is transient - so a
hand the database genuinely refused can never be swept in by re-running it - and
both settled immediately.

## Found and not fixed here

**A hand is refused whole when a departed seat moved nothing.**
`fn_ca_settle_hand_stacks_absolute` demands a club wallet for any seat that has
left before it computes that seat's delta - so hand 7903456, which nets to zero
between two players who are both still seated, was refused because a third seat
with a delta of **0.00** had gone. Settling nothing needs no wallet, and the
departed loop already skips a zero delta two steps later. It is a small, safe
reordering, and it is left out of this branch on purpose: it is DDL, DDL is what
starts a reload, and the engine is not carrying this fix yet.
