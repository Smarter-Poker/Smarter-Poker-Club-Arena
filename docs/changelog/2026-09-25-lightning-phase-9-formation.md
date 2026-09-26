# Lightning 2.0 Phase 9: the hand formation barrier is atomic, and the participant set is locked the moment it is complete

2026-09-25. Migration `20260925215731_lightning_phase_9_the_hand_formation_barrier_is_atomic_and_t`.
Branch `agent/claude-lightning-p5/lightning/phase5-conversion`.

The specification's formation barrier has thirteen steps, and it is explicit
that they complete **before cards become visible**: identify legal candidates,
reserve players, reserve seats, assign positions, assign blind roles, snapshot
`stack_before`, create an immutable `hand_id`, bind the instance, bind the
`cluster_epoch`, lock the participant set, shuffle, commit the deck and deal,
release the hand into gameplay. After it, four things are forbidden outright:

> "No participant substitution. No silent seat swap. No blind reassignment. No
> additional player insertion."

This file builds steps **one to ten**, and it builds the **precondition** of
step thirteen. It does not build eleven or twelve, and that is a decision rather
than a gap; the section below says why.

## Before this file, no hand could have formed for anybody

Phase 2 created seven Lightning relations. Phase 5's conversion writes one of
them, `lightning_pool_session`. **The other six had no writer at all.** Not one
`INSERT` or `UPDATE` of `lightning_pool_slot`, `lightning_instance`,
`lightning_reservation`, `lightning_blind_ledger`, `lightning_hand` or
`lightning_hand_player` exists anywhere in `supabase/migrations/` or
`server/src/` outside this migration. Production agrees: on 2026-09-25 all seven
relations hold zero rows, and all 166 Clusters are `must_move` with
`lightning_enabled = false`.

That is worse than "not built yet", and it is worth stating as a chain.
`fn_cash_cluster_commit_lightning` creates a `lightning_pool_session` for every
eligible seated player and creates **no** `lightning_pool_slot`. A reservation
cannot exist without a slot, because `lightning_reservation_belongs_to_its_slot`
is a four-column foreign key into `lightning_pool_slot`. A hand cannot form
without reservations. So a Cluster converted by Phase 5 as shipped would have put
every one of its players into a pool that could never deal any of them a hand,
and nothing in the schema would have said so.

## The slot is opened on pool entry, not by the conversion

There were two places to open the slot, and the conversion is the wrong one, for
two independent reasons.

**It would have to be done by asserted substitution.** `20260921151618` is
applied, its conversion body is thousands of characters of load-bearing logic,
and applied migrations are immutable. The only way to add a statement to it is
to read `pg_get_functiondef`, assert an anchor, `replace()` it and `EXECUTE` the
result - a technique this project uses only when there is no alternative.

**And, fatally, the conversion is not the only door into the pool.** It runs
once, for the founding population, at the instant a Cluster becomes Lightning.
Everybody who joins afterwards - which is nearly everybody who will ever play in
it - arrives through a door the conversion has stopped watching. A slot created
there would cover the first twenty people and nobody after them, and the defect
would present as "Lightning works for an hour after a conversion and then quietly
stops dealing anyone new in".

So `fn_lightning_pool_slot_open` opens a slot keyed on the pool session,
idempotently, and `fn_lightning_pool_slots_sync` opens one for every open pool
session that lacks one and closes every slot whose session has gone or whose
epoch has passed. One writer, both doors, and a Cluster converted before this
file existed is picked up by the same pass that picks up the next arrival.

## The barrier is steps 1 to 10, and step 13's precondition

`fn_lightning_form_hand` takes a candidate set in the matcher's order and does,
in one transaction:

| Step    | What it means here                                                                                                                                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Candidates are locked `FOR UPDATE` in `player_id` order, then filtered to the legal ones: an open slot and an active pool session at **this** Cluster and **this** epoch, a strictly positive stack, and no active reservation held elsewhere. |
| 2, 3    | One `lightning_reservation` row per player carries both the player claim and the seat claim, because they are one claim. The database refuses a second holder of either at `INSERT` time.                                                      |
| 4, 5, 6 | Seat 1 is the small blind and seat 2 the big blind; seats 3..n are filled in the caller's order untouched, so the matcher's button policy is obeyed rather than overruled. `stack_before` is snapshotted from the pool session.                |
| 7, 8, 9 | An immutable `hand_id`, the instance bound to it, and the Cluster's **current** epoch bound to both.                                                                                                                                           |
| 10      | `participants_locked_at` and `player_count` are set in one statement, and the latch refuses to close over a set whose count disagrees with its rows.                                                                                           |

