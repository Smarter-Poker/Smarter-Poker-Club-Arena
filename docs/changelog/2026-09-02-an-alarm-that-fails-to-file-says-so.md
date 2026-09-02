# An alarm that fails to file says so, and the money checks reach it

Date: 2026-09-02
Branch: `fix/an-alarm-that-fails-says-so`

## The finding that started it

`reconcile_ledger_nightly` works, and it is currently telling the truth about a
real problem every night into a table nobody is paged from.

```
ledger_reconcile_log  club_treasury critical rows : 12
ca_drift_incidents    club_treasury incidents ever:  0
```

Three `ledger_reconcile_log:*` sources reached `ca_drift_incidents`, and all
three were REPORTING checks: `no_flop_no_drop`, `board_not_recorded`, and a
legacy `?`. Not one money check was wired. The estate could report that a board
was not written down and could not report that a club treasury was out by ten
million.

**Deep Stack Society** holds 2,466,795.25 having paid out 7,500,228.38 against
5,315.38 of journalled income. Roughly **9.98 million reached that treasury with
no `chip_ledger` row**. The drift is constant to the cent across nightly runs
while both sides keep moving, which is the signature of one historical event
rather than an ongoing leak. This change does not touch that money and does not
explain it; the baseline migration is explicit that the answer is never to move
the line. It makes the finding reachable.

## The silent failure underneath it, found the hard way

`fn_ca_raise_drift_incident` ended in a blanket handler that logged a warning
and returned NULL. Swallowing is **correct** here and is kept: it is called
from inside settlement paths, and an alarm that can roll back a money
transaction is worse than an alarm that misses one. What was wrong is where the
evidence went. `RAISE WARNING` lands in the Postgres log, which nothing on this
estate reads.

I proved the cost by walking into it. Wiring the money criticals up, I called
that function 901 times and it filed nothing, returning NULL every time. The
cause was mine and trivial: I passed layer `'database'`, and the allowed set is
`ledger/projection/cache/reporting/settlement/unknown`, so every insert died on
`ca_drift_incidents_layer_check`. One visible error would have fixed it in a
minute. Instead it looked exactly like "nothing is wrong", and I nearly shipped
a gate that silently did nothing — which is the same shape as a real alarm
failing, indefinitely.

`ca_incident_file_failures` now records source, dedupe key, SQLSTATE, message
and the DB role for every filing that fails. Verified against production with a
deliberately invalid layer: the row appears with `23514` and the constraint
name. The function still swallows and still returns NULL.

## The escalator

`fn_ca_escalate_reconcile_criticals(interval)` reads the log the reconciler has
already written and raises deduped incidents from it. It returns
`considered/filed`, so a run that files nothing is visible rather than silent.

It is a separate function on purpose. `reconcile_ledger_nightly` is a Tier-3
money function whose own migration reproduces every check byte-for-byte and
asserts on their presence, because a careless edit there deletes a check
silently. Escalation is not reconciliation.

The dedupe key carries no date: a treasury out by the same amount for nine
nights is one incident seen nine times, which is what `occurrences` and
`last_seen_at` are for.

Scheduled hourly on `:52` via pg_cron with the estate's standard advisory-lock
guard, the same home and shape as `reconcile-ledger-integrity-6h` and the seven
other `ca-*` reconciliation jobs.

## A mistake made and cleaned up in the open

Verifying the escalator, I ran it with a **14-day** backfill on production. It
filed 900 incidents in one call. Storm suppression did its job — 891 of 903
notify events were suppressed, so roughly a dozen notifications actually went
out, plus 127 `financial_alerts` rows.

Those 900 were real log rows but overwhelmingly historical: `player_wallet` last
went critical 2026-08-26, `seat_stack_exit` 2026-08-30. Filing them all at once
buried the single current finding, which is the opposite of the point.

All 900 were resolved with root cause and correction ref recorded (the estate
refuses a resolution without both, which is a good guard and worked). The
underlying `ledger_reconcile_log` rows are untouched. The function's **default
window is 36 hours** precisely so the schedule can never repeat this; a backfill
is a human passing an explicit interval.

## What this deliberately does not do

It does not widen `fn_ca_is_midway_scope`, which gates every incident on one
hard-coded union (`fade0000-…-0001`). **Deep Stack Society is outside it**, so
its 9.98M still does not file — confirmed after this change: the escalator
reports `considered 1, filed 0`, and `ca_incident_file_failures` is empty,
because nothing failed; the scope gate declined it by design.

Widening that gate is one line. It is also a paging-volume decision, and the
900-incident run above is a fair preview of what the first sweep would look
like. That is Dan's call, and it is now the only thing between that treasury
finding and a human.
