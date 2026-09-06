# 2026-09-06 - The launcher, second pass: the eight things the first pass only recorded

CLAUDE.md 10.11 landed the same day as the first pass, and it is about exactly
what that pass did:

> "I WANT HARD CODED FIXES FOR THINGS THAT BREAK ... I DON'T JUST WANT IT
> 'FLAGGED' AND 'RECONCILED'. I WANT THEM FIXED AT THE ROOT CAUSE AND STOPPED
> FROM HAPPENING AGAIN."

The first pass fixed nine defects and left eight under "recorded, not changed
here". A detector is not a fix, and neither is a paragraph. This is the rest.

Two of them turned out to be worse than the audit had read them.

## The two that were worse than recorded

### 1. An audit trigger could refuse every table write on the platform

`trg_tables_capture_management_contract` is `AFTER INSERT OR UPDATE ON
public.tables FOR EACH ROW`, with no column list and **no exception handler**.
On 2026-09-06 between 11:38:37 and 12:43:16 UTC it raised on every row it
touched - one wrong constraint name inside an audit INSERT - and took the
caller's statement with it. The caller that matters is
`fn_cash_cluster_open_table`: **683 `controller_tick_error` rows, and no feeder
could open anywhere on the platform for 65 minutes.**

The constraint name was corrected upstream. That is not the fix. Migration
`20260906160042`:

- the capture body cannot raise. Any failure files a `ca_drift_incidents` row
  and returns NEW, because an audit record must not be able to refuse the game
  write it describes - the doctrine CLAUDE.md 11.5 already states for the
  seat-exit trigger ("the trigger never blocks"), made LOUD rather than
  impossible. The handler's own insert is wrapped too: a detector that raises
  is the defect it was written to catch, one level up.
- **the reader is named** (10.86 rule 3). `managed_game_contract_capture` is
  registered in `ca_detector_registry` with an owner and a 4-hour SLA, so it
  appears on `v_ca_alert_board` beside every other detector. Deduped by
  `(game_kind, sqlstate)`, so 683 failures are one row with `occurrences = 683`.
- a write that changes nothing in the contract now exits **before** the advisory
  lock. The contract document is the row minus a denylist that already contains
  `current_players`, `status`, `lifecycle`, `last_activity_at` and the lease
  columns - i.e. everything the engine writes all day. `pg_stat_user_tables`
  reports **3,377,815 updates** on `public.tables`, and every one was building a
  document, hashing it, taking `pg_advisory_xact_lock` and running an indexed
  SELECT to discover the hash had not moved. Comparing the documents is exactly
  equivalent and derived from the document, so it cannot drift from the denylist
  the way a hand-written column list would.

Rolled-back probe first: the churn columns produce an identical document, a real
change still produces a different one, and the handler's insert passes every
CHECK constraint. That last assertion caught `classification =
'contract_capture_failed'` and `layer = 'schema'` - **neither is in its enum**,
so the handler would have raised. The exact defect it was written to survive.

Verified live after apply: handler present, detector registered, zero incidents,
73 real captures in the following 5 minutes, zero tick errors.

### 2. `fn_clone_table_row` has never worked, and could mint a second Main 1

Two defects in one function, the second found by the probe for the first.

**It carried the table's place in its game over.** `cluster_id`, `role`,
`main_index` and `lifecycle` were all copied, so a clone of Main 1 was a second
Main 1 of the same game - the shape that
`docs/HANDOFF-TABLE-STAKES-CURRENT-STATE.md` section 6 records as "opened 3,000
tables on one game before it was caught". The 2026-09-05 repair taught the tick
to look Main 1 up on the live board; nothing stopped a duplicate being _made_.

**And it could not insert at all.** `INSERT INTO public.tables SELECT * FROM
jsonb_populate_record(...)` names all columns, and `public.tables` has **four
generated columns** (`min_buyin`, `max_buyin`, `min_buy_in_bb`, `max_buy_in_bb`).
Postgres refuses a non-DEFAULT value for a generated column:

    428C9 cannot insert a non-DEFAULT value into column "min_buy_in_bb"

So every call has raised since those columns were added, breaking both callers -
`fn_launch_table_from_template` (a live operator feature) and the lifecycle
pass's AUTO CREATE arm, whose only handler is `EXCEPTION WHEN unique_violation`
and does not catch 428C9. The clone path has no test and no caller that reports,
so nothing said so.

Migration `20260906160550`: a clustered clone joins as a `feeder` in `opening`
with no `main_index` - the shape the OPEN rule creates and the controller already
knows how to promote, break or abandon - and the insert uses a column list read
from the catalogue, so a fifth generated column cannot break it again. Probed
rolled back against a real Main 1: `role=feeder`, `main_index=NULL`, cluster
kept, and the generated columns computed correctly (40/200 from 10.00 at 0.25bb).

**A unique index was considered and rejected**, and the reason is written into
the migration so nobody adds it later thinking it was missed: production is
clean enough to build one today, but the controller renumbers mains in separate
UPDATE statements, and a unique index would abort the tick on the first of them.

## The rest, fixed

3. **`runTableLifecyclePass` is deleted** (OPORD 1.4 s18.2 lists it beside
   `spawnOverflowTables` and `retireSurplusTables`; the other two went at Gate
   7). It ran every 30 seconds on zero rows - nothing on the platform carries
   `auto_restart` or `auto_create_table` - and its AUTO CREATE arm is what
   called the cloner. The fleet owns no table lifecycle at all now.