**Steps 11 and 12 are deliberately in the engine.** Step 11 is "shuffle using
existing authoritative RNG architecture" and step 12 is "commit deck/deal". The
authoritative RNG lives in the engine, the deck never touches a table in this
schema, and a hole card that existed as a row in Postgres would be a hole card
that every replica, every backup and every future `SELECT` could read. What the
database hands the engine is a formed, locked, immutable participant set; the
engine shuffles for it and deals it.

**Step 13 is a door.** `fn_lightning_instance_begin_dealing` moves an instance to
`dealing` only when the hand is locked, the participant rows, the committed
reservations and `player_count` all agree, every committed reservation sits in
the seat the hand gave it, and the instance is inside its deadline. The far side
of that door is the engine's.

## One block, and its failure path leaves nothing behind

All of the barrier's writes sit in one inner `BEGIN ... EXCEPTION` block. A
refusal inside it rolls back to the block's implicit savepoint, and the
instance, the reservations, the hand and the participants cease to have ever
existed. That is stronger than the specification's "release player
reservations, release seat reservations, release instance reservations": there is
nothing to release, nothing to reap, and the players' pool state is restored
because it never changed.

The one thing that must survive the rollback is the evidence, so the
`lightning_matcher_retry` event is written in the **outer** block, after the
rollback, carrying the SQLSTATE and message of whatever refused. A retry that
leaves no trace is a retry loop nobody can see. The handler's list is closed on
purpose: anything else propagates and aborts the caller, because a barrier that
swallows every error turns a bug into a pool that silently stops dealing.

## The four no-rules are a one-way latch

The latch is one column, `lightning_hand.participants_locked_at`. It is NULL
while the barrier is assembling the hand and set once, at step 10.
`trg_lightning_hand_is_immutable` refuses to clear it or move it, and every rule
keys off it, so "after the formation barrier" is a fact in a column rather than a
convention in a caller:

- **no participant substitution** - `UPDATE` of `player_id` or `pool_slot_id` on
  a locked hand is refused, and so is `DELETE` of a participant;
- **no silent seat swap** - `UPDATE` of `seat` is refused;
- **no blind reassignment** - `UPDATE` of `position`, `blind_role` or
  `stack_before` is refused;
- **no additional player insertion** - `INSERT` into a locked hand is refused;
- **no matcher mutation** is all four plus: a hand cannot be deleted, its
  identity, Cluster, epoch, instance and formation time are frozen, and
  `lightning_instance.hand_id` is write-once.

They are triggers rather than discipline in the functions, so they hold for a
hand written by a later phase, a backfill, an operator with `psql` or a matcher
with a bug. `fold_type` and `stack_after` stay writable always: they are the hand
being **played**, and a barrier that froze them would freeze the game.

## Rule 725 forced a one-slot pool, and that is said out loud

> "A player can never have more than one active Lightning reservation within the
> same logical gaming session."

The schema as built enforced something orthogonal: one pending reservation per
**slot**, while `lightning_pool_slot_one_open` is unique on
`(player_id, cluster_id, slot)` and therefore lets one player hold slot 1 and
slot 2 open at once - two live claims on one stack. Two indexes close it and
must be read together: `lightning_reservation_one_active_per_player`, unique on
`(cluster_id, player_id)` over `pending` and `committed`, and
`lightning_pool_slot_one_open_per_player`, unique on `(cluster_id, player_id)`
over open slots.

**The second is a real narrowing of the schema's intent.** `slot` ranges 1..24
because the pool was designed to let one player hold several concurrent seats.
Rule 725 and a multi-slot pool cannot both be true. Rule 725 is the
specification, so the pool is single-slot, `fn_lightning_pool_slot_open` always
writes slot 1, and the column keeps its range so that the day the specification
changes, only an index moves.

## An instance is born with a deadline

Phase 5 got its reaper only after a Cluster could already be wedged in
`PENDING_ON`. A forming instance is the same shape at thousands an hour, each one
holding reservations that make its players unmatchable. So:

