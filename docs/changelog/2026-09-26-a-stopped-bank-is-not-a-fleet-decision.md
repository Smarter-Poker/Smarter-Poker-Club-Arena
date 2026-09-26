# A stopped bank is not a fleet decision (2026-09-26) - corrected before merge: it is named past its bound, and still refuses

## What was wrong

`MaintenanceBreak.unparkedTables()` bounds every F06 blocker class through
`f06PreparationHoldsGate` - #4909 added that bound after one unresolved permit
held engine `8825af51` shut for 70 consecutive breaks, and 2026-09-21 extended
the same bound to the manager-retained class beside it.

**The stopped-custody test sitting between them never got one.**

`server/src/maintenance/MaintenanceBreak.ts`, in `unparkedTables()`:

```ts
if (engine.hasUnretiredStoppedTimeBankCustody?.()) {
  out.push(tableId);
  count('stopped_bank_custody_unconfirmed'); // no bound, ever
  continue;
}
if (engine.hasUnresolvedF06Preparation?.()) {
  /* ... bounded since #4909 */
}
if (!engine.isRunning()) continue;
```

Measured on production 2026-09-25/26: `stopped_bank_custody_unconfirmed` went
**137 -> 154 -> 187** over ten hours, monotonic, with `/health` reading
`readyForRestart: false` throughout. Because the census walks every engine on
the engine's single core, and (before #5255) ran inside the release's 15000 ms
admission window, the cost scaled with that number and **the release window
narrowed every hour** - so the engine could not be replaced by the very release
that carried its own fix.

## Why it could never clear

`hasUnretiredStoppedTimeBankCustody()` requires `this.terminal`. Failing a
replacement engine's adoption, a confirmed session close, or a durable F06
receipt, it compares `acknowledgedTimeBankPark` against the custody hand
number - and `acknowledgedTimeBankPark` is set **only** when `when === 'parked'`,
whose every call site is inside the dealing loop, which a terminal engine does
not have. The `'announced'` path it does take passes `timeBanks: undefined` and
writes `time_bank_snapshot: null`. Corroborated from rows: **267,741** tournament
park rows carry a null `time_bank_snapshot` against **8,016** with banks.

So the census answered "not yet" to a question whose answer was "never" -
CLAUDE.md **10.86 rule 1**, and the identical shape #4909 bounded for F06.

## The ordering, and why the check stays where it is

The custody test sits **above** `if (!engine.isRunning()) continue`, and that
position is correct: a terminal engine is exactly what it exists to catch, so
moving it below the skip would **delete** the check and pass over a player's
time bank in silence. What it never did was _inherit_ the skip's reasoning -
that a stopped engine has no hand to protect, and therefore has no business
making a fleet-wide decision for ever. **The bound is how it inherits it.**
Pinned both ways by the law (test 7 asserts the position, test 2 the bound).

## What changed

1. **`STOPPED_CUSTODY_GATE_MS` (10 min), and `stoppedCustodyHoldsGate()`** -
   the same shape, default and three-line contract as `f06PreparationHoldsGate`
   beside it. One definition per blocker class, because a bound that applies to
   one of two paths is what left the unbounded one holding the platform shut.
   Past the bound the table is counted `stopped_bank_custody_stuck`, announced
   once to the container log, published on `/health` as
   `stoppedCustodyStuckTables`, and zero-seeded on `/metrics` - it simply stops
   deciding whether every _other_ table may restart.

2. **The census now publishes the engine's own answer.** #5255 split
   `maintenanceDurabilityReason()` into `stopped_bank_custody_unwritten` and
   `_unreadable` and seeded both as `/metrics` labels, but this census kept
   emitting the retired conflated name `stopped_bank_custody_unconfirmed`, which
   is in **no seed list** - so the count only ever reached `/metrics` through the
   dynamic extension and no rule could read it before it had already wedged the
   fleet. That was the half #5255 still owed. A missing method, a null, or any
   name outside the class falls back to `unreadable`, which **refuses**: an
   unreadable answer is never coerced into a readable one (10.86 rule 2).

3. **Clock hygiene**, mirroring the F06 block: a table whose custody cleared,
   or which left the fleet, drops its entry - otherwise a replacement engine
   would inherit its predecessor's elapsed clock and be past the bound the
   moment it appeared.

## Nothing is passed over

The money protection is not this census and never was.
`server/scripts/legacy-engine-checkpoint-guard.mjs` checks **every captured
engine's own `maintenanceDurabilityReason()`, per table and from rows**, and
admits only `bank_park_write_incomplete` on a row-proved stopped table
(`native_readiness_refused`). An engine whose bank is genuinely unwritten or
unreadable therefore **still refuses the cutover on its own**, whatever the fleet
census says. And `stopped_bank_custody_stuck` is deliberately outside that
guard's allow-list, which admits `f06_preparation_unresolved` and
`f06_preparation_stuck` and nothing else - **no bank or custody reason may ever
enter it**, and the law pins that negatively.

