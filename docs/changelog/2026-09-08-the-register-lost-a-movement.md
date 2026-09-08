# The register serialised the whole economy behind one lock, and started losing movements

2026-09-08. `supabase/migrations/20260908060643_the_register_lost_a_movement.sql`.

## What happened

At 05:37 UTC the diamond money identity broke for the first time since the
register was built. Players held more diamonds than `ca_mint_ledger` recorded.
By 05:53 the gap was 2,236 and it grew every minute.

Nothing had to be guessed. Twenty-four critical `MINT:register_follow_failed`
incidents named twenty-four journal rows, every one carrying SQLSTATE `55P03`,
`canceling statement due to lock timeout`, and those twenty-four rows summed to
exactly the gap. The net built in August for precisely this did its job: it
caught the failure, recorded which movement was lost, and the arithmetic closed.

## The cause, and it is mine

`fn_ca_register_diamond_journal_row` computed `supply_after` under

```sql
PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:diamonds'));
```

An **xact-scoped** advisory lock is held until the CALLER'S transaction commits,
not until the insert finishes. So every diamond movement on the platform took
one global lock and then held it for the rest of whatever transaction it was
part of, while every other player's movement queued behind it.

That was survivable while a transaction moved diamonds once. It stopped being
survivable at 04:38, when the horse claim went live and a single
`record_daily_challenge_event` began claiming several challenges in one
transaction: the first claim took the global lock, the transaction went on
working, and everyone else's movement died on `lock_timeout`.

The scan inside the lock was never the problem - 8,961 rows, single-digit
milliseconds. **The problem was the scope of the lock, not the cost of the work
under it.** A profiler would have said the function was fast.

## The fix, at the root

The lock is removed from the follow path.

An EXACT running total cannot exist on a path that runs thousands of times an
hour without serialising the entire economy behind it. That is not a tuning
problem; it is what a global running total means. So the column stops
pretending to be one.

`supply_after` is an annotation: nine functions write it, no view and no
function reads it, and the authority on supply is `fn_ca_mint_supply()`, which
SUMS the movements. It now records the supply observed as the row was written -
under simultaneous movements two rows may each omit the other - and the column
comment says so, instead of that precision being bought with an outage.

Nothing else is weakened. Every movement still gets a register row, the sum of
those rows still equals what players hold, and that identity never depended on
this column.

## The damage, settled once

The twenty-seven rows lost by the time the migration ran (the set grew while it
was written) were re-registered inside the same transaction, after the cause was
fixed, through the platform's own idempotent path
`fn_ca_register_diamond_journal_row`. Each incident was resolved with a note
saying what happened. No diamonds were created or destroyed: the money had
always moved correctly and the journal row had always stood - only the register
row was missing.

**This is not a repair job under CLAUDE.md 10.12.** Nothing scheduled was
created. The set was read from the incidents that recorded it, the migration
aborts unless the identity is exact afterwards, and if it ever needs doing again
that means the cause came back and the cause is the thing to fix.

Only the failures were replayed. There are 1,198 unregistered journal rows in
total going back to February, worth 738,728, and they are unregistered on
purpose: the register was seeded from balances rather than by replaying history,
so replaying them would double every diamond issued before the seed. The
incidents are the evidence of what was lost and the whole of what was restored.

## Verified live, not by probe

- rolled-back probe: register = players, twenty-seven incidents resolved, no
  global lock left in the body;
- after applying, on production at 05:59 UTC: register 1,035,633 = players
  1,035,633, drift `0.00`, zero unresolved `MINT:register_follow_failed`, zero
  journal rows in the previous two hours that the register had not followed.

## The lesson worth keeping

The first version of this migration's own guard - "the follow path no longer
takes a transaction-scoped global lock" - FAILED, because the new body's comment
explains what it no longer does and the check matched its own explanation. That
is the same "a mention is not a call" mistake being fixed the same night in
`fn_ca_diamond_unreachable_money`. The guard strips comments before looking.
