# Lightning 2.0 Phase 5: the conversion is one transaction, the tables stop dealing, and the tick and the balancer stand down

2026-09-21. Migration `20260921151618_lightning_phase_5_the_conversion_is_one_transaction_and_the_`.
Branch `agent/claude-lightning-p5/lightning/phase5-conversion`.

The specification's Phase 5 section is nine lines and has no numbered steps. The
twenty-four steps live in **STATE MACHINE - LIGHTNING TRANSITION**, and they are
what this file implements: acquire the Cluster lock, verify `MUST_MOVE`, compute
the live eligible population, stop below the threshold, set `PENDING_ON`, stop
starting new assignments, let started hands resolve, wait for a conversion-safe
boundary, recalculate, abort if it fell, snapshot, create the next Epoch, detach
the physical assignments, preserve everything economic, initialise Pool
Sessions, set `LIGHTNING`, emit `lightning_on`, release the lock.

> "NO MONEY MOVES AS A RESULT OF THIS TRANSITION."

Steps 18, 20 and 23 - fairness ledgers, matcher prewarm, matcher operation - are
Phase 6 and later and are **named in the file as not-done** rather than quietly
skipped. Everything else is here.

## The shape: the seat stays as the anchor

`table_seats` is never written. The row survives untouched, keeping the stack,
the custody binding and its `cash_player_session`. The physical tables stop
DEALING. The pool is an overlay in `lightning_pool_session` pointing at the
**same** `cash_player_session` the seat already had.

That choice is what makes the mandated invariants true by construction rather
than by enforcement. The specification's own list -

> "The following values must not change solely because of conversion: stack,
> baseline, stay clock, rejoin obligation, wallet balance, rake rate,
> accumulated legitimate rake, player identity, cluster membership, VPIP sample,
> `cluster_join_at`."

\- is, item for item, a list of things that live on rows this transaction does
not write. F12, the conversion chip invariant, is not so much checked by this
file as made unreachable by it: there is no `UPDATE table_seats.stack` here to
get wrong. It is measured anyway - the chip total is read before the writes and
again after them and the two must be byte-identical - because an invariant
nobody measures is an invariant nobody knows about, and that assertion exists to
start failing the day somebody adds a write that does move a stack.

It also means the whole conversion is one transaction under one row lock, and
that reversing it is a matter of clearing two columns. Step 14's "detach
physical table assignments in a non-economic operation" is the one line of the
specification in tension with this, and the tension is linguistic: the
assignment is detached in the sense that matters - the table no longer deals to
the seat, and the matcher owns the player - without destroying the record that
proves whose chips those are. A design that really deleted the seat row would
have to re-derive custody on the way back out, and Phase 10 (`LIGHTNING ->
MUST-MOVE`, **"THIS PHASE IS MANDATORY"**) would become a reconstruction problem
instead of a lookup.

## The engine did not know any of this existed

**Before this file, nothing in `server/src` read `cash_games.cluster_mode`.**
Zero occurrences in the whole tree. Three layers were checked one at a time:

- `cash_tables_needing_engine`, which decides who gets an engine, joins
  `table_seats` to `tables` and never touches `cash_games`. Because this design
  deliberately keeps every seat alive, every physical table of a converted
  Cluster still qualifies on the next five-second sweep, and a reaped engine is
  rebuilt into the same state.
- `isNextHandPaused()`, which decides whether a table starts a hand, was seven
  in-memory booleans, not one of them ever set from Cluster state.
- `stopIfClusterTableClosed()` returns early on `seatedPlayers.length > 0`. It
  only stops an **empty** table.

So a Cluster could have converted to `LIGHTNING` and its physical tables would
have gone on dealing, **from the same seats, with the same chips, while the pool
believed it owned those players.** That is the duplicate-player failure F13, F14
and F15 are all written about, arriving not from a race but from an engine that
was never told.

`tables.dealing_halted_at` is the signal, and it says exactly one thing: _finish
the hand you are in, and start no other_. It does not close the table, drop the
engine, unseat anybody or touch a stack. The engine reads it through the table
row it already re-reads on a sixty-second throttle, and on `start()`, so a
rebuilt engine comes up halted immediately. `dealing_halted_reason` exists so an
operator looking at a stopped table at three in the morning is told why by the
row itself, and so a future halt for some other cause cannot be mistaken for a
Lightning conversion and cleared by Phase 10's revert.

The pairing is a CHECK, and the CHECK contains a line that looks redundant and
is not:

```sql
OR (dealing_halted_at IS NOT NULL
    AND dealing_halted_reason IS NOT NULL
    AND dealing_halted_reason IN ('lightning_pending_on', 'lightning'))
```

