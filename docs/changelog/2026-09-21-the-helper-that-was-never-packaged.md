# The helper that was never packaged, and the gate that blamed the database

2026-09-21. The engine had been frozen on `8825af51` for 59 hours.

## What #5003 built, and why it could not run

#5003 diagnosed the freeze correctly: a tournament hand permit that could
never resolve inside that process was being read, all the way up the stack, as
"a hand may be in the air". It added `server/scripts/engine-release-inflight-
hands.py` - a careful helper that asks the DATABASE whether a hand is really in
the air, with three outcomes (QUIET / IN AIR / UNKNOWN), a threshold derived
from production and written down beside itself, and no flag that can turn a
refusal into permission.

It was never packaged.

`install-engine-supervisor.sh` materializes each immutable control generation
into `/usr/local/lib/club-arena/engine-control-generations/<sha>/` from a
hand-maintained `REQUIRED_FILES` array, and then validates that directory by
EXACT SET equality against the same array. The new helper was not added to it,
so there was no route by which the file could reach the host.

From `auto-deploy-hetzner` run 35577995941, verbatim:

```
[engine-release-transaction] restart certificate is held shut only by
  {'f06_preparation_unresolved': 1}; consulting the database for hands
  actually in the air
/usr/local/lib/club-arena/engine-control-generations/5afd94e4.../engine-release-inflight-hands.py: No such file or directory
[engine-release-transaction] the database did not prove the felt is quiet;
  the cutover stays refused
```

**The last line is false.** The database was never asked. The shell answered
127 for a missing file and the caller was `if "$INFLIGHT_HANDS" ...; then`,
which reads every non-zero status as the same thing. Five consecutive releases
(08:27, 08:23, 07:32, 06:55, 06:36) reported a database refusal that had never
happened.

That is CLAUDE.md 10.86 rules 1 and 2 - "I could not tell" folded into a
verdict, and an unreadable answer coerced into a definite one - occurring one
level BELOW the identical defect #5003 had just fixed one level above. The
helper's own three outcomes were correct and were destroyed by its caller.

## The fix

1. **`engine-release-inflight-hands.py` is in `REQUIRED_FILES`**, and in the
   installer's Python syntax-check loop, so it is packaged and validated like
   every other control script.

