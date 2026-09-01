# The guard written for the vanished chips crashed the moment it saw any

2026-09-01. Found while checking why two scheduled jobs were failing.

## What it is

`fn_ca_quick_reconcile` step 3e loops over `fn_unaccounted_seat_exits()` — the
detector built after 2026-08-25, when a probe deleted two `table_seats` rows and
48 chips left a member wallet and landed nowhere. Its entire job is to make
chips leaving the felt **loud**.

That function returns a column called `exit_id`. The loop body reads `r.id`,
twice.

plpgsql resolves record fields at **runtime**, so the mistake is invisible until
the loop has a row to iterate — which is to say, invisible until the guard
fires:

```
ERROR:  record "r" has no field "id"
CONTEXT: ... 'qr:seatexit:' || r.id::text ...
PL/pgSQL function fn_ca_quick_reconcile() line 112 at PERFORM
```

A guard that reports nothing when it finds nothing, and throws when it finds
something, is worse than no guard. The silence is identical either way, and the
one time it mattered the exception stood in for the alert.

## It was not hypothetical

`ca-quick-reconcile-5m` failed on this **four times between 11:15 and 11:30
today** — a fifteen-minute window in which unaccounted seat exits genuinely
existed. Nobody was told. Those exits have since been accounted for: the
matching credits landed inside the grace, and the seven-day unaccounted total is
0.00 across 0 exits.

**The blast radius is wider than the one check.** The exception aborts the whole
function, so step 3f (ledger write failures) and everything after it did not run
either, for those four cycles. One wrong field name took the five-minute
reconciler offline exactly when it had something to say.

## Proven, in a transaction that was rolled back

Per the never-spend-real-chips rule, both directions were probed live inside
`BEGIN … ROLLBACK`, with one synthetic row in `ca_seat_stack_exits`:

**Before** — reproduced verbatim:

```
ERROR:  record "r" has no field "id"
```

**After** — the reconcile completes and raises the incident it was written for:

```
 completed_without_throwing | t
 severity | source                          | cause
 critical | fn_ca_quick_reconcile:seat_exit | seat exited with 123.45 chips and no matching wallet credit
```

The first probe used random UUIDs and raised nothing even after the fix —
`fn_ca_raise_drift_incident` gates on `fn_ca_is_midway_scope`, so an out-of-scope
row is dropped on purpose. Re-probing with a real club, table and member is what
actually demonstrates the path. Worth knowing before someone concludes from a
synthetic negative that the guard is still dead.

Both probes left nothing: 0 probe rows, 0 probe incidents.

## How it was fixed

`r.id` → `r.exit_id`, applied as a **targeted substitution on the live
definition** rather than by retyping 200 lines of a money-adjacent function, so
nothing else could drift by transcription. Both occurrences are asserted present
before the swap and absent after, and the migration refuses to run if the
function has changed shape.

Other loops in that function rebind `r` to records that legitimately do have an
`id`, so the match is anchored on the surrounding text and never on `r.id`
alone.
