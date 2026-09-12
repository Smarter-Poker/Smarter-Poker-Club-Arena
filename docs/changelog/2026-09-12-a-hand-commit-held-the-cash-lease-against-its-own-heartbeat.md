# A hand commit holds the cash lease against its own heartbeat

**2026-09-12**

The cash path was left half-way through a fix that was completed for
tournaments on 2026-09-10. This finishes it.

## Read this first: what this is NOT

This was found while chasing a restart loop in which every cash table
re-claimed its lease about every twenty seconds. **It is not the cause of that
loop**, and an earlier draft of this file said it was. The measurement that
refutes it is below. The loop is still open and is engine-side.

Two wrong causes have now been named for that loop, saturation and this, both
by attaching a real defect to a symptom without measuring the step that
connects them. The connecting measurement is the whole job.

## What is actually wrong

`heartbeat_table_leases_v4` renews with `FOR NO KEY UPDATE ... SKIP LOCKED`,
deliberately, so that it can never queue behind a settlement. The price of that
choice is that a row it cannot lock comes back `busy` and is extended by
nothing.

`fn_ca_commit_hand_settlement_exact_before_obligations` locks the lease row
before it commits a hand, and on the cash branch it took `FOR SHARE`.
`FOR SHARE` conflicts with `FOR NO KEY UPDATE`. So for the length of a
settlement, that table's heartbeat cannot renew that table's lease.

Measured against production, on an inert row, twice each, every transaction
rolled back:

```
holder takes FOR SHARE      -> heartbeat saw 0 rows   (skipped -> busy)
holder takes FOR KEY SHARE  -> heartbeat saw 1 row    (renews normally)
```

The conflict is real. What it is not is frequent.

## Why it is not the cause of the restart loop

Replicating the heartbeat's own probe, one sample per transaction, across the
78 cash lease rows:

```
15 of 30 samples: 0 rows skipped
11 of 30 samples: 1 row skipped
 4 of 30 samples: 2 rows skipped      mean 0.63 of 78 = 0.8% of rows
```

A lease expires only after four consecutive missed renewals. At 0.8% that is
roughly one chance in two billion, not once every twenty seconds on every
table.

Two further readings settle it. On all 78 rows `heartbeat_at` is exactly equal
to `acquired_at`, so no renewal has ever succeeded for any of them, ever, which
is not what intermittent lock contention looks like. And calling
`heartbeat_table_leases_v4` by hand with a real row's own instance and
generation returns `kept` and moves `heartbeat_at`. The database side is
healthy.

So this is a latent hazard, not an incident. It costs nothing today at 0.8%
contention, and it grows with settlement volume.

## What changed

- `fn_ca_commit_hand_settlement_exact_before_obligations`: cash lease read
  `FOR SHARE` becomes `FOR KEY SHARE`
- `fn_ca_resolve_unbound_pending_addons`: the same read, the same change
- `claim_table_lease_v2`: takes `FOR UPDATE` on the row before its upsert

The third is what makes the first two safe, and it is the half that matters.
The primary key of `engine_table_leases` is `table_id` alone, so a takeover is
a **non-key** update and takes exactly the same lock strength as the heartbeat.
No lock a holder can take will block a takeover and admit a heartbeat; they are
indistinguishable at the row-lock level. Exclusion has to be asserted by the
takeover rather than inferred by the holder, which is why
`claim_tournament_lease_v2` has taken `FOR UPDATE` since 2026-09-10 and why
dropping the holder to `FOR KEY SHARE` without this would weaken the cash path
rather than fix it.

Both halves were applied to tournaments on 2026-09-10 and neither to cash. The
two branches sit eleven lines apart in one function, one of them carrying the
comment that explains why the other is wrong.

Every edit is a substitution against the live catalogue, not a retyped money
path. Each asserts its site appears exactly once before changing anything, each
asserts the lease-generation check, the upsert and the audited stale-window
guard survive, and the migration reads the catalogue back at the end. The whole
file was dry-run against production inside a transaction that was rolled back.

## What was deliberately not changed

`fn_stage_a_bridge_legacy_capacity_receipt` takes `FOR SHARE` on a tournament
lease and is the same shape. Its predicate requires `protocol_version = 1`, and
there are zero version 1 rows in either lease table: 78 table leases and 694
tournament leases, all version 2. It locks nothing and cannot starve anything
today. Changing a legacy cutover path that cannot be exercised buys nothing and
risks a handoff that cannot be tested. If Stage A is ever re-run it needs this
edit first.

## So it cannot come back

`scripts/ci/check-lease-lock-strength.mjs` refuses a new migration that takes
`FOR SHARE` on either lease relation, reads inside function bodies, ignores the
lock quoted in a comment, and takes a reasoned `lease-lock-ok:` exemption of 40
characters or more. It runs in CI beside the other Supabase invariants, and
`tests/a-lease-holder-does-not-starve-its-own-heartbeat.law.test.ts` pins that
the guard exists, that CI runs it, and that it still bites.

## A note on how the measurement was taken

The contention figure above was obtained by running the heartbeat's own
`FOR NO KEY UPDATE ... SKIP LOCKED` against the live lease table. That probe
takes the lock the engine depends on, on every row at once, and it coincided
with an eight-minute stoppage of cash dealing on 2026-09-12 between 01:54 and
02:01 UTC. Recovery was unassisted and no settlement failed. Do not measure
lease contention this way. Use the engine's own
`poker_lease_heartbeat_outcomes_total`, or a Supabase branch.
