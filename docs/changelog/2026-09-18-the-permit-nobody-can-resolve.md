# The permit nobody can resolve

Found 2026-09-18 02:20 UTC while verifying the engine cutover. Not fixed: the fix is a change to the F06 hand-permit authority's proof rule, and it needs the decision of whoever owns F06. Everything needed to make that decision is here.

## The symptom

`Tournament.table_engine_never_ready` and `Tournament.table_engine_readmission_failed` fire about 255 times a minute each, steadily, on a healthy engine. The readmission error carries `f06_engine_admission_unproven`.

## The mechanism

`TournamentManagerBase.startManagedTableEngine` calls `fn_f06_hand_number_state(tournament, lease_generation, table)` and refuses to start the table unless the answer has `can_reserve = true` and `blocked_reason = null`.

That function sets `blocked = 'hand_permit_unresolved'` whenever a row exists in `smarter_private.f06_hand_permits` for the table with `state = 'reserved'`. So one unresolved permit stops its table dealing, permanently.

## The scale, measured

| | |
| --- | --- |
| Permits in state `reserved` | 157 at 02:25, 160 at 02:28 (growing) |
| Tables blocked | one per permit |
| Tournaments affected | 94, all RUNNING |
| Horses seated at those tables | **696** |
| Share of the seated fleet | about a quarter |

This set does not overlap the 553 decided-but-unfinished tournaments at all. They are two separate problems.

## Why nothing can resolve them

`fn_f06_finish_hand(tournament, lease_generation, permit, outcome, evidence)` is the only resolver, and it takes two outcomes:

`accepted` requires a `hand_atomic_commits` row for that table and hand number with `post_commit_completed_at IS NOT NULL`. Of the 157 checked, **none** has one. One has an incomplete commit; one appears in `hand_history`.

`never_started` requires all of: the permit's own `generation` equal to the caller's lease generation, an `f06_operations` row in state `park_requested` with matching custody and `revision > 0`, and no hand commit, no hand history and no `f06_hand_dispatch` row. Only **5** of the 160 tables have a `park_requested` operation at all. The rule is deliberate and the code says why: "A successor generation is not evidence that the original dealer never started."

For 66 of the 157 the owning lease generation is no longer heartbeating, so by that rule nothing can ever resolve them. For the other 91 the owning generation is the live lease — the same manager that is failing to start the table — and it cannot resolve either, because it has no park-requested custody receipt to offer.

There is no cron job and no sweeper: `cron.job` contains nothing matching F06.

## Where they come from

A permit is reserved when a hand number is allocated and resolved when the hand finishes. An engine killed between those two points strands it. Tonight's sources were the 00:20 lease storm (engines self-terminating on `tournament_lease_lost` while the database was timing out) and the 01:56 engine cutover. Any engine restart adds to the pile, which is why the count grows and never falls.

## The shape of the fix

The durable record is the evidence the rule is missing. If there is no `hand_atomic_commits` row and no `hand_history` row at that (table_id, hand_number), then no hand exists in the database at that number — whichever process held the permit, and whether it died before dealing or mid-hand before its atomic commit. A hand that never committed moved no money: the commit is atomic.

So a third outcome is defensible, with a proof stronger than `never_started`'s:

- the permit is `reserved`;
- no `hand_atomic_commits` row at (table_id, hand_number);
- no `hand_history` row at (table_id, hand_number);
- the caller holds the current live lease for the tournament (`f06_prefix` already enforces this);
- and, for the conservative version, the permit's owning generation is provably no longer heartbeating.

Resolving such a permit to `never_started` keeps the row, so `used_hand_number_max` is unchanged and the burned hand number is never reused. `f06_hand_dispatch_guard` continues to fence a late write from the original dealer.

Two things then have to happen for the 696 horses to play: the authority gains that path, and the manager attempts it on readmission rather than throwing `f06_engine_admission_unproven`.

## What was deliberately not done

No data was changed. The repo's `check-no-new-band-aids` gate refuses a migration that declares a repair, back-pay or catch-up path, and it is right to: resolving a hand permit wrongly can either void a dealt hand or let one be dealt twice. This wants the F06 owner's design, not a 02:30 patch.
