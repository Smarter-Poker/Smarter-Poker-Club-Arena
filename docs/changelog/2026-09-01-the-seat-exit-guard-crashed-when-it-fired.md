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

---

# And the settlement check could not reach its own index

Same sweep, second failing job. `ca-settlement-correctness-30m` had been dying
at its 120s statement timeout, every time on the same statement:

```sql
SELECT count(*) FROM public.hand_history
 WHERE created_at > now() - interval '24 hours' AND has_human IS TRUE
```

An index exists for exactly that:

```sql
idx_hand_history_human_created ON hand_history (created_at) WHERE has_human
```

and it is never used. Postgres's predicate-implication prover does not equate
the `BooleanTest` node `has_human IS TRUE` with the bare boolean predicate
`has_human` the index was declared with. The two are identical in a `WHERE`
clause — both exclude NULL and false — and the planner still will not connect
them.

Measured on production, the same query one word apart:

```
... AND has_human IS TRUE   cost 231817.29   Index Scan idx_hand_history_created
                                             + Filter: (has_human IS TRUE)
... AND has_human           cost     12.57   Index Only Scan
                                             idx_hand_history_human_created
```

Eighteen thousand times the cost. The first plan walks every hand dealt in 24
hours — about 221,000 rows — to find the ~265 a human sat in.

**Worth being blunt about this one.** That index was added earlier today to fix
this exact job, and the job kept timing out afterwards. The index was correct.
The query could not reach it. An index added for a query that cannot use it
looks like a fix, measures like a fix against any hand-run variant of the query,
and changes nothing in production.

So the measurement that matters is the function itself, not its query:

```
SELECT public.fn_ca_settlement_correctness_check();
Time: 9183.581 ms
```

Nine seconds, against a 120-second timeout it had been failing at.

`fn_hand_history_prune_skip_depth` also writes `has_human IS TRUE`, inside
`count(*) FILTER (WHERE has_human IS TRUE OR reported IS TRUE)`. That is an
aggregate filter over an OR, not an index-usable predicate, so rewriting it
would buy nothing and it is deliberately left alone.