`x IN (...)` with `x` NULL is NULL, not false, **and a CHECK that evaluates to
NULL passes.** Without the `IS NOT NULL` line the constraint accepts the exact
row it was written to reject - halted, with no reason - and because Phase 10's
revert matches on the reason, that table would stay halted for ever.

## The tick read the capability and never the state

`fn_cash_cluster_tick` gates on `IF NOT g.must_move`, a BOOLEAN column that says
whether this game uses must-move seating **at all**. It is true throughout a
conversion and is supposed to be: Phase 10 reverts to must-move seating using
the existing table lifecycle rules, so a Cluster that turned that column off on
the way into Lightning would have nothing to turn back on.

**`cluster_mode` is the state; `must_move` is the capability.** The tick read
the capability and never the state, so it would have gone on opening feeders,
planning moves, balancing and reconciling Main 1 underneath a Lightning pool.

`fn_cash_clusters_tick_all` then calls `fn_cash_cluster_balance(game_id, now)`
after each tick, in the same transaction, **independently of what the tick
returned** - so standing the tick down does not stand the balancer down. A
Lightning Cluster would still have its census taken and a `cash_seat_moves` row
planned every five seconds, moving players between tables that are not dealing,
in a Cluster whose players the pool believes it owns. Both stand down now.

Neither is retyped. `fn_cash_cluster_tick` is **40,443 characters** of table
lifecycle, must-move planning, feeder windows, opening holds and reconciliation,
re-cut by at least eight migrations and pinned by a dozen assertions across
`TheTablesOpenAndCloseThemselves.law.test.ts`; retyping it to add four lines
would be the single most dangerous act in the file. Both are re-created by
**asserted substitution**: the body is read from `pg_get_functiondef`, the
anchor is asserted to occur _exactly once_, one `replace()` is made, every
sibling guard is asserted to have survived, and the result is read **back from
the catalogue** rather than from the variable that was just built - the variable
is what the migration intended, and only the catalogue is what the database has.
The read-back also asserts the body **grew** and that `is_horse` is still absent
from both, because Law 10.5 - a horse counts exactly like a human - is pinned
twice against these two bodies and a substitution is a very quiet way to
introduce a discrimination into a function nobody reread.

## A pending seat move is cancelled, because one loop cannot see the halt

The engine's start-up wait loop - where a cluster table below
`minPlayersToDeal()` lives - never re-reads its table row, so it can observe the
halt neither being set **nor being cleared**; gating it on a flag it can never
see lift would wedge a quiet table permanently. It still runs
`executeIdleSeatMoves()`, so a `cash_seat_moves` row planned a second before
`PENDING_ON` would execute mid-conversion and write `table_seats` from the
engine.

The database owns that hole rather than papering over it in the engine: entering
`PENDING_ON` cancels every pending move of the Cluster, and the stood-down tick
and balancer plan no more. `state = 'cancelled'` already exists in
`cash_seat_moves_state_check`; the **reason** vocabulary is untouched, because
its four values are pinned in `TheTablesOpenAndCloseThemselves.law.test.ts` and
a fifth would break two assertions for no gain.

## Membership is one predicate, and it does not mention `status`

Every query in this file that asks _which tables and which players belong to this
Cluster_ now asks it the same way, and only this way:

```sql
coalesce(tb.is_deleted, false) = false AND coalesce(tb.lifecycle, '') <> 'closed'
```

There is **no `status IN (...)` filter left anywhere in the file**, and the test
suite asserts its absence over the literal-blanked view - it has to be blanked,
because section 5c must quote the old form in order to substitute it away.

### Two nullable columns, and a CHECK that cannot save either

`tables.status` and `tables.lifecycle` are **both nullable**. `status` carries a
CHECK constraint, which looks like it should stop that and does not: **a CHECK
that evaluates to NULL PASSES.** `20260904160500` added `lifecycle` as
`text CHECK (lifecycle IN (...))` with no `NOT NULL` and no default, and `status`
has the same shape. So on a board with either column NULL:

- `tb.status IN ('waiting', 'running', 'active')` is **NULL**, not true;
- `tb.lifecycle <> 'closed'` is **NULL**, not true.

An earlier cut carried both, uncoalesced, in the orphan check, the
`lightning_pool_session` `INSERT` and the `v_seated` census, while the two halt
`UPDATE`s coalesced them. **That is the worst possible combination.** The board
was dropped from the halt _and_ from every player-set query at once, so both
sides of the `v_pool <> v_seated` guard narrowed together and the guard still
agreed. A guard that compares two numbers cannot see a predicate that makes both
numbers smaller.

### What that looked like on a running backend

Reproduced on a throwaway backend, not reasoned about:

