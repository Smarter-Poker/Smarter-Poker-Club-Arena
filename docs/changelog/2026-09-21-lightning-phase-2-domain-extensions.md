# Lightning 2.0 Phase 2: domain and database extensions

2026-09-21. Migration `20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_`.
Branch `agent/claude-lightning-p2/lightning/phase2-domain-extensions`.

Phase 2 of the Lightning 2.0 build. The assignment is one sentence: "Add only
missing entities/fields. Do not duplicate existing concepts."

Phase 1 gave the existing continuous cash session a Cluster. Phase 2 adds the
entities the rest of the build needs and nothing else. Every relation is created
empty, nothing writes to any of them yet, and there is no matcher (Phase 6), no
population predicate (Phase 4), no conversion (Phase 5) and no formation
(Phase 9). That is what a schema phase is; it is also why every invariant the
later phases depend on is encoded as a constraint here rather than left to the
code that will eventually do the writing.

## What already existed, and is therefore not duplicated

Reconnaissance against the live catalog and the source came first:

- The continuous economic identity is `cash_player_session`. Phase 2 adds no
  stats to it. Its whole purpose is to be one stable row per player per Cluster.
- `session_history` exists but is client-authored and non-authoritative
  (`SessionStatsService` buffers to `localStorage` and writes one row on leave).
- `ca_hand_player_stat` and `ca_hand_facts` are per-hand analytics, the wrong
  grain for a participation period.
- `cash_seat_moves` is the precedent for a hold with a state and an expiry. Its
  shape is copied; the table is not extended.
- **Blind debt does not persist anywhere today.** It lives in engine memory on
  `ServerTableEngineBase` (`returningFromSitout`, `postingBBToEnter`,
  `waitingForBB`, `mustPostBB`, `postBBWhenClear`) and is lost on every engine
  restart. Only the entry hold survives, via `table_seats.entry_hold`. There was
  nothing to extend.

Two name collisions were avoided. `instance_id` is already taken and means the
**engine process id** (`engine_table_leases.instance_id`, and the
`p_instance_id` lease fence on `fn_ca_commit_hand_settlement`); everything here
says `lightning_instance_id`. `seat_reservation` belongs to the live-venue
Commander module.

## The model has three levels

```
cash_player_session      the economic identity      (Phase 1)
  -> lightning_pool_session   the participation period
       -> lightning_pool_slot      one of the player's simultaneous tables
```

The third level is the one that matters, and the first draft of this migration
did not have it. Multi-table Lightning is an explicit product requirement, and
P0 reconnaissance had already named the shape: "one cluster cash identity and
configurable simultaneous play must be represented as distinct participation
slots under that identity."

Without the slot, a player at three tables is unrepresentable. One `state` for
three answers. One `hands_since_bb` for three independent orbits. One `p95` for
three distributions - and a percentile cannot be merged across them by any
arithmetic, so whichever table wrote last would win. One `wait_total_ms`
summing intervals that overlap in wall-clock time, because a multi-tabler waits
at three tables while playing the fourth, inflating the derived mean by the
table count. And no way to leave one table while playing the others.

So the split is by what a thing is true OF, not by convenience:

| Lives on the SLOT (true of a table)                              | Lives on the IDENTITY (true of a human)               |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| orbit position: `hands_since_bb`, `last_bb_at`, `last_button_at` | blind debt: `missed_bb_debt`, `bb_owed`               |
| wait: `wait_total_ms`, `p95_wait_ms`, `p99_wait_ms`              | fairness totals: `bb_count`, `sb_count`, `btn_count`  |
| counters: `hands`, `fast_folds`, `showdowns`                     | money: `starting_stack`, `ending_stack`, `net_result` |
| per-table open and close                                         | participation state, narrowed to seven values         |

The participation `state` keeps only the seven values that aggregate - joining,
eligibility_check, active, sit_out, disconnected, leaving, closed. The eight
per-hand states the specification names (idle_pool, matching, reserved,
in_instance, in_hand, folded, watching, ghost_bb) are **derived** from a live
`lightning_reservation` and the `lightning_instance` it names, which is where
that truth already is. One truth read two ways, never two truths that drift.

## The seven relations

`lightning_pool_session`, `lightning_pool_slot`, `lightning_instance`,
`lightning_reservation`, `lightning_blind_ledger`, `lightning_hand`,
`lightning_hand_player`. Plus `cash_cluster_events.cluster_epoch integer NOT
NULL DEFAULT 0`, so events can be grouped by the seating regime they happened
under; the default is the epoch every existing cluster is at, so all four
existing insert shapes and all 35 migration files that write to that table keep
working untouched.

An instance is deliberately **not** a row in `public.tables`. That relation is
273,037 rows of durable tables with its own lifecycle, balancer and F06 readers;
a disposable one-hand container would arrive at hand rate and drag `table_seats`
with it.