1. `lightning_instance.deadline_at` is `NOT NULL` with a default and a CHECK that
   it follows `created_at`. No code path can create an instance without one.
2. `fn_lightning_instance_open` reaps the Cluster's expired instances **before**
   it opens a new one, in the same transaction.
3. `fn_lightning_instance_begin_dealing` refuses an instance past its deadline.
4. `fn_lightning_reap_formations` is the estate-wide sweep, and is the third line
   of defence rather than the first.

A committed reservation is handed back when its instance reaches `complete` or
`abandoned`, by an `AFTER` trigger on `lightning_instance` rather than a line in
a function, so it is true of every road into a terminal state.

## P2 is consulted, not reimplemented

The barrier writes the blind roles, so a barrier that assigned them freely would
make P2 unenforceable however good the matcher is. `fn_lightning_blind_order` is
the one expression of the P2 key in the database - unresolved big-blind
obligation first, then `last_bb_at` ascending `NULLS FIRST`, then blind-debt age,
then pool entry, then `player_id` - and it is the first reader the
`lightning_pool_slot_oldest_bb` index has ever had. The barrier calls it; it does
not restate it. An earlier cut did restate it, and a mutation run caught the two
copies drifting apart.

The matcher may name its own big blind, and the barrier refuses the choice unless
it ties with the P2-maximal candidate on the whole key. The barrier stamps
`last_bb_at`, `last_sb_at`, `last_button_at` and the hands-since counters, and
increments the role counters in `lightning_blind_ledger`; without that stamp the
same player would be the big blind of every hand for ever. Candidacy, batching,
long-run convergence and P3's position fairness remain the matcher's.

## Forming a hand moves no money

`stack_before` is read from where the conversion put it:
`starting_stack + net_result` on the pool session. Nothing in this file writes
`table_seats`, any wallet, `chip_ledger`, `cash_player_session` or
`lightning_pool_session`, and none of `missed_bb_debt`, `bb_owed` or `sb_owed` -
those are obligations discharged when a blind is **posted**, and posting is the
engine's. The barrier measures the Cluster's pool chip total before and after the
formation block and raises, uncaught, if it moved, because money moving during
formation is not a thing to retry.

## Nothing forms outside a Lightning Cluster or across an epoch

`trg_lightning_instance_is_disciplined` refuses an instance whose Cluster is not
`lightning` with `lightning_enabled`, whose epoch is not the Cluster's current
one, or whose epoch row has ended. The foreign key into `cash_cluster_epoch`
proves an epoch existed; this proves it is the one in force. The barrier takes
the `cash_games` row `FOR UPDATE` before it reads the epoch, which serialises it
against the conversion's own lock.

Law 10.5 holds: there is no `is_horse` in any predicate, ordering or filter. The
freeze gates the five doors in - forming, opening an instance, beginning to deal,
opening a slot and the opening half of the sync - and none of the roads out:
reaping, abandoning, releasing reservations and closing a departed player's slot
are recovery, and the maintenance break is when recovery happens. Every function
is `SECURITY INVOKER` with a pinned `search_path`, revoked from `PUBLIC`, `anon`
and `authenticated`, and granted to `service_role` only.

## What this does not do

It forms nothing. No caller exists, no matcher exists, and the instance trigger
refuses every Cluster in production because none is `lightning`. It shuffles
nothing and deals nothing. It settles nothing, and `complete` is reachable only
through a settlement phase that has not been written. No money moved, no seat was
written and no Cluster converted.

## Found in review

After this migration was applied, an adversarial audit found defects in it. They
are listed here as found, and **all of them are being repaired in a follow-up
remediation migration**, which carries its own changelog entry; nothing below
describes that repair.

- **A `dealing` instance could never be reaped.** The reaper sweeps only
  `forming` and `reserved`, so an instance that reached `dealing` and was then
  lost kept its committed reservations for ever, and
  `lightning_reservation_one_active_per_player` locked every one of its players
  out of the pool permanently.
- **The reaper, the slot sync and the slot opener were called by nothing**, and
  the barrier itself never reaped. The "self-healing" half lived in
  `fn_lightning_instance_open`, which the barrier does not call.
- **The latch could be set at `INSERT`.** `trg_lightning_hand_is_immutable` fires
  on `UPDATE` and `DELETE` only, so a hand inserted already locked skipped the
  check that its `player_count` matches its rows.