> A Cluster of **21** eligible players converted. **18** entered the pool. **3**
> kept being dealt cash at a board nobody stopped, inside a Cluster that had
> become `LIGHTNING`, holding no pool session, with the tick and the balancer
> stood down so that nothing would ever come for them.

That is the duplicate-player failure F13, F14 and F15 are written about, arriving
not from a race but from a comparison operator against a nullable column.

`status` is an engine-facing field that can be NULL, `'paused'`, or a value
somebody adds next year. **It must not decide who is in a Cluster.** Halting a
paused board costs nothing; missing one costs a player.

### The assertion a count cannot make

`v_pool` and `v_seated` share a predicate, so the fix is not only to coalesce but
to ask the question from the **other side**, over the tables this conversion
actually halted:

```sql
SELECT count(DISTINCT ts.user_id) INTO v_stranded
  FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
 WHERE tb.cluster_id = g.id AND tb.dealing_halted_at IS NOT NULL
   AND ...eligible...
   AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session s
                    WHERE s.cluster_id = g.id AND s.player_id = ts.user_id
                      AND s.cluster_epoch = v_epoch AND s.exited_at IS NULL);
```

It deliberately carries **no membership filter at all**, so it cannot be
satisfied by the same narrowing that caused the defect: _if we stopped a table,
every eligible player sitting at it must have somewhere to play._ It counts
`DISTINCT` players, because a player seated at two halted boards is one player
and not two failures, and it names `cluster_epoch = v_epoch`, because a stale
pool session from an earlier epoch of the same Cluster - which Phase 10 and a
re-conversion both produce - would otherwise answer for a player this conversion
never pooled.

## The number that authorises a conversion, and the number printed beside it

Fixing this file's own queries was not enough, because **two of the readers it
depends on carried the same predicate**.

`fn_cash_cluster_live_eligible` is the number that AUTHORISES a conversion: the
verdict the lobby embeds and the threshold every step of Phase 5 hangs off.
Uncoalesced, it told a Cluster `threshold_not_reached` **however many people were
playing** on such a board, and when a Cluster did convert it wrote a short
`trigger_population` into the audit record - the number an operator reads
afterwards to understand what happened. It is re-created here with
`CREATE OR REPLACE`, which keeps the OID and therefore keeps its grants, its
`SECURITY INVOKER` and its `20260921064717` COMMENT untouched.

`fn_cash_cluster_population` is the nine-statement breakdown the operator console
reads, and it carried the same predicate in **five** places while delegating its
headline number to `live_eligible`. Repairing the delegate alone left one
function **contradicting itself**: on the board this migration's own harness
builds it reported `live_eligible: 24` beside `seated_eligible: 18`, over three
live boards and a hundred and twenty seats. That is worse than the original
defect - _an operator reading a console with two numbers on it believes the
smaller one._

So it is re-cut by **asserted substitution**, not retyped: the 224-line body is
read from `pg_get_functiondef`, the anchor is asserted to occur **exactly five
times** (four or six means a body this migration has not read, and it refuses
rather than substituting blind), one `replace()` is made, and the result is read
**back from the catalogue** - the old predicate gone, the new one in all five
places, the delegation intact, `is_horse` still absent - and then every Cluster in
the estate is checked for `live_eligible > seated_eligible`, which is the only
assertion that can catch a fix applied to one reader and not the other. It is a
REPLACE and not a DROP, so the function keeps its grants; a `DROP` and re-`CREATE`
would silently return a population reader to the `PUBLIC EXECUTE` default.

**`20260921064717`'s own `@live-proof` asserts that predicate occurs exactly five
times in `fn_cash_cluster_population`.** That proof is now false, deliberately: it
was pinning the defect in place. It is retired out loud, with a dated Correction
appended to `docs/changelog/2026-09-21-lightning-phase-4-population.md`, in the
same way `20260920235343`'s proof #8 was handled - not quietly reworded.

## Two more that a nullable column and a plural made

**`ORDER BY (s.cluster_id = g.id) DESC` put the wrong session first.** The pool
`INSERT` looks up the player's existing open `cash_player_session` by any of the
three routes a seat has to one - `cluster_id`, `scope_id` or `table_id` - and
breaks the tie in favour of the cluster-scoped one. But `cash_player_session.
cluster_id` is a **nullable added column**, so for a session matched only by its
table scope the sort key is NULL, and a bare `<boolean> DESC` implies **NULLS
FIRST**. The key therefore put exactly the session it exists to deprioritise at
the top. A player holding both an open cluster-scoped session and an open
table-scoped one - a shape `cash_player_session_one_open` explicitly permits -
got the wrong parent on their pool session, silently, and the pool session is
what the matcher will bill against. It is `coalesce(s.cluster_id = g.id, false)
DESC` now, with `s.opened_at DESC, s.id` behind it so the tie-break is total.