The hand linkage is a **side table**, not nine columns on the existing hand
relations. Measured: `hand_history` 2,899,738 rows / 14 GB,
`hand_atomic_commits` 2,851,032 / 11 GB, `ca_hand_facts` 9,397,778 / 8.6 GB, all
on the live per-hand write path. Non-Lightning hands would carry nine
permanently NULL columns forever, and `fn_ca_commit_hand_settlement` keeps its
exact 12-argument signature.

## Delete rules, chosen rather than defaulted

`lightning_pool_slot.pool_session_id` is **ON DELETE RESTRICT**.
`lightning_hand_player.pool_slot_id` is the hand's only record of which table it
was played at, and it deliberately carries no foreign key so hand history
outlives the pool. A slot that could cascade away would leave every historical
hand pointing at a table that no longer exists - the same rule as "instance
destruction must never destroy hand history", one level down. A participation
period is a record; it is closed, not deleted.

`lightning_reservation.pool_slot_id` is **ON DELETE CASCADE**, because a hold is
a transient claim that a closed table should never keep.

Both foreign keys are **composite over (id, player_id, cluster_id)**. The child
relations denormalise `player_id` and `cluster_id` so the indexes can key on
them without a join, and denormalised copies that nothing checks are copies that
drift. The indexes they feed are the ones that matter:
`lightning_pool_slot_one_open` would enforce one-open-table for the wrong human,
`lightning_pool_slot_oldest_bb` would select blinds for the wrong human, and
`lightning_reservation_one_seat_per_player_instance` - the index that stops one
human holding two chairs at one instance - keys on the hold's own `player_id`,
so a mismatch would silently reopen exactly the hole it exists to close. Each
level now exposes a `UNIQUE (id, player_id, cluster_id)` constraint and the level
below references all three columns together, so the database refuses a child
whose idea of the human or the cluster differs from its parent's.

Real `UNIQUE` constraints rather than bare unique indexes: PostgreSQL accepts
either as a foreign-key target, but `information_schema.referential_constraints`
leaves `unique_constraint_name` NULL for an index, so anything introspecting
through the standard views rather than `pg_catalog` sees a key it cannot
resolve.

## One rule this schema cannot hold, stated rather than assumed

Nothing here stops a hold being issued on a table the player has already closed,
or a new table being opened under a participation period that has already
exited. Both are cross-row conditions, so neither is expressible as a CHECK, and
a partial unique index cannot be a foreign-key target. A trigger reaching across
levels would sit on the matcher's hot path. **Phase 6's forming transaction owns
this rule, and Phase 6's harness owes two named checks for it.** The exposure is
bounded rather than open-ended: a stray hold expires within
`expires_at - created_at`, and `lightning_reservation_pending_by_expiry` exists
for the sweep that collects it.

## Qualification

`scripts/dev/test-lightning-phase2-domain.sh` - real PostgreSQL 17 via `initdb`,
unix socket only, wired into the `accounting_postgres` job in `ci.yml` so it
actually executes on a pull request. It prints one `ok` line per check; the
checks are named rather than counted.

**Thirty-two mutations of a copy of the migration, zero survivors.** Every one
produces a precise named failure and a non-zero exit. That number is the point
of this entry: the first draft of this migration passed a harness that could not
catch a one-player instance, a lost cascade, a widened fold taxonomy or a
missing grant, and the mutations are what found that.

Adversarial verification changed the design five times, not merely the tests:
the slot entity itself; one player holding two seats at one instance (accepted
by the reservation layer, impossible at the hand layer, discovered only by
trying it); orbit and percentiles living at the wrong level; the cascade that
destroyed hand attribution; and a sequential scan of the highest-churn relation
on every slot close, measured at 19,990 rows scanned to find 10.

`tests/lightning-phase-2-domain.test.ts` pins what is only visible in the
source: that per-table things are on the slot and absent from the session and
the ledger, that per-identity things stayed, that nothing derived is stored,
that no hot relation is widened, that no foreign key touches a pre-existing
table, and that the manifest declares exactly what the migration creates.

## Rollback

Seven new relations, all empty, plus one defaulted column. Dropping the seven
and the column restores the prior shape exactly. No existing relation is
altered except `cash_cluster_events`, which gains a column with a constant
default - a catalog-only operation on PostgreSQL 11+. No money moved, and no row
of any pre-existing table was written.

## Correction, 2026-09-21

Written after an adversarial audit of this migration as merged. Migration files
are immutable, so nothing above is edited; what follows is the record of what
it got wrong and where each is answered.

**Three counts in this document are wrong.** There are **33** migration files
that write to `cash_cluster_events`, not 35 (`grep -rl "INSERT INTO
public.cash_cluster_events" supabase/migrations/ | wc -l`). There were **34**
mutations of the migration copy, not 32; the commit says 34 and this document
says thirty-two. Neither number changes a conclusion, and both are stated
because a document that rounds its own evidence cannot be used as evidence.

**The eighth `@live-proof` line of `20260920235343` is now false.** It reads

```
array_length(c.conkey, 1) = 3
```

over `lightning_pool_slot_belongs_to_its_session` and
`lightning_reservation_belongs_to_its_slot`. `20260921025504` makes both
four-column keys, so that expression returns false from the moment that
migration applies. It is superseded, not repaired: the file stays as merged and
the new migration declares the new truth in its own proofs.

