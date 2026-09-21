# A preparation that can never resolve is not a hand in the air

**2026-09-21.** The engine had been frozen on `8825af51` for 57 hours. This is
what held it, why every layer agreed to hold it, and the three changes that
end it.

## What was actually frozen

Read from production at 07:30 UTC, before any change:

|                                          |                                                  |
| ---------------------------------------- | ------------------------------------------------ |
| engine `/health` version                 | `8825af51`, uptime 207,077s (57.5h)              |
| breaks under that engine                 | **71**                                           |
| breaks that certified a restart          | **1**                                            |
| `unparked_at_countdown`, every countdown | **1**                                            |
| `thaw_ok` / `tables_resumed`             | true / ~158 every break                          |
| RUNNING tournaments with no engine lease | **6**                                            |
| seats / chips frozen behind them         | **49** / **4,908,000**                           |
| oldest frozen event                      | `$100 Freeroll - 12:00 PM`, since **2026-09-14** |

The felt was healthy the whole time. `/health` said `ok`, 158 tables resumed
after every break, and the thaw worked. What was dead was the DEPLOY ROUTE,
which is why nothing looked wrong and nothing paged.

## The deadlock

One tournament hand permit could never resolve inside that process, and every
layer above it read "unresolved" as "a hand may be in flight":

1. `MaintenanceBreak.unparkedTables()` counted the table as unparked;
2. so `readyForRestart()` stayed false;
3. so `engine-release-transaction.sh`, which requires
   `readyForRestart is True and unparkedTables == 0`, refused the cutover;
4. and the cutover is the only thing that can replace the process holding the
   permit.

Step 4 closes the loop. The build that fixes the permit was on the far side of
the gate the permit was holding shut.

**And there was nothing to protect.** The blocking permit, read from the
database:

```
permit 14cddb92  table 9f30d335  hand 12943630  state aborted_unsettled
dispatch rows 0   hand snapshots 0   atomic commits 0   hole cards 0
```

Every other permit on that table is `accepted` with its commit. That one was
prepared, never started, and is terminal. Fifty-seven hours of frozen
tournaments to protect a hand that was never dealt.

## The three changes

### 1. The engine already told the truth; now it is pinned

`parkForTournamentMove` answers truthfully for a stopped generation - a
stopped, terminal engine that has released process ownership is _more_ parked
than a running one. That landed in #3716 and is **not changed here**. What was
missing is a law preventing it regressing to a blanket `if (!this.running)
return false`, which is what makes a manager's pending seat-move set
unresolvable for ever.

What makes it safe, and what the law now pins conjunct by conjunct: the answer
is a six-way AND - the owner is claimed, the engine is terminal, process
ownership is released, no move operation is in flight, no settlement is in
flight, and no post-hand tasks remain. And the quarantine **replays** the
pending move through `requestTournamentSeatMoveAtBoundary` to a receipt; the
UUID is forgotten only after that returns. A failed replay refuses. No move is
discarded on any path.

### 2. Both blocker classes now share one bound

`MaintenanceBreak` has two preparation-blocker classes. The per-engine one was
bounded in #4909 for exactly the reason written above it - _"a fail-closed gate
with no bound, on a resource the whole platform shares"_ trades "breaks get
dismantled" for "a stuck table never recovers", and the second is the worse
bug.

The **manager-retained** class, `retainedPreparationBlockers()`, was left
unbounded by that change, and it is the one that held the platform. It pushed
and counted with no clock at all.

Both now call one `f06PreparationHoldsGate(tableId)`. Past the bound a table is
still named, still counted, still on `/health` and still alertable - it simply
stops deciding whether every other table may be restarted. Identification never
stops; only the veto does.

### 3. The release gate asks the database whether a hand is in the AIR

This is the change that unblocks production **without** a restart, because
`engine-release-transaction.sh` is checked out fresh by the workflow on every
run - it is not part of the running engine.

The gate used to ask process memory one question. When it would now refuse
_solely_ because of an unresolved preparation, three things must all agree:

1. the countdown window is real, durable, and has the full budget left
   (**unchanged** - phase, `durableConfirmed` and `MIN_BREAK_MS` are still
   hard requirements);
2. the engine's own `handsInFlightTotal` is **present and zero**;
3. `engine-release-inflight-hands.py` finds no incomplete hand snapshot
   written recently.

That is **strictly stronger** than the old line for a real in-flight hand - it
adds two independent witnesses - and weaker only for a preparation that is
provably not a hand.

**The reasons are an allow-list, never a deny-list.** Only
`f06_preparation_unresolved` and `f06_preparation_stuck` may be passed over.
`cards_in_air`, the bank-durability classes, and any string a future engine
invents all keep the gate shut.

**Freshness is the whole design of the database check.** Production held
**2,553** incomplete `hand_state_snapshots` rows, the oldest last touched on
**2026-08-22**. Gating on "an incomplete snapshot exists" would have refused
every cutover for ever - the same forever-block, one level up. A hand is in
flight when its row is still moving. Ages of every incomplete snapshot on a
non-closed table, against `handsInFlightTotal = 40`:

```
<=30s  28      <=300s  36
<=60s  36      <=600s  36
<=120s 36       >600s 539
```

The band between 60s and 600s is **empty**. Any threshold in it classifies
identically. 120s is used: twice the observed live ceiling, a fifth of the
corpse floor, and deliberately not the 60s ceiling just measured.

**Three outcomes, never two.** `0` quiet, `1` hand in the air, `3` could not
tell. UNKNOWN refuses and is never folded into quiet: a non-200 is checked
before the body is parsed, a filled page is "not complete" rather than "all of
them", a wrong project host is unreadable rather than empty. There is no flag,
environment variable or argument that turns a refusal into permission.

Verified before shipping - every one of these returns UNKNOWN(3), never
QUIET(0): missing env file, env file with no identity, a non-pinned host, an
out-of-band freshness window, and a rejected key (HTTP 401).

## The detector this never had

`poker_maintenance_breaks_since_restart_certified` has been published since
#4909 and **nothing read it**. Seventy consecutive failures paged nobody
(CLAUDE.md 10.83).

`EngineCannotBeReplaced` now reads it, with the CLAUDE.md 13 rule 6 break
guard. Threshold derived from the live series - every run of consecutive
uncertified breaks in the 30 days to 2026-09-21:

```
1 break  20 times     4 breaks  2 times
2 breaks  2 times     8 breaks  1 time   <- real outage
3 breaks  1 time     70 breaks  1 time   <- this outage
```

A single uncertified break is ordinary - twenty in a month, a long hand
outlasting its window, retried an hour later. `>= 6` fires on both real events
and on **none** of the 25 benign runs. Not 2 (the data says that is too
eager), not 8 (the observed ceiling leaves no headroom). Six breaks is about
six hours of undeployable production, against the 57 hours this took.

It is a net, which 10.12 permits. No cron, sweep, repair or back-fill job was
added, and none may be: the causes are fixed above.

## Not done here, deliberately

The frozen tournaments are not settled by this change. They are frozen because
the engine cannot restart; the restart is what re-adopts their leases and
resumes them. This removes the thing preventing the restart. If any event still
holds stranded money after the engine is replaced, that is a 10.9 settlement on
its own evidence, not something to guess at now.

No migration. No schema change. Nothing was written to production by this work.