**The orphan check counted seats, not players.** It refuses the whole Cluster's
conversion when an eligible seated player has no open cash session it can point a
pool session at. Counting seat ROWS, a player seated on two member boards whose
only open session was scoped to **one** of them was counted an orphan against the
other seat - and the conversion was refused for the entire Cluster while the
`INSERT` immediately below would happily have found that same player's session.
Two queries meant to ask one question, disagreeing. It is
`GROUP BY ts.user_id ... HAVING NOT EXISTS` now, and the session lookup inside it
is character-for-character the one the `INSERT` uses; the test compares the two
rather than describing them.

## The conversion is a record, and the record is the race guard

> "Every conversion must record: `from_mode`, `to_mode`, `trigger_population`,
> `on_threshold`, `off_threshold`, `epoch_before`, `epoch_after`,
> `conversion_request_id`, completion status."

`cash_cluster_conversion` is that row, and it does more than record. Its partial
unique index on `(cluster_id) WHERE status = 'pending'` is **F13's answer in the
database** rather than in a worker that might be restarted, duplicated or run
twice by a cron overlap: two simultaneous converters cannot both open one, so
one commits and the other is told so and returns. The `cash_games` row lock
already serialises them; the index exists because a lock protects a transaction
and an index protects the table, and the table outlives every transaction.

`conversion_request_id` is unique on its own, so a retry of the **same** request
is idempotent and is answered with what already happened. That is the difference
between "no-op safely" and "no-op": a worker told `no` retries, and a worker told
`committed at epoch 3` stops.

## Two orderings that are the whole design

