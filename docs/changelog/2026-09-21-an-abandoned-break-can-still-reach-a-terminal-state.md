# An abandoned table break can still reach a terminal state

2026-09-21. 161 `smarter_private.f06_operations` had been non-terminal since
2026-09-18 - 153 `park_requested`, 8 `begun` - across 81 RUNNING events. This is
what they were, why nothing could finish them, and why the restart everybody was
waiting for was never going to.

## What was actually true

Measured against production, not assumed:

| fact                                                       | value                                 |
| ---------------------------------------------------------- | ------------------------------------- |
| operations non-terminal                                    | 161 (153 `park_requested`, 8 `begun`) |
| events affected                                            | 81 RUNNING, prize pools 11,330.00     |
| created                                                    | 2026-09-18 02:09 - 2026-09-19 14:04   |
| hands in the air on any of the 161 tables                  | **0**                                 |
| source tables adoptable (`running`/`waiting`, not deleted) | **161 of 161**                        |
| `tables.f06_lifecycle` = `f06_operations.lifecycle`        | **161 of 161**                        |
| `terminal_handoff_required`                                | **false on all 161**                  |
| `origin_generation` still the live lease generation        | **0 of 161**                          |
| chip conservation on the affected events                   | exact                                 |

Four comfortable explanations were all false. The tables had not been closed or
deleted, the lifecycle had not moved, the SQL side had not marked any of them as
needing a terminal handoff, and no hand was stuck mid-deal.

**The restart theory was false too, and this is the part worth keeping.** Every
one of the 153 parks was created on 2026-09-18 between 02:09 and 22:10. The
leases those events run under today were acquired at **23:12-23:14 on
2026-09-18** - after the last of them. Those managers have heartbeated
continuously for three days, and they have driven 422 other operations to
`acknowledged`, the most recent at 14:52 on the day this was written. So a
restart had already happened on top of these operations, the protocol was
demonstrably healthy on the same build, and the 161 still did not move. Waiting
for the next deploy would have bought another three days of the same.

## Why nothing could finish them

A park on the last open table of an event has exactly one terminal exit: the
no-start continuation, `fn_f06_continue_no_start_last_table`, which writes
`withdrawn_before_manifest`. There is nowhere to move the players to, so there
is no manifest to write and no ordinary retirement to reach.

That exit had exactly one caller: **table engine admission**
(`TournamentManagerBase.ts`, the `blocked_reason === 'source_excluded'` branch).
It runs when a manager brings an engine up for a table. It does not run again.

The repeating path - discovery, `recoverTournamentBreak` - can only reach the
continuation through `bindStoppedOriginalBreak`, and that requires an in-memory
hand permit whose binding carries the **current** lease generation:

```ts
b.lease_generation !== this.getTournamentLeaseGeneration() ||
```

A table parked by a generation that has since died, and not dealt since, can
never present such a permit. So `bindStoppedOriginalBreak` returns false,
`prepareParkedTournamentBreak` finds no destination on a last table and returns
`null`, and `recoverTournamentBreak` returns. Every pass. For ever.

The operation was discovered hundreds of times - the discovery cursors show
revisions in the hundreds - and could be acted on never. Nothing logged,
because `return null` is not a throw.

**The protocol had no way to represent a break abandoned by a retired
generation.** That is the defect. It is not a capacity problem and not a
scheduling problem, and no sweep would have been the right answer to it.

## The classes

| class                            | n   | shape                                                                          | honest terminal state                                                              |
| -------------------------------- | --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1. last-table park, custody held | 54  | the source is the only open table of the event; `custody_id` set; no members   | `withdrawn_before_manifest`, via the no-start continuation - now reachable         |
| 2. multi-table park, no custody  | 99  | 2-38 open tables, most of them stuck sources, so the balancer can place nobody | `begun` -> `close_confirmed` -> `acknowledged` once class 1 frees the destinations |
| 3. `begun`                       | 8   | 6 with a clean roster, 2 on an empty source                                    | ordinary retirement, same unblocking                                               |

Class 2 is self-reinforcing: `eligibleBreakDestinations` excludes every table
that is the source of a remembered break, so each stuck park removes a
destination for the others. 15 events had half or more of their live tables
stuck as sources. Clearing class 1 returns those tables to the destination pool,
which is why one fix addresses all three.

## The fix

`recoverTournamentBreak` now offers the **same audited continuation** to the
operation discovery already holds, when no destination could be proven:

```ts
const begun = await this.prepareParkedTournamentBreak(current);
if (!begun) {
  await this.continueAbandonedNoStartPark(current);
  return;
}
```

`continueAbandonedNoStartPark` consults no permit and no per-process registry.
It reads the operation, requires an owned engine, and delegates to
`continueExcludedNoStartTable`, which re-proves the entire scope itself - that
this is the only open table, that the table is excluded, that the operation is
`park_requested` with no members, that the lifecycle matches, that custody is
held - drains the engine, and calls the RPC.

What this deliberately does **not** do:

- it does not weaken `bindStoppedOriginalBreak`. Relaxing that generation check
  was the tempting one-line fix and it would have let a stale permit drive a
  terminal transition. It is unchanged, and the law test pins it;
- it does not write a state column by hand. Every transition still goes through
  the protocol's own RPC under `f06_authority`, which still demands a live lease
  heartbeating at the caller's own generation;
- it is not a sweep, a cron, a healer, a backfill or a repair job. It is the
  live path learning to finish work it had already found.

## The money

The 161 blocked 81 events holding 11,330.00 in prize pools. Almost none of that
was owed to anybody: **80 of the 81 events are genuinely multiway**, with two or
more players still holding chips and conservation exact. An unfinished event is
frozen, not unpaid, and paying one would mean inventing finishing positions for
live stacks.

Exactly one event is decided: `bfcfaf17` (DSS Thursday $5.50 NLH Turbo),
63.00, where one player holds all 168,000 chips and the other left with zero.
It is not settled here, and the reason is recorded in the task report rather
than acted on: the winner is still seated at the F06-bound table, so ending the
event writes `table_seats` on a table `f06_source_guard` protects - and
defeating that guard to collect 63.00 risks a 168,000-chip double move. The
correct order is this fix, then the engine finishes the break, then the event
settles itself through its own path. Both claimants are horses, which under
CLAUDE.md 10.5 changes nothing about what they are owed or when.

The 100.00 previously reported as frozen alongside it (`5a387a75`) is **not
owed**: that event still has 13 players holding 1,755,000 chips between them.

## Also found, not fixed here

`smarter_private.f06_lease_has_pending_custody` tests `state <> 'acknowledged'`,
while `fn_f06_discover_breaks` treats both `acknowledged` **and**
`withdrawn_before_manifest` as terminal. The two disagree about what finished
means. Today that makes the custody test report 111 events as holding pending
custody where discovery's own definition gives 81 - and **30 of those 111 are
pending for no reason other than a `withdrawn_before_manifest` row**, a state
this very fix produces more of. Anything gating a release on that function will
not go quiet by waiting. Reported to the release-preflight work rather than
changed here, because the custody test is that task's surface.
