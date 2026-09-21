# Lightning 2.0 Phase 2 remediation: the hand knows its cluster, its instance and its epoch

2026-09-21. Migration `20260921025504_lightning_phase_2_remediation_the_hand_knows_its_cluster_its`.
Branch `agent/claude-lightning-p3/lightning/phase3-feeder-first`.

An adversarial audit of the merged `20260920235343` found two holes that a
schema phase exists to close and did not. Both are closed while all seven
Lightning relations are still empty - verified 0 rows in each at 02:57 UTC - so
every `ALTER` here is a catalogue edit with no rewrite and no validation scan.
After the first Lightning hand is dealt, the same repair needs a backfill and a
maintenance window.

## Hole 1: the hand family was joined to nothing

`20260920235343` wrote two foreign keys, both in the pool family, and stated
the principle they encode: *"each level exposes `(id, player_id, cluster_id)`
as a unique key and the level below references all three columns together. The
database then refuses a child whose idea of the human or the cluster differs
from its parent's."* The instance / hand / hand_player family got the columns
and none of the keys. Demonstrated against a throwaway PostgreSQL 17 backend
carrying that migration:

- A hand could claim cluster A epoch 4 while its instance was in cluster B
  epoch 1. `lightning_hand_by_cluster_epoch` exists precisely to group history
  by that pair, so the hand would be filed under the wrong seating regime for
  good.
- `lightning_hand.lightning_instance_id` is `NOT NULL` and referenced nothing:
  a hand could name an instance that does not exist.
- `lightning_hand_player.pool_slot_id` is `NOT NULL` and referenced nothing, so
  a participation row could point at **another player's table**. Every
  per-table statistic reads `lightning_hand_player_by_pool_slot`.
- `lightning_hand_player.hand_id` is `NOT NULL` and referenced nothing: a
  participation could outlive, or precede, any hand.

The fix carries the same principle one level further rather than inventing a
second one. `lightning_instance` and `lightning_hand` each expose an identity;
`lightning_hand_player` learns `cluster_id` and `cluster_epoch` so its two keys
can be composite, and the database - not the writer - is what makes the copies
agree.

## Hole 2: `cluster_epoch` had no authority

Six relations carry a `cluster_epoch`. Nothing said what an epoch is, which
epochs exist, or that a Lightning row's epoch is its cluster's.
`cash_games.cluster_epoch` is one mutable integer: the moment Phase 5 bumps it,
every row written under the old value is unanchored, because the only record
that the old epoch existed was the integer that just changed.

So the epoch becomes a row. `public.cash_cluster_epoch` is append-only history
- one row per `(cluster, epoch)`, the mode it ran under, when it started and
when it ended - with `cash_cluster_epoch_current` enforcing exactly one open
epoch per cluster. `cash_games.cluster_epoch` stays what it is, the pointer to
the current one, and this is what it points at. 166 genesis rows were
backfilled from each cluster's own epoch, its own mode and its own
`created_at`; a `DO` block refuses the migration if any cluster is left without
an open epoch row.

**Why not a foreign key onto `cash_games (id, cluster_epoch)` directly.** That
was the first draft and it is wrong: `cash_games.cluster_epoch` is mutable by
design, and a key onto it would refuse Phase 5's bump for as long as any
historical Lightning row still named the old value - which is forever, because
history is never deleted. An epoch row is never deleted and never renumbered.

## Hole 2b: the event ledger's default was about to become a lie

`cash_cluster_events.cluster_epoch DEFAULT 0` is right today and wrong on the
first bump: **33** insert sites across the estate name no epoch, and each would
silently file its event under the genesis epoch of a cluster that had moved on.
A DEFAULT cannot read another row, so the fill happens in a `BEFORE INSERT`
trigger, and it is deliberately narrow - it supplies the cluster's current
epoch only when the row arrives carrying 0 and the cluster is not at 0. An
author who names an epoch is obeyed, including one who names 0.

## What this does not do

The **formation barrier** is not enforced here and cannot be. "A committed hand
has at least two players" and "no seat exceeds its instance's `max_size`" are
statements about a set of rows, which no CHECK constraint can see. They belong
to the formation function of spec Phase 9. What this migration does is make
that function's job possible: after it, a hand cannot be formed in a cluster
its instance is not in, and a seat cannot be filled by a player who is not at
that table.

`lightning_blind_ledger` is deliberately left without an epoch. A blind
obligation is owed by a human to a Cluster and survives a change of seating
regime; keying it by epoch would forgive every debt at conversion.

## Qualification

`scripts/dev/test-lightning-phase2-remediation.sh` applies `20260920235343` and
then this migration to a throwaway PostgreSQL 17 cluster built by `initdb`, and
exercises fifteen sections against a real backend rather than against a reading
of the file. Every refusal is asserted **by constraint name**; every refusal is
paired with the thing that must still be accepted, because a key that refuses
too widely makes multi-tabling impossible and would pass a test that only
looked for the refusal.

**Ten mutations of a copy of the migration, zero survivors.** Deleting
`lightning_hand_player_sits_in_its_own_slot` is caught by a participation naming
another player's table; deleting `lightning_hand_belongs_to_its_instance` by a
hand filing itself under a cluster its instance is not in; turning
`cash_cluster_epoch_current` into a plain index by the catalogue read;
replacing the backfill's `g.cluster_mode` with a literal by the cluster whose
mode is `lightning`; deleting the trigger and neutering its early return by the
event section; narrowing the slot key by two separate mutations, one for the
catalogue shape and one for the behaviour, because the literal mutation could
not even apply against the four-column identity; and removing `cluster_epoch`
from the BB index by reading its key columns.

**The migration was not re-appliable and is now.** The first draft dropped only
the two keys `20260920235343` wrote. On a second application PostgreSQL refuses
to drop `lightning_pool_slot_identity` while
`lightning_hand_player_sits_in_its_own_slot` - added by this same file on the
first run - depends on it, and the same held for two more pairs. Found by the
harness, not by review. All nine drops are now gathered at the head of section
3, children before parents.

`tests/lightning-phase-2-remediation.test.ts` pins what is only visible in the
source, including that ordering: the offset of every child-key drop is less
than the offset of the identity it points at.

## Rollback

One new table with 166 rows that nothing reads yet, one new trigger function,
one trigger, five new foreign keys and four rebuilt unique constraints over
relations that are still empty. Dropping the table and the trigger and
restoring the three-column identities returns the prior shape exactly. No money
moved. The only pre-existing relations touched are `cash_cluster_events`, which
gains a trigger and no column, and `cash_games`, which is read and not written.