**`PENDING_ON` moves no epoch and creates no pool session.** The specification
creates the next Epoch at step 13, _after_ the re-check at steps 10-11, not at
step 5 - and that ordering is the entire reason an abort is cheap. Nothing that
binds to an epoch, a pool session, an instance or a hand can have been created
against an epoch that then has to be unwound, so acceptance test F04 ("18th
player leaves during `PENDING_ON`: conversion canceled, state returns to
`MUST_MOVE`, regular tables resume, no Lightning player stranded") is a
two-column clear and not a reconciliation. No Lightning player can be stranded
by that path because no Lightning player exists yet.

**The orphan check runs before the epoch bump.** A pool session must name a cash
session - the column is `NOT NULL`, and the subordination is the point:
"Entering/exiting Lightning does not create a new cash session" - so a seated
eligible player with no open Cluster session causes the whole conversion to be
refused rather than converted around. An earlier cut ran that check **after** the
epoch bump, and the consequence is worth spelling out, because it compiles,
applies, and passes every read-back the migration can take of itself: the
refusal path is a self-abort through `fn_cash_cluster_abort_pending_on`, which
begins by testing `g.cluster_mode <> 'pending_on'` and answering `wrong_state`.
By then the mode is already `lightning`. So the abort is refused, the commit
returns that refusal, **and the transaction commits anyway** - leaving a Cluster
in `lightning`, at an epoch that moved, with no pool sessions at all, because the
function returned before the `INSERT`. Every player in it is seated at a table
that has stopped dealing, in a Cluster that believes it is a pool. That is
precisely the stranding the specification forbids.

Both orderings are asserted by character index in
`tests/lightning-phase-5-conversion.test.ts`, because no catalogue read-back can
see the order of two statements inside one function body.

## The conversion-safe hand boundary, defined rather than assumed

The phrase appears exactly once in the specification and is never defined there,
so it is defined in the file and the definition is stated: **no table of this
Cluster has a hand in flight** - no `hand_history` row with `ended_at IS NULL`
that started within six hours. "Recently" is doing real work: an abandoned row
from a crashed engine has `ended_at` NULL for ever, and a boundary test that
waited for it would wait for ever and no Cluster would ever convert again. Six
hours is far beyond any real hand and far inside any plausible abandonment.

The halt placed at step 6 is what makes the boundary _arrive_ rather than merely
be tested for: no new hand starts, so the set of in-flight hands only shrinks.
The caller polls; the function does not block, because blocking would hold the
Cluster lock while tables finish their hands and the tick would queue behind it
for the length of a river.

The population is then asked **again**, in `pending_on`, rather than trusting the
number written down at `PENDING_ON` - which may be minutes old and a player
short. Until `20260921142954` the verdict could not answer in that state at all,
so this re-check would have returned false unconditionally and every conversion
would have aborted at its own safety check. That is what the Phase 4 remediation
was for.

## Sixteen defects, every one of them found before production

`scripts/dev/test-lightning-phase5-conversion.sh` applies the real fixture chain

- including the **real** 40,443-character `fn_cash_cluster_tick` and the real
  `fn_cash_cluster_balance`, assembled by line range out of the migrations that
  produced them - and then this migration, to a throwaway PostgreSQL 17 cluster,
  and exercises every claim against a running catalogue and a running estate. It
  found **eight defects in the first cut**, and line-by-line review of the cuts
  that followed found **eight more**. None of the sixteen reached production.

### Eight the harness found in the first cut

1. **The post-apply catalogue scan could not run, on any database.**
   `n.nspname` is a JOIN qual, so the planner pushes only the `p.*` quals into
   the `pg_proc` scan and evaluates `pg_get_functiondef` over every catalogue row
   it touches - including aggregates, for which it raises `"array_agg" is an
aggregate function`. Without `p.prokind = 'f'` the migration cannot apply _at
   all, anywhere_, and `EXPLAIN` says so rather than it being a matter of luck.
2. **The orphan check sat after the epoch bump**, with the consequence described
   above: a Cluster left in `lightning` with no pool sessions.
3. **An `ALTER TABLE ... ADD CONSTRAINT` was unguarded.** PostgreSQL 17 has no
   `IF NOT EXISTS` for it, so the file applied exactly once. All five are now
   wrapped in a `DO` block that asks `pg_constraint` for their own `conname`
   first.
4. **The halt CHECK accepted the row it was written to reject** - `IN (...)` with
   a NULL left-hand side is NULL, and a NULL CHECK passes.
5. **The idempotency read had no `AND cluster_id = p_game_id`.** A request id
   belonging to Cluster A, replayed against Cluster B, answered
   `{"ok": true, "status": "pending", "cluster_mode": "pending_on"}` - about A -
   while B was never touched and stayed `must_move`. The caller was told a
   conversion was in progress on a Cluster that had none.
6. **The commit's halt re-stamp matched only rows already carrying
   `lightning_pending_on`**, so a table opened between `PENDING_ON` and the
   commit would have joined a Lightning Cluster and gone on dealing. The
   stood-down tick should make that unreachable; "should be unreachable" is the
   reason a guard is cheap, not the reason to omit it.
7. **The pending seat move was not cancelled**, so the one engine loop that
   cannot see the halt would have executed a planned move mid-conversion and
   written `table_seats`.
8. **The "nothing changed" read-back asserted the estate was VIRGIN** - no
   Cluster off `must_move`, no epoch moved, no halt, no pool session - which is
   true today and becomes false the first time Phase 6 drives a conversion, at
   which point the file would stop being re-appliable over the database it was
   written for. It now takes three checksums into transaction-local settings
   before any of its own behaviour and compares them at the end, so what it
   proves is that **it** changed nothing.

### Eight more that review found, and that are repaired in the cut that shipped

9.  **Membership was decided by the nullable `lifecycle` column.** The two halt
    `UPDATE`s coalesced it; the orphan check, the pool `INSERT` and the `v_seated`
    census did not. A NULL-lifecycle board was therefore **halted** while its
    seated eligible players were left out of every player-set query.
10. **Membership also required `status IN ('waiting', 'running', 'active')`,
    against a second nullable column** whose CHECK cannot stop a NULL, because a
    CHECK that evaluates to NULL passes. This is the one that was reproduced
    live: **21 converted, 18 entered the pool, 3 kept being dealt cash** at a
    board nobody stopped, with the tick and the balancer stood down so that
    nothing would ever come for them. Both sides of the `v_pool <> v_seated`
    guard narrowed together, so the guard still agreed.
11. **The commit's halt re-stamp overwrote a halt it did not place.**
    `begin_pending_on` leaves a foreign halt alone and `abort_pending_on` lifts
    only its own; the re-stamp was the third of the three and was the one that
    did not. `IS DISTINCT FROM 'lightning'` rewrote **any** other reason into
    one of ours, and Phase 10's revert - which matches on the reason - would then
    have lifted a halt somebody else placed.
12. **The hand-boundary query carried none of the table filters the rest of the
    file carries.** An abandoned `ended_at IS NULL` row on a closed or
    soft-deleted board blocked the conversion for six hours, and nothing could
    ever end that hand - the exact wedge the six-hour window was chosen to
    prevent, arriving by a different door.
13. **A same-request-id retry that raced itself was told `wrong_state`.** Under
    READ COMMITTED the second caller's pre-lock snapshot misses the row the first
    is about to commit; it then blocks on the lock, wakes, finds `pending_on` and
    answered `wrong_state` - in precisely the case the unique
    `conversion_request_id` exists to make idempotent. A worker told
    `wrong_state` retries; a worker told `already_known` stops. The row is
    re-read after the lock is held now.
14. **The pool `INSERT`'s session tie-break was `ORDER BY (s.cluster_id = g.id)
DESC`.** A bare `<boolean> DESC` implies **NULLS FIRST** and
    `cash_player_session.cluster_id` is nullable, so the key put exactly the
    session it exists to deprioritise at the top, and a player with both an open
    cluster-scoped and an open table-scoped session got the wrong parent on their
    pool session.
15. **The orphan check was per SEAT, not per PLAYER.** A player seated on two
    member boards whose only open session was scoped to one of them was counted
    an orphan against the other seat, and the whole Cluster's conversion was
    refused - while the `INSERT` immediately below would have found that same
    player's session.
16. **`fn_cash_cluster_population` contradicted its own headline number.** It
    carried the same uncoalesced predicate in five places while delegating
    `live_eligible` to the reader that had just been repaired, and reported
    `live_eligible: 24` beside `seated_eligible: 18` on one board. Two readers of
    one population that disagree is the defect `20260921064717` was restructured
    to make impossible, and this was the last place they still did.

The checksums are `set_config(..., true)` and not three temp tables, because a
`CREATE TEMP TABLE` is still DDL, it still fires this database's break-window
event trigger, and an assertion mechanism that can refuse the migration it is
asserting about is worse than no assertion.

**The harness is owned by a separate branch and was not run from here**, so no
pass count or mutation count is claimed for it in this entry.

## The capability gate: nothing converts itself, deliberately

**The three new functions are called by nothing.** That is not an oversight and it
is not a stub. A Cluster converted to `LIGHTNING` before the Phase 6 matcher
exists would strand every one of its eligible players in a pool with **no one to
deal them a hand** - seated at a table that has stopped dealing, in a Cluster
that believes it is a pool. The trigger that calls these belongs with the
matcher, and ships with it.

Two independent gates hold until then, and the post-apply read-back asserts them
independently because the whole safety argument for shipping a conversion before
its matcher rests on both:

- `lightning_enabled` is false on all 166 Clusters;
- no function in the catalogue calls
  `fn_cash_cluster_begin_pending_on` or `fn_cash_cluster_commit_lightning`.

There is no trigger and no cron entry. The harness proves the conversion works
by calling the functions directly, which is how a transition is tested before
the thing that fires it exists.

## The freeze is honoured on the way in and not on the way out

`fn_cash_cluster_begin_pending_on` and `fn_cash_cluster_commit_lightning` refuse
during the maintenance break. A conversion moves no chips, but it stops every
table in a Cluster from dealing, which is emphatically an engine-affecting act,
and `theFreezeIsTotal.law.test.ts` exists so the engine is doing exactly one
thing at a time.

`fn_cash_cluster_abort_pending_on` is **deliberately not gated**. A Cluster stuck
in `PENDING_ON` with every table halted is exactly the state an operator needs to
be able to leave during an incident, and the break is when incidents are handled.
The asymmetry is the same one the verdict already carries: entering Lightning is
gated, leaving it never is. Both halves are pinned in the test and in the
migration's own read-back, because gating all three looks tidier and would make a
half-converted Cluster unrecoverable for the length of the window.

Idempotency is also asked **before** the freeze and before the lock: a worker
retrying a request that already succeeded must be told so even during a break,
and answering `platform_frozen` to a retry makes it keep retrying for the length
of the window, which is the opposite of what the freeze is for.

## What this does not do

It converts nothing. No Cluster changes mode, no epoch moves, no table is
halted, no pool session is created and no chip moves - measured at the top of
the same transaction and compared at the end, rather than assumed. All 166
Clusters are still `must_move` and still `lightning_enabled = false` after it
applies.

All three **new** functions are `SECURITY DEFINER` with `SET search_path TO
'public', 'pg_temp'`, revoked from `PUBLIC`, `anon` and `authenticated`, and
granted to `service_role` only. `cash_cluster_conversion` has RLS enabled and the
same grants. `fn_cash_cluster_live_eligible` stays `SECURITY INVOKER`, `LANGUAGE
sql`, `STABLE` - it counts and writes nothing, and the lobby reaches it through
`fn_cash_game_lobby`, which is a definer and embeds it - and the test asserts it
is **not** promoted, because a blanket rule over every function in the file would
be demanding a privilege escalation on a read-only counter.

## Qualification

`tests/lightning-phase-5-conversion.test.ts` is 46 static and structural
assertions over the migration, in the house style of its Phase 4 sibling: the
transaction shape, one `ADD COLUMN` per `ALTER TABLE`, every `ADD CONSTRAINT`
matched to an existence check **on its own conname**, the `REVOKE`/`GRANT` pair
for every function the file writes - driven off a regex over the file, so a
fifth function added later cannot slip past ungranted - the absence of any write
to `table_seats` in all three writers, both halves of the freeze asymmetry,
the re-ask at the boundary, the epoch bump read out of the text as _exactly one_,
the two orderings above asserted by character index, the `IS NOT NULL` asserted
to come **before** its `IN`, `p.prokind = 'f'` required on every catalogue scan
not restricted to a named allowlist, all three asserted substitutions checked for a
catalogue read-back after the `EXECUTE` and never against the variable, and all
30 `@live-proof` lines parsed for balance as a floor rather than an equality.

Five of those assertions are new law rather than new coverage, and each is driven
off a regex over the file rather than off a list somebody has to remember to
extend:

- **every** mention of `is_deleted` or `lifecycle` in this file's own queries must
  **be** the one membership predicate, in one of exactly two spellings - qualified
  where a join names the table `tb`, bare inside `UPDATE public.tables` where
  there is no alias - and the statement it sits in must not mention `status` at
  all. Seven sites; a third spelling, a half-stated predicate or a reintroduced
  status filter each turn the suite red;
- `tb.status` appears nowhere in code, asserted over the literal-blanked view,
  with the non-vacuity that section 5c **does** quote the old form as a string;
- **every** cast of a `v_state` jsonb lookup sits inside a `coalesce`, checked by
  reading the nine of them out of the text and asserting the nine characters in
  front of each - a missing or JSON-null key casts to SQL NULL, `IF NOT NULL` is
  NULL, and plpgsql takes that as false, so the bare form would have read an
  unparseable verdict as _convert_;
- the orphan check's session lookup and the `INSERT`'s are compared
  character-for-character rather than described;
- `fn_cash_cluster_live_eligible` is asserted **not** to be `SECURITY DEFINER` and
  **not** to be re-commented, because `CREATE OR REPLACE` keeps its OID: a blanket
  rule over every function in the file would demand a privilege escalation on a
  read-only counter and a second copy of a COMMENT that can then drift from the
  first.

It **does not** use the sibling's one-line comment strip. This migration's string
literals contain comment markers - sections 6 and 7 build replacement SQL out of
quoted lines beginning `--`, and the read-back hands a comment pattern to
`regexp_replace` as a literal - so a regex strip corrupts both. The scan here is
literal-aware, and it is asserted to be doing work **in both directions** rather
than assumed to be, in four places where the migration's own prose is what makes
the rule expressible:

| the rule                                       | false without the strip, because                                     |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| no conversion function names `table_seats`     | `begin_pending_on`'s comment explains why a seat move is cancelled   |
| the abort is not gated on `fn_platform_frozen` | the abort's comment says, in those words, that it is not             |
| no conversion function mentions `is_horse`     | the commit's comment says "NO `is_horse` ANYWHERE" and cites the law |
| nothing in the file writes a seat              | the read-back quotes `UPDATE table_seats` as a regex, in quotes      |
| no query decides membership by `tb.status`     | section 5c must quote the old predicate in order to substitute it    |

That last class is not hypothetical. Three `@live-proof` lines in this project
have already gone false purely because a comment quoted the string the proof
forbade, and a fourth went false because a `COMMENT ON FUNCTION` body containing
the words "granted to authenticated" made a grant-safety regex fire on correct
code.

**Mutation tested, twenty-four for twenty-four** - ten in the first cut and
fourteen more against the assertions added for the defects above. Each mutation
was made on a
scratch copy of the migration and the suite pointed at it with
`LIGHTNING_P5_MIGRATION`, so the migration in the repository was never touched.
The first ten: orphan check moved after the epoch bump; `AND
dealing_halted_reason IS NOT NULL` removed; `p.prokind = 'f'` removed; `is_horse`
added to the tick substitution; one `GRANT EXECUTE` removed; the epoch bumped at
`PENDING_ON`; the substitution read back from `v_new` instead of the catalogue;
one `ADD CONSTRAINT` unguarded; the abort gated on the freeze; an `UPDATE
public.table_seats` added to the commit.

Fourteen more were run against the assertions added for the defects above:

| mutation                                                         | caught by                                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| pool `INSERT`'s `lifecycle` test uncoalesced                     | the one-predicate site count                                |
| `tb.status IN (...)` put back into `live_eligible`               | the status rule, the site count, and the authorising number |
| tie-break returned to a bare `<boolean> DESC`                    | the session-lookup test                                     |
| orphan check returned to per-seat                                | the per-player test                                         |
| `v_stranded` counted without `DISTINCT`                          | the stranding test                                          |
| `s.cluster_epoch = v_epoch` dropped from the stranding sub-query | the stranding test                                          |
| commit's `would_turn_on` uncoalesced                             | the re-ask test **and** the jsonb rule                      |
| `fn_cash_cluster_live_eligible` no longer re-cut at all          | the suite refuses to load                                   |
| population's anchor count relaxed from five to one               | the breakdown-substitution test                             |
| one `@live-proof` line deleted                                   | the proof floor                                             |
| `'thresholds' ->> 'on'` read without `coalesce`                  | the jsonb rule                                              |
| the counter promoted to `SECURITY DEFINER`                       | the reader test                                             |
| `begin_pending_on`'s halt filter uncoalesced                     | the halt test **and** the site count                        |
| the population substitution reading back `v_new`                 | the breakdown-substitution test                             |

A control mutation - rewording one comment and nothing else - left the suite
green, so the twenty-four are catching what they name rather than the suite
failing on anything at all.

`scripts/ci/schema-manifest.d/lightning-phase5-conversion.json` declares the new
table, its fourteen columns, the two new `tables` columns and all **five**
functions this migration re-cuts - the three it creates, plus
`fn_cash_cluster_live_eligible` and `fn_cash_cluster_population`, which it did
not create and does change. The test reads the fifth name out of the substitution
block rather than off a list, because that function never appears as a `CREATE`
in this file at all, so the CI gates see them without any branch having to append to a
shared sorted array. The test drives the column list off the `CREATE TABLE`
rather than off a list, so a fifteenth column added later cannot go undeclared.

`scripts/dev/test-lightning-phase5-conversion.sh` is wired into the
`accounting_postgres` job immediately after `test-lightning-phase4-remediation.sh`,
with the same `PG_BIN` its neighbours use. The test asserts the ordering, the
exact step text, and that the path it names is really in the tree - a wired step
that points at nothing is a red CI run and nothing else. Seven Lightning
harnesses now gate merge through the `server` job, which is a required check and
`needs: accounting_postgres`. `scripts/qualification/cash-native-hosted.manifest.json`
was re-pinned for the new `ci.yml`: **one pin moved**, the top-level
`files[".github/workflows/ci.yml"]` entry, from 153,498 to 153,727 bytes. The
five deeper `previousPins` occurrences are historical records of earlier
workflow states and were left exactly as they were.

## Still open, and it is about the test pattern rather than the migration

Everything the previous cut of this entry listed under _found in review, not
repaired here_ - the uncoalesced `lifecycle` in the three player-set queries, the
halt re-stamp overwriting a foreign halt, the hand-boundary query carrying none of
the table filters, and the same-request-id retry answered `wrong_state` - **is
repaired in the migration as it now stands**, and each is written up as defects 9,
11, 12 and 13 above. One item from that list survives, and it was never a defect
in the migration:

**A note for the next Lightning suite.** `tests/lightning-phase-4-remediation.test.ts` builds its
comment-stripped view with one regex replace of everything from a double dash to
end of line. Copied verbatim onto this migration it silently corrupts sections 6
and 7 and the post-apply read-back, because those carry comment markers inside
string literals. A test that reads a corrupted body still passes; it just stops
meaning anything. The scan in `tests/lightning-phase-5-conversion.test.ts` is
literal-aware and asserts both facts about itself.

Nothing else is known to be open. The three claims this entry cannot make for
itself are unchanged: the harness is owned by a separate branch and was not run
from here, so no pass count is claimed for it; nothing calls these functions, so
no conversion has been driven end to end on a live Cluster; and Phase 10's revert
does not exist yet, so the halt vocabulary's forward compatibility is argued
rather than exercised.

## Rollback

Two nullable columns, one constraint, one table, three indexes, three new
functions, two existing readers re-cut in place, and two function bodies
substituted.

Clearing `tables.dealing_halted_at` and `dealing_halted_reason` restores dealing
on every table, immediately, without touching a seat or a stack - which is the
same two-column clear the abort path performs. `DROP` the three new functions and
`cash_cluster_conversion` and nothing else refers to them, because nothing calls
them. `fn_cash_cluster_live_eligible` and `fn_cash_cluster_population` must be
`CREATE OR REPLACE`d back rather than dropped - dropping either would take its
grants and its COMMENT with it, and `fn_cash_game_lobby` reaches the first of them
on every open. All three substituted bodies are restored from the
`pg_get_functiondef` output taken before the apply; every substitution is
idempotent on re-apply and stands off with a `NOTICE` if its marker is already
present.

No money moved. No seat was written. No Cluster converted.