`cards_in_air` stays unbounded, on purpose: this bound is scoped to a class that
has no hand. A terminal engine has no dealing loop, so bounding it cannot
certify a cutover over a hand in the air. The 285000 ms floor (150 s proof +
135 s rollback) and the `O_EXCL` one-shot guard with its disjoint 1/70/75 exit
codes are untouched.

## Does this need a cutover?

**Yes.** `MaintenanceBreak.ts` and `GameServer.ts` are engine TypeScript
compiled into the image, so the bound takes effect only on the next engine
cutover. It is not placed in `server/scripts/legacy-engine-checkpoint-guard.mjs`

- which is `cat`'d from `CONTROL_DIR` at run time and is not hash-pinned, so
  changes there apply with no cutover - because this is the engine's own census of
  its own fleet, and putting a bound on the engine's `readyForRestart()` into a
  script that merely _reads_ it would be the wedge moved rather than removed.

Note for whoever reads this next: the live engine at the time of writing is
`778075b4` (#5037), **20 commits behind main and without #5255**, so the write
fix that removes the _cause_ is also not yet live. #5255 removes the cause; this
bounds the _class_, so that no future variant of "a per-table fact this process
cannot clear" can hold the whole fleet again.

## Law

`server/src/maintenance/aStoppedBankPastItsBoundIsNamedAndStillRefuses.law.test.ts` - 10 pins.
Verified **8 of 10 failing** against pre-fix `origin/main` sources and 10/10
passing after (the other two are invariant pins: the guard allow-list already
excluded custody, and `cards_in_air` was already unbounded). Registry entry:
`docs/laws.d/server-src-maintenance-aStoppedBankPastItsBoundIsNamedAndStillRefuses.md`.

## Correction before merge (2026-09-26, release-path owner)

The first commit of this PR retired a stopped-custody table from the census
past `STOPPED_CUSTODY_GATE_MS`, as the F06 class is retired. The section
"Nothing is passed over" above justified that by the per-table durability
witness in `legacy-engine-checkpoint-guard.mjs`. That guard does not run for an
ordinary cutover: `engine-release-transaction.sh` sets
`LEGACY_CHECKPOINT_REQUIRED=1` only when the serving release is one of
`2f4e3356`, `758610f3`, `a0ab287d` or `8825af51`. Every other release,
including the one off `778075b4`, is admitted on
`readyForRestart && unparkedTables == 0` and never reads a reason. Retiring the
table in the census would have been a custody allow-list the release script
cannot see - the thing the hard limit forbids.

It is also not needed to unwedge the fleet. The root cause described above
("`acknowledgedTimeBankPark` is set only on the 'parked' path") is the
778075b4 code. On main, #5255 made the 'announced' path persist a terminal
engine's custody and acknowledge it on a real write, and every break's :53
fan-out reaches that path for every engine, running or not. What can outlive
the bound there is a write that keeps failing, which #5255 names "a bank we
could not persist is still a bank at stake".

So the bound now changes the NAME, never the verdict: past it the table is
reported as `stopped_bank_custody_stuck`, is still counted in
`unparkedTables`, and still refuses. The decision is one declared field,
`UNPARKED_REASON_BOUNDS.stopped_bank_custody_*.neverHoldsGate: true`, beside
F06's `false`. The law was renamed to say what it now pins.

Carried over from #5266 (closed as superseded): the single shared
`holdsGateWithinBound` helper, now reading each bound from the registry
instead of restating it. Not carried: #5266's `BOUNDED_ONLY` release
allow-list entry for `stopped_bank_custody_stuck` and its raw-reason exception
for predecessor `778075b4`, both of which admit custody state into the release
allow-list.

## Every restart blocker declares its bound

`MaintenanceBreak.UNPARKED_REASON_BOUNDS` declares every reason the census can
report: scope `break` (a live loop resolves it within one break; its never is
the uncertified break, already counted by `breaksSinceRestartCertified`) or
scope `lifetime` (can be held by something with no dealing loop; finite
`boundMs`, distinct `never`, explicit `neverHoldsGate`).
`server/src/maintenance/everyRestartBlockerDeclaresItsBound.law.test.ts`
derives the reasons from the census and the engines' `maintenanceDurabilityReason()`,
requires every one to be declared, requires anything asked of a non-running
engine to be `lifetime`, drives each lifetime reason past its bound, and checks
every name is seeded on /metrics. Negative proof: planting
`count('terminal_boundary_pending')` above the running skip in
`MaintenanceBreak.ts` turned the law red with "asked of a non-running engine
but not declared scope 'lifetime'" and "not declared in UNPARKED_REASON_BOUNDS";
the in-test plants do the same on every run.

## What this does not do

It does not get the fleet off `778075b4`. That build's census has no bound and
no custody write, and it is the build whose `/health` every cutover reads. Its
custody count restarts from zero at each process start and climbs (0 at the
01:55 countdown after a restart, 29 at the 02:07 recovery window), so a
cutover off it needs a break at which it reads zero. No release-script
exception was added for it.