- **The chip guard was a READ COMMITTED false positive.** The before and after
  totals are two statements, each seeing whatever had committed when it ran, so
  any concurrent commit that moves a pool session's `net_result` or `exited_at`
  between them makes a correct formation raise `LIGHTNING_FORMATION_MOVED_MONEY`
  and abort its caller.
- **The exception handler excluded the retryable SQLSTATEs.** Serialization
  failures, deadlocks and lock timeouts propagated and aborted the caller instead
  of being recorded as a retry.
- **`TRUNCATE` bypassed the immutability triggers.** Row-level triggers do not
  fire on it, so a locked hand could be erased wholesale.
- **The specification's five version columns were absent.**

Two more were found while writing the static suite for this migration, and are
recorded here for the same remediation:

- **The migration sets no `SET LOCAL lock_timeout`.** Every Lightning migration
  from `20260921025504` on carries one; this one takes `ACCESS EXCLUSIVE` on
  `lightning_instance` and `lightning_hand` four times with no bound on the wait.
- **The CI harvester reads one sentence of the header as a proof.**
  `declaredProofs` in `scripts/ci/check-migrations-are-live.mjs` matches
  `-- @live-proof:` anywhere on a line, so the header sentence that introduces
  the proofs is harvested as a 35th "proof" that is not SQL. It is latent,
  because proofs are evaluated only for a migration the check cannot match by
  name, but on a replay it would be sent to `psql` inside the single `UNION ALL`
  probe every proof shares and fail all of them at once. `20260925204249` has the
  same shape. Six of the thirty-four real proofs also read a function body with
  `pg_get_functiondef` without stripping its comments first, one of them a
  negative (`!~`) match - the defect class this project has already been bitten
  by three times.

## Qualification

`tests/lightning-phase-9-formation.test.ts` is a static suite over this
migration only, in the house style of `tests/lightning-phase-5-conversion.test.ts`:
a literal-aware strip asserted to do work in both directions on this file, the
transaction shape, one `ADD COLUMN` per `ALTER TABLE`, every `ADD CONSTRAINT`
and every `CREATE TRIGGER` paired with the existence check immediately in front
of it **by name and by table**, the `REVOKE`/`GRANT` pair for every function
driven off a regex so a new function cannot slip past, no `SECURITY DEFINER`
without a written argument, no `is_horse` in code, no write to any money-bearing
table, the exact set of freeze-gated functions, the statement orderings above by
character index, every nullable operand of every CHECK guarded in its own arm
(nullability read from the Phase 2 `CREATE TABLE`, not from a list), `prokind` on
every catalogue-wide scan, and the `@live-proof` lines parsed for balance as a
floor with the extraction count equal to the raw line count. It is 25 cases,
and every one of them was mutation-tested: 33 mutants of scratch copies, fed in
through `LIGHTNING_P9_MIGRATION` and `LIGHTNING_P9_CHANGELOG` - a second
`COMMIT`, a merged `ADD COLUMN`, a guard on the wrong constraint name or the
wrong table, a missing `GRANT`, a grant to `authenticated`, a `SECURITY DEFINER`,
an `is_horse` filter, a write to `cash_player_session` or `chip_ledger`, a debt
column in the ledger upsert, a gated reaper, an ungated barrier, the reap moved
out of the instance opener, a proof without `prokind`, an unguarded nullable in a
CHECK, an unbalanced proof, a proof hidden from the anchored harvest, a lock
timeout after the first DDL, a `random()` call, a second P2 ordering, a two-way
latch, an instance inserted without its deadline, and the changelog losing either
of the two findings this suite depends on. All 33 turned the suite red.

`scripts/dev/test-lightning-phase9-formation.sh` exercises the same claims
against a running PostgreSQL 17 catalogue and estate built by the real
conversion. It is owned by a separate branch and was not run from here, so no
pass count is claimed for it; at the time of writing it is not yet a step of the
`accounting_postgres` job. The migration is recorded in production's
`schema_migrations`, and all thirty-four of its line-anchored `@live-proof`
expressions were evaluated read-only against production on 2026-09-25 and are
true.

## Rollback

Four columns, three constraints, three indexes, six triggers and fifteen
functions, over tables that hold no rows. Dropping the triggers, then the
functions, then the indexes, constraints and columns returns the schema to
Phase 5's shape exactly. Nothing else refers to any of them, because nothing
calls them. No money moved.