The line is latent rather than red. `scripts/ci/check-migrations-are-live.mjs`
decides cheapest-first and stops at step 1, the name match, which this
migration passes - it is recorded in `supabase_migrations.schema_migrations`
under its own slug. The proofs are evaluated only for a migration that step 1
and step 2 could not clear. It would fire on a replay into a database whose
`schema_migrations` was not carried over.

**The hand family was joined to nothing.** `lightning_hand`,
`lightning_instance` and `lightning_hand_player` were given the cluster, epoch,
instance and slot columns and none of the keys, so the database permitted a
hand in a cluster its own instance was not in, a hand naming an instance that
did not exist, and a participation row pointing at another player's table -
the exact column whose stated purpose here is that "per-table statistics could
be reconstructed". Closed by `20260921025504`, which carries this document's
own stated principle one level further: every level exposes its identity as a
real UNIQUE constraint and the level below references the whole tuple.

**`cluster_epoch` had no authority.** Six relations carry one and nothing said
which epochs exist. `20260921025504` makes the epoch a row
(`public.cash_cluster_epoch`, append-only, one open epoch per cluster) and both
family roots reference it.

**`cash_cluster_events.cluster_epoch DEFAULT 0` was about to become a lie.**
Correct while every cluster is at epoch 0, and a silent misfiling on the first
bump, for all 33 insert sites that name no epoch. `20260921025504` fills it in
a `BEFORE INSERT` trigger, which a DEFAULT cannot do because a DEFAULT cannot
read another row.

**One test here claimed more than it proved.** The case named `locks the
participant set of a committed hand` asserted the primary key and the
unique-seat index and nothing else. Neither is the formation barrier. It is
renamed in `20260921025504`'s change to say what it does prove; the barrier
itself - at least two players, no seat past the instance's `max_size` - is a
statement about a set of rows that no CHECK constraint can see, and belongs to
the formation function of spec Phase 9.

**The manifest-honesty case was one-directional.** It checked that the
migration's objects appeared in the fragment, by substring, and not that the
fragment contained nothing else. It is now a set equality in both directions on
exact strings.

## Correction, 2026-09-25: the second `@live-proof` of `20260921025504` was false by construction, and has been restated

The line read:

```sql
-- @live-proof: (SELECT count(*) = (SELECT count(*) FROM public.cash_games)
--                 FROM public.cash_cluster_epoch WHERE epoch = 0)
```

It was never true of anything but a virgin estate, and that is worth stating precisely, because it is not the usual kind of stale proof. It had not drifted away from code that changed under it. It contradicted the backfill standing four lines below it on the day it was written.

The genesis backfill inserts one open epoch row per Cluster **at that Cluster's own epoch** — that is its entire purpose, it is what the migration's own read-back guard asserts, and it is what the harness section named `GENESIS BACKFILL` already said in so many words: "each carrying that cluster's own epoch … rather than three constants". A Cluster that has ever advanced its epoch therefore has no epoch-0 row at all, and never had one to lose. `WHERE epoch = 0` can only ever match Clusters that have not moved.

It went unnoticed for four days because it was accidentally true of production, where all 166 Clusters sit at epoch 0 and nothing has yet converted. That is the tell: it pinned an **estate fact dressed as a fact about the migration**. The same class of mistake was found and removed from two Phase 4 proofs and two Phase 5 proofs in the same week, and it is worth naming as a category, because it is the one kind of false proof that a green production check cannot find — it is true right up until the feature it guards starts working, and then it fails for the first time on the day of the thing it was supposed to protect.

**How it was found.** Three of the six Lightning harnesses — this file's included — had no live-proof section at all, so 47 proof lines across them had never once been put to a database. `-- @live-proof:` lines are comments; nothing evaluates them unless a harness is written to. Giving all three the section that Phase 4 and Phase 5 already had turned this one red on the first run, on a board carrying a Cluster at epoch 2.

**What changed.** The comment only. No applied statement in `20260921025504` is touched, and the migration is not re-applied. The claim is restated as the invariant the backfill really establishes, and which stays true however many Clusters convert:

```sql
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g
--   WHERE (SELECT count(*) FROM public.cash_cluster_epoch e
--           WHERE e.cluster_id = g.id AND e.ended_at IS NULL) <> 1))
```

Exactly one open epoch row per Cluster. Verified true against production after the change, and — unlike its predecessor — it will still be true after the first Lightning conversion. The adjacent third proof, which states the same idea over `g.cluster_epoch` rather than over the constant `0`, was true all along and is unchanged.

**Still worth doing, and not done here.** None of this file's thirteen proofs uses the comment-stripping idiom `regexp_replace(pg_get_functiondef(...), '--[^' || chr(10) || ']*', '', 'g')`, and `20260921044045`'s seventh proof forbids the string `DESC` while reading the raw function body. It is true today and one explanatory comment containing the word away from the failure that has already bitten three proofs in this project. That wants a supersession of its own rather than a quiet edit here.
