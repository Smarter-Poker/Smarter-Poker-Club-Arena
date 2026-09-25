# The escrow sweep reports a stale hold, not missing chips

2026-09-25

## What the board said, and what was true

`fn_ca_escrow_ttl_sweep` held 25 of the drift board's 38 open incidents. They
claimed **480,000 chips of discrepancy**, and their own metadata named the
standing backlog behind them as **166 holds worth 3,778,600**.

No chips were missing. Not one.

## The cause

`fn_ca_raise_drift_incident`'s parameters run
`(p_source, p_classification, p_severity, p_dedupe_key, p_discrepancy, p_expected, p_actual, p_layer, ...)`.

The sweep passed them positionally as `r.amount, r.amount, 0`. The intent is
legible from the values - expected and actual both the hold amount, discrepancy
zero, i.e. "this hold is stale and nothing is missing". What the recorder read
was `p_discrepancy = r.amount`, `p_expected = r.amount`, `p_actual = 0`: every
row filed as _expected N, found 0, N chips gone_.

All 25 open rows carried `discrepancy_amount = expected_amount AND
actual_amount = 0`. A scan of every source in `ca_drift_incidents` found that
fingerprint on **this producer only** - the mis-wiring is local to one call
site, not a pattern.

## Why the number could never have been real

Only five functions in the database reference `chip_escrow_holds`
(`fn_ca_escrow_ttl_sweep`, `fn_club_retirement_impact`,
`fn_release_tournament_holds`, `fn_remove_settled_club_member`,
`fn_retire_settled_club`) and **none subtracts a held amount from a balance**.
There is no `available = balance - holds` anywhere in SQL, and `src/` and
`server/` do not reference the table at all. A held row is an advisory marker;
the chips were in `club_members.chip_balance` throughout.

## The 166 holds

`chip_escrow_holds` carries 705 rows and none is newer than **2026-08-16**:
539 released (every one `released_reason = 'table_unlock'`) and 166 still
`held`, all on **closed** tables in one club. **No function inserts into this
table** and no application code names it, so the writer that made them is gone
and cannot make another.

So they are not a backlog needing a drainer - they are the finite residue of a
retired path, and this migration ends them once. That is 10.11 step 3, settling
the damage already done; it is not a healer (no schedule, nothing recurs) and
so not barred by 10.12.

They were not harmless while they sat there: `fn_remove_settled_club_member`
and `fn_club_retirement_impact` both read `status='held'`, so a marker on a
table that closed 40 days ago could block a member removal or a club
retirement for a hold nobody could release.

## The fix

1. The sweep now passes **named arguments**, so the recorder's parameter order
   cannot silently re-map this call again (10.86 rule 4 - the trap one level
   up). A stale hold is reported as `discrepancy 0`, `expected = actual = the
hold amount`, with a cause line that says no chips are missing and names
   what the hold _does_ block.
2. The 166 legacy holds are released, gated on `status='held' AND expired`, so
   the statement is idempotent and cannot touch a live hold.
3. The 25 board rows resolve on `closure_basis = 'verified_remeasured'`.

The sweep stays and is now expected to find nothing. If it reports again, a
writer has come back - and none exists today.

## No money moved

This migration writes no wallet, no `club_members.chip_balance`, no
`table_seats.stack`, no `chip_ledger`. The only money-shaped column it touches
is `chip_escrow_holds.status`, which no balance reads.

## Proved before it was committed

One `execute_sql` call, one `DO` block, `SET CONSTRAINTS ALL IMMEDIATE`, ending
in `RAISE EXCEPTION` so the transaction aborted (CLAUDE.md 11.5). It returned
`released=166 resolved=25 still_held_expired=0` and proved that neither
`trg_guard_retired_club_mutation` (all 166 are in one club) nor
`fn_ca_resolution_needs_a_cause` refuses these writes. The migration's
assertions re-assert those numbers, so it aborts if the board moved underneath
them.