4. **The cycle stops scanning every seat for every table.** `humanShort` filtered
   all ~2,000 open seats and was called _from inside a sort comparator_ over
   ~1,100 tables: on the order of **4x10^7 row visits to decide an ORDER**, before
   a seat was filled. Plus a second full scan per table for `tableOccupiedSeats`.
   Both are now one indexing pass and O(1) lookups. This is the root of the
   19-118 second cycle, which is why the feeder abandon window had to be widened
   to six minutes, which is why an opening feeder can sit empty for eight.

5. **Three unpaged reads are paged.** `cash_seat_moves` (pending reservations),
   and both `table_waitlist` reads. The reservation one is the sharp one: a
   truncated read UNDERCOUNTS reservations, and an undercounted reservation is
   the fleet filling the very seat the controller planned a feeder player into -
   the bug that read was added to fix. The waitlist queue reached 10,004 rows on
   2026-08-31 against a silent 1,000-row cap, so `pruneHorseWaitlist` could not
   drain the queue it exists to drain, and a human past the cap was invisible to
   the release rule that is the only thing that stands a horse up.

6. **A horse can answer a seat call it was actually offered.** `pruneHorseWaitlist`
   cleared `waiting` AND `notified` horse rows, and `notified` means a seat is
   being HELD for that horse by `fn_offer_open_seat`. It ran before
   `claimOfferedSeats` in the same cycle, and that method reads `notified` and
   nothing else - so the feature Dan asked for on 2026-08-31 ("MAKE HORSES ANSWER
   A SEAT CALL... THEY SHOULD NEVER BE SKIPPED") could never find a row, and was
   dead in the direction 10.5 forbids: a human's offer stood, a horse's did not.
   Only `waiting` is pruned now, and the claim path gained the `breaking`/`closed`
   guard the seeding loop has always had - previously it had no lifecycle test at
   all, and was safe only by the accident of the prune running first.

7. **The cash-table ceiling counts cash seats.** `remainingGameCapacity` has always
   said "the tag ceiling ... is measured against cash seats" and has always
   subtracted `load.seats`, which the fleet builds from every open seat on the
   platform, tournaments included. A horse tagged `max_tables: 2` sitting at two
   tournament tables was refused every cash table by a rule documented as being
   about cash multi-tabling; **837 horses carry a tag of 2 or 3**. `cashSeats` is
   optional and falls back to `seats`, because a caller that cannot tell them
   apart should get the stricter answer.

8. **A probe is a full table.** `countOnly` is also set when the vibe target is
   met or the trickle produced zero - tables with real open seats - and each of
   those booked two horses of shared capacity to answer a question the OPEN rule
   cannot act on (it needs `v_open_unreserved = 0`), while reporting two buyers
   that keep the game "due" on every 5-second pass. The claim follows the seats
   now.

9. **A draining table is not band supply.** The band scan excluded breaking,
   closed and disabled tables but not `retire_when_empty` or the night park, so a
   band whose only tables are draining read as supplied and `projectStakeBandOnto`
   refused to step a horse down out of it. Empty on the cash floor today; it
   cannot rot now.

10. **An opening feeder is never skipped silently.** The diagnostic was created
    _after_ the surplus / breaking / disabled `continue`s, so a feeder skipped
    structurally produced no line at all - the one diagnostic these sessions rely
    on went quiet exactly in the case hardest to guess from outside. It is opened
    first and every skip names itself (`surplus_draining`, `lifecycle_breaking`,
    `game_disabled`).

11. **The controller's row map forgets.** `rowByGame` was written every pass and
    never pruned, so a game that leaves the worklist kept its `main1_table_id`
    for the life of the process and a wake would ask the fleet about a table that
    may have closed an hour ago. Pruned by AGE (20 passes, ~100s) rather than by
    absence from one pass, because a single missing pass is the transient
    `rested_games` was added to survive.

Tests: `theFeederFillsFromTheCountItOpenedOn.test.ts` grows to 22 cases; six
existing source-contract pins updated in the same commit for shapes deliberately
changed. Full server suite: **437 files, 6,276 tests, green; tsc clean.** Both
migrations probed rolled-back, applied, and verified against production.

## Still open, and honestly so

- **The occupancy target is cluster-blind.** `occupancyTargetFor` drives 75% of
  tables to FULL, and under clusters FULL plus two buyers is the OPEN signal, so
  the fleet's own vibe rule manufactures a perpetual open signal. Whether that is
  the design (grow every game to `cap_mains` on horse demand) or the fleet should
  leave one seat on the newest Main is a rule for Dan, not a fix for an agent -
  it decides how the floor looks.
- **`capacityByHorse` is recorded at first sight**, so a horse first seen at a
  late table has a capacity already net of seats this cycle gave it, and the
  allocator debits it again. The effect is a buyer count that is systematically
  low and non-deterministic in table order. Correct fix is to build the map once
  before the loop from the cycle's opening position; it touches the allocator's
  contract and wants its own pass with its own probe.
- **Ordering is `main_index`, not shortest-Main-first.** OPORD 9.4's phrase is
  about the controller's auto-seat, and the fleet's comment gives a reason for
  Main 1 first (a horse on a feeder while a main has a chair is a horse the
  controller must move). Left alone deliberately; changing it changes how the
  whole floor fills.
- **Status vocabularies still differ**: fleet `waiting|running`, door
  `waiting|running|active`, worklist lifecycle-only. No cluster table is `active`
  today, so nothing is stranded; one exported `SEATABLE_STATUSES` would end it.