2. **The gate keeps three outcomes.** `case "$inflight_rc"` names 0 (QUIET,
   the only status that proceeds), 1 (a hand IS in the air), 3 (could not
   tell), 126/127 (the helper is missing or not executable - "the database was
   NEVER ASKED", explicitly not a verdict about the felt), and anything else.
   All five branches still refuse. Only the message differs, and that is the
   entire point: the operator could not previously distinguish "the felt is
   busy" from "the file is not here", and the difference cost 59 hours.

3. **A build check, derived rather than enumerated.**
   `tests/a-control-script-ships-with-its-siblings.law.test.ts` SCANS every
   `server/scripts/*.{sh,py,mjs}` for siblings invoked out of the generation
   (`$CONTROL_DIR/...`, `$GENERATION_DIR/...`, `$SOURCE_DIR/...`,
   `$GENERATION_STAGE/...`) and requires each one to be in `REQUIRED_FILES`.
   It deliberately does not keep a second list: an enumeration is exactly what
   failed here, so adding another to maintain would re-create the defect. It
   also pins the installer's two per-language syntax-check loops to the same
   manifest - the same drift, one line down - and pins the gate's three
   outcomes. Verified to fail on the pre-fix tree.

An entry-time assertion that every sibling exists was drafted and dropped: it
shifted an index anchor in `a-degraded-engine-can-still-be-replaced.law.test.ts`
and broke `engine-release-seal.law.test.ts`, which executes the real
transaction against a synthetic control directory. The build check prevents the
fault from shipping and the 126/127 branch names it at the point of use, so the
third copy bought nothing and cost two other people's pins.

## The second blocker, which this does NOT fix

The same runs then died at a different gate, and it is still shut:

```
{"ok":false,"reason":"mixed_original_work_not_drained","failedCheck":"engineCollection.size",
 "failedTable":"2c621856-e728-4e8b-bf08-4c56746a8649",
 "failedField":"terminalBoundaryPendingGenerations","observed":"1","expected":"0"}
```

### What the field is, read from the source

`terminalBoundaryPendingGenerations` is an in-memory `Set<number>` on
`ServerTableEngineBase`. A generation is added by
`beginTerminalBoundaryPersistence()` (`ServerTableEngineDealing.ts:3196`)
immediately before `controllerForHand.start()`, and removed at exactly three
places:

| where                                 | meaning                                                          |
| ------------------------------------- | ---------------------------------------------------------------- |
| `ServerTableEngineDealing.ts:3214`    | the synchronous catch around hand start - the hand never started |
| `ServerTableEngineSettlement.ts:1449` | `postHandTasks` rejected - the settlement failed                 |
| `ServerTableEngineSettlement.ts:2468` | the authoritative commit succeeded                               |

All three sit downstream of the `HAND_COMPLETE` event or of the start-throw
catch. `fenceTerminalEngine()` - the body of `killForRestart()` - sets
`handController = null`, `running = false` and `terminal = true`
**synchronously, and does not touch the pending set**. After that fence no
`HAND_COMPLETE` can ever be dispatched, so none of the three resolvers can ever
run: the generation is unreachable, and the number can never be decremented by
anything in the process.

The checkpoint guard reaches that field only after proving, on the same engine,
`running === false`, `terminal === true`, `terminalTeardownComplete === true`,
`hasReleasedProcessOwnership() === true`, `!liveEngines.has(tableId)`,
`dealingLoopPromise === null`, `postHandTasksPromise === null`,
`snapshotFlushPromise === null`, `handController === null`, `actionLock ===
false`, `f06HandPreparation === null`, `f06RecoveryInFlight === false`,
`terminalBoundaryPersistenceFailed === false`, every serial queue identical to
capture, and `settlementInFlight.size === 0` (index 0 of the same loop, so it
is proven before index 3 is read). There is provably no writer left.

### Is it real work? Read from rows, 2026-09-21

Table `2c621856` belongs to `5a387a75` ("$100 Freeroll - 12:00 PM"), untouched
since 2026-09-18 22:10.

- `hand_state_snapshots` for that table: **zero rows, ever.** By the predicate
  #5003 derived and shipped - a hand is in the air when an incomplete snapshot
  has been written to within 120s - there is no hand in the air and never was.
- Its three `f06_hand_permits`:

  | hand     | state               | dispatches | committed in `hand_history` |
  | -------- | ------------------- | ---------- | --------------------------- |
  | 12942021 | `aborted_unsettled` | 0          | 0                           |
  | 12941732 | `accepted`          | 0          | 1                           |
  | 12859817 | `accepted`          | 0          | 1                           |

  Two hands settled durably; one provably never started - the same shape as
  the 14cddb92 permit #5003 was written about.

All six derelict tournaments (`5a387a75`, `615783bf`, `99271c16`, `45126295`,
`7c6277e7`, `bfcfaf17`) were checked: **zero moving snapshots across all of
them.** Not one hand is in the air anywhere behind this gate.

So the condition is stale bookkeeping for a generation that can never resolve,
not unfinished work - the 10.86 failure again, in a third place.

### Why it is not fixed here

The honest fix has two halves and neither is safe alone:

- **In the engine**, `fenceTerminalEngine()` must stop leaving an unresolvable
  generation in a set whose only meaning is "a writer may still be running".
  But it must not resolve it as `finish(gen, false)` either: that sets
  `terminalBoundaryPersistenceFailed`, which the guard checks one step
  EARLIER, so the deadlock would simply move up a line - and it would assert
  "this did not succeed", which is a fact not in evidence (10.86 rule 2). The
  correct shape is a third, named outcome: ABANDONED - no writer remains, the
  outcome is unknown to this process, and it must be resolved from the
  database.
- **In the guard**, that abandoned state has to be answered from rows, exactly
  as #5003 answered the layer above. `legacy-engine-checkpoint-guard.mjs`
  already holds `modules.client.supabase.rpc`, but `physical()` is
  synchronous, so this means deferring those tables out of the sync sweep and
  proving them before `sealAndRetireOriginals`.

Shipping only the engine half would make a fenced engine PASS the drain check
while nothing had read a single row about its last hand - satisfying a check
by asserting what has not been read, which is the one thing this gate exists
to prevent. Shipping only the guard half is the same trade in the other
direction.

Per CLAUDE.md 10.11: the cause is named, the classification is read from rows
rather than guessed, and the remaining work is stated plainly rather than
papered over. **The next break will still refuse at the legacy checkpoint.**
No detector, cron, sweep or repair job was added in its place (10.12).
